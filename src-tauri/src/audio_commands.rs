use crate::audio::{
    self, AudioConfig, AudioEvent, AudioState, CaptureMode, InputState, SystemAudioEvent,
    SystemAudioState,
};
use tauri::{ipc::Channel, State};

/// Device discovery is independent of Codex, Realtime, and WebView permissions.
#[tauri::command]
pub async fn audio_input_state() -> Result<InputState, String> {
    tauri::async_runtime::spawn_blocking(audio::input_state)
        .await
        .map_err(|_| "Не удалось проверить аудиоустройства Windows.".to_string())
}

/// The native worker owns capture and DSP. Test mode never emits PCM to the UI.
#[tauri::command]
pub async fn audio_start(
    state: State<'_, AudioState>,
    mode: CaptureMode,
    device_id: Option<String>,
    noise_suppression: bool,
    on_event: Channel<AudioEvent>,
) -> Result<u64, String> {
    if device_id
        .as_ref()
        .is_some_and(|id| id.len() > 4096 || id.chars().any(char::is_control))
    {
        return Err("Некорректное устройство ввода.".into());
    }
    let audio = state.inner().clone();
    // Capture the permission to start before entering the blocking queue. Closing
    // the settings/view while queued invalidates this ticket before any device opens.
    let ticket = audio.start_ticket(mode);
    tauri::async_runtime::spawn_blocking(move || {
        audio.start_with_ticket(
            AudioConfig {
                device_id: device_id.filter(|id| !id.is_empty()),
                mode,
                noise_suppression,
            },
            ticket,
            move |event| on_event.send(event).is_ok(),
        )
    })
    .await
    .map_err(|_| "Не удалось запустить обработку микрофона.".to_string())?
}

/// A delayed stop from an old view or input cannot stop its replacement.
#[tauri::command]
pub async fn audio_stop(state: State<'_, AudioState>, capture_id: u64) -> Result<(), String> {
    let audio = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || audio.stop(Some(capture_id)))
        .await
        .map_err(|_| "Не удалось остановить микрофон.".to_string())?
}

/// Processing switches on the existing stream; toggling a filter must not reopen
/// a USB endpoint or interrupt the Realtime microphone interval.
#[tauri::command]
pub fn audio_set_noise_suppression(
    state: State<'_, AudioState>,
    capture_id: u64,
    enabled: bool,
) -> Result<(), String> {
    state.set_noise_suppression(capture_id, enabled)
}

/// Render endpoint inventory only; this never starts recording.
#[tauri::command]
pub async fn system_audio_state() -> Result<InputState, String> {
    tauri::async_runtime::spawn_blocking(audio::system_state)
        .await
        .map_err(|_| "Не удалось проверить устройства вывода Windows.".to_string())
}

/// A distinct native state allows microphone and output loopback to run together.
/// Output is the selected endpoint's complete mix, not participant-specific audio.
#[tauri::command]
pub async fn system_audio_start(
    state: State<'_, SystemAudioState>,
    mode: CaptureMode,
    device_id: Option<String>,
    noise_suppression: bool,
    on_event: Channel<SystemAudioEvent>,
) -> Result<u64, String> {
    if device_id
        .as_ref()
        .is_some_and(|id| id.len() > 4096 || id.chars().any(char::is_control))
    {
        return Err("Некорректное устройство вывода.".into());
    }
    let audio = state.inner().clone();
    let ticket = audio.start_ticket(mode);
    tauri::async_runtime::spawn_blocking(move || {
        audio.start_with_ticket(
            AudioConfig {
                device_id: device_id.filter(|id| !id.is_empty()),
                mode,
                noise_suppression,
            },
            ticket,
            move |event| on_event.send(event.into()).is_ok(),
        )
    })
    .await
    .map_err(|_| "Не удалось запустить захват системного звука.".to_string())?
}

/// Exact IDs cannot stop a different microphone or a replacement output capture.
#[tauri::command]
pub async fn system_audio_stop(
    state: State<'_, SystemAudioState>,
    capture_id: u64,
) -> Result<(), String> {
    let audio = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || audio.stop(Some(capture_id)))
        .await
        .map_err(|_| "Не удалось остановить захват системного звука.".to_string())?
}
