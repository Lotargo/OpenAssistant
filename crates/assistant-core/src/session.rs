//! Native-client session runtime; no HTTP listener, browser auth or API-key fallback.
use crate::{
    agent,
    auth::{self, SafeError},
    bridge::{self, Action, Bridge, Input},
    codex, provider,
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SessionConfig {
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
    fn agent(&self) -> agent::Config {
        agent::Config {
            workspace: self.workspace.clone(),
            model: self.model.clone(),
            effort: self.effort.clone(),
            web_search: self.web_search,
            parallel: self.parallel,
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
    Audio(Vec<u8>),
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

enum Parsed {
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

fn parse_message(value: Value, sequence: &mut u64) -> Result<Parsed, SafeError> {
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
        "text" => {
            let text = value["text"]
                .as_str()
                .filter(|s| !s.trim().is_empty() && s.chars().count() <= bridge::MAX_TEXT_LENGTH)
                .ok_or_else(|| SafeError::new("Введите сообщение длиной до 4000 символов"))?;
            Ok(Parsed::Voice(Input::Text(Some(text.to_owned()))))
        }
        "mic_start" => Ok(Parsed::Voice(Input::MicStart)),
        "mic_stop" => Ok(Parsed::Voice(Input::MicStop)),
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

async fn send_upstream(
    socket: &mut provider::ProviderSocket,
    message: UpstreamMessage,
) -> Result<(), SafeError> {
    time::timeout(Duration::from_secs(10), socket.send(message))
        .await
        .map_err(|_| SafeError::new("Realtime не принимает данные"))?
        .map_err(|_| SafeError::new("Соединение Realtime закрыто"))
}
async fn send_value(socket: &mut provider::ProviderSocket, value: Value) -> Result<(), SafeError> {
    send_upstream(socket, UpstreamMessage::Text(value.to_string().into())).await
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
    let mut payload = provider::session_payload(&config.realtime_model);
    if let Some(instructions) = payload["instructions"].as_str() {
        payload["instructions"] = json!(format!(
            "{instructions} Рабочая папка: {}.",
            config.workspace.display()
        ));
    }
    let ephemeral = provider::mint(&payload, &credential.access_token).await?;
    drop(credential);
    events
        .emit(bridge::status("websocket", "Подключение Realtime"))
        .await?;
    let mut socket = provider::connect(&ephemeral, &config.realtime_model).await?;
    drop(ephemeral);
    payload.as_object_mut().unwrap().remove("model");
    send_value(
        &mut socket,
        json!({"type":"session.update","session":payload}),
    )
    .await?;
    Ok(socket)
}

impl Runtime {
    async fn disable_voice(&mut self, message: &str, events: &Events) -> Result<(), SafeError> {
        self.socket = None;
        self.bridge = Bridge::new(false);
        self.pending.clear();
        self.response_active = false;
        self.awaiting_response = None;
        self.speaking = false;
        self.wants_response = false;
        self.wants_tool_response = false;
        events
            .emit(bridge::event(
                "status",
                json!({"stage":"voice_error","detail":message,
            "realtime":false,"agent_available":self.agent.is_some()}),
            ))
            .await
    }
}

pub async fn run(
    config: SessionConfig,
    input: mpsc::Receiver<SessionInput>,
    events: mpsc::Sender<Value>,
) -> Result<(), SafeError> {
    let config = config.validate()?;
    let options = codex::SpawnOptions::new(config.workspace.clone());
    let events = Events { sender: events };
    let voice = connect_voice(&config, &events);
    run_inner(&config, options, input, events.clone(), voice).await
}

async fn run_inner<F>(
    config: &SessionConfig,
    options: codex::SpawnOptions,
    mut input: mpsc::Receiver<SessionInput>,
    events: Events,
    voice: F,
) -> Result<(), SafeError>
where
    F: std::future::Future<Output = Result<provider::ProviderSocket, SafeError>> + Send,
{
    let (agent_tx, mut agent_rx) = mpsc::channel(128);
    let handle = agent::Handle::spawn(config.agent(), options, agent_tx);
    let mut runtime = Runtime {
        bridge: Bridge::new(false),
        socket: None,
        agent: Some(handle),
        pending: HashMap::new(),
        response_active: false,
        awaiting_response: None,
        response_sequence: 0,
        speaking: false,
        wants_response: false,
        wants_tool_response: false,
    };
    let result = async {
        events.emit(bridge::event("status",json!({"stage":"connecting","detail":"Подключение Codex","realtime":false}))).await?;
        let mut opening = false;
        let mut voice_attempted = !config.realtime;
        tokio::pin!(voice);
        let mut ready_deadline = Instant::now() + Duration::from_secs(90);
        let mut agent_open = true;
        let mut sequence = 0;
        let mut heartbeat = time::interval_at(Instant::now()+Duration::from_secs(20), Duration::from_secs(20));
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
                result=&mut voice,if opening=>{
                    opening=false;
                    match result {
                        Ok(socket)=>{
                            runtime.socket=Some(socket);
                            ready_deadline=Instant::now()+Duration::from_secs(22);
                            last_provider=Instant::now();
                        }
                        Err(error)=>runtime.disable_voice(&error.to_string(),&events).await?,
                    }
                }
                _=time::sleep_until(ready_deadline),if runtime.socket.is_some() && !runtime.bridge.is_ready()=>{
                    runtime.disable_voice("Провайдер не подтвердил готовность голосовой сессии",&events).await?;
                }
                command=input.recv()=>{
                    let Some(command)=command else {return Ok(());};
                    let parsed=match command {
                        SessionInput::Message(value)=>parse_message(value,&mut sequence),
                        SessionInput::Audio(bytes)=>{
                            if bytes.is_empty() || bytes.len()>bridge::MAX_AUDIO_BYTES || !bytes.len().is_multiple_of(2) {
                                Err(SafeError::new("Некорректный размер PCM16 аудиофрагмента"))
                            } else {Ok(Parsed::Voice(Input::Audio(bytes)))}
                        }
                    };
                    match parsed {
                        Err(error)=>events.emit(bridge::error(&error.to_string())).await?,
                        Ok(Parsed::Disconnect)=>return Ok(()),
                        Ok(Parsed::Agent(command))=>{
                            if runtime.agent.as_ref().is_none_or(|h|h.commands.try_send(command).is_err()) {
                                events.emit(bridge::event("agent_error",json!({"message":"Codex недоступен; переподключись"}))).await?;
                            }
                        }
                        Ok(Parsed::Voice(command))=>{
                            if !runtime.bridge.is_ready() {
                                if !matches!(command,Input::Audio(_)) {
                                    events.emit(bridge::error("Голосовая сессия недоступна. Текстовые задачи Codex доступны.")).await?;
                                }
                            } else {
                                let actions=runtime.bridge.input(command);
                                if let Err(error)=runtime.apply(actions,&events).await {
                                    runtime.disable_voice(&error.to_string(),&events).await?;
                                }
                            }
                        }
                    }
                }
                output=agent_rx.recv(),if agent_open=>{
                    match output {
                        Some(agent::Output::Ui(value))=>{
                            let agent_ready=value["type"]=="agent_state" && value["stage"]=="ready";
                            events.emit(value).await?;
                            if agent_ready {
                                if !voice_attempted {
                                    voice_attempted=true;
                                    opening=true;
                                    ready_deadline=Instant::now()+Duration::from_secs(90);
                                } else if !config.realtime {
                                    events.emit(bridge::event("status",json!({"stage":"ready","detail":"Codex · текстовый режим","realtime":false}))).await?;
                                }
                            }
                        }
                        Some(agent::Output::Completed{id,text,status})=>{
                            if let Some(call)=runtime.pending.remove(&id) {
                                let result=if let Some(socket)=&mut runtime.socket {
                                    send_value(socket,Bridge::tool_output(&call,&text,status=="completed")).await
                                } else {Ok(())};
                                if let Err(error)=result {runtime.disable_voice(&error.to_string(),&events).await?;}
                                else {runtime.wants_tool_response=true;}
                            }
                        }
                        None=>{
                            agent_open=false;
                            runtime.agent=None;
                            let calls:Vec<_>=runtime.pending.drain().map(|(_,call)|call).collect();
                            for call in calls {
                                if let Some(socket)=&mut runtime.socket
                                    && let Err(error)=send_value(socket,Bridge::tool_output(&call,"Codex отключён",false)).await {
                                        runtime.disable_voice(&error.to_string(),&events).await?;
                                        break;
                                    }
                                runtime.wants_tool_response=true;
                            }
                        }
                    }
                }
                message=async {runtime.socket.as_mut().unwrap().next().await},if upstream_available=>{
                    last_provider=Instant::now();
                    match message {
                        Some(Ok(UpstreamMessage::Text(raw)))=>{
                            let Ok(value)=serde_json::from_str::<Value>(&raw) else {continue;};
                            if !value.is_object() {continue;}
                            if runtime.observe_provider_state(&value,Instant::now()) {continue;}
                            let actions=runtime.bridge.provider_event(&value);
                            if let Err(error)=runtime.apply(actions,&events).await {
                                runtime.disable_voice(&error.to_string(),&events).await?;
                            } else if !runtime.bridge.is_ready() && value["type"]=="error" {
                                runtime.disable_voice("Провайдер отклонил настройки Realtime",&events).await?;
                            }
                        }
                        Some(Ok(UpstreamMessage::Ping(data)))=>{
                            let result=send_upstream(runtime.socket.as_mut().unwrap(),UpstreamMessage::Pong(data)).await;
                            if let Err(error)=result {runtime.disable_voice(&error.to_string(),&events).await?;}
                        }
                        Some(Ok(UpstreamMessage::Close(_)))|None=>
                            runtime.disable_voice("Голосовое соединение закрыто. Codex продолжает работать.",&events).await?,
                        Some(Err(_))=>runtime.disable_voice("Сбой транспорта Realtime. Codex продолжает работать.",&events).await?,
                        _=>{}
                    }
                }
                _=heartbeat.tick(),if upstream_available=>{
                    if last_provider.elapsed()>Duration::from_secs(60) {
                        runtime.disable_voice("Realtime не отвечает на проверку соединения",&events).await?;
                    } else {
                        let result=send_upstream(runtime.socket.as_mut().unwrap(),UpstreamMessage::Ping(vec![].into())).await;
                        if let Err(error)=result {runtime.disable_voice(&error.to_string(),&events).await?;}
                    }
                }
            }
            if let Err(error)=runtime.flush_response().await {
                runtime.disable_voice(&error.to_string(),&events).await?;
            }
        }
    }.await;
    runtime.socket = None;
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
    socket: Option<provider::ProviderSocket>,
    agent: Option<agent::Handle>,
    pending: HashMap<String, String>,
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
                    if !accepted {
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
