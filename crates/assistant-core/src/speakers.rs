//! Local, anonymous voice grouping. No microphone, network, transcript storage or identity lookup.
//!
//! Vosk emits one x-vector per supplied utterance. This is conservative clustering, not
//! an overlap detector: callers must mark known overlaps, and short/ambiguous evidence
//! stays unknown. Profiles exist only for this handle's listening epoch.
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, MutexGuard, TryLockError,
        atomic::{AtomicBool, AtomicU8, Ordering},
        mpsc::{self as sync_mpsc, Receiver, SyncSender, TrySendError},
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tokio::sync::mpsc;

const INPUT_RATE: usize = 24_000;
const MAX_PCM_BYTES: usize = INPUT_RATE * 2 * 30;
const QUEUE_CAPACITY: usize = 4;
const MIN_SPEECH_FRAMES: u32 = 400; // Vosk speaker MFCC frames have a 10 ms shift.
const VECTOR_SIZE: usize = 128; // Official vosk-model-spk-0.4 transform.
const MAX_PROFILES: usize = 12;
const MATCH_SIMILARITY: f32 = 0.80;
const NEW_PROFILE_MAX_SIMILARITY: f32 = 0.55;
const MIN_MATCH_MARGIN: f32 = 0.12;
const LOADING: u8 = 0;
const READY: u8 = 1;
const UNAVAILABLE: u8 = 2;
const STOPPED: u8 = 3;

// Native model loading cannot be interrupted inside FFI. Retain this permit until
// the worker's Engine has been destroyed, so rapid listening epochs cannot create
// multiple heavy loads while an old cancelled worker is finishing native work.
static ENGINE_PERMIT: Mutex<()> = Mutex::new(());

pub fn default_asset_dir() -> PathBuf {
    dirs::data_local_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("OpenAssistant")
        .join("models")
        .join("vosk-speakers")
}

/// PCM is mono 24 kHz signed 16-bit little endian, aligned to the source's clock.
pub struct SpeakerUtterance {
    pub item_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub pcm: Vec<u8>,
    /// True when the caller knows that voices overlap. Vosk cannot establish this itself.
    pub known_overlap: bool,
}

#[derive(Clone, Debug, Serialize)]
pub struct SpeakerSegment {
    pub item_id: String,
    pub start_ms: u64,
    pub end_ms: u64,
    pub speaker_id: Option<String>,
    /// Cosine similarity to a session-local profile, NOT an identity probability.
    pub similarity: Option<f32>,
    pub detail: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SpeakerEvent {
    Status { available: bool, detail: String },
    Segment(SpeakerSegment),
}

#[derive(Default)]
struct Control {
    cancelled: AtomicBool,
    state: AtomicU8,
}

pub struct SpeakerHandle {
    sender: Option<SyncSender<SpeakerUtterance>>,
    control: Arc<Control>,
    worker: Option<JoinHandle<()>>,
}

impl SpeakerHandle {
    /// Loading is asynchronous; availability is reported exactly once through Status.
    /// A missing/unsupported model is a normal unavailable status, not a fake result.
    pub fn spawn(asset_dir: PathBuf, events: mpsc::Sender<SpeakerEvent>) -> Result<Self, String> {
        let (sender, receiver) = sync_mpsc::sync_channel(QUEUE_CAPACITY);
        let control = Arc::new(Control::default());
        let worker_control = control.clone();
        let worker = thread::Builder::new()
            .name("anonymous-speakers".into())
            .spawn(move || run(asset_dir, receiver, worker_control, events))
            .map_err(|error| {
                format!("Не удалось запустить локальную группировку голосов: {error}")
            })?;
        Ok(Self {
            sender: Some(sender),
            control,
            worker: Some(worker),
        })
    }

    /// Never waits for inference or a free queue slot. At most four 30-second clips queue.
    pub fn submit(&self, utterance: SpeakerUtterance) -> Result<(), String> {
        validate(&utterance)?;
        if self.control.cancelled.load(Ordering::Acquire) {
            return Err("Группировка голосов остановлена".into());
        }
        match self.control.state.load(Ordering::Acquire) {
            UNAVAILABLE => return Err("Локальная модель группировки голосов недоступна".into()),
            STOPPED => return Err("Группировка голосов остановлена".into()),
            LOADING | READY => {}
            _ => return Err("Некорректное состояние группировки голосов".into()),
        }
        self.sender
            .as_ref()
            .ok_or("Группировка голосов остановлена")?
            .try_send(utterance)
            .map_err(|error| match error {
                TrySendError::Full(_) => {
                    "Очередь группировки голосов занята; говорящий не определён".into()
                }
                TrySendError::Disconnected(_) => "Группировка голосов остановлена".into(),
            })
    }

    pub fn stop(&self) {
        self.control.cancelled.store(true, Ordering::Release);
        self.control.state.store(STOPPED, Ordering::Release);
        if let Some(worker) = &self.worker {
            worker.thread().unpark();
        }
    }

    /// Optional deterministic cleanup. The blocking join is kept off the async executor.
    pub async fn shutdown(&mut self) {
        self.stop();
        self.sender.take();
        if let Some(worker) = self.worker.take() {
            let _ = tokio::task::spawn_blocking(move || worker.join()).await;
        }
    }
}

impl Drop for SpeakerHandle {
    fn drop(&mut self) {
        self.stop();
        self.sender.take();
        // Never block a UI or runtime thread in native inference. An in-progress FFI
        // call finishes, then cancellation is checked before another 100 ms PCM chunk.
        // Queued clips and profiles are dropped by the worker; late labels are suppressed.
        if self.worker.as_ref().is_some_and(JoinHandle::is_finished)
            && let Some(worker) = self.worker.take()
        {
            let _ = worker.join();
        }
    }
}

fn validate(utterance: &SpeakerUtterance) -> Result<(), String> {
    if utterance.item_id.is_empty() || utterance.item_id.len() > 256 {
        return Err("Некорректный идентификатор реплики".into());
    }
    if utterance.pcm.len() > MAX_PCM_BYTES || !utterance.pcm.len().is_multiple_of(2) {
        return Err("Ожидается не более 30 секунд PCM 24 кГц, 16 бит, mono".into());
    }
    let duration = utterance
        .end_ms
        .checked_sub(utterance.start_ms)
        .ok_or("Некорректные границы реплики")?;
    let pcm_ms = utterance.pcm.len() as u64 * 1_000 / (INPUT_RATE as u64 * 2);
    if duration > 30_000 || duration.abs_diff(pcm_ms) > 200 {
        return Err("Аудиофрагмент неполон или не соответствует границам реплики".into());
    }
    Ok(())
}

fn acquire_engine_permit<'a>(
    permit: &'a Mutex<()>,
    cancelled: &AtomicBool,
) -> Option<MutexGuard<'a, ()>> {
    loop {
        if cancelled.load(Ordering::Acquire) {
            return None;
        }
        let guard = match permit.try_lock() {
            Ok(guard) => guard,
            Err(TryLockError::Poisoned(error)) => {
                let guard = error.into_inner();
                permit.clear_poison();
                guard
            }
            Err(TryLockError::WouldBlock) => {
                thread::park_timeout(Duration::from_millis(10));
                continue;
            }
        };
        // Cancellation may win between the first check and taking the permit.
        if cancelled.load(Ordering::Acquire) {
            return None;
        }
        return Some(guard);
    }
}

fn run(
    asset_dir: PathBuf,
    receiver: Receiver<SpeakerUtterance>,
    control: Arc<Control>,
    events: mpsc::Sender<SpeakerEvent>,
) {
    // This wait runs only on anonymous-speakers, never on the UI/async executor.
    // Declaration order ensures Engine drops before the permit is released.
    let Some(_permit) = acquire_engine_permit(&ENGINE_PERMIT, &control.cancelled) else {
        return;
    };
    let mut engine = match Engine::open(&asset_dir, &control.cancelled) {
        Ok(engine) => engine,
        Err(detail) => {
            if !control.cancelled.load(Ordering::Acquire) {
                control.state.store(UNAVAILABLE, Ordering::Release);
                emit(
                    &events,
                    &control,
                    SpeakerEvent::Status {
                        available: false,
                        detail: detail.clone(),
                    },
                );
                for utterance in receiver.try_iter() {
                    if !emit(
                        &events,
                        &control,
                        SpeakerEvent::Segment(unknown(&utterance, &detail)),
                    ) {
                        break;
                    }
                }
            }
            return;
        }
    };
    if control.cancelled.load(Ordering::Acquire) {
        return;
    }
    control.state.store(READY, Ordering::Release);
    if !emit(&events, &control, SpeakerEvent::Status {
        available: true,
        detail: "Локальная группировка голосов готова. Метки анонимны и действуют до остановки; короткие и неоднозначные реплики остаются без метки. Наложение голосов автоматически не определяется.".into(),
    }) {
        return;
    }
    let mut profiles = Profiles::default();
    consume(receiver, &control, &events, |utterance| {
        if let Some(detail) = precheck(utterance) {
            return unknown(utterance, detail);
        }
        match engine.extract(&utterance.pcm, &control.cancelled) {
            Ok(vector) => {
                let assignment = profiles.assign(vector);
                SpeakerSegment {
                    item_id: utterance.item_id.clone(),
                    start_ms: utterance.start_ms,
                    end_ms: utterance.end_ms,
                    speaker_id: assignment.speaker_id,
                    similarity: assignment.similarity,
                    detail: assignment.detail.into(),
                }
            }
            Err(detail) => unknown(utterance, &detail),
        }
    });
    control.state.store(STOPPED, Ordering::Release);
}

fn consume(
    receiver: Receiver<SpeakerUtterance>,
    control: &Control,
    events: &mpsc::Sender<SpeakerEvent>,
    mut process: impl FnMut(&SpeakerUtterance) -> SpeakerSegment,
) {
    while !control.cancelled.load(Ordering::Acquire) && !events.is_closed() {
        match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(utterance) => {
                if control.cancelled.load(Ordering::Acquire) {
                    break;
                }
                let result = process(&utterance);
                if !emit(events, control, SpeakerEvent::Segment(result)) {
                    break;
                }
            }
            Err(sync_mpsc::RecvTimeoutError::Timeout) => {}
            Err(sync_mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn emit(events: &mpsc::Sender<SpeakerEvent>, control: &Control, mut event: SpeakerEvent) -> bool {
    // Bounded downstream backpressure, cancellation-aware. Never accumulates extra audio.
    while !control.cancelled.load(Ordering::Acquire) {
        match events.try_send(event) {
            Ok(()) => return true,
            Err(mpsc::error::TrySendError::Closed(_)) => return false,
            Err(mpsc::error::TrySendError::Full(returned)) => {
                event = returned;
                thread::park_timeout(Duration::from_millis(10));
            }
        }
    }
    false
}

fn precheck(utterance: &SpeakerUtterance) -> Option<&'static str> {
    if utterance.known_overlap {
        Some("Наложение голосов: говорящий не определён")
    } else if utterance.pcm.len() < INPUT_RATE * 2 * 4 {
        Some("Для надёжной метки нужно не менее четырёх секунд речи")
    } else {
        None
    }
}

fn unknown(utterance: &SpeakerUtterance, detail: &str) -> SpeakerSegment {
    SpeakerSegment {
        item_id: utterance.item_id.clone(),
        start_ms: utterance.start_ms,
        end_ms: utterance.end_ms,
        speaker_id: None,
        similarity: None,
        detail: detail.into(),
    }
}

#[derive(Default, Deserialize)]
struct SpeakerVector {
    #[serde(default)]
    spk: Vec<f32>,
    #[serde(default)]
    spk_frames: u32,
}

#[derive(Default)]
struct Profiles {
    entries: Vec<Profile>,
}

struct Profile {
    anchor: Vec<f32>,
    centroid: Vec<f32>,
    observations: u32,
}

struct Assignment {
    speaker_id: Option<String>,
    similarity: Option<f32>,
    detail: &'static str,
}

impl Assignment {
    fn unknown(detail: &'static str) -> Self {
        Self {
            speaker_id: None,
            similarity: None,
            detail,
        }
    }
}

impl Profiles {
    fn assign(&mut self, vector: SpeakerVector) -> Assignment {
        if vector.spk_frames < MIN_SPEECH_FRAMES {
            return Assignment::unknown(
                "Недостаточно подтверждённых речевых кадров; говорящий не определён",
            );
        }
        let Some(embedding) = normalize(vector.spk) else {
            return Assignment::unknown("Модель не вернула пригодный вектор голоса");
        };
        let mut ranked: Vec<(usize, f32)> = self
            .entries
            .iter()
            .enumerate()
            .map(|(index, profile)| {
                // A fixed anchor prevents repeated centroid updates drifting into another voice.
                (
                    index,
                    cosine(&embedding, &profile.anchor).min(cosine(&embedding, &profile.centroid)),
                )
            })
            .collect();
        ranked.sort_by(|left, right| right.1.total_cmp(&left.1));
        if let Some(&(index, score)) = ranked.first() {
            let runner_up = ranked.get(1).map_or(-1.0, |entry| entry.1);
            if score >= MATCH_SIMILARITY && score - runner_up >= MIN_MATCH_MARGIN {
                let profile = &mut self.entries[index];
                if score >= 0.90 {
                    let weight = profile.observations.min(20) as f32;
                    let updated: Vec<_> = profile
                        .centroid
                        .iter()
                        .zip(&embedding)
                        .map(|(old, new)| old * weight + new)
                        .collect();
                    if let Some(updated) = normalize(updated) {
                        profile.centroid = updated;
                        profile.observations = profile.observations.saturating_add(1);
                    }
                }
                return Assignment {
                    speaker_id: Some(format!("anonymous-{}", index + 1)),
                    similarity: Some(score),
                    detail: "Похожий голос в этой сессии; это анонимная группа, а не установленная личность",
                };
            }
            if score > NEW_PROFILE_MAX_SIMILARITY {
                return Assignment::unknown(
                    "Голос неоднозначен относительно известных групп; метка не назначена",
                );
            }
        }
        if self.entries.len() >= MAX_PROFILES {
            return Assignment::unknown("Достигнут предел анонимных групп; говорящий не определён");
        }
        self.entries.push(Profile {
            anchor: embedding.clone(),
            centroid: embedding,
            observations: 1,
        });
        Assignment {
            speaker_id: Some(format!("anonymous-{}", self.entries.len())),
            similarity: None,
            detail: "Новая анонимная группа голоса в этой сессии",
        }
    }
}

fn normalize(mut vector: Vec<f32>) -> Option<Vec<f32>> {
    if vector.len() != VECTOR_SIZE || vector.iter().any(|value| !value.is_finite()) {
        return None;
    }
    let norm = vector
        .iter()
        .map(|value| (*value as f64).powi(2))
        .sum::<f64>()
        .sqrt();
    if !norm.is_finite() || norm < 1e-8 {
        return None;
    }
    for value in &mut vector {
        *value = (*value as f64 / norm) as f32;
    }
    Some(vector)
}

fn cosine(left: &[f32], right: &[f32]) -> f32 {
    left.iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>()
        .clamp(-1.0, 1.0)
}

#[cfg(windows)]
use vosk::Engine;

#[cfg(not(windows))]
struct Engine;

#[cfg(not(windows))]
impl Engine {
    fn open(_: &Path, _: &AtomicBool) -> Result<Self, String> {
        Err("Локальная группировка голосов настроена только для Windows".into())
    }
    fn extract(&mut self, _: &[u8], _: &AtomicBool) -> Result<SpeakerVector, String> {
        Err("Локальная модель группировки голосов недоступна".into())
    }
}

#[cfg(windows)]
mod vosk {
    use super::*;
    use libloading::os::windows::{
        LOAD_LIBRARY_SEARCH_DEFAULT_DIRS, LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR, Library,
    };
    use std::ffi::{CStr, CString, c_char, c_int, c_void};

    type ModelNew = unsafe extern "C" fn(*const c_char) -> *mut c_void;
    type Free = unsafe extern "C" fn(*mut c_void);
    type RecognizerNew = unsafe extern "C" fn(*mut c_void, f32, *mut c_void) -> *mut c_void;
    type Accept = unsafe extern "C" fn(*mut c_void, *const i16, c_int) -> c_int;
    type FinalResult = unsafe extern "C" fn(*mut c_void) -> *const c_char;

    pub(super) struct Engine {
        // Kept alive until all native destructors have run.
        _library: Library,
        model: *mut c_void,
        speaker_model: *mut c_void,
        model_free: Free,
        speaker_free: Free,
        recognizer_new: RecognizerNew,
        recognizer_free: Free,
        accept: Accept,
        final_result: FinalResult,
    }

    impl Engine {
        pub(super) fn open(asset_dir: &Path, cancelled: &AtomicBool) -> Result<Self, String> {
            let dir = dunce::canonicalize(asset_dir).map_err(|_| {
                format!(
                    "Локальные модели голосов не установлены: {}",
                    asset_dir.display()
                )
            })?;
            let acoustic = dir.join("vosk-model-small-ru-0.22");
            let speaker = dir.join("vosk-model-spk-0.4");
            for required in [
                dir.join("libvosk.dll"),
                acoustic.join("am/final.mdl"),
                acoustic.join("conf/mfcc.conf"),
                speaker.join("final.ext.raw"),
                speaker.join("mfcc.conf"),
                speaker.join("mean.vec"),
                speaker.join("transform.mat"),
            ] {
                if !required.is_file() {
                    return Err(format!(
                        "Отсутствует файл локальной модели: {}",
                        required.display()
                    ));
                }
            }
            let acoustic_path = path_cstring(&acoustic)?;
            let speaker_path = path_cstring(&speaker)?;
            if cancelled.load(Ordering::Acquire) {
                return Err("Группировка голосов остановлена".into());
            }
            // SAFETY: These signatures are the official Vosk 0.3.45 C API. The DLL and
            // dependencies are loaded only from the explicitly installed asset directory.
            // Models/recognizers never cross threads and no pointer outlives this Library.
            unsafe {
                let library = Library::load_with_flags(
                    dir.join("libvosk.dll"),
                    LOAD_LIBRARY_SEARCH_DLL_LOAD_DIR | LOAD_LIBRARY_SEARCH_DEFAULT_DIRS,
                )
                .map_err(|error| format!("Не удалось загрузить локальную Vosk DLL: {error}"))?;
                macro_rules! symbol {
                    ($name:literal, $kind:ty) => {
                        *library.get::<$kind>(concat!($name, "\0").as_bytes())
                            .map_err(|error| format!("Vosk API {} недоступен: {error}", $name))?
                    };
                }
                let model_new = symbol!("vosk_model_new", ModelNew);
                let speaker_new = symbol!("vosk_spk_model_new", ModelNew);
                let mut engine = Self {
                    model: std::ptr::null_mut(),
                    speaker_model: std::ptr::null_mut(),
                    model_free: symbol!("vosk_model_free", Free),
                    speaker_free: symbol!("vosk_spk_model_free", Free),
                    recognizer_new: symbol!("vosk_recognizer_new_spk", RecognizerNew),
                    recognizer_free: symbol!("vosk_recognizer_free", Free),
                    accept: symbol!("vosk_recognizer_accept_waveform_s", Accept),
                    final_result: symbol!("vosk_recognizer_final_result", FinalResult),
                    _library: library,
                };
                engine.model = model_new(acoustic_path.as_ptr());
                if engine.model.is_null() {
                    return Err("Vosk не смог загрузить акустическую модель".into());
                }
                if cancelled.load(Ordering::Acquire) {
                    return Err("Группировка голосов остановлена".into());
                }
                engine.speaker_model = speaker_new(speaker_path.as_ptr());
                if engine.speaker_model.is_null() {
                    return Err("Vosk не смог загрузить модель векторов голоса".into());
                }
                if cancelled.load(Ordering::Acquire) {
                    return Err("Группировка голосов остановлена".into());
                }
                Ok(engine)
            }
        }

        pub(super) fn extract(
            &mut self,
            pcm: &[u8],
            cancelled: &AtomicBool,
        ) -> Result<SpeakerVector, String> {
            if cancelled.load(Ordering::Acquire) {
                return Err("Группировка голосов остановлена".into());
            }
            // The shipped acoustic (16k) and speaker (8k) mfcc.conf both explicitly
            // allow downsampling. Vosk/Kaldi applies its filter from the real 24k rate.
            let pointer =
                unsafe { (self.recognizer_new)(self.model, INPUT_RATE as f32, self.speaker_model) };
            if pointer.is_null() {
                return Err("Vosk не смог создать анализатор голоса".into());
            }
            let recognizer = Recognizer {
                engine: self,
                pointer,
            };
            for bytes in pcm.chunks(INPUT_RATE / 10 * 2) {
                if cancelled.load(Ordering::Acquire) {
                    return Err("Группировка голосов остановлена".into());
                }
                let samples: Vec<i16> = bytes
                    .chunks_exact(2)
                    .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
                    .collect();
                // Keep the entire caller-VAD utterance: endpoint hints do not reset
                // the decoder; only FinalResult is called once at the end.
                let result =
                    unsafe { (self.accept)(pointer, samples.as_ptr(), samples.len() as c_int) };
                if result < 0 {
                    return Err("Vosk отклонил аудиофрагмент".into());
                }
            }
            if cancelled.load(Ordering::Acquire) {
                return Err("Группировка голосов остановлена".into());
            }
            let result = unsafe { (self.final_result)(recognizer.pointer) };
            if result.is_null() {
                return Err("Vosk вернул пустой результат".into());
            }
            let bytes = unsafe { CStr::from_ptr(result) }.to_bytes();
            serde_json::from_slice(bytes)
                .map_err(|_| "Vosk вернул некорректный вектор голоса".into())
        }
    }

    fn path_cstring(path: &Path) -> Result<CString, String> {
        CString::new(path.to_str().ok_or("Путь модели не является UTF-8")?)
            .map_err(|_| "Путь модели содержит NUL".into())
    }

    struct Recognizer<'a> {
        engine: &'a Engine,
        pointer: *mut c_void,
    }

    impl Drop for Recognizer<'_> {
        fn drop(&mut self) {
            unsafe { (self.engine.recognizer_free)(self.pointer) };
        }
    }

    impl Drop for Engine {
        fn drop(&mut self) {
            unsafe {
                if !self.speaker_model.is_null() {
                    (self.speaker_free)(self.speaker_model);
                }
                if !self.model.is_null() {
                    (self.model_free)(self.model);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "speakers_tests.rs"]
mod tests;
