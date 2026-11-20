//! Native WASAPI/CPAL input, independent of WebView media permissions.
//! Capture callbacks only convert/channel audio. DSP, IPC and device checks run on the worker.
mod devices;
mod levels;
mod loopback;
mod processing;
pub use devices::{input_state, system_state, InputState};
pub use levels::AudioLevels;

use cpal::{
    traits::{DeviceTrait, StreamTrait},
    FromSample, Sample, SampleFormat, SizedSample, Stream, StreamConfig,
};
use loopback::LoopbackClock;
use processing::{Captured, Processor};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering},
        mpsc::{self, SyncSender, TrySendError},
        Arc, Mutex, MutexGuard, Weak,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

const STOP: u8 = 1;
const DISCARD: u8 = 2;
const REPLACED: u8 = 3;
const TEST_LIMIT: Duration = Duration::from_secs(20);
const PACKET_SAMPLES: usize = 2400;
static CAPTURE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

/// Separate states own separate endpoints; system capture never replaces a microphone.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum CaptureSource {
    #[default]
    Microphone,
    System,
}
impl CaptureSource {
    fn label(self) -> &'static str {
        match self {
            Self::Microphone => "Микрофон",
            Self::System => "Системный звук",
        }
    }
    fn thread_prefix(self) -> &'static str {
        match self {
            Self::Microphone => "microphone",
            Self::System => "system-audio",
        }
    }
    fn stalled(self, elapsed: Duration) -> bool {
        // WASAPI loopback may produce no packets while the render endpoint is idle.
        self == Self::Microphone && elapsed > Duration::from_secs(5)
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CaptureMode {
    #[default]
    Stream,
    Test,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct AudioConfig {
    pub device_id: Option<String>,
    pub mode: CaptureMode,
    pub noise_suppression: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AudioEvent {
    Started {
        capture_id: u64,
        device_id: String,
        device_name: String,
    },
    Pcm {
        capture_id: u64,
        data: Vec<u8>,
    },
    Levels {
        capture_id: u64,
        #[serde(flatten)]
        levels: AudioLevels,
    },
    Stopped {
        capture_id: u64,
        reason: String,
        error: Option<String>,
    },
}

/// Keep the existing capture DTO while explicitly attributing the output mix.
#[derive(Clone, Debug, Serialize)]
pub struct SystemAudioEvent {
    source: &'static str,
    #[serde(flatten)]
    event: AudioEvent,
}
impl From<AudioEvent> for SystemAudioEvent {
    fn from(event: AudioEvent) -> Self {
        Self {
            source: "system",
            event,
        }
    }
}

type Callback = Arc<dyn Fn(AudioEvent) -> bool + Send + Sync>;
fn lock<T>(value: &Mutex<T>) -> MutexGuard<'_, T> {
    value.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Default)]
struct Control {
    stop: AtomicU8,
    activate: AtomicBool,
    live: AtomicBool,
    noise_suppression: AtomicBool,
}
impl Control {
    fn stop(&self, reason: u8) {
        if reason == DISCARD {
            self.stop.store(DISCARD, Ordering::Release);
        } else {
            let _ = self
                .stop
                .compare_exchange(0, reason, Ordering::AcqRel, Ordering::Acquire);
        }
    }
}
struct Worker {
    id: u64,
    mode: CaptureMode,
    control: Arc<Control>,
    thread: Mutex<Option<JoinHandle<()>>>,
}
impl Worker {
    fn join(&self) -> Result<(), String> {
        match lock(&self.thread).take() {
            Some(thread) => thread
                .join()
                .map_err(|_| "Рабочий аудиопоток завершился с ошибкой.".into()),
            None => Ok(()),
        }
    }
    fn finished(&self) -> bool {
        lock(&self.thread)
            .as_ref()
            .is_none_or(JoinHandle::is_finished)
    }
}
#[derive(Default)]
struct Slots {
    current: Option<Arc<Worker>>,
    starting: Option<Arc<Worker>>,
    retired: Vec<Arc<Worker>>,
}
#[derive(Default)]
struct Inner {
    epoch: AtomicU64,
    test_epoch: AtomicU64,
    operation: Mutex<()>,
    slots: Mutex<Slots>,
}
impl Drop for Inner {
    fn drop(&mut self) {
        let slots = self.slots.get_mut().unwrap_or_else(|p| p.into_inner());
        for worker in slots
            .current
            .iter()
            .chain(slots.starting.iter())
            .chain(slots.retired.iter())
        {
            worker.control.stop(DISCARD);
        }
    }
}
/// Captured at IPC entry, before work is queued on a blocking executor.
#[derive(Clone, Copy, Debug)]
pub struct StartTicket {
    epoch: u64,
    test_epoch: u64,
    mode: CaptureMode,
}
impl StartTicket {
    fn valid(&self, state: &Inner, mode: CaptureMode) -> bool {
        self.mode == mode
            && self.epoch == state.epoch.load(Ordering::Acquire)
            && (mode != CaptureMode::Test
                || self.test_epoch == state.test_epoch.load(Ordering::Acquire))
    }
}

#[derive(Clone, Default)]
pub struct AudioState {
    inner: Arc<Inner>,
    source: CaptureSource,
}

/// Independent lifecycle for Windows render-endpoint loopback. Main-view retirement
/// and app shutdown must invalidate and join both this state and AudioState.
#[derive(Clone)]
pub struct SystemAudioState(AudioState);
impl Default for SystemAudioState {
    fn default() -> Self {
        Self(AudioState {
            inner: Arc::new(Inner::default()),
            source: CaptureSource::System,
        })
    }
}
impl std::ops::Deref for SystemAudioState {
    type Target = AudioState;
    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

impl AudioState {
    pub fn start_ticket(&self, mode: CaptureMode) -> StartTicket {
        StartTicket {
            epoch: self.inner.epoch.load(Ordering::Acquire),
            test_epoch: self.inner.test_epoch.load(Ordering::Acquire),
            mode,
        }
    }

    #[cfg(test)]
    pub fn start<F>(&self, config: AudioConfig, callback: F) -> Result<u64, String>
    where
        F: Fn(AudioEvent) -> bool + Send + Sync + 'static,
    {
        let ticket = self.start_ticket(config.mode);
        self.start_with_ticket(config, ticket, callback)
    }

    /// Blocks only the command worker, never the WebView or the CPAL callback.
    pub fn start_with_ticket<F>(
        &self,
        config: AudioConfig,
        ticket: StartTicket,
        callback: F,
    ) -> Result<u64, String>
    where
        F: Fn(AudioEvent) -> bool + Send + Sync + 'static,
    {
        if config
            .device_id
            .as_ref()
            .is_some_and(|id| id.is_empty() || id.len() > 4096)
        {
            return Err("Некорректный идентификатор аудиоустройства.".into());
        }
        if !ticket.valid(&self.inner, config.mode) {
            return Err("Запуск захвата звука отменён.".into());
        }
        let mode = config.mode;
        let _operation = lock(&self.inner.operation);
        if !ticket.valid(&self.inner, mode) {
            return Err("Запуск захвата звука отменён.".into());
        }
        self.reap_finished();
        {
            let slots = lock(&self.inner.slots);
            if config.mode == CaptureMode::Test
                && slots.current.as_ref().is_some_and(|w| {
                    w.mode == CaptureMode::Stream && w.control.live.load(Ordering::Acquire)
                })
            {
                return Err(
                    "Сначала останови текущий захват звука, затем запусти проверку.".into(),
                );
            }
        }
        let id = CAPTURE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let control = Arc::new(Control {
            noise_suppression: AtomicBool::new(config.noise_suppression),
            ..Control::default()
        });
        let worker_control = control.clone();
        let state = Arc::downgrade(&self.inner);
        let callback: Callback = Arc::new(callback);
        let mode = config.mode;
        let source = self.source;
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let thread = thread::Builder::new()
            .name(format!("{}-{id}", source.thread_prefix()))
            .spawn(move || {
                capture(
                    id,
                    ticket,
                    state,
                    config,
                    source,
                    worker_control,
                    callback,
                    ready_tx,
                );
            })
            .map_err(|e| format!("Не удалось создать аудиопоток: {e}"))?;
        let candidate = Arc::new(Worker {
            id,
            mode,
            control,
            thread: Mutex::new(Some(thread)),
        });
        {
            let mut slots = lock(&self.inner.slots);
            if !ticket.valid(&self.inner, mode) {
                candidate.control.stop(DISCARD);
                slots.retired.push(candidate);
                return Err("Запуск захвата звука отменён.".into());
            }
            slots.starting = Some(candidate.clone());
        }
        let prepared = ready_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| {
                "Аудиоустройство не ответило за 5 секунд. Проверь выбранный источник и доступ Windows.".to_owned()
            })
            .and_then(|value| value);
        if let Err(error) = prepared {
            self.retire(&candidate, DISCARD);
            if candidate.finished() {
                candidate.join()?;
            }
            return Err(error);
        }
        let previous = {
            let mut slots = lock(&self.inner.slots);
            if !ticket.valid(&self.inner, mode)
                || candidate.control.stop.load(Ordering::Acquire) != 0
            {
                drop(slots);
                self.retire(&candidate, DISCARD);
                candidate.join()?;
                return Err("Запуск захвата звука отменён.".into());
            }
            slots.current.take()
        };
        // The candidate has successfully opened and played before the old device is retired.
        if let Some(previous) = previous {
            previous.control.stop(REPLACED);
            previous.join()?;
        }
        {
            let mut slots = lock(&self.inner.slots);
            if !ticket.valid(&self.inner, mode)
                || candidate.control.stop.load(Ordering::Acquire) != 0
            {
                drop(slots);
                self.retire(&candidate, DISCARD);
                candidate.join()?;
                return Err("Запуск захвата звука отменён.".into());
            }
            if slots.starting.as_ref().is_some_and(|w| w.id == id) {
                slots.starting = None;
            }
            slots.current = Some(candidate.clone());
            candidate.control.activate.store(true, Ordering::Release);
        }
        Ok(id)
    }

    /// Changes only worker DSP. The WASAPI stream, capture ID and test deadline stay intact.
    pub fn set_noise_suppression(&self, capture_id: u64, enabled: bool) -> Result<(), String> {
        let slots = lock(&self.inner.slots);
        let worker = slots
            .current
            .as_ref()
            .filter(|worker| {
                worker.id == capture_id
                    && worker.control.live.load(Ordering::Acquire)
                    && worker.control.stop.load(Ordering::Acquire) == 0
            })
            .ok_or_else(|| "Этот захват звука уже завершён.".to_owned())?;
        worker
            .control
            .noise_suppression
            .store(enabled, Ordering::Release);
        Ok(())
    }

    /// Exact IDs protect a newer capture from delayed stop requests.
    pub fn stop(&self, capture_id: Option<u64>) -> Result<(), String> {
        if capture_id.is_none() {
            self.inner.epoch.fetch_add(1, Ordering::AcqRel);
        }
        let workers = self.take_matching(|worker| capture_id.is_none_or(|id| worker.id == id));
        let reason = if capture_id.is_some() { STOP } else { DISCARD };
        for worker in &workers {
            worker.control.stop(reason);
        }
        for worker in workers {
            worker.join()?;
        }
        Ok(())
    }

    /// Immediate cancellation for window blur/hide. Ordinary voice input is untouched.
    pub fn invalidate_test(&self) {
        self.inner.test_epoch.fetch_add(1, Ordering::AcqRel);
        self.invalidate_matching(|worker| worker.mode == CaptureMode::Test);
    }

    /// Retire a WebView generation synchronously; join cancelled workers via stop(None).
    pub fn invalidate(&self) {
        self.inner.epoch.fetch_add(1, Ordering::AcqRel);
        self.invalidate_matching(|_| true);
    }

    fn invalidate_matching(&self, predicate: impl Fn(&Worker) -> bool) {
        let mut slots = lock(&self.inner.slots);
        if slots.current.as_ref().is_some_and(|w| predicate(w)) {
            let worker = slots.current.take().unwrap();
            worker.control.stop(DISCARD);
            slots.retired.push(worker);
        }
        if slots.starting.as_ref().is_some_and(|w| predicate(w)) {
            let worker = slots.starting.take().unwrap();
            worker.control.stop(DISCARD);
            slots.retired.push(worker);
        }
        for worker in &slots.retired {
            if predicate(worker) {
                worker.control.stop(DISCARD);
            }
        }
    }

    fn take_matching(&self, predicate: impl Fn(&Worker) -> bool) -> Vec<Arc<Worker>> {
        let mut slots = lock(&self.inner.slots);
        let mut result = Vec::new();
        if slots.current.as_ref().is_some_and(|w| predicate(w)) {
            result.push(slots.current.take().unwrap());
        }
        if slots.starting.as_ref().is_some_and(|w| predicate(w)) {
            result.push(slots.starting.take().unwrap());
        }
        let mut index = 0;
        while index < slots.retired.len() {
            if predicate(&slots.retired[index]) {
                result.push(slots.retired.swap_remove(index));
            } else {
                index += 1;
            }
        }
        let mut ids = HashSet::new();
        result.retain(|worker| ids.insert(worker.id));
        result
    }

    fn retire(&self, worker: &Arc<Worker>, reason: u8) {
        worker.control.stop(reason);
        let mut slots = lock(&self.inner.slots);
        if slots.starting.as_ref().is_some_and(|w| w.id == worker.id) {
            slots.starting = None;
        }
        if !slots.retired.iter().any(|w| w.id == worker.id) {
            slots.retired.push(worker.clone());
        }
    }
    fn reap_finished(&self) {
        let workers = self.take_matching(Worker::finished);
        for worker in workers {
            let _ = worker.join();
        }
    }
}

// CPAL keeps WASAPI capture running after these advisory notifications.
// Queue overflow and actual device/backend failures remain terminal.
fn terminal_stream_error(cause: &cpal::Error) -> Option<String> {
    match cause.kind() {
        cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied => None,
        _ => Some(format!("Ошибка аудиопотока: {cause} ({cause:?})")),
    }
}

struct TimedCaptured {
    audio: Captured,
    at: Instant,
}

fn make_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    sender: SyncSender<TimedCaptured>,
    overflow: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    control: Arc<Control>,
) -> Result<Stream, String>
where
    T: SizedSample + Sample + Send + 'static,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    let rate = config.sample_rate;
    let chunk_samples = (rate as usize / 50).max(1) * channels;
    device.build_input_stream(*config,move|samples:&[T],info|{
        if control.stop.load(Ordering::Acquire)!=0 || !control.activate.load(Ordering::Acquire) {return;}
        let now = Instant::now();
        let timestamp = info.timestamp();
        let age = timestamp.callback.duration_since(timestamp.capture);
        let first = now.checked_sub(age).unwrap_or(now);
        for (index, chunk) in samples.chunks(chunk_samples).enumerate() {
            let offset = Duration::from_secs_f64((index * chunk_samples / channels) as f64 / rate as f64);
            let at = first.checked_add(offset).unwrap_or(first);
            let mut mono=Vec::with_capacity(chunk.len()/channels);
            let mut peak=0.0_f32;
            let mut clipped=0;
            for frame in chunk.chunks_exact(channels) {
                let mut sum=0.0;
                for sample in frame {
                    let value=f32::from_sample(*sample);
                    let value=if value.is_finite(){value}else{0.0};
                    peak=peak.max(value.abs());
                    if value.abs()>=0.985 {clipped+=1;}
                    sum+=value;
                }
                mono.push((sum/channels as f32).clamp(-1.0,1.0));
            }
            if !mono.is_empty() {
                match sender.try_send(TimedCaptured{audio:Captured{mono,peak:peak.min(1.0),clipped,samples:chunk.len()},at}) {
                    Err(TrySendError::Full(_))=>{overflow.store(true,Ordering::Release);return;}
                    Err(TrySendError::Disconnected(_))=>return,
                    Ok(())=>{}
                }
            }
        }
    },move|cause|{
        if let Some(message) = terminal_stream_error(&cause) {
            // Preserve the first terminal cause; later advisory callbacks cannot erase it.
            lock(&error).get_or_insert(message);
        }
    },None).map_err(|error|format!("Не удалось открыть аудиоустройство. Проверь выбранный источник, доступ Windows и занятость устройства. {error}"))
}

struct Packetizer {
    samples: Vec<i16>,
}
impl Packetizer {
    fn new() -> Self {
        Self {
            samples: Vec::with_capacity(PACKET_SAMPLES),
        }
    }
    fn push(&mut self, samples: &[i16], emit: &mut impl FnMut(Vec<u8>) -> bool) -> bool {
        for sample in samples {
            self.samples.push(*sample);
            if self.samples.len() == PACKET_SAMPLES && !self.flush(emit) {
                return false;
            }
        }
        true
    }
    fn flush(&mut self, emit: &mut impl FnMut(Vec<u8>) -> bool) -> bool {
        if self.samples.is_empty() {
            return true;
        }
        let bytes = self.samples.drain(..).flat_map(i16::to_le_bytes).collect();
        emit(bytes)
    }
}

fn emit_captured(
    captured: Captured,
    processor: &mut Processor,
    packets: &mut Packetizer,
    mode: CaptureMode,
    id: u64,
    send: &impl Fn(AudioEvent) -> bool,
) -> bool {
    let (samples, levels) = processor.push(captured);
    if let Some(levels) = levels {
        if !send(AudioEvent::Levels {
            capture_id: id,
            levels,
        }) {
            return false;
        }
    }
    mode == CaptureMode::Test
        || packets.push(&samples, &mut |data| {
            send(AudioEvent::Pcm {
                capture_id: id,
                data,
            })
        })
}

#[allow(clippy::too_many_arguments)]
fn emit_silence(
    frames: usize,
    rate: u32,
    processor: &mut Processor,
    packets: &mut Packetizer,
    mode: CaptureMode,
    id: u64,
    send: &impl Fn(AudioEvent) -> bool,
) -> bool {
    let mut remaining = frames;
    while remaining > 0 {
        let count = remaining.min((rate as usize / 10).max(1));
        if !emit_captured(
            Captured {
                mono: vec![0.0; count],
                peak: 0.0,
                clipped: 0,
                samples: count,
            },
            processor,
            packets,
            mode,
            id,
            send,
        ) {
            return false;
        }
        remaining -= count;
    }
    true
}

#[allow(clippy::too_many_arguments)]
fn emit_source(
    captured: TimedCaptured,
    loopback: &mut Option<LoopbackClock>,
    origin: Instant,
    rate: u32,
    processor: &mut Processor,
    packets: &mut Packetizer,
    mode: CaptureMode,
    id: u64,
    send: &impl Fn(AudioEvent) -> bool,
) -> bool {
    let mut audio = captured.audio;
    if let Some(clock) = loopback {
        let plan = clock.capture(
            captured.at.saturating_duration_since(origin),
            audio.mono.len(),
        );
        if !emit_silence(plan.silence, rate, processor, packets, mode, id, send) {
            return false;
        }
        if plan.skip >= audio.mono.len() {
            return true;
        }
        if plan.skip > 0 {
            audio.mono.drain(..plan.skip);
            // A trimmed packet no longer has valid per-channel aggregate peaks.
            // Recompute conservative mono evidence from its actual remaining samples.
            audio.peak = audio
                .mono
                .iter()
                .map(|sample| sample.abs())
                .fold(0.0, f32::max);
            audio.clipped = audio
                .mono
                .iter()
                .filter(|sample| sample.abs() >= 0.985)
                .count();
            audio.samples = audio.mono.len();
        }
    }
    emit_captured(audio, processor, packets, mode, id, send)
}

#[allow(clippy::too_many_arguments)]
fn capture(
    id: u64,
    ticket: StartTicket,
    state: Weak<Inner>,
    config: AudioConfig,
    source: CaptureSource,
    control: Arc<Control>,
    callback: Callback,
    ready: SyncSender<Result<(), String>>,
) {
    let send = |event: AudioEvent| -> bool {
        let Some(current) = state.upgrade() else {
            return false;
        };
        if current.epoch.load(Ordering::Acquire) != ticket.epoch {
            return false;
        }
        if (control.stop.load(Ordering::Acquire) == DISCARD || !ticket.valid(&current, config.mode))
            && !matches!(event, AudioEvent::Stopped { .. })
        {
            return false;
        }
        callback(event)
    };
    let is_current = || {
        state
            .upgrade()
            .is_some_and(|state| ticket.valid(&state, config.mode))
    };
    let prepared = (|| {
        if !is_current() {
            return Err("Запуск захвата звука отменён.".into());
        }
        let device = devices::resolve(source, config.device_id.as_deref())?;
        let device_id = device
            .id()
            .map_err(|e| format!("Идентификатор аудиоустройства: {e}"))?
            .to_string();
        let device_name = device
            .description()
            .map(|d| d.name().to_owned())
            .unwrap_or_else(|_| source.label().into());
        // CPAL's WASAPI backend enables AUDCLNT_STREAMFLAGS_LOOPBACK when an
        // input stream is built on a render endpoint; its format is output config.
        let supported = match source {
            CaptureSource::Microphone => device.default_input_config(),
            CaptureSource::System => device.default_output_config(),
        }
        .map_err(|e| format!("Формат аудиоустройства ({}): {e}", source.label()))?;
        let format = supported.sample_format();
        let stream_config: StreamConfig = supported.into();
        if stream_config.channels == 0 || stream_config.sample_rate == 0 {
            return Err("Некорректный формат аудиоустройства.".into());
        }
        if control.stop.load(Ordering::Acquire) != 0 || !is_current() {
            return Err("Запуск захвата звука отменён.".into());
        }
        let (sender, receiver) = mpsc::sync_channel(16);
        let overflow = Arc::new(AtomicBool::new(false));
        let error = Arc::new(Mutex::new(None));
        macro_rules! stream {
            ($ty:ty) => {
                make_stream::<$ty>(
                    &device,
                    &stream_config,
                    sender,
                    overflow.clone(),
                    error.clone(),
                    control.clone(),
                )?
            };
        }
        let stream = match format {
            SampleFormat::F32 => stream!(f32),
            SampleFormat::F64 => stream!(f64),
            SampleFormat::I8 => stream!(i8),
            SampleFormat::U8 => stream!(u8),
            SampleFormat::I16 => stream!(i16),
            SampleFormat::U16 => stream!(u16),
            SampleFormat::I32 => stream!(i32),
            SampleFormat::U32 => stream!(u32),
            _ => {
                return Err(format!(
                    "Формат аудиоустройства {format:?} пока не поддерживается."
                ))
            }
        };
        if control.stop.load(Ordering::Acquire) != 0 || !is_current() {
            return Err("Запуск захвата звука отменён.".into());
        }
        stream
            .play()
            .map_err(|e| format!("Не удалось запустить захват звука: {e}"))?;
        control.live.store(true, Ordering::Release);
        Ok((
            stream,
            receiver,
            overflow,
            error,
            device_id,
            device_name,
            stream_config.sample_rate,
        ))
    })();
    let (stream, receiver, overflow, error, device_id, device_name, rate) = match prepared {
        Ok(value) => value,
        Err(message) => {
            let _ = ready.send(Err(message.clone()));
            let _ = send(AudioEvent::Stopped {
                capture_id: id,
                reason: "error".into(),
                error: Some(message),
            });
            return;
        }
    };
    if ready.send(Ok(())).is_err() {
        control.stop(DISCARD);
    }
    while !control.activate.load(Ordering::Acquire)
        && control.stop.load(Ordering::Acquire) == 0
        && is_current()
    {
        thread::sleep(Duration::from_millis(5));
    }
    if !is_current() {
        control.stop(DISCARD);
    }
    let mut processor = Processor::new(rate, control.noise_suppression.load(Ordering::Acquire));
    let mut packets = Packetizer::new();
    let mut send_pcm = |data| {
        config.mode == CaptureMode::Test
            || send(AudioEvent::Pcm {
                capture_id: id,
                data,
            })
    };
    let start = Instant::now();
    let mut loopback = (source == CaptureSource::System).then(|| LoopbackClock::new(rate));
    let mut last_audio = Instant::now();
    let mut last_device_check = Instant::now();
    let mut failure = None;
    if control.stop.load(Ordering::Acquire) == 0
        && !send(AudioEvent::Started {
            capture_id: id,
            device_id: device_id.clone(),
            device_name,
        })
    {
        control.stop(DISCARD);
    }
    let reason = loop {
        if !is_current() {
            control.stop(DISCARD);
        }
        let stop = control.stop.load(Ordering::Acquire);
        if stop != 0 {
            break match stop {
                DISCARD => "invalidated",
                REPLACED => "replaced",
                _ => "stopped",
            };
        }
        if config.mode == CaptureMode::Test && start.elapsed() >= TEST_LIMIT {
            break "timeout";
        }
        if let Some(message) = lock(&error).take() {
            failure = Some(message);
            break "device_lost";
        }
        if overflow.load(Ordering::Acquire) {
            failure=Some("Обработка не успевает за аудиопотоком. Захват остановлен, чтобы не отправлять устаревшую речь.".into());
            break "overflow";
        }
        if last_device_check.elapsed() >= Duration::from_secs(1) {
            last_device_check = Instant::now();
            if !devices::connected(source, &device_id) {
                failure = Some(
                    "Выбранное аудиоустройство отключено. Подключи его или выбери другое.".into(),
                );
                break "device_lost";
            }
        }
        if source.stalled(last_audio.elapsed()) {
            failure = Some(
                "Микрофон не передаёт аудиоданные. Проверь устройство и разрешение Windows.".into(),
            );
            break "device_lost";
        }
        match receiver.recv_timeout(Duration::from_millis(20)) {
            Ok(captured) => {
                last_audio = Instant::now();
                // Switch between complete input blocks; drain the previous filter before
                // accepting new samples so toggles cannot drop a partial spoken word.
                let tail = processor
                    .set_noise_suppression(control.noise_suppression.load(Ordering::Acquire));
                if config.mode == CaptureMode::Stream && !packets.push(&tail, &mut send_pcm) {
                    control.stop(DISCARD);
                    break "receiver_closed";
                }
                if !emit_source(
                    captured,
                    &mut loopback,
                    start,
                    rate,
                    &mut processor,
                    &mut packets,
                    config.mode,
                    id,
                    &send,
                ) {
                    control.stop(DISCARD);
                    break "receiver_closed";
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break "device_lost";
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Some(clock) = &mut loopback {
                    let silence = clock.idle(start.elapsed());
                    if !emit_silence(
                        silence,
                        rate,
                        &mut processor,
                        &mut packets,
                        config.mode,
                        id,
                        &send,
                    ) {
                        control.stop(DISCARD);
                        break "receiver_closed";
                    }
                }
            }
        }
    };
    // Stop the hardware first, then flush accepted PCM before the stopped acknowledgement.
    drop(stream);
    control.live.store(false, Ordering::Release);
    if config.mode == CaptureMode::Stream && matches!(reason, "stopped" | "replaced") {
        while let Ok(captured) = receiver.try_recv() {
            if !emit_source(
                captured,
                &mut loopback,
                start,
                rate,
                &mut processor,
                &mut packets,
                config.mode,
                id,
                &send,
            ) {
                break;
            }
        }
        let tail = processor.finish();
        if packets.push(&tail, &mut send_pcm) {
            let _ = packets.flush(&mut send_pcm);
        }
    }
    let _ = send(AudioEvent::Stopped {
        capture_id: id,
        reason: reason.into(),
        error: failure,
    });
}

#[cfg(test)]
mod tests;
