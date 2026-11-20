//! Native IPC adapter. Provider credentials and child processes stay in Rust.
use assistant_core::{
    bridge::{MAX_AUDIO_BYTES, MAX_LOCAL_MESSAGE},
    session::{self, SessionConfig, SessionInput},
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::atomic::{AtomicU64, Ordering},
    time::Duration,
};
use tauri::{ipc::Channel, State};
use tokio::{
    sync::{mpsc, Mutex},
    task::JoinHandle,
};

const INPUT_QUEUE_SIZE: usize = 96;
const EVENT_QUEUE_SIZE: usize = 256;

#[derive(Default)]
pub struct AssistantState {
    session: Mutex<Option<NativeSession>>,
    next_id: AtomicU64,
    view_epoch: AtomicU64,
}

struct NativeSession {
    id: u64,
    view_epoch: u64,
    input: mpsc::Sender<SessionInput>,
    run: JoinHandle<()>,
    forward: JoinHandle<()>,
}

impl NativeSession {
    async fn stop(mut self) {
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
    }
}

impl Drop for NativeSession {
    fn drop(&mut self) {
        // Aborting the core drops its agent handle, closing the app-server process
        // and its provider socket. No orphaned session survives the native window.
        self.run.abort();
        self.forward.abort();
    }
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
    workspace: String,
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
            workspace: String::new(),
            model: String::new(),
            effort: String::new(),
            web_search: true,
            parallel: true,
            realtime: true,
            realtime_model: assistant_core::provider::MODEL_DEFAULT.into(),
        }
    }
}

fn default_workspace() -> PathBuf {
    std::env::current_dir()
        .ok()
        .filter(|path| path.is_dir())
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn optional_setting(value: String, name: &str, limit: usize) -> Result<Option<String>, String> {
    let value = value.trim();
    if value.len() > limit || value.chars().any(char::is_control) {
        return Err(format!("Invalid {name} setting"));
    }
    Ok((!value.is_empty()).then(|| value.to_owned()))
}

fn options(config: ConnectOptions) -> Result<SessionConfig, String> {
    if config.workspace.len() > 4096 || config.workspace.chars().any(char::is_control) {
        return Err("Invalid workspace path".into());
    }
    let path = if config.workspace.trim().is_empty() {
        default_workspace()
    } else {
        PathBuf::from(config.workspace.trim())
    };
    if !path.is_absolute() || !path.is_dir() {
        return Err("Выбери существующую рабочую папку с абсолютным путём.".into());
    }
    if !assistant_core::provider::allowed_model(&config.realtime_model) {
        return Err("Неподдерживаемая модель Realtime.".into());
    }
    Ok(SessionConfig {
        workspace: path,
        model: optional_setting(config.model, "model", 128)?,
        effort: optional_setting(config.effort, "effort", 32)?,
        web_search: config.web_search,
        parallel: config.parallel,
        realtime: config.realtime,
        realtime_model: config.realtime_model,
    })
}

#[tauri::command]
pub async fn assistant_status() -> Result<Value, String> {
    Ok(session::status(&default_workspace()).await)
}

#[tauri::command]
pub async fn assistant_connect(
    state: State<'_, AssistantState>,
    config: ConnectOptions,
    on_event: Channel<Value>,
) -> Result<u64, String> {
    let view_epoch = state.view_epoch.load(Ordering::Acquire);
    // Validate before replacing an existing session.
    let config = options(config)?;
    let mut slot = state.session.lock().await;
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
    let run = tokio::spawn(async move {
        if let Err(error) = session::run(config, input_rx, events_tx).await {
            // SafeError contains fixed/sanitized text, never provider bodies.
            let _ = final_events
                .send(json!({"type":"agent_error","message":error.to_string()}))
                .await;
        }
        let _ = final_events
            .send(json!({"type":"session_closed","message":"Сессия закрыта."}))
            .await;
    });
    let abort_run = run.abort_handle();
    let forward = tokio::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            if on_event.send(event).is_err() {
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
        "agent_task",
        "agent_interrupt",
        "agent_approval",
        "agent_input",
        "agent_models",
        "models",
        "text",
        "mic_start",
        "mic_stop",
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

#[tauri::command]
pub async fn assistant_send(
    state: State<'_, AssistantState>,
    session_id: u64,
    message: Value,
) -> Result<(), String> {
    valid_message(&message)?;
    let input = active_input(&state, session_id).await?;
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
    audio: Vec<u8>,
) -> Result<(), String> {
    if audio.is_empty() || audio.len() > MAX_AUDIO_BYTES || !audio.len().is_multiple_of(2) {
        return Err("Некорректный PCM16 аудиофрагмент.".into());
    }
    // Audio must never wait behind an unbounded queue. Let the frontend stop the
    // microphone explicitly on backpressure rather than accumulate stale speech.
    active_input(&state, session_id)
        .await?
        .try_send(SessionInput::Audio(audio))
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
    fn options_keep_default_provider_and_reject_control_characters() {
        let config = options(ConnectOptions::default()).unwrap();
        assert!(config.workspace.is_dir());
        assert!(config.model.is_none());
        assert!(config.effort.is_none());
        assert!(config.realtime);
        assert!(options(ConnectOptions {
            model: "model\nsecret".into(),
            ..Default::default()
        })
        .is_err());
        assert!(options(ConnectOptions {
            workspace: "relative".into(),
            ..Default::default()
        })
        .is_err());
        assert!(options(ConnectOptions {
            realtime_model: "third-party".into(),
            ..Default::default()
        })
        .is_err());
    }
}
