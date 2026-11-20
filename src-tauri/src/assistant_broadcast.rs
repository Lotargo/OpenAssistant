//! Session-owned permission to capture. Stop fences queued native starts before UI delivery.
use crate::audio::{AudioState, CaptureMode, StartTicket, StreamStop, SystemAudioState};
use serde_json::Value;
use std::sync::{Mutex, MutexGuard};

#[derive(Default)]
struct Gate {
    id: Option<String>,
    live: bool,
    terminal: bool,
    stop: Option<[StreamStop; 2]>,
}
pub(crate) struct BroadcastAudio {
    microphone: AudioState,
    system: SystemAudioState,
    gate: Mutex<Gate>,
}
impl Default for BroadcastAudio {
    fn default() -> Self {
        Self::new(AudioState::default(), SystemAudioState::default())
    }
}
impl BroadcastAudio {
    pub fn new(microphone: AudioState, system: SystemAudioState) -> Self {
        Self {
            microphone,
            system,
            gate: Mutex::new(Gate::default()),
        }
    }
    fn gate(&self) -> MutexGuard<'_, Gate> {
        self.gate
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    pub fn validate_id(id: &str) -> Result<(), String> {
        if !id.is_empty() && id.chars().count() <= 80 && !id.chars().any(char::is_control) {
            Ok(())
        } else {
            Err("Некорректный идентификатор эфира.".into())
        }
    }
    pub fn start(&self, id: &str) -> Result<(), String> {
        Self::validate_id(id)?;
        let mut gate = self.gate();
        if gate.terminal || gate.id.as_deref().is_some_and(|current| current != id) {
            return Err("Этот эфир уже завершён. Для нового эфира нужна новая сессия.".into());
        }
        gate.id = Some(id.to_owned());
        Ok(())
    }
    pub fn live(&self, id: &str) -> bool {
        let gate = self.gate();
        gate.live && !gate.terminal && gate.id.as_deref() == Some(id)
    }
    pub fn require_live(&self, id: &str) -> Result<(), String> {
        Self::validate_id(id)?;
        if self.live(id) {
            Ok(())
        } else {
            Err("Эфир не активен или уже завершён.".into())
        }
    }
    pub fn ticket(&self, id: &str, audio: &AudioState) -> Result<StartTicket, String> {
        let gate = self.gate();
        if !gate.live || gate.terminal || gate.id.as_deref() != Some(id) {
            return Err("Запуск захвата отменён: эфир не активен.".into());
        }
        // Stop holds this same gate while invalidating the stream epoch.
        Ok(audio.start_ticket(CaptureMode::Stream))
    }
    pub fn terminal(&self) -> bool {
        self.gate().terminal
    }
    pub fn stop(&self, id: &str) -> Result<(), String> {
        Self::validate_id(id)?;
        let mut gate = self.gate();
        if gate.id.as_deref() != Some(id) {
            return Err("Команда относится к другому эфиру.".into());
        }
        self.cancel_locked(&mut gate);
        Ok(())
    }
    fn cancel_locked(&self, gate: &mut Gate) {
        gate.live = false;
        gate.terminal = true;
        if gate.stop.is_none() {
            gate.stop = Some([
                self.microphone.invalidate_stream(),
                self.system.invalidate_stream(),
            ]);
        }
    }
    pub fn cancel(&self) {
        self.cancel_locked(&mut self.gate());
    }
    pub async fn join(&self) -> Result<(), String> {
        let stops = {
            let mut gate = self.gate();
            self.cancel_locked(&mut gate);
            gate.stop.clone().unwrap()
        };
        tokio::task::spawn_blocking(move || {
            stops[0].join()?;
            stops[1].join()
        })
        .await
        .map_err(|_| "Не удалось завершить аудиопотоки.".to_owned())?
    }
    /// Called in the native forwarder before the event reaches WebView. A ready
    /// status precedes live in core, so it also opens the gate before JS starts capture.
    pub fn observe(&self, event: &Value) -> bool {
        if event["type"] == "status" && event["stage"] == "ready" && event["realtime"] == true {
            let mut gate = self.gate();
            if gate.id.is_some() && !gate.terminal {
                gate.live = true;
            }
        }
        if event["type"] != "broadcast_state" {
            return false;
        }
        let Some(id) = event["broadcast_id"].as_str() else {
            return false;
        };
        let mut gate = self.gate();
        if gate.id.as_deref() != Some(id) {
            return false;
        }
        match event["stage"].as_str() {
            Some("live") if !gate.terminal => gate.live = true,
            Some("stopping" | "ended") => {
                self.cancel_locked(&mut gate);
                return true;
            }
            _ => {}
        }
        false
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[tokio::test]
    async fn pending_stream_start_is_fenced_without_canceling_a_local_test_or_new_owner() {
        let microphone = AudioState::default();
        let system = SystemAudioState::default();
        let owner = BroadcastAudio::new(microphone.clone(), system.clone());
        owner.start("old").unwrap();
        owner.observe(&json!({"type":"status","stage":"ready","realtime":true}));
        let ticket = owner.ticket("old", &microphone).unwrap();
        let test_ticket = microphone.start_ticket(CaptureMode::Test);
        owner.stop("old").unwrap();
        assert!(!owner.live("old"));
        assert!(owner.start("new").is_err());
        let result = microphone.start_with_ticket(
            crate::audio::AudioConfig {
                device_id: Some("invalid-device".into()),
                mode: CaptureMode::Stream,
                noise_suppression: false,
            },
            ticket,
            |_| panic!("stale broadcast must not emit audio"),
        );
        assert!(result.unwrap_err().contains("отменён"));
        owner.join().await.unwrap();
        // A test ticket remains valid: invalid selection is checked before any device access.
        assert!(microphone.ticket_valid_for_test(test_ticket, CaptureMode::Test));
        let newer = BroadcastAudio::new(microphone.clone(), system);
        newer.start("new").unwrap();
        newer.observe(&json!({"type":"status","stage":"ready","realtime":true}));
        let fresh = newer.ticket("new", &microphone).unwrap();
        owner.observe(&json!({"type":"broadcast_state","broadcast_id":"old","stage":"ended"}));
        owner.join().await.unwrap();
        assert!(microphone.ticket_valid_for_test(fresh, CaptureMode::Stream));
        assert!(microphone.ticket_valid_for_test(test_ticket, CaptureMode::Test));
        newer.join().await.unwrap();
    }
    #[test]
    fn unbound_and_mismatched_capture_never_receives_a_ticket() {
        let owner = BroadcastAudio::default();
        assert!(owner.ticket("unknown", &AudioState::default()).is_err());
        owner.start("one").unwrap();
        assert!(owner.ticket("one", &AudioState::default()).is_err());
        owner.observe(&json!({"type":"broadcast_state","broadcast_id":"one","stage":"live"}));
        assert!(owner.require_live("one").is_ok());
        assert!(owner.stop("other").is_err());
        assert!(owner.require_live("one").is_ok());
        owner.cancel();
        assert!(owner.require_live("one").is_err());
    }
}
