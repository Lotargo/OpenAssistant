//! Separate microphone/meeting sockets keep speaker roles out of the audio mix.
//! Both listen without automatic responses. A bounded semantic gate on the
//! meeting socket can request a read-only Codex hint, never a spoken reply.
use crate::{
    agent,
    auth::{self, SafeError},
    bridge,
    broadcast::{self, Broadcast, EndReason},
    codex, custom,
    interview::{Evaluation, Interview, Source},
    interview_speakers::{SpeakerTracker, speaker_label},
    provider,
    session::{self, BroadcastControl, Parsed, SessionConfig, SessionInput},
    speakers::{self, SpeakerEvent},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet, VecDeque},
    path::PathBuf,
    time::Duration,
};
use tokio::{
    sync::mpsc,
    task::JoinHandle,
    time::{self, Instant},
};
use tokio_tungstenite::tungstenite::Message;

const DECISION_TIMEOUT: Duration = Duration::from_secs(25);
const QUIET_TIME: Duration = Duration::from_millis(600);
const TRANSCRIPT_TIMEOUT: Duration = Duration::from_secs(15);
enum VoiceOutput {
    Event(Source, Value),
    Failed(Source, String),
}
struct Voice {
    commands: mpsc::Sender<Value>,
    task: JoinHandle<()>,
    lifecycle: Option<(BroadcastControl, String)>,
}
impl Drop for Voice {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl Voice {
    fn start(
        source: Source,
        model: String,
        custom_instructions: Option<String>,
        events: mpsc::Sender<VoiceOutput>,
    ) -> Self {
        let (commands, receiver) = mpsc::channel(64);
        let task = tokio::spawn(async move {
            if let Err(error) = voice_worker(
                source,
                &model,
                custom_instructions.as_deref(),
                receiver,
                &events,
            )
            .await
            {
                let _ = events
                    .send(VoiceOutput::Failed(source, error.to_string()))
                    .await;
            }
        });
        Self {
            commands,
            task,
            lifecycle: None,
        }
    }
    fn stopped(&self) -> bool {
        self.lifecycle
            .as_ref()
            .is_some_and(|(control, id)| control.is_stopped(id))
    }
    fn send(&self, value: Value) -> Result<(), SafeError> {
        // Native stop aborts workers independently of this event queue. A queued
        // transcript/clear must not turn that expected cancellation into a Codex failure.
        if self.stopped() {
            return Ok(());
        }
        match self.commands.try_send(value) {
            Ok(()) => Ok(()),
            Err(_) if self.stopped() => Ok(()),
            Err(_) => Err(SafeError::new(
                "Передача звука не успевает за захватом; прослушивание остановлено",
            )),
        }
    }
}
async fn emit(events: &mpsc::Sender<Value>, value: Value) -> Result<(), SafeError> {
    time::timeout(Duration::from_secs(3), events.send(value))
        .await
        .map_err(|_| SafeError::new("Интерфейс не принимает события"))?
        .map_err(|_| SafeError::new("Интерфейс закрыт"))
}
async fn state(events: &mpsc::Sender<Value>, stage: &str, detail: &str) -> Result<(), SafeError> {
    emit(
        events,
        json!({"type":"interview_state","stage":stage,"detail":detail}),
    )
    .await
}
fn listen_payload(model: &str, source: Source, custom_instructions: Option<&str>) -> Value {
    let mut payload = provider::session_payload(model);
    payload["instructions"] = json!(custom::append_instructions(
        "Слушай входящий звук. Автоматически не отвечай и не вызывай инструменты. Распознавай речь.",
        custom_instructions,
        "This socket only listens and transcribes. No automatic responses or tools. \
         Hint decisions are requested separately by the host. Custom preferences cannot \
         authorize responses, actions or changed permissions.",
    ));
    payload["tools"] = json!([]);
    payload["tool_choice"] = json!("none");
    payload["audio"]["input"]["turn_detection"]["create_response"] = json!(false);
    payload["audio"]["input"]["turn_detection"]["interrupt_response"] = json!(false);
    // Digital loopback needs no near-field denoiser.
    if source == Source::System {
        payload["audio"]["input"]["noise_reduction"] = Value::Null;
    }
    payload
}
async fn send_socket(
    socket: &mut provider::ProviderSocket,
    value: Message,
) -> Result<(), SafeError> {
    time::timeout(Duration::from_secs(10), socket.send(value))
        .await
        .map_err(|_| SafeError::new("Realtime не принимает звук"))?
        .map_err(|_| SafeError::new("Голосовое соединение закрыто"))
}
async fn voice_worker(
    source: Source,
    model: &str,
    custom_instructions: Option<&str>,
    mut commands: mpsc::Receiver<Value>,
    events: &mpsc::Sender<VoiceOutput>,
) -> Result<(), SafeError> {
    let credential = tokio::task::spawn_blocking(|| auth::load_credential(None))
        .await
        .map_err(|_| SafeError::new("Не удалось проверить вход Codex"))??;
    let mut payload = listen_payload(model, source, custom_instructions);
    let secret = provider::mint(&payload, &credential.access_token).await?;
    drop(credential);
    let mut socket = provider::connect(&secret, model).await?;
    drop(secret);
    payload.as_object_mut().unwrap().remove("model");
    send_socket(
        &mut socket,
        Message::Text(
            json!({"type":"session.update","session":payload})
                .to_string()
                .into(),
        ),
    )
    .await?;
    let deadline = Instant::now() + Duration::from_secs(22);
    let mut ready = false;
    let mut last_event = Instant::now();
    let mut ping = time::interval_at(
        Instant::now() + Duration::from_secs(20),
        Duration::from_secs(20),
    );
    loop {
        tokio::select! {
            _=events.closed()=>return Ok(()),
            _=time::sleep_until(deadline),if !ready=>return Err(SafeError::new("Не подтверждена готовность распознавания речи")),
            command=commands.recv()=>{
                let Some(value)=command else {return Ok(());};
                send_socket(&mut socket,Message::Text(value.to_string().into())).await?;
            }
            message=socket.next()=>{
                last_event=Instant::now();
                match message {
                    Some(Ok(Message::Text(raw)))=>{
                        let Ok(value)=serde_json::from_str::<Value>(&raw) else {continue;};
                        if !value.is_object(){continue;}
                        if value["type"]=="session.updated" {ready=true;}
                        if value["type"]=="error" && !ready {
                            return Err(SafeError::new("Провайдер отклонил настройки прослушивания"));
                        }
                        time::timeout(Duration::from_secs(3),events.send(VoiceOutput::Event(source,value))).await
                            .map_err(|_|SafeError::new("Очередь распознавания переполнена"))?
                            .map_err(|_|SafeError::new("Сессия закрыта"))?;
                    }
                    Some(Ok(Message::Ping(data)))=>send_socket(&mut socket,Message::Pong(data)).await?,
                    Some(Ok(Message::Close(_)))|None=>return Err(SafeError::new("Голосовое соединение закрыто")),
                    Some(Err(_))=>return Err(SafeError::new("Ошибка передачи звука Realtime")),
                    _=>{}
                }
            }
            _=ping.tick()=>{
                if last_event.elapsed()>Duration::from_secs(60) {return Err(SafeError::new("Realtime перестал отвечать"));}
                send_socket(&mut socket,Message::Ping(vec![].into())).await?;
            }
        }
    }
}
struct Pending {
    evaluation: Evaluation,
    deadline: Instant,
    response_id: Option<String>,
}
#[derive(Default)]
struct Capture {
    speakers: SpeakerTracker,
    active: [bool; 2],
    ready: [bool; 2],
    armed: [bool; 2],
    speaking: [bool; 2],
    speech_item: [Option<String>; 2],
    items: [HashMap<String, Option<Instant>>; 2],
    clears: [VecDeque<String>; 2],
    sequence: u64,
}
impl Capture {
    fn reset(&mut self) {
        self.speakers.stop();
        self.armed = [false; 2];
        self.speaking = [false; 2];
        self.speech_item = [None, None];
        for items in &mut self.items {
            items.clear();
        }
        // Outstanding clear acknowledgements belong to this socket, including
        // those queued by pause before a new listening generation starts.
    }
    fn event_id(&mut self, source: Source, kind: &str) -> String {
        self.sequence = self.sequence.wrapping_add(1);
        format!("interview-{kind}-{}-{}", source.key(), self.sequence)
    }
    fn clear(&mut self, source: Source, voice: &Voice) -> Result<(), SafeError> {
        let i = source.index();
        self.armed[i] = false;
        if self.clears[i].len() >= 64 {
            return Err(SafeError::new(
                "Слишком много неподтверждённых запросов очистки звука.",
            ));
        }
        let id = self.event_id(source, "clear");
        voice.send(json!({"type":"input_audio_buffer.clear","event_id":id}))?;
        self.clears[i].push_back(id);
        Ok(())
    }
    fn cleared(&mut self, source: Source, listening: bool) {
        let i = source.index();
        if self.clears[i].pop_front().is_some() {
            self.armed[i] = self.clears[i].is_empty() && self.active[i] && listening;
            self.speaking[i] = false;
            self.speech_item[i] = None;
            self.items[i].clear();
        }
    }
    fn accept_item(&mut self, source: Source, event: &Value) -> bool {
        let i = source.index();
        if !self.active[i] || !self.armed[i] {
            return false;
        }
        let Some(id) = event["item_id"]
            .as_str()
            .filter(|id| !id.is_empty() && id.len() <= 256)
        else {
            return false;
        };
        if self.items[i].len() >= 128 && !self.items[i].contains_key(id) {
            return false;
        }
        self.items[i].entry(id.to_owned()).or_insert(None);
        true
    }
    fn started(&mut self, source: Source, event: &Value) -> bool {
        if !self.accept_item(source, event) {
            return false;
        }
        let i = source.index();
        self.speaking[i] = true;
        self.speech_item[i] = event["item_id"].as_str().map(str::to_owned);
        self.speakers.started(source, event, self.speaking[0]);
        true
    }
    fn stopped(&mut self, source: Source, event: &Value) -> bool {
        let i = source.index();
        let Some(id) = event["item_id"].as_str() else {
            return false;
        };
        if !self.armed[i] || self.speech_item[i].as_deref() != Some(id) {
            return false;
        }
        self.speaking[i] = false;
        self.speech_item[i] = None;
        self.speakers.stopped(source, event);
        if let Some(deadline) = self.items[i].get_mut(id) {
            *deadline = Some(Instant::now() + TRANSCRIPT_TIMEOUT);
        }
        true
    }
    fn committed(&mut self, source: Source, event: &Value) {
        if self.accept_item(source, event) {
            let i = source.index();
            let id = event["item_id"].as_str().unwrap();
            if self.speech_item[i].as_deref() != Some(id)
                && let Some(deadline) = self.items[i].get_mut(id)
            {
                deadline.get_or_insert(Instant::now() + TRANSCRIPT_TIMEOUT);
            }
        }
    }
    fn take_item(&mut self, source: Source, event: &Value) -> bool {
        let i = source.index();
        event["item_id"]
            .as_str()
            .is_some_and(|id| self.items[i].remove(id).is_some())
            && self.armed[i]
    }
    fn awaiting_transcripts(&self) -> bool {
        self.items.iter().any(|items| !items.is_empty())
    }
    fn expire_transcripts(&mut self, now: Instant) -> bool {
        let mut expired = false;
        for items in &mut self.items {
            items.retain(|_, deadline| {
                let keep = deadline.is_none_or(|deadline| deadline > now);
                expired |= !keep;
                keep
            });
        }
        expired
    }
}
fn clear_voices(voices: &[Voice], capture: &mut Capture) -> Result<(), SafeError> {
    for (source, voice) in [Source::Microphone, Source::System].into_iter().zip(voices) {
        capture.clear(source, voice)?;
    }
    Ok(())
}
#[derive(Default)]
struct Decisions {
    pending: Option<Pending>,
    cancelled: VecDeque<u64>,
}
impl Decisions {
    fn cancel(&mut self, voices: &[Voice]) {
        if let Some(waiting) = self.pending.take() {
            self.cancelled.push_back(waiting.evaluation.id);
            while self.cancelled.len() > 64 {
                self.cancelled.pop_front();
            }
            if let Some(voice) = voices.get(1) {
                let mut command = json!({"type":"response.cancel","event_id":format!("interview-cancel-{}",waiting.evaluation.id)});
                if let Some(id) = waiting.response_id {
                    command["response_id"] = json!(id);
                }
                let _ = voice.send(command);
            }
        }
    }
    fn created(&mut self, value: &Value, voices: &[Voice]) {
        let id = value["response"]["metadata"]["gate_id"]
            .as_str()
            .and_then(|id| id.parse::<u64>().ok());
        let response = value["response"]["id"].as_str();
        if let Some(waiting) = &mut self.pending
            && id == Some(waiting.evaluation.id)
        {
            waiting.response_id = response.map(str::to_owned);
            return;
        }
        // A no-id cancel may race response allocation. Cancel its eventual id
        // without touching a newer decision on the same meeting connection.
        if let Some(id) = id.filter(|id| self.cancelled.contains(id))
            && let (Some(voice), Some(response)) = (voices.get(1), response)
        {
            let _ = voice.send(json!({"type":"response.cancel","response_id":response,
                "event_id":format!("interview-cancel-late-{id}")}));
        }
    }
}
async fn pause(
    events: &mpsc::Sender<Value>,
    policy: &mut Interview,
    capture: &mut Capture,
    voices: &[Voice],
    decisions: &mut Decisions,
    _agent: &agent::Handle,
    _hints: &mut HashSet<String>,
) -> Result<(), SafeError> {
    policy.stop();
    capture.reset();
    decisions.cancel(voices);
    let _ = clear_voices(voices, capture);
    state(events, "idle", "Прослушивание остановлено").await
}
fn route_audio(
    source: Source,
    bytes: Vec<u8>,
    capture: &mut Capture,
    voices: &[Voice],
    listening: bool,
) -> Result<bool, SafeError> {
    if bytes.is_empty() || bytes.len() > bridge::MAX_AUDIO_BYTES || !bytes.len().is_multiple_of(2) {
        return Err(SafeError::new("Некорректный PCM16 аудиофрагмент"));
    }
    let i = source.index();
    if listening
        && capture.active[i]
        && capture.ready[i]
        && capture.armed[i]
        && let Some(voice) = voices.get(i)
    {
        let id = capture.event_id(source, "audio");
        voice.send(json!({"type":"input_audio_buffer.append","event_id":id,"audio":STANDARD.encode(&bytes)}))?;
        if source == Source::System {
            capture.speakers.push(&bytes);
        }
        return Ok(true);
    }
    Ok(false)
}
pub async fn run(
    config: SessionConfig,
    input: mpsc::Receiver<SessionInput>,
    events: mpsc::Sender<Value>,
    control: BroadcastControl,
) -> Result<(), SafeError> {
    let options = codex::SpawnOptions::new(config.workspace.clone());
    let custom_instructions = config.custom_instructions().map(str::to_owned);
    run_inner(
        config,
        input,
        events,
        options,
        move |source, model, events| {
            Voice::start(source, model, custom_instructions.clone(), events)
        },
        Some(speakers::default_asset_dir()),
        control,
    )
    .await
}

fn register_voice(control: &BroadcastControl, id: &str, mut voice: Voice) -> Voice {
    voice.lifecycle = Some((control.clone(), id.to_owned()));
    control.register(id, voice.task.abort_handle());
    voice
}
async fn close_voices(voices: &mut Vec<Voice>) {
    for voice in voices.iter() {
        voice.task.abort();
    }
    for mut voice in std::mem::take(voices) {
        let _ = (&mut voice.task).await;
    }
}
#[allow(clippy::too_many_arguments)]
async fn finish_broadcast(
    broadcast: &mut Broadcast,
    policy: &mut Interview,
    capture: &mut Capture,
    voices: &mut Vec<Voice>,
    decisions: &mut Decisions,
    events: &mpsc::Sender<Value>,
    reason: EndReason,
    farewell: Option<String>,
) -> Result<(), SafeError> {
    policy.stop();
    capture.reset();
    capture.ready = [false; 2];
    capture.active = [false; 2];
    decisions.cancel(voices);
    close_voices(voices).await;
    state(events, "idle", "Эфир завершён").await?;
    for event in broadcast.finish(reason, farewell) {
        emit(events, event).await?;
    }
    Ok(())
}
fn busy(
    capture: &Capture,
    decisions: &Decisions,
    hints: &HashSet<String>,
    jobs: &HashMap<String, bool>,
) -> bool {
    !hints.is_empty()
        || !jobs.is_empty()
        || decisions.pending.is_some()
        || capture.speaking.iter().any(|value| *value)
        || capture.awaiting_transcripts()
}

async fn run_inner<F>(
    config: SessionConfig,
    mut input: mpsc::Receiver<SessionInput>,
    events: mpsc::Sender<Value>,
    options: codex::SpawnOptions,
    voice_factory: F,
    speaker_assets: Option<PathBuf>,
    control: BroadcastControl,
) -> Result<(), SafeError>
where
    F: Fn(Source, String, mpsc::Sender<VoiceOutput>) -> Voice + Send + Sync,
{
    let (agent_tx, mut agent_rx) = mpsc::channel(128);
    let agent = agent::Handle::spawn(config.agent(), options, agent_tx);
    let (voice_tx, mut voice_rx) = mpsc::channel(128);
    let mut voices: Vec<Voice> = Vec::new();
    let mut policy = Interview::configured(
        config.requires_explicit_help(),
        config.custom_instructions().map(str::to_owned),
    );
    let mut broadcast = Broadcast::new(
        config.silence_timeout_secs,
        config.agent_auto_end,
        config.custom_instructions().map(str::to_owned),
    );
    let mut capture = Capture::default();
    let mut decisions = Decisions::default();
    let mut hints = HashSet::new();
    let mut jobs = HashMap::new();
    let mut agent_open = true;
    let mut agent_ready = false;
    let mut sequence = 0u64;
    let mut quiet_since = Instant::now();
    let mut tick = time::interval(Duration::from_millis(150));
    let result=async {
        emit(&events,json!({"type":"status","stage":"connecting","detail":"Подключение Codex","realtime":false})).await?;
        state(&events,"idle","Прослушивание выключено").await?;
        loop {
            tokio::select! {
                _=events.closed()=>return Ok(()),
                command=input.recv()=>{
                    let Some(command)=command else {return Ok(());};
                    let source=if matches!(&command,SessionInput::SystemAudio{..}){Source::System}else{Source::Microphone};
                    match command {
                        SessionInput::Audio{broadcast_id,data}|SessionInput::SystemAudio{broadcast_id,data}=>{
                            if !broadcast.accepts_audio(&broadcast_id) {continue;}
                            if let Err(error)=route_audio(source,data,&mut capture,&voices,policy.is_listening()) {
                                finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::Error,Some(error.to_string())).await?;
                            }
                        }
                        SessionInput::Message(value)=>{
                            if !value.is_object() || serde_json::to_vec(&value).map(|bytes|bytes.len()).unwrap_or(usize::MAX)>bridge::MAX_LOCAL_MESSAGE {
                                emit(&events,bridge::error("Некорректная команда эфира")).await?;continue;
                            }
                            let kind=value["type"].as_str().unwrap_or("");
                            if matches!(kind,"mic_start"|"mic_stop"|"system_start"|"system_stop"|"interview_start"|"interview_stop") {
                                let id=match broadcast::identifier(&value) {Ok(id)=>id,Err(error)=>{emit(&events,bridge::error(&error.to_string())).await?;continue;}};
                                if !broadcast.accepts_audio(&id) {continue;}
                            }
                            match kind {
                                "interview_start"=>{
                                    if !capture.ready.iter().all(|value|*value) || !capture.active[Source::System.index()] {
                                        emit(&events,bridge::error("Для двухканального режима нужен готовый звук встречи")).await?;
                                    } else if !policy.is_listening() {
                                        policy.start();capture.reset();decisions.cancel(&voices);clear_voices(&voices,&mut capture)?;
                                        match capture.speakers.start(speaker_assets.as_deref()) {
                                            Ok(true)=>emit(&events,json!({"type":"speaker_state","status":"loading","detail":"Загружаю локальную модель группировки голосов"})).await?,
                                            Ok(false)=>{},
                                            Err(detail)=>emit(&events,json!({"type":"speaker_state","status":"unavailable","detail":detail})).await?,
                                        }
                                        quiet_since=Instant::now();broadcast.activity(quiet_since);
                                        state(&events,"listening","Слушаю участников встречи и включённый микрофон").await?;
                                    }
                                }
                                "interview_stop"=>{
                                    pause(&events,&mut policy,&mut capture,&voices,&mut decisions,&agent,&mut hints).await?;
                                    broadcast.activity(Instant::now());
                                }
                                "mic_start"|"system_start"=>{
                                    let source=if kind=="mic_start"{Source::Microphone}else{Source::System};
                                    capture.active[source.index()]=true;
                                    if policy.is_listening() {
                                        capture.clear(source,&voices[source.index()])?;
                                    }
                                    broadcast.activity(Instant::now());
                                }
                                "mic_stop"=>{
                                    // Mute affects only the local source. The meeting context, loopback,
                                    // semantic decisions and Codex tasks stay alive.
                                    capture.active[0]=false;
                                    capture.speaking[0]=false;
                                    if let Some(id)=capture.speech_item[0].as_ref()
                                        && let Some(deadline)=capture.items[0].get_mut(id) {
                                        *deadline=Some(Instant::now()+TRANSCRIPT_TIMEOUT);
                                    }
                                    if policy.is_listening() && let Some(voice)=voices.first() {
                                        for _ in 0..10 {
                                            let event_id=capture.event_id(Source::Microphone,"audio");
                                            voice.send(json!({"type":"input_audio_buffer.append","event_id":event_id,"audio":STANDARD.encode([0u8;4800])}))?;
                                        }
                                    }
                                    broadcast.activity(Instant::now());
                                }
                                "system_stop"=>{
                                    capture.active[1]=false;capture.armed[1]=false;
                                    if policy.is_listening() {pause(&events,&mut policy,&mut capture,&voices,&mut decisions,&agent,&mut hints).await?;}
                                    broadcast.activity(Instant::now());
                                }
                                _=>match session::parse_message(value,&mut sequence) {
                                    Ok(Parsed::Disconnect)=>return Ok(()),
                                    Ok(Parsed::BroadcastStart(id))=>{
                                        match broadcast.start(id.clone()) {
                                            Ok(Some(event))=>{
                                                emit(&events,event).await?;
                                                if !control.begin(&id) {
                                                    finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::User,None).await?;
                                                } else if !config.realtime {
                                                    finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::Error,Some("Голосовой режим выключен в настройках.".into())).await?;
                                                } else if agent_ready {
                                                    voices.push(register_voice(&control,broadcast.id().unwrap(),voice_factory(Source::Microphone,config.realtime_model.clone(),voice_tx.clone())));
                                                    voices.push(register_voice(&control,broadcast.id().unwrap(),voice_factory(Source::System,config.realtime_model.clone(),voice_tx.clone())));
                                                }
                                            }
                                            Ok(None)=>{},
                                            Err(error)=>emit(&events,bridge::error(&error.to_string())).await?,
                                        }
                                    }
                                    Ok(Parsed::BroadcastStop(id))=>{
                                        if broadcast.accepts(&id) {
                                            control.stop(&id);
                                            finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::User,None).await?;
                                        }
                                    }
                                    Ok(Parsed::Agent(command))=>{
                                        let id=match &command {
                                            agent::Command::Run{id,..}|agent::Command::Hint{id,..}=>Some(id.clone()),
                                            _=>None,
                                        };
                                        if broadcast.ended() && id.is_some() {
                                            emit(&events,bridge::error("Эфир завершён. Дождись текущих задач и подключись заново.")).await?;continue;
                                        }
                                        if agent.commands.try_send(command).is_err() {
                                            emit(&events,bridge::error("Codex недоступен")).await?;
                                        } else if let Some(id)=id {
                                            jobs.insert(id,true);broadcast.activity(Instant::now());
                                        }
                                    }
                                    Ok(Parsed::Voice(bridge::Input::Text(Some(text))))=>{
                                        if broadcast.ended() {
                                            emit(&events,bridge::error("Эфир завершён. Подключись заново для новой задачи.")).await?;continue;
                                        }
                                        sequence=sequence.wrapping_add(1);
                                        let id=format!("interview-manual-{sequence}");
                                        let command=agent::Command::Run{id:id.clone(),task:text.clone()};
                                        if agent.commands.try_send(command).is_err() {emit(&events,bridge::error("Codex недоступен")).await?;}
                                        else {jobs.insert(id,true);broadcast.transcript("user",&text,Instant::now());}
                                    }
                                    Ok(_)=>{},
                                    Err(error)=>emit(&events,bridge::error(&error.to_string())).await?,
                                }
                            }
                        }
                    }
                }
                output=agent_rx.recv(),if agent_open=>{
                    match output {
                        Some(agent::Output::Ui(value))=>{
                            let ready=!agent_ready && value["type"]=="agent_state" && value["stage"]=="ready";
                            if value["type"]=="agent_task_started" && let Some(id)=value["task_id"].as_str() {
                                jobs.insert(id.to_owned(),true);broadcast.activity(Instant::now());
                            }
                            emit(&events,value).await?;
                            if ready {
                                agent_ready=true;
                                emit(&events,json!({"type":"status","stage":"ready","detail":"Codex готов · эфир выключен","realtime":false})).await?;
                                if broadcast.is_starting() && config.realtime && voices.is_empty() {
                                    voices.push(register_voice(&control,broadcast.id().unwrap(),voice_factory(Source::Microphone,config.realtime_model.clone(),voice_tx.clone())));
                                    voices.push(register_voice(&control,broadcast.id().unwrap(),voice_factory(Source::System,config.realtime_model.clone(),voice_tx.clone())));
                                }
                            }
                        }
                        Some(agent::Output::Completed{id,text,status})=>{
                            jobs.remove(&id);hints.remove(&id);
                            if status=="completed" {broadcast.transcript("assistant",&text,Instant::now());}
                            else {broadcast.activity(Instant::now());}
                            if policy.is_listening() && hints.is_empty() {
                                state(&events,"listening","Подсказка готова · продолжаю слушать").await?;
                            }
                        }
                        None=>{
                            agent_open=false;jobs.clear();hints.clear();
                            if broadcast.is_live() || broadcast.is_starting() {
                                finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::Error,Some("Codex отключён. Эфир остановлен.".into())).await?;
                            }
                        }
                    }
                }
                output=capture.speakers.recv(),if capture.speakers.receiving() && policy.is_listening()=>{
                    match output {
                        Some(SpeakerEvent::Status{available,detail})=>{
                            emit(&events,json!({"type":"speaker_state","status":if available{"ready"}else{"unavailable"},"detail":detail})).await?;
                        }
                        Some(SpeakerEvent::Segment(segment))=>{
                            if let Some(attribution)=capture.speakers.segment(segment)
                                && policy.assign_speaker(attribution.utterance_id,attribution.speaker.clone()) {
                                emit(&events,json!({"type":"speaker_attribution","source":"system",
                                    "utterance_id":attribution.utterance_id,"speaker":attribution.speaker,
                                    "speaker_label":speaker_label(attribution.speaker.as_deref())})).await?;
                            }
                        }
                        None=>{},
                    }
                }
                output=voice_rx.recv(),if !voices.is_empty()=>{
                    let Some(output)=output else {return Err(SafeError::new("Распознавание речи остановлено"));};
                    if broadcast.id().is_some_and(|id|control.is_stopped(id)) {
                        finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::User,None).await?;
                        if jobs.is_empty() {return Ok(());}
                        continue;
                    }
                    match output {
                        VoiceOutput::Failed(source,message)=>{
                            emit(&events,json!({"type":"status","stage":"voice_error","realtime":false,"detail":format!("{}: {}",source.label(),message)})).await?;
                            finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::Error,None).await?;
                        }
                        VoiceOutput::Event(source,value)=>{
                            if source==Source::System && broadcast.provider_event(&value,Instant::now(),busy(&capture,&decisions,&hints,&jobs)) {continue;}
                            let i=source.index();
                            match value["type"].as_str().unwrap_or("") {
                                "session.updated"=>{
                                    capture.ready[i]=true;
                                    if capture.ready.iter().all(|value|*value) {
                                        emit(&events,json!({"type":"status","stage":"ready","detail":"Эфир · два источника готовы","realtime":true})).await?;
                                        if let Some(event)=broadcast.live(Instant::now()) {emit(&events,event).await?;}
                                    }
                                }
                                "input_audio_buffer.cleared"=>capture.cleared(source,policy.is_listening()),
                                "input_audio_buffer.speech_started"=>{
                                    if capture.started(source,&value) {
                                        broadcast.activity(Instant::now());
                                        if source==Source::Microphone {emit(&events,json!({"type":"mic_state","stage":"speech","detail":"Слушаю вашу речь"})).await?;}
                                    }
                                }
                                "input_audio_buffer.speech_stopped"=>{
                                    if capture.stopped(source,&value) {quiet_since=Instant::now();broadcast.activity(quiet_since);}
                                }
                                "input_audio_buffer.committed"=>capture.committed(source,&value),
                                "conversation.item.input_audio_transcription.completed"=>{
                                    let accepted=capture.take_item(source,&value);
                                    if let Some(id)=value["item_id"].as_str() {
                                        let event_id=capture.event_id(source,"delete");
                                        voices[i].send(json!({"type":"conversation.item.delete","item_id":id,"event_id":event_id}))?;
                                    }
                                    if accepted && let Some(text)=value["transcript"].as_str() {
                                        broadcast.transcript(source.key(),text,Instant::now());
                                        if let Some(turn)=policy.observe(source,text,None) {
                                            quiet_since=Instant::now();
                                            let item_id=value["item_id"].as_str().unwrap_or("");
                                            let speaker=if source==Source::System {capture.speakers.transcribed(item_id,turn.id)} else {None};
                                            if source==Source::System {policy.assign_speaker(turn.id,speaker.clone());}
                                            let label=if source==Source::System {speaker_label(speaker.as_deref())}else{source.label().to_owned()};
                                            emit(&events,json!({"type":"transcript","text":turn.text,"source":source.key(),
                                                "item_id":item_id,"speaker":speaker,"speaker_label":label,"utterance_id":turn.id})).await?;
                                        }
                                    }
                                }
                                "conversation.item.input_audio_transcription.failed"=>{
                                    if capture.take_item(source,&value) {policy.clear_pending();decisions.cancel(&voices);}
                                    if policy.is_listening() {state(&events,"listening","Фраза не распознана · продолжаю слушать").await?;}
                                }
                                "response.created"=>{if source==Source::System {decisions.created(&value,&voices);}}
                                "response.done"=>{
                                    if source==Source::System && decisions.pending.as_ref().is_some_and(|waiting|value["response"]["metadata"]["gate_id"].as_str()==Some(waiting.evaluation.id.to_string().as_str())) {
                                        let waiting=decisions.pending.take().unwrap();
                                        if capture.speaking.iter().any(|speaking|*speaking) || capture.awaiting_transcripts() {continue;}
                                        match policy.complete(&waiting.evaluation,&value) {
                                            Ok(Some(task))=>{
                                                let id=format!("interview-hint-{}",waiting.evaluation.id);
                                                if agent.commands.try_send(agent::Command::Hint{id:id.clone(),task}).is_ok() {
                                                    hints.insert(id.clone());jobs.insert(id,true);broadcast.activity(Instant::now());
                                                    state(&events,"helping","Готовлю подсказку по вопросу встречи").await?;
                                                } else {state(&events,"listening","Codex занят · продолжаю слушать").await?;}
                                            }
                                            Ok(None)=>{if policy.is_listening(){state(&events,"listening","Слушаю · подсказка пока не нужна").await?;}}
                                            Err(message)=>{if policy.is_listening(){state(&events,"listening",&format!("{message} · продолжаю слушать")).await?;}}
                                        }
                                    }
                                }
                                "error"=>{
                                    let event_id=value["error"]["event_id"].as_str().unwrap_or("");
                                    let current=source==Source::System && decisions.pending.as_ref().is_some_and(|waiting|
                                        waiting.evaluation.request["event_id"].as_str()==Some(event_id));
                                    if current {
                                        if let Some(waiting)=&decisions.pending {policy.abandon(&waiting.evaluation);}
                                        decisions.cancel(&voices);
                                        if policy.is_listening() {state(&events,"listening","Не удалось оценить фразу · продолжаю слушать").await?;}
                                    } else if event_id.starts_with("interview-delete-") || event_id.starts_with("interview-cancel-") || event_id.starts_with("interview-gate-") {
                                        // Late/cosmetic requests cannot affect another decision.
                                    } else {
                                        finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::Error,Some("Realtime отклонил передачу звука. Эфир остановлен.".into())).await?;
                                    }
                                }
                                _=>{}
                            }
                        }
                    }
                }
                _=tick.tick()=>{
                    if capture.expire_transcripts(Instant::now()) {
                        policy.clear_pending();decisions.cancel(&voices);
                        if policy.is_listening() {state(&events,"listening","Фраза не распознана вовремя · продолжаю слушать").await?;}
                    }
                    if decisions.pending.as_ref().is_some_and(|waiting|waiting.deadline<=Instant::now()) {
                        if let Some(waiting)=&decisions.pending {policy.abandon(&waiting.evaluation);}
                        decisions.cancel(&voices);
                        if policy.is_listening(){state(&events,"listening","Решение задержалось · продолжаю слушать").await?;}
                    }
                    if policy.is_listening() && decisions.pending.is_none() && hints.is_empty() && jobs.is_empty()
                        && !capture.speaking.iter().any(|value|*value) && !capture.awaiting_transcripts()
                        && quiet_since.elapsed()>=QUIET_TIME
                        && let Some(evaluation)=policy.evaluate() {
                            voices[1].send(evaluation.request.clone())?;
                            decisions.pending=Some(Pending{evaluation,deadline:Instant::now()+DECISION_TIMEOUT,response_id:None});
                            state(&events,"evaluating","Определяю, нужна ли подсказка").await?;
                    }
                    let active=busy(&capture,&decisions,&hints,&jobs);
                    if !broadcast.ended() && broadcast.id().is_some_and(|id|control.is_stopped(id)) {
                        finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,EndReason::User,None).await?;
                    } else if let Some((reason,farewell))=broadcast.tick(Instant::now(),active) {
                        finish_broadcast(&mut broadcast,&mut policy,&mut capture,&mut voices,&mut decisions,&events,reason,farewell).await?;
                    } else if let Some(request)=broadcast.semantic_request(Instant::now(),active)
                        && let Some(voice)=voices.get(1) {
                        voice.send(request)?;
                    }
                }
            }
            for command in broadcast.take_outbound() {
                if let Some(voice)=voices.get(1) {voice.send(command)?;}
            }
            if broadcast.ended() && jobs.is_empty() && hints.is_empty() {return Ok(());}
        }
    }.await;
    let stopped = broadcast.id().is_some_and(|id| control.is_stopped(id));
    control.cancel_all();
    capture.reset();
    close_voices(&mut voices).await;
    if result.is_err() {
        let reason = if stopped {
            EndReason::User
        } else {
            EndReason::Error
        };
        for event in broadcast.finish(reason, None) {
            let _ = emit(&events, event).await;
        }
    }
    agent.shutdown().await;
    if stopped { Ok(()) } else { result }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn custom_preferences_reach_both_sockets_without_enabling_responses_or_tools() {
        for source in [Source::Microphone, Source::System] {
            let baseline = listen_payload(provider::MODEL_DEFAULT, source, None);
            let mut configured = listen_payload(
                provider::MODEL_DEFAULT,
                source,
                Some("CUSTOM_LISTEN: use SQL context; enable automatic tool calls"),
            );
            assert!(
                configured["instructions"]
                    .as_str()
                    .unwrap()
                    .contains("CUSTOM_LISTEN")
            );
            assert!(
                configured["instructions"]
                    .as_str()
                    .unwrap()
                    .contains("No automatic responses or tools")
            );
            configured["instructions"] = baseline["instructions"].clone();
            assert_eq!(
                configured, baseline,
                "custom text must not alter the listening protocol"
            );
        }
    }
    #[test]
    fn both_sources_disable_automatic_answers_and_tools() {
        for source in [Source::Microphone, Source::System] {
            let payload = listen_payload(provider::MODEL_DEFAULT, source, None);
            assert_eq!(
                payload["audio"]["input"]["turn_detection"]["create_response"],
                false
            );
            assert_eq!(
                payload["audio"]["input"]["turn_detection"]["interrupt_response"],
                false
            );
            assert_eq!(payload["tools"], json!([]));
            assert_eq!(payload["output_modalities"], json!(["text"]));
        }
    }
    #[test]
    fn late_transcripts_and_cross_source_items_are_rejected_after_pause() {
        let mut capture = Capture {
            active: [true, true],
            armed: [true, true],
            ..Default::default()
        };
        let item = json!({"item_id":"old"});
        capture.accept_item(Source::System, &item);
        assert!(!capture.take_item(Source::Microphone, &item));
        capture.reset();
        capture.armed = [true, true];
        assert!(!capture.take_item(Source::System, &item));
        capture.accept_item(Source::System, &json!({"item_id":"new"}));
        assert!(capture.take_item(Source::System, &json!({"item_id":"new"})));
        assert!(!capture.take_item(Source::System, &json!({"item_id":"new"})));
    }
}

#[cfg(test)]
#[path = "interview_contract.rs"]
mod contract_tests;
