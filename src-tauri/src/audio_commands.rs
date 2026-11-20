use crate::{
    assistant::{AssistantState, BroadcastAudio},
    audio::{
        self, AudioConfig, AudioEvent, AudioState, CaptureMode, InputState, StartTicket,
        SystemAudioEvent, SystemAudioState,
    },
};
use std::sync::Arc;
use tauri::{State, ipc::Channel};

struct CapturePermission {
    ticket: StartTicket,
    binding: Option<(Arc<BroadcastAudio>, String)>,
}
impl CapturePermission {
    fn current(&self) -> bool {
        self.binding
            .as_ref()
            .is_none_or(|(owner, id)| owner.live(id))
    }
}
async fn prepare_capture(
    assistant: &AssistantState,
    audio: &AudioState,
    mode: CaptureMode,
    session_id: Option<u64>,
    broadcast_id: Option<String>,
) -> Result<CapturePermission, String> {
    if mode == CaptureMode::Test {
        return Ok(CapturePermission {
            ticket: audio.start_ticket(mode),
            binding: None,
        });
    }
    let session_id =
        session_id.ok_or_else(|| "Для передачи звука нужен активный эфир.".to_owned())?;
    let broadcast_id = broadcast_id.ok_or_else(|| "Не задан идентификатор эфира.".to_owned())?;
    let binding = assistant.audio_binding(session_id, &broadcast_id).await?;
    let ticket = binding.ticket(&broadcast_id, audio)?;
    Ok(CapturePermission {
        ticket,
        binding: Some((binding, broadcast_id)),
    })
}
fn validate_device(device_id: &Option<String>) -> Result<(), String> {
    if device_id
        .as_ref()
        .is_some_and(|id| id.len() > 4096 || id.chars().any(char::is_control))
    {
        Err("Некорректное аудиоустройство.".into())
    } else {
        Ok(())
    }
}
#[tauri::command]
pub async fn audio_input_state() -> Result<InputState, String> {
    tauri::async_runtime::spawn_blocking(audio::input_state)
        .await
        .map_err(|_| "Не удалось проверить аудиоустройства Windows.".to_string())
}
/// Flat IPC fields preserve the existing UI contract; only stream mode requires ownership.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn audio_start(
    state: State<'_, AudioState>,
    assistant: State<'_, AssistantState>,
    mode: CaptureMode,
    device_id: Option<String>,
    noise_suppression: bool,
    on_event: Channel<AudioEvent>,
    session_id: Option<u64>,
    broadcast_id: Option<String>,
) -> Result<u64, String> {
    validate_device(&device_id)?;
    let audio = state.inner().clone();
    let permission = prepare_capture(&assistant, &audio, mode, session_id, broadcast_id).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let id = audio.start_with_ticket(
            AudioConfig {
                device_id: device_id.filter(|id| !id.is_empty()),
                mode,
                noise_suppression,
            },
            permission.ticket,
            move |event| on_event.send(event).is_ok(),
        )?;
        if !permission.current() {
            audio.stop(Some(id))?;
            return Err("Запуск микрофона отменён: эфир завершён.".into());
        }
        Ok(id)
    })
    .await
    .map_err(|_| "Не удалось запустить обработку микрофона.".to_string())?
}
#[tauri::command]
pub async fn audio_stop(state: State<'_, AudioState>, capture_id: u64) -> Result<(), String> {
    let audio = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || audio.stop(Some(capture_id)))
        .await
        .map_err(|_| "Не удалось остановить микрофон.".to_string())?
}
#[tauri::command]
pub fn audio_set_noise_suppression(
    state: State<'_, AudioState>,
    capture_id: u64,
    enabled: bool,
) -> Result<(), String> {
    state.set_noise_suppression(capture_id, enabled)
}
#[tauri::command]
pub async fn system_audio_state() -> Result<InputState, String> {
    tauri::async_runtime::spawn_blocking(audio::system_state)
        .await
        .map_err(|_| "Не удалось проверить устройства вывода Windows.".to_string())
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn system_audio_start(
    state: State<'_, SystemAudioState>,
    assistant: State<'_, AssistantState>,
    mode: CaptureMode,
    device_id: Option<String>,
    noise_suppression: bool,
    on_event: Channel<SystemAudioEvent>,
    session_id: Option<u64>,
    broadcast_id: Option<String>,
) -> Result<u64, String> {
    validate_device(&device_id)?;
    let audio = state.inner().clone();
    let permission = prepare_capture(&assistant, &audio, mode, session_id, broadcast_id).await?;
    tauri::async_runtime::spawn_blocking(move || {
        let id = audio.start_with_ticket(
            AudioConfig {
                device_id: device_id.filter(|id| !id.is_empty()),
                mode,
                noise_suppression,
            },
            permission.ticket,
            move |event| on_event.send(event.into()).is_ok(),
        )?;
        if !permission.current() {
            audio.stop(Some(id))?;
            return Err("Запуск звука встречи отменён: эфир завершён.".into());
        }
        Ok(id)
    })
    .await
    .map_err(|_| "Не удалось запустить захват системного звука.".to_string())?
}
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn stream_requires_a_live_binding_but_local_test_does_not() {
        let assistant = AssistantState::default();
        let audio = AudioState::default();
        assert!(
            prepare_capture(&assistant, &audio, CaptureMode::Stream, None, None)
                .await
                .is_err()
        );
        assert!(
            prepare_capture(
                &assistant,
                &audio,
                CaptureMode::Stream,
                Some(99),
                Some("old".into())
            )
            .await
            .is_err()
        );
        let test = prepare_capture(&assistant, &audio, CaptureMode::Test, None, None)
            .await
            .unwrap();
        assert!(test.current());
        assert!(audio.ticket_valid_for_test(test.ticket, CaptureMode::Test));
    }
}
