//! Native IPC adapter. Provider credentials and child processes stay in Rust.
#[path = "assistant_broadcast.rs"]
mod broadcast_audio;
use crate::audio::{AudioState, SystemAudioState};
use assistant_core::{
    bridge::{MAX_AUDIO_BYTES, MAX_LOCAL_MESSAGE},
    session::{self, SessionConfig, SessionInput},
    workspace::{
        self, CleanupReport, CleanupStatus, WorkspaceLease, WorkspaceMode, WorkspaceStatus,
    },
};
pub(crate) use broadcast_audio::BroadcastAudio;
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex as StdMutex,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};
use tauri::{AppHandle, Manager, State, ipc::Channel};
use tauri_plugin_dialog::DialogExt;
use tokio::{
    sync::{Mutex, mpsc},
    task::JoinHandle,
};

const INPUT_QUEUE_SIZE: usize = 96;
const EVENT_QUEUE_SIZE: usize = 256;

#[derive(Default)]
pub struct AssistantState {
    session: Mutex<Option<NativeSession>>,
    next_id: AtomicU64,
    view_epoch: AtomicU64,
    catalog: Mutex<()>,
    last_workspace: Arc<StdMutex<Option<WorkspaceStatus>>>,
}

struct NativeSession {
    id: u64,
    view_epoch: u64,
    input: mpsc::Sender<SessionInput>,
    run: JoinHandle<()>,
    forward: JoinHandle<()>,
    workspace: Arc<WorkspaceLease>,
    last_workspace: Arc<StdMutex<Option<WorkspaceStatus>>>,
    on_event: Option<Channel<Value>>,
    audio: Arc<BroadcastAudio>,
    voice_control: session::BroadcastControl,
}

impl NativeSession {
    async fn stop(mut self) {
        self.audio.cancel();
        self.voice_control.cancel_all();
        let _ = self
            .input
            .try_send(SessionInput::Message(json!({"type":"disconnect"})));
        if tokio::time::timeout(Duration::from_secs(2), &mut self.run)
            .await
            .is_err()
        {
            self.run.abort();
            // Observe cancellation before returning from the application's exit hook.
            let _ = (&mut self.run).await;
        }
        self.forward.abort();
        let _ = (&mut self.forward).await;
        let _ = self.audio.join().await;
        let status = cleanup_workspace(self.workspace.clone(), &self.last_workspace).await;
        if let Some(channel) = &self.on_event {
            let _ = channel.send(workspace_event(&status));
        }
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        // Aborting the core drops its agent handle, closing the app-server process
        // and its provider socket. No orphaned session survives the native window.
        self.audio.cancel();
        self.voice_control.cancel_all();
        self.run.abort();
        self.forward.abort();
    }
}

fn workspace_event(status: &WorkspaceStatus) -> Value {
    let mut value = serde_json::to_value(status).expect("workspace status is serializable");
    value["type"] = json!("workspace_state");
    value
}

fn remember_workspace(target: &Arc<StdMutex<Option<WorkspaceStatus>>>, status: WorkspaceStatus) {
    *target
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(status);
}

async fn cleanup_workspace(
    workspace: Arc<WorkspaceLease>,
    target: &Arc<StdMutex<Option<WorkspaceStatus>>>,
) -> WorkspaceStatus {
    let fallback = workspace.clone();
    let status = match tokio::task::spawn_blocking(move || workspace.cleanup()).await {
        Ok(status) => status,
        Err(_) => {
            let mut status = fallback.status();
            status.cleanup_status = CleanupStatus::Pending;
            status.message = Some("Workspace cleanup could not finish; it will be retried.".into());
            status
        }
    };
    remember_workspace(target, status.clone());
    status
}

pub async fn cleanup_stale_workspaces() -> Result<CleanupReport, String> {
    tokio::task::spawn_blocking(workspace::cleanup_stale)
        .await
        .map_err(|_| "Could not inspect temporary workspaces.".to_owned())?
        .map_err(|error| error.to_string())
}

impl AssistantState {
    pub fn invalidate_view(&self) {
        self.view_epoch.fetch_add(1, Ordering::AcqRel);
    }

    pub async fn close_stale_view(&self) {
        let mut slot = self.session.lock().await;
        if slot
            .as_ref()
            .is_some_and(|session| session.view_epoch != self.view_epoch.load(Ordering::Acquire))
        {
            if let Some(session) = slot.take() {
                session.stop().await;
            }
        }
    }

    pub async fn shutdown(&self) {
        let mut slot = self.session.lock().await;
        if let Some(session) = slot.take() {
            session.stop().await;
        }
    }
}

/// The UI stores preferences only. Neither secrets nor arbitrary executable paths
/// are accepted by IPC.
#[derive(Debug, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ConnectOptions {
    workspace_mode: WorkspaceMode,
    workspace: String,
    scenario: session::Scenario,
    custom_name: String,
    custom_instructions: String,
    custom_behavior: session::CustomBehavior,
    silence_timeout_secs: u32,
    agent_auto_end: bool,
    model: String,
    effort: String,
    web_search: bool,
    parallel: bool,
    realtime: bool,
    realtime_model: String,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            workspace_mode: WorkspaceMode::Temporary,
            workspace: String::new(),
            scenario: session::Scenario::default(),
            custom_name: session::default_custom_name(),
            custom_instructions: String::new(),
            custom_behavior: session::CustomBehavior::default(),
            silence_timeout_secs: session::default_silence_timeout_secs(),
            agent_auto_end: session::default_agent_auto_end(),
            model: String::new(),
            effort: String::new(),
            web_search: true,
            parallel: true,
            realtime: true,
            realtime_model: assistant_core::provider::MODEL_DEFAULT.into(),
        }
    }
}

fn optional_setting(value: String, name: &str, limit: usize) -> Result<Option<String>, String> {
    let value = value.trim();
    if value.len() > limit || value.chars().any(char::is_control) {
        return Err(format!("Invalid {name} setting"));
    }
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

fn options(config: ConnectOptions) -> Result<(SessionConfig, Arc<WorkspaceLease>), String> {
    if config.workspace.len() > 4096 || config.workspace.chars().any(char::is_control) {
        return Err("Invalid workspace path".into());
    }
    if !assistant_core::provider::allowed_model(&config.realtime_model) {
        return Err("Unsupported Realtime model.".into());
    }
    session::validate_silence_timeout(config.silence_timeout_secs)
        .map_err(|error| error.to_string())?;
    let (custom_name, custom_instructions) =
        session::normalize_custom_settings(config.custom_name, config.custom_instructions)
            .map_err(|error| error.to_string())?;
    let model = optional_setting(config.model, "model", 128)?;
    let effort = optional_setting(config.effort, "effort", 32)?;
    let project =
        (!config.workspace.trim().is_empty()).then(|| PathBuf::from(config.workspace.trim()));
    let workspace = Arc::new(
        WorkspaceLease::open(config.workspace_mode, project.as_deref())
            .map_err(|error| error.to_string())?,
    );
    let session = SessionConfig {
        workspace: workspace.path().to_owned(),
        scenario: config.scenario,
        custom_name,
        custom_instructions,
        custom_behavior: config.custom_behavior,
        silence_timeout_secs: config.silence_timeout_secs,
        agent_auto_end: config.agent_auto_end,
        model,
        effort,
        web_search: config.web_search,
        parallel: config.parallel,
        realtime: config.realtime,
        realtime_model: config.realtime_model,
    };
    Ok((session, workspace))
}

#[tauri::command]
pub async fn assistant_status(state: State<'_, AssistantState>) -> Result<Value, String> {
    let current = state
        .last_workspace
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone();
    let path = current
        .as_ref()
        .map(|value| value.path.clone())
        .unwrap_or_default();
    let mut status = session::status(&path).await;
    status["workspace_mode"] = json!(current.as_ref().map(|value| value.mode).unwrap_or_default());
    status["workspace_state"] = json!(current);
    Ok(status)
}

#[tauri::command]
pub async fn assistant_models(state: State<'_, AssistantState>) -> Result<Value, String> {
    let _request = state.catalog.lock().await;
    // Catalog inspection is independent of the current agent and selected project.
    let workspace =
        tokio::task::spawn_blocking(|| WorkspaceLease::open(WorkspaceMode::Temporary, None))
            .await
            .map_err(|_| "Could not prepare a model catalog workspace.".to_owned())?
            .map_err(|error| error.to_string())?;
    let options = assistant_core::codex::SpawnOptions::new(workspace.path());
    let result = tokio::time::timeout(
        Duration::from_secs(30),
        assistant_core::agent::available_models(options),
    )
    .await
    .map_err(|_| "Codex model catalog timed out.".to_owned())
    .and_then(|result| result.map_err(|error| error.to_string()));
    let _ = tokio::task::spawn_blocking(move || workspace.cleanup()).await;
    result
}

#[tauri::command]
pub fn assistant_workspace_state(state: State<'_, AssistantState>) -> Option<WorkspaceStatus> {
    state
        .last_workspace
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .clone()
}

#[tauri::command]
pub async fn assistant_cleanup_workspaces(
    state: State<'_, AssistantState>,
) -> Result<CleanupReport, String> {
    let report = cleanup_stale_workspaces().await?;
    let mut status = state
        .last_workspace
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(current) = status.as_mut() {
        if current.temporary
            && current.cleanup_status == CleanupStatus::Pending
            && matches!(current.path.try_exists(), Ok(false))
        {
            current.cleanup_status = CleanupStatus::Removed;
            current.message = None;
        }
    }
    Ok(report)
}

#[tauri::command]
pub async fn assistant_choose_workspace(
    app: AppHandle,
    state: State<'_, AssistantState>,
) -> Result<Option<String>, String> {
    let epoch = state.view_epoch.load(Ordering::Acquire);
    let result = tokio::task::spawn_blocking(move || {
        let parent = app
            .get_webview_window("settings")
            .filter(|window| window.is_visible().unwrap_or(false))
            .or_else(|| app.get_webview_window("main"));
        let mut dialog = app
            .dialog()
            .file()
            .set_title("OpenAssistant: project folder");
        if let Some(parent) = &parent {
            dialog = dialog.set_parent(parent);
        }
        dialog
            .blocking_pick_folder()
            .map(|selection| {
                let path = selection
                    .into_path()
                    .map_err(|_| "The selected folder has no local path.".to_owned())?;
                workspace::project_path(&path)
                    .map(|path| path.to_string_lossy().into_owned())
                    .map_err(|error| error.to_string())
            })
            .transpose()
    })
    .await
    .map_err(|_| "Could not open the folder picker.".to_owned())??;
    if epoch != state.view_epoch.load(Ordering::Acquire) {
        return Err("The interface reloaded before folder selection finished.".into());
    }
    Ok(result)
}

#[tauri::command]
pub async fn assistant_connect(
    app: AppHandle,
    state: State<'_, AssistantState>,
    config: ConnectOptions,
    on_event: Channel<Value>,
) -> Result<u64, String> {
    let view_epoch = state.view_epoch.load(Ordering::Acquire);
    // Validate before replacing an existing session.
    let (config, workspace) = tokio::task::spawn_blocking(move || options(config))
        .await
        .map_err(|_| "Could not prepare the workspace.".to_owned())??;
    let mut slot = state.session.lock().await;
    if slot
        .as_ref()
        .is_some_and(|previous| previous.audio.terminal() && !previous.run.is_finished())
    {
        return Err("Дождись завершения текущих задач Codex перед новым эфиром.".into());
    }
    if let Some(previous) = slot.take() {
        previous.stop().await;
    }
    if view_epoch != state.view_epoch.load(Ordering::Acquire) {
        return Err("Интерфейс перезагружен. Подключись заново.".into());
    }
    let id = state.next_id.fetch_add(1, Ordering::Relaxed) + 1;
    let (input_tx, input_rx) = mpsc::channel(INPUT_QUEUE_SIZE);
    let (events_tx, mut events_rx) = mpsc::channel(EVENT_QUEUE_SIZE);
    let final_events = events_tx.clone();
    let initial_workspace = workspace.status();
    remember_workspace(&state.last_workspace, initial_workspace.clone());
    events_tx
        .send(workspace_event(&initial_workspace))
        .await
        .map_err(|_| "Session output is unavailable".to_owned())?;
    let run_workspace = workspace.clone();
    let last_workspace = state.last_workspace.clone();
    let cleanup_channel = on_event.clone();
    let audio = Arc::new(BroadcastAudio::new(
        app.state::<AudioState>().inner().clone(),
        app.state::<SystemAudioState>().inner().clone(),
    ));
    let voice_control = session::BroadcastControl::default();
    let run_control = voice_control.clone();
    let forward_control = voice_control.clone();
    let run_audio = audio.clone();
    let forward_audio = audio.clone();
    let run = tokio::spawn(async move {
        if let Err(error) =
            session::run_with_control(config, input_rx, events_tx, run_control).await
        {
            // SafeError contains fixed/sanitized text, never provider bodies.
            let _ = final_events
                .send(json!({"type":"agent_error","message":error.to_string()}))
                .await;
        }
        run_audio.cancel();
        let _ = run_audio.join().await;
        let cleaned = cleanup_workspace(run_workspace, &last_workspace).await;
        let _ = final_events.send(workspace_event(&cleaned)).await;
        let _ = final_events
            .send(json!({"type":"session_closed","message":"Сессия закрыта."}))
            .await;
    });
    let abort_run = run.abort_handle();
    let forward = tokio::spawn(async move {
        while let Some(mut event) = events_rx.recv().await {
            if forward_audio.observe(&event) {
                if let Err(error) = forward_audio.join().await {
                    event["reason"] = json!("error");
                    event["farewell"] = json!(error);
                }
            }
            if on_event.send(event).is_err() {
                forward_audio.cancel();
                forward_control.cancel_all();
                // The webview disappeared/reloaded. Do not keep recording or
                // executing tasks for a UI that cannot receive approval requests.
                abort_run.abort();
                break;
            }
        }
    });
    *slot = Some(NativeSession {
        id,
        view_epoch,
        input: input_tx,
        run,
        forward,
        workspace,
        last_workspace: state.last_workspace.clone(),
        on_event: Some(cleanup_channel),
        audio,
        voice_control,
    });
    Ok(id)
}

fn valid_message(message: &Value) -> Result<(), String> {
    if !message.is_object()
        || serde_json::to_vec(message)
            .map_err(|_| "Invalid message")?
            .len()
            > MAX_LOCAL_MESSAGE
    {
        return Err("Некорректное или слишком большое сообщение.".into());
    }
    let allowed = [
        "broadcast_start",
        "broadcast_stop",
        "agent_task",
        "agent_interrupt",
        "agent_approval",
        "agent_input",
        "agent_models",
        "models",
        "text",
        "mic_start",
        "mic_stop",
        "system_start",
        "system_stop",
        "interview_start",
        "interview_stop",
    ];
    if !message
        .get("type")
        .and_then(Value::as_str)
        .is_some_and(|kind| allowed.contains(&kind))
    {
        return Err("Неизвестная команда сессии.".into());
    }
    Ok(())
}

#[cfg(test)]
async fn active_input(
    state: &AssistantState,
    session_id: u64,
) -> Result<mpsc::Sender<SessionInput>, String> {
    let slot = state.session.lock().await;
    slot.as_ref()
        .filter(|session| {
            session.id == session_id
                && session.view_epoch == state.view_epoch.load(Ordering::Acquire)
                && !session.run.is_finished()
        })
        .map(|session| session.input.clone())
        .ok_or_else(|| "Сессия уже закрыта. Подключись к Codex заново.".into())
}

async fn active_session(
    state: &AssistantState,
    session_id: u64,
) -> Result<(mpsc::Sender<SessionInput>, Arc<BroadcastAudio>), String> {
    let slot = state.session.lock().await;
    slot.as_ref()
        .filter(|session| {
            session.id == session_id
                && session.view_epoch == state.view_epoch.load(Ordering::Acquire)
                && !session.run.is_finished()
        })
        .map(|session| (session.input.clone(), session.audio.clone()))
        .ok_or_else(|| "Сессия уже закрыта. Подключись к Codex заново.".into())
}
impl AssistantState {
    pub async fn audio_binding(
        &self,
        session_id: u64,
        broadcast_id: &str,
    ) -> Result<Arc<BroadcastAudio>, String> {
        let (_, audio) = active_session(self, session_id).await?;
        audio.require_live(broadcast_id)?;
        Ok(audio)
    }
}
fn message_broadcast_id(message: &Value) -> Result<&str, String> {
    let id = message["broadcast_id"]
        .as_str()
        .ok_or_else(|| "Не задан идентификатор эфира.".to_owned())?;
    BroadcastAudio::validate_id(id)?;
    Ok(id)
}

#[tauri::command]
pub async fn assistant_send(
    state: State<'_, AssistantState>,
    session_id: u64,
    message: Value,
) -> Result<(), String> {
    valid_message(&message)?;
    let (input, audio) = active_session(&state, session_id).await?;
    match message["type"].as_str().unwrap_or("") {
        "broadcast_start" => audio.start(message_broadcast_id(&message)?)?,
        "broadcast_stop" => {
            let id = message_broadcast_id(&message)?;
            audio.stop(id)?;
            let slot = state.session.lock().await;
            if let Some(session) = slot.as_ref().filter(|session| session.id == session_id) {
                session.voice_control.stop(id);
            }
        }
        "agent_task" | "text" if audio.terminal() => {
            return Err(
                "The broadcast has ended; wait for current Codex tasks before reconnecting.".into(),
            );
        }
        "mic_start" | "mic_stop" | "system_start" | "system_stop" | "interview_start"
        | "interview_stop" => audio.require_live(message_broadcast_id(&message)?)?,
        _ => {}
    }
    tokio::time::timeout(
        Duration::from_secs(2),
        input.send(SessionInput::Message(message)),
    )
    .await
    .map_err(|_| "Очередь команд заполнена. Повтори после завершения текущего шага.".to_string())?
    .map_err(|_| "Сессия уже закрыта.".into())
}

#[tauri::command]
pub async fn assistant_audio(
    state: State<'_, AssistantState>,
    session_id: u64,
    broadcast_id: String,
    audio: Vec<u8>,
    source: Option<String>,
) -> Result<(), String> {
    if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES || !audio.len().is_multiple_of(2) {
        return Err("Некорректный PCM16 аудиофрагмент.".into());
    }
    let packet = match source.as_deref().unwrap_or("microphone") {
        "microphone" => SessionInput::Audio {
            broadcast_id: broadcast_id.clone(),
            data: audio,
        },
        "system" => SessionInput::SystemAudio {
            broadcast_id: broadcast_id.clone(),
            data: audio,
        },
        _ => return Err("Неизвестный источник звука.".into()),
    };
    // Audio must never wait behind an unbounded queue. Let the frontend stop the
    // microphone explicitly on backpressure rather than accumulate stale speech.
    let (input, binding) = active_session(&state, session_id).await?;
    binding.require_live(&broadcast_id)?;
    input
        .try_send(packet)
        .map_err(|_| "Передача аудио не успевает за микрофоном или сессия закрыта.".into())
}

#[tauri::command]
pub async fn assistant_disconnect(
    state: State<'_, AssistantState>,
    session_id: u64,
) -> Result<(), String> {
    let mut slot = state.session.lock().await;
    if slot
        .as_ref()
        .is_some_and(|session| session.id == session_id)
    {
        if let Some(session) = slot.take() {
            session.stop().await;
        }
    }
    // A late disconnect from an obsolete webview must not close a newer session.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn install_session(state: &AssistantState, id: u64) {
        let (input, mut receiver) = mpsc::channel(1);
        let run = tokio::spawn(async move {
            let _ = receiver.recv().await;
        });
        let forward = tokio::spawn(std::future::pending());
        *state.session.lock().await = Some(NativeSession {
            id,
            view_epoch: state.view_epoch.load(Ordering::Acquire),
            input,
            run,
            forward,
            workspace: Arc::new(WorkspaceLease::open(WorkspaceMode::Temporary, None).unwrap()),
            last_workspace: state.last_workspace.clone(),
            on_event: None,
            audio: Arc::new(BroadcastAudio::default()),
            voice_control: session::BroadcastControl::default(),
        });
    }

    #[tokio::test]
    async fn reload_rejects_old_commands_without_closing_the_new_view() {
        let state = AssistantState::default();
        install_session(&state, 1).await;
        assert!(active_input(&state, 1).await.is_ok());
        state.invalidate_view();
        assert!(active_input(&state, 1).await.is_err());
        state.close_stale_view().await;
        assert!(state.session.lock().await.is_none());

        install_session(&state, 2).await;
        // A delayed cleanup from the previous page must spare this new session.
        state.close_stale_view().await;
        assert!(active_input(&state, 2).await.is_ok());
        assert!(active_input(&state, 1).await.is_err());
        state.shutdown().await;
        assert!(state.session.lock().await.is_none());
    }

    #[test]
    fn ipc_rejects_invalid_message_shapes_and_control_commands() {
        assert!(valid_message(&json!({"type":"agent_task","task":"Check a file"})).is_ok());
        assert!(valid_message(&json!({"type":"connect","token":"no"})).is_err());
        assert!(valid_message(&json!({"type":"disconnect"})).is_err());
        assert!(valid_message(&json!([])).is_err());
        assert!(
            valid_message(&json!({"type":"text","text":"x".repeat(MAX_LOCAL_MESSAGE)})).is_err()
        );
    }

    #[test]
    fn custom_options_validate_native_boundary_and_preserve_effective_routing() {
        let input: ConnectOptions = serde_json::from_value(json!({
            "scenario":"custom","custom_name":"  Режим SQL  ",
            "custom_instructions":"  Отвечай кратко.\nПоказывай SQL.  ",
            "custom_behavior":"on_request"
        }))
        .unwrap();
        let (config, workspace) = options(input).unwrap();
        assert_eq!(config.scenario, session::Scenario::Custom);
        assert_eq!(config.custom_name, "Режим SQL");
        assert_eq!(
            config.custom_instructions,
            "  Отвечай кратко.\nПоказывай SQL.  "
        );
        assert_eq!(config.custom_behavior, session::CustomBehavior::OnRequest);
        assert!(config.uses_meeting_audio());
        assert_eq!(workspace.cleanup().cleanup_status, CleanupStatus::Removed);
        for invalid in [
            ConnectOptions {
                custom_name: "я".repeat(65),
                ..Default::default()
            },
            ConnectOptions {
                custom_name: "bad\nname".into(),
                ..Default::default()
            },
            ConnectOptions {
                custom_instructions: "я".repeat(12_001),
                ..Default::default()
            },
            ConnectOptions {
                custom_instructions: "bad\0prompt".into(),
                ..Default::default()
            },
        ] {
            assert!(options(invalid).is_err());
        }
        assert!(
            serde_json::from_value::<ConnectOptions>(
                json!({"scenario":"custom","custom_behavior":"unrestricted"})
            )
            .is_err()
        );
    }
    #[test]
    fn options_keep_default_provider_and_reject_control_characters() {
        let (config, workspace) = options(ConnectOptions::default()).unwrap();
        assert!(config.workspace.is_dir());
        assert!(config.model.is_none());
        assert!(config.effort.is_none());
        assert!(config.realtime);
        assert_eq!(workspace.status().mode, WorkspaceMode::Temporary);
        assert_eq!(std::fs::read_dir(workspace.path()).unwrap().count(), 0);
        assert_eq!(workspace.cleanup().cleanup_status, CleanupStatus::Removed);
        assert!(
            options(ConnectOptions {
                model: "model\nsecret".into(),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            options(ConnectOptions {
                workspace_mode: WorkspaceMode::Project,
                workspace: "relative".into(),
                ..Default::default()
            })
            .is_err()
        );
        assert!(
            options(ConnectOptions {
                realtime_model: "third-party".into(),
                ..Default::default()
            })
            .is_err()
        );
    }
}

#[cfg(test)]
#[path = "assistant_workspace_tests.rs"]
mod workspace_tests;
