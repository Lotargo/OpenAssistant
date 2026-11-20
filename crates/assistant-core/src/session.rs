//! Native-client session runtime; no HTTP listener, browser auth or API-key fallback.
pub use crate::broadcast::{
    default_agent_auto_end, default_silence_timeout_secs, validate_silence_timeout,
};
pub use crate::broadcast_control::BroadcastControl;
pub use crate::custom::{
    CustomBehavior, DEFAULT_CUSTOM_NAME, default_custom_name, normalize_custom_settings,
};
use crate::{
    agent,
    auth::{self, SafeError},
    bridge::{self, Action, Bridge, Input},
    broadcast::{self, Broadcast, EndReason},
    codex, custom, provider,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::{
    sync::mpsc,
    time::{self, Instant},
};
use tokio_tungstenite::tungstenite::Message as UpstreamMessage;

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scenario {
    #[default]
    Assistant,
    Interview,
    Custom,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionConfig {
    #[serde(default)]
    pub scenario: Scenario,
    #[serde(default = "default_custom_name")]
    pub custom_name: String,
    #[serde(default)]
    pub custom_instructions: String,
    #[serde(default)]
    pub custom_behavior: CustomBehavior,
    #[serde(default = "default_silence_timeout_secs")]
    pub silence_timeout_secs: u32,
    #[serde(default = "default_agent_auto_end")]
    pub agent_auto_end: bool,
    pub workspace: PathBuf,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub web_search: bool,
    pub parallel: bool,
    pub realtime: bool,
    pub realtime_model: String,
}

impl SessionConfig {
    pub fn validate(mut self) -> Result<Self, SafeError> {
        validate_silence_timeout(self.silence_timeout_secs)?;
        (self.custom_name, self.custom_instructions) =
            normalize_custom_settings(self.custom_name, self.custom_instructions)?;
        if !self.workspace.is_dir() {
            return Err(SafeError::new("Рабочая папка не существует"));
        }
        self.workspace = std::fs::canonicalize(&self.workspace)
            .map_err(|_| SafeError::new("Не удалось открыть рабочую папку"))?;
        self.model = normalized(self.model, 150, "model")?;
        self.effort = normalized(self.effort, 30, "effort")?;
        if !provider::allowed_model(&self.realtime_model) {
            return Err(SafeError::new("Неподдерживаемая модель Realtime"));
        }
        Ok(self)
    }
    pub fn uses_meeting_audio(&self) -> bool {
        self.scenario == Scenario::Interview
            || (self.scenario == Scenario::Custom
                && self.custom_behavior != CustomBehavior::Dialogue)
    }
    pub(crate) fn custom_instructions(&self) -> Option<&str> {
        (self.scenario == Scenario::Custom)
            .then_some(self.custom_instructions.as_str())
            .filter(|value| !value.is_empty())
    }
    pub(crate) fn requires_explicit_help(&self) -> bool {
        self.scenario == Scenario::Custom && self.custom_behavior == CustomBehavior::OnRequest
    }
    pub(crate) fn agent(&self) -> agent::Config {
        agent::Config {
            workspace: self.workspace.clone(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            web_search: self.web_search,
            parallel: self.parallel,
            custom_instructions: self.custom_instructions().map(str::to_owned),
        }
    }
}

fn normalized(value: Option<String>, max: usize, field: &str) -> Result<Option<String>, SafeError> {
    match value {
        Some(value) if value.chars().count() > max => {
            Err(SafeError::new(format!("Некорректный параметр {field}")))
        }
        Some(value) if !value.trim().is_empty() => Ok(Some(value.trim().to_owned())),
        _ => Ok(None),
    }
}

#[derive(Debug)]
pub enum SessionInput {
    Message(Value),
    Audio { broadcast_id: String, data: Vec<u8> },
    SystemAudio { broadcast_id: String, data: Vec<u8> },
}

pub async fn status(default_workspace: &Path) -> Value {
    let available = codex::resolve_native_executable(None).is_ok();
    let mut value = json!({"backend":"rust","provider":"codex","mode":"real",
        "workspace":default_workspace,"codex_available":available});
    match tokio::task::spawn_blocking(|| auth::load_credential(None)).await {
        Ok(Ok(credential)) => {
            value["oauth"] = json!("valid");
            value["auth_mode"] = json!("chatgpt");
            value["expires_min"] =
                json!(credential.expires_at.saturating_sub(auth::now_seconds()) / 60);
        }
        Ok(Err(error)) => {
            value["oauth"] = json!(if error.to_string().contains("expired") {
                "expired"
            } else {
                "missing"
            });
            value["message"] = json!(error.to_string());
        }
        Err(_) => {
            value["oauth"] = json!("unavailable");
            value["message"] = json!("Не удалось проверить вход Codex");
        }
    }
    value
}

#[derive(Clone)]
struct Events {
    sender: mpsc::Sender<Value>,
}
impl Events {
    async fn emit(&self, value: Value) -> Result<(), SafeError> {
        time::timeout(Duration::from_secs(10), self.sender.send(value))
            .await
            .map_err(|_| SafeError::new("Клиент не принимает события"))?
            .map_err(|_| SafeError::new("Клиент отключён"))
    }
}

pub(crate) enum Parsed {
    BroadcastStart(String),
    BroadcastStop(String),
    VoiceControl { broadcast_id: String, input: Input },
    Voice(Input),
    Agent(agent::Command),
    Disconnect,
}

fn identifier(value: &Value, name: &str) -> Result<String, SafeError> {
    value[name]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 128)
        .map(str::to_owned)
        .ok_or_else(|| SafeError::new(format!("Некорректный параметр {name}")))
}

pub(crate) fn parse_message(value: Value, sequence: &mut u64) -> Result<Parsed, SafeError> {
    if !value.is_object()
        || serde_json::to_vec(&value)
            .map(|s| s.len())
            .unwrap_or(usize::MAX)
            > bridge::MAX_LOCAL_MESSAGE
    {
        return Err(SafeError::new(
            "Некорректная команда или превышен размер сообщения",
        ));
    }
    match value["type"].as_str().unwrap_or("") {
        "disconnect" => Ok(Parsed::Disconnect),
        "broadcast_start" => Ok(Parsed::BroadcastStart(broadcast::identifier(&value)?)),
        "broadcast_stop" => Ok(Parsed::BroadcastStop(broadcast::identifier(&value)?)),
        "text" => {
            let text = value["text"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= bridge::MAX_TEXT_LENGTH)
                .ok_or_else(|| SafeError::new("Введите сообщение длиной до 4000 символов"))?;
            Ok(Parsed::Voice(Input::Text(Some(text.to_owned()))))
        }
        "mic_start" | "mic_stop" => Ok(Parsed::VoiceControl {
            broadcast_id: broadcast::identifier(&value)?,
            input: if value["type"] == "mic_start" {
                Input::MicStart
            } else {
                Input::MicStop
            },
        }),
        "agent_task" => {
            let task = value["task"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= agent::MAX_TASK_CHARS)
                .ok_or_else(|| SafeError::new("Введите задачу длиной до 16000 символов"))?;
            *sequence = sequence
                .checked_add(1)
                .ok_or_else(|| SafeError::new("Исчерпан счётчик задач"))?;
            Ok(Parsed::Agent(agent::Command::Run {
                id: format!("task-{sequence}"),
                task: task.to_owned(),
            }))
        }
        "agent_interrupt" => {
            let id = if value.get("task_id").is_none_or(Value::is_null) {
                None
            } else {
                Some(identifier(&value, "task_id")?)
            };
            Ok(Parsed::Agent(agent::Command::Interrupt { id }))
        }
        "agent_models" => Ok(Parsed::Agent(agent::Command::Models)),
        "agent_approval" => {
            let id = identifier(&value, "request_id")?;
            let decision = value["decision"]
                .as_str()
                .filter(|s| matches!(*s, "accept" | "decline" | "cancel"))
                .ok_or_else(|| SafeError::new("Некорректный ответ на запрос разрешения"))?;
            Ok(Parsed::Agent(agent::Command::Approval {
                id,
                decision: decision.to_owned(),
            }))
        }
        "agent_input" => {
            let id = identifier(&value, "request_id")?;
            if !value["answers"].is_object() {
                return Err(SafeError::new("Некорректный ответ Codex"));
            }
            Ok(Parsed::Agent(agent::Command::UserInput {
                id,
                answers: value["answers"].clone(),
            }))
        }
        _ => Err(SafeError::new("Неизвестная команда")),
    }
}

async fn send_provider(
    socket: &mut provider::ProviderSocket,
    message: UpstreamMessage,
) -> Result<(), SafeError> {
    time::timeout(Duration::from_secs(10), socket.send(message))
        .await
        .map_err(|_| SafeError::new("Realtime не принимает данные"))?
        .map_err(|_| SafeError::new("Соединение Realtime закрыто"))
}
async fn send_provider_value(
    socket: &mut provider::ProviderSocket,
    value: Value,
) -> Result<(), SafeError> {
    send_provider(socket, UpstreamMessage::Text(value.to_string().into())).await
}

/// Provider IO has its own abortable task. Native Stop can close it without
/// cancelling Codex or waiting behind a UI/output/backpressure await.
struct VoiceTransport {
    commands: mpsc::Sender<UpstreamMessage>,
    events: mpsc::Receiver<Result<UpstreamMessage, SafeError>>,
    task: tokio::task::JoinHandle<()>,
}
impl Drop for VoiceTransport {
    fn drop(&mut self) {
        self.task.abort();
    }
}
impl VoiceTransport {
    fn new(mut socket: provider::ProviderSocket, control: &BroadcastControl, id: &str) -> Self {
        let (commands, mut input) = mpsc::channel(64);
        let (output, events) = mpsc::channel(128);
        let task = tokio::spawn(async move {
            let result=async {
                loop {
                    tokio::select! {
                        command=input.recv()=>{
                            let Some(command)=command else{return Ok::<(),SafeError>(());};
                            send_provider(&mut socket,command).await?;
                        }
                        event=socket.next()=>{
                            let event=match event {
                                Some(Ok(event))=>event,
                                Some(Err(_))=>return Err(SafeError::new("Ошибка транспорта Realtime")),
                                None=>UpstreamMessage::Close(None),
                            };
                            let closed=matches!(event,UpstreamMessage::Close(_));
                            time::timeout(Duration::from_secs(3),output.send(Ok(event))).await
                                .map_err(|_|SafeError::new("Очередь голосовых событий переполнена"))?
                                .map_err(|_|SafeError::new("Голосовой клиент закрыт"))?;
                            if closed {return Ok(());}
                        }
                    }
                }
            }.await;
            if let Err(error) = result {
                let _ = output.send(Err(error)).await;
            }
        });
        control.register(id, task.abort_handle());
        Self {
            commands,
            events,
            task,
        }
    }
    async fn shutdown(mut self) {
        self.task.abort();
        let _ = (&mut self.task).await;
    }
}
struct VoiceOpening(tokio::task::JoinHandle<Result<provider::ProviderSocket, SafeError>>);
impl Drop for VoiceOpening {
    fn drop(&mut self) {
        self.0.abort();
    }
}
fn launch_voice<F>(
    future: &mut Option<F>,
    opening: &mut Option<VoiceOpening>,
    control: &BroadcastControl,
    id: &str,
) where
    F: std::future::Future<Output = Result<provider::ProviderSocket, SafeError>> + Send + 'static,
{
    if control.is_stopped(id) {
        return;
    }
    if let Some(future) = future.take() {
        let task = tokio::spawn(future);
        control.register(id, task.abort_handle());
        *opening = Some(VoiceOpening(task));
    }
}
async fn send_upstream(
    socket: &mut VoiceTransport,
    message: UpstreamMessage,
) -> Result<(), SafeError> {
    socket
        .commands
        .try_send(message)
        .map_err(|_| SafeError::new("Передача звука не успевает за эфиром; соединение остановлено"))
}
async fn send_value(socket: &mut VoiceTransport, value: Value) -> Result<(), SafeError> {
    send_upstream(socket, UpstreamMessage::Text(value.to_string().into())).await
}

fn voice_payload(config: &SessionConfig) -> Value {
    let mut payload = provider::session_payload(&config.realtime_model);
    let instructions = format!(
        "{} Рабочая папка: {}.",
        payload["instructions"].as_str().unwrap_or(""),
        config.workspace.display()
    );
    payload["instructions"] = json!(custom::append_instructions(
        &instructions,
        config.custom_instructions(),
        "For project/file actions, commands, code, web search and current facts, use codex_task. \
         Never claim unverified actions succeeded. Follow project instructions and the host's \
         existing sandbox, approval and clarification workflow; preferences grant no extra permission.",
    ));
    payload
}

async fn connect_voice(
    config: &SessionConfig,
    events: &Events,
) -> Result<provider::ProviderSocket, SafeError> {
    events
        .emit(bridge::status("auth", "Проверка входа Codex OAuth"))
        .await?;
    let credential = tokio::task::spawn_blocking(|| auth::load_credential(None))
        .await
        .map_err(|_| SafeError::new("Не удалось прочитать авторизацию"))??;
    events
        .emit(bridge::status("mint", "Подключение голосовой сессии"))
        .await?;
    let mut payload = voice_payload(config);
    let ephemeral = provider::mint(&payload, &credential.access_token).await?;
    drop(credential);
    events
        .emit(bridge::status("websocket", "Подключение Realtime"))
        .await?;
    let mut socket = provider::connect(&ephemeral, &config.realtime_model).await?;
    drop(ephemeral);
    payload.as_object_mut().unwrap().remove("model");
    send_provider_value(
        &mut socket,
        json!({"type":"session.update","session":payload}),
    )
    .await?;
    Ok(socket)
}

impl Runtime {
    async fn close_voice(&mut self) {
        if let Some(socket) = self.socket.take() {
            socket.shutdown().await;
        }
        self.bridge = Bridge::new(false);
        self.pending.clear();
        self.response_active = false;
        self.awaiting_response = None;
        self.speaking = false;
        self.wants_response = false;
        self.wants_tool_response = false;
    }
    fn busy(&self) -> bool {
        !self.jobs.is_empty()
            || !self.pending.is_empty()
            || self.response_active
            || self.awaiting_response.is_some()
            || self.speaking
            || self.wants_response
            || self.wants_tool_response
    }
}

pub async fn run(
    config: SessionConfig,
    input: mpsc::Receiver<SessionInput>,
    events: mpsc::Sender<Value>,
) -> Result<(), SafeError> {
    run_with_control(config, input, events, BroadcastControl::default()).await
}
pub async fn run_with_control(
    config: SessionConfig,
    input: mpsc::Receiver<SessionInput>,
    events: mpsc::Sender<Value>,
    control: BroadcastControl,
) -> Result<(), SafeError> {
    let config = config.validate()?;
    if config.uses_meeting_audio() {
        return crate::interview_session::run(config, input, events, control).await;
    }
    let options = codex::SpawnOptions::new(config.workspace.clone());
    let events = Events { sender: events };
    let voice_config = config.clone();
    let voice_events = events.clone();
    let voice = async move { connect_voice(&voice_config, &voice_events).await };
    run_inner(&config, options, input, events.clone(), voice, control).await
}

async fn finish_broadcast(
    runtime: &mut Runtime,
    broadcast: &mut Broadcast,
    events: &Events,
    reason: EndReason,
    farewell: Option<String>,
) -> Result<(), SafeError> {
    runtime.close_voice().await;
    for event in broadcast.finish(reason, farewell) {
        events.emit(event).await?;
    }
    Ok(())
}

async fn run_inner<F>(
    config: &SessionConfig,
    options: codex::SpawnOptions,
    mut input: mpsc::Receiver<SessionInput>,
    events: Events,
    voice: F,
    control: BroadcastControl,
) -> Result<(), SafeError>
where
    F: std::future::Future<Output = Result<provider::ProviderSocket, SafeError>> + Send + 'static,
{
    let (agent_tx, mut agent_rx) = mpsc::channel(128);
    let handle = agent::Handle::spawn(config.agent(), options, agent_tx);
    let mut runtime = Runtime {
        bridge: Bridge::new(false),
        socket: None,
        agent: Some(handle),
        pending: HashMap::new(),
        jobs: std::collections::HashSet::new(),
        response_active: false,
        awaiting_response: None,
        response_sequence: 0,
        speaking: false,
        wants_response: false,
        wants_tool_response: false,
    };
    let mut broadcast = Broadcast::new(
        config.silence_timeout_secs,
        config.agent_auto_end,
        config.custom_instructions().map(str::to_owned),
    );
    // Constructing a future performs no auth/network work. It is polled only after
    // an explicit broadcast_start, and dropped permanently on terminal stop.
    let mut voice = Some(voice);
    let mut opening: Option<VoiceOpening> = None;
    let result = async {
        events.emit(bridge::event("status",json!({"stage":"connecting","detail":"Подключение Codex","realtime":false}))).await?;
        let mut agent_ready = false;
        let mut agent_open = true;
        let mut ready_deadline = Instant::now() + Duration::from_secs(90);
        let mut sequence = 0;
        let mut heartbeat = time::interval_at(Instant::now()+Duration::from_secs(20), Duration::from_secs(20));
        let mut watchdog = time::interval(Duration::from_millis(200));
        let mut last_provider = Instant::now();
        loop {
            let upstream_available = runtime.socket.is_some();
            let response_deadline = runtime.awaiting_response.as_ref().map(|pending|pending.deadline);
            tokio::select! {
                _=events.sender.closed()=>return Ok(()),
                _=time::sleep_until(response_deadline.unwrap_or_else(||Instant::now()+RESPONSE_START_TIMEOUT)),if response_deadline.is_some()=>{
                    if runtime.expire_response_start(Instant::now()) {
                        events.emit(bridge::error("Realtime не подтвердил начало ответа; повтори сообщение")).await?;
                    }
                }
                result=async {(&mut opening.as_mut().unwrap().0).await},if opening.is_some()=>{
                    opening=None;
                    match result {
                        Ok(Ok(socket)) if !broadcast.ended()=>{
                            let id=broadcast.id().unwrap();
                            if control.is_stopped(id) {
                                drop(socket);
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::User,None).await?;
                            } else {
                                runtime.socket=Some(VoiceTransport::new(socket,&control,id));
                                ready_deadline=Instant::now()+Duration::from_secs(22);
                                last_provider=Instant::now();
                            }
                        }
                        Ok(Ok(_))=>{},
                        failed=>{
                            let stopped=broadcast.id().is_some_and(|id|control.is_stopped(id));
                            let reason=if stopped {EndReason::User}else{EndReason::Error};
                            if !stopped {
                                let detail=match failed {Ok(Err(error))=>error.to_string(),_=>"Voice connection task stopped".into()};
                                events.emit(bridge::event("status",json!({"stage":"voice_error","detail":detail,"realtime":false,"agent_available":runtime.agent.is_some()}))).await?;
                            }
                            finish_broadcast(&mut runtime,&mut broadcast,&events,reason,None).await?;
                        }
                    }
                }
                _=time::sleep_until(ready_deadline),if runtime.socket.is_some() && !runtime.bridge.is_ready()=>{
                    finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some("Realtime не подтвердил готовность. Эфир остановлен.".into())).await?;
                }
                command=input.recv()=>{
                    let Some(command)=command else {return Ok(());};
                    let parsed=match command {
                        SessionInput::Message(value)=>parse_message(value,&mut sequence),
                        SessionInput::SystemAudio{..}=>Err(SafeError::new("Звук встречи доступен только в двухканальном режиме")),
                        SessionInput::Audio{broadcast_id,data}=>{
                            if !broadcast.accepts_audio(&broadcast_id) {continue;}
                            if data.is_empty() || data.len()>bridge::MAX_AUDIO_BYTES || !data.len().is_multiple_of(2) {
                                Err(SafeError::new("Некорректный размер PCM16 аудиофрагмента"))
                            } else {Ok(Parsed::Voice(Input::Audio(data)))}
                        }
                    };
                    match parsed {
                        Err(error)=>events.emit(bridge::error(&error.to_string())).await?,
                        Ok(Parsed::Disconnect)=>return Ok(()),
                        Ok(Parsed::BroadcastStart(id))=>{
                            match broadcast.start(id.clone()) {
                                Ok(Some(event))=>{
                                    events.emit(event).await?;
                                    if !control.begin(&id) {
                                        voice=None;
                                        finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::User,None).await?;
                                    } else if !config.realtime {
                                        voice=None;
                                        finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some("Голосовой режим выключен в настройках.".into())).await?;
                                    } else if agent_ready {
                                        launch_voice(&mut voice,&mut opening,&control,&id);
                                        ready_deadline=Instant::now()+Duration::from_secs(90);
                                    }
                                }
                                Ok(None)=>{},
                                Err(error)=>events.emit(bridge::error(&error.to_string())).await?,
                            }
                        }
                        Ok(Parsed::BroadcastStop(id))=>{
                            if broadcast.accepts(&id) {
                                control.stop(&id);
                                opening=None;
                                voice=None;
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::User,None).await?;
                            }
                        }
                        Ok(Parsed::Agent(command))=>{
                            let task_id=match &command {
                                agent::Command::Run{id,..}|agent::Command::Hint{id,..}=>Some(id.clone()),
                                _=>None,
                            };
                            if broadcast.ended() && task_id.is_some() {
                                events.emit(bridge::error("Эфир завершён. Дождись текущих задач и подключись заново для новой задачи.")).await?;
                                continue;
                            }
                            if runtime.agent.as_ref().is_none_or(|h|h.commands.try_send(command).is_err()) {
                                events.emit(bridge::event("agent_error",json!({"message":"Codex недоступен; переподключись"}))).await?;
                            } else if let Some(id)=task_id {
                                runtime.jobs.insert(id);
                                broadcast.activity(Instant::now());
                            }
                        }
                        Ok(Parsed::VoiceControl{broadcast_id,input})=>{
                            if !broadcast.accepts_audio(&broadcast_id) {continue;}
                            if matches!(&input,Input::MicStart|Input::MicStop) {
                                broadcast.activity(Instant::now());
                            }
                            if matches!(&input,Input::MicStop) {runtime.speaking=false;}
                            let actions=runtime.bridge.input(input);
                            if let Err(error)=runtime.apply(actions,&events).await {
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
                            }
                        }
                        Ok(Parsed::Voice(Input::Text(Some(text)))) if !broadcast.is_live()=>{
                            if broadcast.ended() {
                                events.emit(bridge::error("Эфир завершён. Подключись заново для новой задачи.")).await?;
                                continue;
                            }
                            sequence=sequence.wrapping_add(1);
                            let id=format!("text-{sequence}");
                            let command=agent::Command::Run{id:id.clone(),task:text};
                            if runtime.agent.as_ref().is_some_and(|h|h.commands.try_send(command).is_ok()) {
                                runtime.jobs.insert(id);
                            } else {events.emit(bridge::error("Codex недоступен")).await?;}
                        }
                        Ok(Parsed::Voice(command))=>{
                            if !broadcast.is_live() || !runtime.bridge.is_ready() {continue;}
                            if let Input::Text(Some(text))=&command {
                                broadcast.transcript("user",text,Instant::now());
                            }
                            let actions=runtime.bridge.input(command);
                            if let Err(error)=runtime.apply(actions,&events).await {
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
                            }
                        }
                    }
                }
                output=agent_rx.recv(),if agent_open=>{
                    match output {
                        Some(agent::Output::Ui(value))=>{
                            let ready=!agent_ready && value["type"]=="agent_state" && value["stage"]=="ready";
                            if value["type"]=="agent_task_started" && let Some(id)=value["task_id"].as_str() {
                                runtime.jobs.insert(id.to_owned());
                                broadcast.activity(Instant::now());
                            }
                            events.emit(value).await?;
                            if ready {
                                agent_ready=true;
                                events.emit(bridge::event("status",json!({"stage":"ready","detail":"Codex готов · эфир выключен","realtime":false}))).await?;
                                if broadcast.is_starting() && config.realtime && voice.is_some() {
                                    launch_voice(&mut voice,&mut opening,&control,broadcast.id().unwrap());
                                    ready_deadline=Instant::now()+Duration::from_secs(90);
                                }
                            }
                        }
                        Some(agent::Output::Completed{id,text,status})=>{
                            runtime.jobs.remove(&id);
                            if status=="completed" {broadcast.transcript("assistant",&text,Instant::now());}
                            else {broadcast.activity(Instant::now());}
                            if let Some(call)=runtime.pending.remove(&id) {
                                let result=if let Some(socket)=&mut runtime.socket {
                                    send_value(socket,Bridge::tool_output(&call,&text,status=="completed")).await
                                } else {Ok(())};
                                if let Err(error)=result {
                                    finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
                                } else if runtime.socket.is_some() {runtime.wants_tool_response=true;}
                            }
                        }
                        None=>{
                            agent_open=false;
                            runtime.agent=None;
                            runtime.jobs.clear();
                            if broadcast.is_starting() || broadcast.is_live() {
                                opening=None;voice=None;
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some("Codex отключён. Эфир остановлен.".into())).await?;
                            }
                        }
                    }
                }
                message=async {runtime.socket.as_mut().unwrap().events.recv().await},if upstream_available=>{
                    last_provider=Instant::now();
                    match message {
                        Some(Ok(UpstreamMessage::Text(raw)))=>{
                            if broadcast.id().is_some_and(|id|control.is_stopped(id)) {
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::User,None).await?;
                                if runtime.jobs.is_empty() {return Ok(());}
                                continue;
                            }
                            let Ok(value)=serde_json::from_str::<Value>(&raw) else {continue;};
                            if !value.is_object() {continue;}
                            if broadcast.provider_event(&value,Instant::now(),runtime.busy()) {continue;}
                            match value["type"].as_str().unwrap_or("") {
                                "input_audio_buffer.speech_started"|"input_audio_buffer.speech_stopped"=>{
                                    broadcast.activity(Instant::now());
                                }
                                "conversation.item.input_audio_transcription.completed"=>{
                                    if let Some(text)=value["transcript"].as_str() {broadcast.transcript("microphone",text,Instant::now());}
                                }
                                "response.done"=>{
                                    broadcast.transcript("assistant",&broadcast::assistant_text(&value),Instant::now());
                                }
                                _=>{}
                            }
                            if runtime.observe_provider_state(&value,Instant::now()) {continue;}
                            let actions=runtime.bridge.provider_event(&value);
                            if let Err(error)=runtime.apply(actions,&events).await {
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
                            } else if runtime.bridge.is_ready() {
                                if let Some(event)=broadcast.live(Instant::now()) {events.emit(event).await?;}
                            } else if value["type"]=="error" {
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some("Провайдер отклонил настройки Realtime".into())).await?;
                            }
                        }
                        Some(Ok(UpstreamMessage::Ping(data)))=>{
                            if let Err(error)=send_upstream(runtime.socket.as_mut().unwrap(),UpstreamMessage::Pong(data)).await {
                                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
                            }
                        }
                        Some(Ok(UpstreamMessage::Close(_)))|None=>{
                            let reason=if broadcast.id().is_some_and(|id|control.is_stopped(id)){EndReason::User}else{EndReason::Error};
                            finish_broadcast(&mut runtime,&mut broadcast,&events,reason,None).await?;
                        }
                        Some(Err(_))=>finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,None).await?,
                        _=>{}
                    }
                }
                _=heartbeat.tick(),if upstream_available=>{
                    if last_provider.elapsed()>Duration::from_secs(60) {
                        finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some("Realtime перестал отвечать. Эфир остановлен.".into())).await?;
                    } else if let Err(error)=send_upstream(runtime.socket.as_mut().unwrap(),UpstreamMessage::Ping(vec![].into())).await {
                        finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
                    }
                }
                _=watchdog.tick()=>{
                    if !broadcast.ended() && broadcast.id().is_some_and(|id|control.is_stopped(id)) {
                        opening=None;voice=None;
                        finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::User,None).await?;
                    } else if let Some((reason,farewell))=broadcast.tick(Instant::now(),runtime.busy()) {
                        finish_broadcast(&mut runtime,&mut broadcast,&events,reason,farewell).await?;
                    } else if let Some(request)=broadcast.semantic_request(Instant::now(),runtime.busy())
                        && let Some(socket)=&mut runtime.socket
                        && let Err(error)=send_value(socket,request).await
                    {
                        finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
                    }
                }
            }
            for command in broadcast.take_outbound() {
                if let Some(socket)=&mut runtime.socket
                    && let Err(error)=send_value(socket,command).await {
                    finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
                    break;
                }
            }
            if broadcast.ended() {
                if runtime.jobs.is_empty() {return Ok(());}
            } else if let Err(error)=runtime.flush_response().await {
                finish_broadcast(&mut runtime,&mut broadcast,&events,EndReason::Error,Some(error.to_string())).await?;
            }
        }
    }.await;
    control.cancel_all();
    opening = None;
    drop(opening);
    runtime.close_voice().await;
    if let Some(handle) = runtime.agent.take() {
        handle.shutdown().await;
    }
    result
}

#[cfg(test)]
mod input_tests {
    use super::*;
    #[test]
    fn malformed_commands_never_become_broad_actions() {
        let mut sequence = 0;
        for value in [
            json!([]),
            json!({"type":"agent_interrupt","task_id":3}),
            json!({"type":"agent_approval","request_id":"","decision":"accept"}),
            json!({"type":"agent_approval","request_id":"id","decision":"acceptForSession"}),
            json!({"type":"agent_input","request_id":"id","answers":[]}),
            json!({"type":"agent_task","task":""}),
            json!({"type":"agent_task","task":"a".repeat(16001)}),
        ] {
            assert!(parse_message(value, &mut sequence).is_err());
        }
        assert_eq!(sequence, 0);
        assert!(
            matches!(parse_message(json!({"type":"agent_interrupt","task_id":"task-1"}),&mut sequence).unwrap(),
            Parsed::Agent(agent::Command::Interrupt{id:Some(id)}) if id=="task-1")
        );
    }
    #[test]
    fn unicode_limits_and_generated_task_ids_are_consistent() {
        let mut sequence = 0;
        assert!(
            matches!(parse_message(json!({"type":"agent_task","task":"я".repeat(16000)}),&mut sequence).unwrap(),
            Parsed::Agent(agent::Command::Run{id,..}) if id=="task-1")
        );
        assert!(
            matches!(parse_message(json!({"type":"agent_task","task":"проверка"}),&mut sequence).unwrap(),
            Parsed::Agent(agent::Command::Run{id,..}) if id=="task-2")
        );
        assert!(
            parse_message(
                json!({"type":"text","text":"я".repeat(4001)}),
                &mut sequence
            )
            .is_err()
        );
    }
}
const RESPONSE_START_TIMEOUT: Duration = Duration::from_secs(15);
struct AwaitingResponse {
    event_id: Option<String>,
    deadline: Instant,
    user_requested: bool,
    tool_requested: bool,
}
struct Runtime {
    bridge: Bridge,
    socket: Option<VoiceTransport>,
    agent: Option<agent::Handle>,
    pending: HashMap<String, String>,
    jobs: std::collections::HashSet<String>,
    response_active: bool,
    awaiting_response: Option<AwaitingResponse>,
    response_sequence: u64,
    speaking: bool,
    wants_response: bool,
    wants_tool_response: bool,
}
impl Runtime {
    async fn apply(&mut self, actions: Vec<Action>, events: &Events) -> Result<(), SafeError> {
        for action in actions {
            match action {
                Action::Emit(value) => events.emit(value).await?,
                Action::Send(value) => {
                    if value["type"] == "response.create" {
                        self.wants_response = true;
                    } else if let Some(socket) = &mut self.socket {
                        send_value(socket, value).await?;
                    }
                }
                Action::Resume => self.wants_tool_response = true,
                Action::Delegate { call_id, task } => {
                    let id = format!("call-{call_id}");
                    self.pending.insert(id.clone(), call_id.clone());
                    let accepted = self.agent.as_ref().is_some_and(|handle| {
                        handle
                            .commands
                            .try_send(agent::Command::Run {
                                id: id.clone(),
                                task,
                            })
                            .is_ok()
                    });
                    if accepted {
                        self.jobs.insert(id.clone());
                    } else {
                        self.pending.remove(&id);
                        if let Some(socket) = &mut self.socket {
                            send_value(
                                socket,
                                Bridge::tool_output(
                                    &call_id,
                                    "Codex недоступен; задача не выполнялась",
                                    false,
                                ),
                            )
                            .await?;
                        }
                        self.wants_tool_response = true;
                    }
                }
            }
        }
        Ok(())
    }
    fn can_start_response(&self) -> bool {
        !self.response_active
            && self.awaiting_response.is_none()
            && !self.speaking
            && (self.wants_response || (self.wants_tool_response && self.pending.is_empty()))
    }
    fn begin_response(&mut self, now: Instant) -> Value {
        self.response_sequence += 1;
        let id = format!("assistant-response-{}", self.response_sequence);
        self.awaiting_response = Some(AwaitingResponse {
            event_id: Some(id.clone()),
            deadline: now + RESPONSE_START_TIMEOUT,
            user_requested: self.wants_response,
            tool_requested: self.wants_tool_response,
        });
        self.wants_response = false;
        self.wants_tool_response = false;
        json!({"type":"response.create","event_id":id})
    }
    fn expire_response_start(&mut self, now: Instant) -> bool {
        if self
            .awaiting_response
            .as_ref()
            .is_some_and(|pending| pending.deadline <= now)
        {
            self.awaiting_response = None;
            // Do not restore the failed request's flags: that would cause an automatic retry loop.
            return true;
        }
        false
    }
    /// Update only response lifecycle state; errors belonging to other events cannot stop
    /// an acknowledged active response. Returns true for a handled active-response conflict.
    fn observe_provider_state(&mut self, event: &Value, now: Instant) -> bool {
        match event["type"].as_str().unwrap_or("") {
            "response.created" => {
                self.awaiting_response = None;
                self.response_active = true;
            }
            "response.done" => {
                self.awaiting_response = None;
                self.response_active = false;
            }
            "input_audio_buffer.speech_started" => self.speaking = true,
            "input_audio_buffer.cleared" => self.speaking = false,
            "input_audio_buffer.committed" => {
                self.speaking = false;
                if self.awaiting_response.is_none() {
                    self.awaiting_response = Some(AwaitingResponse {
                        event_id: None,
                        deadline: now + RESPONSE_START_TIMEOUT,
                        user_requested: false,
                        tool_requested: false,
                    });
                }
            }
            "error" => {
                let rejected_id = event["error"]["event_id"].as_str();
                let matching = self
                    .awaiting_response
                    .as_ref()
                    .and_then(|pending| pending.event_id.as_deref())
                    .is_some_and(|id| Some(id) == rejected_id);
                let conflict = matches!(
                    event["error"]["code"].as_str(),
                    Some(
                        "conversation_already_has_active_response" | "response_already_in_progress"
                    )
                );
                if conflict {
                    // The provider confirms that another response exists. Retry this particular
                    // request once that response ends, while preserving the all-tools barrier.
                    if (matching || rejected_id.is_none())
                        && let Some(pending) = self.awaiting_response.take()
                    {
                        self.wants_response |= pending.user_requested;
                        self.wants_tool_response |= pending.tool_requested;
                    }
                    self.response_active = true;
                    return true;
                }
                if matching {
                    self.awaiting_response = None;
                }
            }
            _ => {}
        }
        false
    }
    async fn flush_response(&mut self) -> Result<(), SafeError> {
        if self.can_start_response() && self.socket.is_some() {
            let request = self.begin_response(Instant::now());
            if let Some(socket) = &mut self.socket {
                send_value(socket, request).await?;
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn runtime() -> Runtime {
        Runtime {
            bridge: Bridge::new(false),
            socket: None,
            agent: None,
            pending: HashMap::new(),
            jobs: std::collections::HashSet::new(),
            response_active: false,
            awaiting_response: None,
            response_sequence: 0,
            speaking: false,
            wants_response: false,
            wants_tool_response: false,
        }
    }
    #[test]
    fn rejected_response_create_clears_only_its_own_wait_without_retrying() {
        let mut runtime = runtime();
        let now = Instant::now();
        runtime.wants_response = true;
        let request = runtime.begin_response(now);
        assert!(!runtime.response_active);
        assert!(runtime.awaiting_response.is_some());
        runtime.observe_provider_state(
            &json!({"type":"error","error":{
                "code":"rate_limit_exceeded","event_id":"unrelated-input-event"
            }}),
            now,
        );
        assert!(runtime.awaiting_response.is_some());
        runtime.observe_provider_state(
            &json!({"type":"error","error":{
                "code":"rate_limit_exceeded","event_id":request["event_id"]
            }}),
            now,
        );
        assert!(runtime.awaiting_response.is_none());
        assert!(!runtime.response_active);
        assert!(
            !runtime.can_start_response(),
            "a rejected request must not loop automatically"
        );
        runtime.wants_response = true;
        assert!(
            runtime.can_start_response(),
            "the next explicit message must still work"
        );
    }
    #[test]
    fn acknowledged_response_survives_unrelated_and_late_errors() {
        let mut runtime = runtime();
        let now = Instant::now();
        runtime.wants_response = true;
        let request = runtime.begin_response(now);
        runtime.observe_provider_state(&json!({"type":"response.created"}), now);
        assert!(runtime.response_active);
        assert!(runtime.awaiting_response.is_none());
        runtime.observe_provider_state(
            &json!({"type":"error","error":{
                "code":"invalid_request_error","event_id":request["event_id"]
            }}),
            now,
        );
        assert!(runtime.response_active);
        assert!(!runtime.expire_response_start(now + Duration::from_secs(20)));
        runtime.observe_provider_state(&json!({"type":"response.done"}), now);
        assert!(!runtime.response_active);
    }
    #[test]
    fn vad_start_wait_is_bounded_and_cleared_audio_releases_speaking() {
        let mut runtime = runtime();
        let now = Instant::now();
        runtime.observe_provider_state(&json!({"type":"input_audio_buffer.speech_started"}), now);
        assert!(runtime.speaking);
        runtime.observe_provider_state(&json!({"type":"input_audio_buffer.cleared"}), now);
        assert!(!runtime.speaking);
        runtime.observe_provider_state(&json!({"type":"input_audio_buffer.committed"}), now);
        assert!(!runtime.response_active);
        assert!(
            runtime
                .awaiting_response
                .as_ref()
                .unwrap()
                .event_id
                .is_none()
        );
        assert!(!runtime.expire_response_start(now + Duration::from_secs(14)));
        assert!(runtime.expire_response_start(now + Duration::from_secs(15)));
        assert!(!runtime.can_start_response());
        runtime.wants_response = true;
        assert!(runtime.can_start_response());
    }
    #[test]
    fn tool_outputs_wait_for_the_whole_batch_and_conflicts_resume_once() {
        let mut runtime = runtime();
        let now = Instant::now();
        runtime.pending.insert("task-a".into(), "call-a".into());
        runtime.pending.insert("task-b".into(), "call-b".into());
        runtime.wants_tool_response = true;
        assert!(!runtime.can_start_response());
        runtime.pending.remove("task-a");
        assert!(!runtime.can_start_response());
        runtime.pending.remove("task-b");
        assert!(runtime.can_start_response());
        let request = runtime.begin_response(now);
        assert!(!runtime.can_start_response());
        assert!(runtime.observe_provider_state(
            &json!({"type":"error","error":{
                "code":"conversation_already_has_active_response","event_id":request["event_id"]
            }}),
            now
        ));
        assert!(runtime.response_active);
        assert!(runtime.wants_tool_response);
        runtime.observe_provider_state(&json!({"type":"response.done"}), now);
        assert!(runtime.can_start_response());
        runtime.begin_response(now);
        runtime.observe_provider_state(&json!({"type":"response.created"}), now);
        runtime.observe_provider_state(&json!({"type":"response.done"}), now);
        assert!(
            !runtime.can_start_response(),
            "one batch should produce one summary"
        );
    }
}

#[cfg(test)]
#[path = "session_contract.rs"]
mod contract_tests;

#[cfg(test)]
#[path = "custom_tests.rs"]
mod custom_tests;

#[cfg(test)]
#[path = "session_broadcast_tests.rs"]
mod broadcast_tests;
