//! Align anonymous voice evidence with source-local Realtime utterances.
//! Every listening period owns a fresh worker and inbox. Audio and profiles
//! stay in memory; an old worker can never label a later listening period.
use crate::{
    interview::Source,
    interview_audio::AudioWindow,
    speakers::{SpeakerEvent, SpeakerHandle, SpeakerSegment, SpeakerUtterance},
};
use serde_json::Value;
use std::{collections::VecDeque, path::Path};
use tokio::sync::mpsc;

const MAX_ITEMS: usize = 64;

struct Item {
    id: String,
    start_ms: u64,
    end_ms: Option<u64>,
    known_overlap: bool,
    utterance_id: Option<u64>,
    speaker: Option<String>,
}

pub(crate) struct Attribution {
    pub utterance_id: u64,
    pub speaker: Option<String>,
}

pub(crate) struct SpeakerTracker {
    audio: AudioWindow,
    items: VecDeque<Item>,
    current: Option<String>,
    worker: Option<SpeakerHandle>,
    inbox: mpsc::Receiver<SpeakerEvent>,
    receiving: bool,
}

impl Default for SpeakerTracker {
    fn default() -> Self {
        let (_, inbox) = mpsc::channel(16);
        Self {
            audio: AudioWindow::default(),
            items: VecDeque::new(),
            current: None,
            worker: None,
            inbox,
            receiving: false,
        }
    }
}

pub(crate) fn speaker_label(speaker: Option<&str>) -> String {
    speaker
        .and_then(speaker_number)
        .map(|number| format!("Участник {number}"))
        .unwrap_or_else(|| Source::System.label().to_owned())
}

fn speaker_number(id: &str) -> Option<u32> {
    id.strip_prefix("anonymous-")
        .and_then(|number| number.parse::<u32>().ok())
        .filter(|number| (1..=12).contains(number))
}

impl SpeakerTracker {
    pub fn start(&mut self, assets: Option<&Path>) -> Result<bool, String> {
        self.stop();
        let Some(assets) = assets else {
            return Ok(false);
        };
        let (events, inbox) = mpsc::channel(16);
        let worker = SpeakerHandle::spawn(assets.to_owned(), events)?;
        self.inbox = inbox;
        self.worker = Some(worker);
        self.receiving = true;
        Ok(true)
    }

    pub fn stop(&mut self) {
        self.worker.take();
        self.inbox.close();
        while self.inbox.try_recv().is_ok() {}
        self.receiving = false;
        self.audio.clear();
        self.items.clear();
        self.current = None;
    }

    pub fn receiving(&self) -> bool {
        self.receiving
    }

    pub async fn recv(&mut self) -> Option<SpeakerEvent> {
        let event = self.inbox.recv().await;
        if event.is_none() {
            self.receiving = false;
        }
        event
    }

    /// Called only after the same PCM was accepted by the meeting socket queue.
    pub fn push(&mut self, pcm: &[u8]) {
        self.audio.push(pcm);
    }

    pub fn started(&mut self, source: Source, event: &Value, microphone_speaking: bool) {
        if source == Source::Microphone {
            if let Some(item) = self
                .items
                .iter_mut()
                .find(|item| Some(&item.id) == self.current.as_ref())
            {
                item.known_overlap = true;
            }
            return;
        }
        let (Some(id), Some(start_ms)) =
            (event["item_id"].as_str(), event["audio_start_ms"].as_u64())
        else {
            return;
        };
        if id.is_empty() || id.len() > 256 || self.items.iter().any(|item| item.id == id) {
            return;
        }
        self.items.push_back(Item {
            id: id.to_owned(),
            start_ms,
            end_ms: None,
            known_overlap: microphone_speaking,
            utterance_id: None,
            speaker: None,
        });
        self.current = Some(id.to_owned());
        while self.items.len() > MAX_ITEMS {
            self.items.pop_front();
        }
    }

    pub fn stopped(&mut self, source: Source, event: &Value) {
        if source != Source::System {
            return;
        }
        let (Some(id), Some(end_ms)) = (event["item_id"].as_str(), event["audio_end_ms"].as_u64())
        else {
            return;
        };
        if self.current.as_deref() != Some(id) {
            return;
        }
        self.current = None;
        let Some(item) = self.items.iter_mut().find(|item| item.id == id) else {
            return;
        };
        item.end_ms = Some(end_ms);
        if let Some(worker) = &self.worker
            && let Some(pcm) = self.audio.extract(item.start_ms, end_ms)
        {
            // Busy/missing evidence means unknown, never an invented label.
            let _ = worker.submit(SpeakerUtterance {
                item_id: item.id.clone(),
                start_ms: item.start_ms,
                end_ms,
                pcm,
                known_overlap: item.known_overlap,
            });
        }
    }

    /// Transcription and local inference may finish in either order.
    pub fn transcribed(&mut self, item_id: &str, utterance_id: u64) -> Option<String> {
        let item = self.items.iter_mut().find(|item| item.id == item_id)?;
        item.utterance_id = Some(utterance_id);
        item.speaker.clone()
    }

    pub fn segment(&mut self, segment: SpeakerSegment) -> Option<Attribution> {
        let item = self
            .items
            .iter_mut()
            .find(|item| item.id == segment.item_id)?;
        if item.start_ms != segment.start_ms || item.end_ms != Some(segment.end_ms) {
            return None;
        }
        item.speaker = segment
            .speaker_id
            .filter(|id| !item.known_overlap && speaker_number(id).is_some());
        item.utterance_id.map(|utterance_id| Attribution {
            utterance_id,
            speaker: item.speaker.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn speech(tracker: &mut SpeakerTracker, id: &str, start: u64, end: u64) {
        tracker.started(
            Source::System,
            &json!({"item_id":id,"audio_start_ms":start}),
            false,
        );
        tracker.stopped(Source::System, &json!({"item_id":id,"audio_end_ms":end}));
    }
    fn segment(id: &str, start: u64, end: u64, speaker: &str) -> SpeakerSegment {
        SpeakerSegment {
            item_id: id.into(),
            start_ms: start,
            end_ms: end,
            speaker_id: Some(speaker.into()),
            similarity: Some(0.9),
            detail: String::new(),
        }
    }

    #[test]
    fn inference_before_and_after_transcription_labels_only_matching_utterance() {
        let mut tracker = SpeakerTracker::default();
        speech(&mut tracker, "first", 0, 4000);
        speech(&mut tracker, "second", 4000, 8000);
        assert!(
            tracker
                .segment(segment("first", 0, 4000, "anonymous-1"))
                .is_none()
        );
        assert_eq!(
            tracker.transcribed("first", 10).as_deref(),
            Some("anonymous-1")
        );
        assert!(tracker.transcribed("second", 11).is_none());
        let late = tracker
            .segment(segment("second", 4000, 8000, "anonymous-2"))
            .unwrap();
        assert_eq!(late.utterance_id, 11);
        assert_eq!(late.speaker.as_deref(), Some("anonymous-2"));
        assert!(
            tracker
                .segment(segment("second", 4001, 8000, "anonymous-1"))
                .is_none()
        );
        assert!(
            tracker
                .segment(segment("unrelated", 4000, 8000, "anonymous-1"))
                .is_none()
        );
    }

    #[test]
    fn pause_discards_old_attribution_and_keeps_provider_pcm_clock() {
        let mut tracker = SpeakerTracker::default();
        tracker.push(&vec![1; 4800]);
        speech(&mut tracker, "old", 0, 100);
        tracker.transcribed("old", 10);
        tracker.stop();
        assert!(
            tracker
                .segment(segment("old", 0, 100, "anonymous-1"))
                .is_none()
        );
        assert!(!tracker.receiving());
        tracker.push(&vec![2; 4800]);
        assert!(tracker.audio.extract(0, 100).is_none());
        assert_eq!(tracker.audio.extract(100, 200).unwrap(), vec![2; 4800]);
        assert!(tracker.items.is_empty());
    }

    #[test]
    fn known_overlap_and_untrusted_labels_stay_unknown() {
        let mut tracker = SpeakerTracker::default();
        tracker.started(
            Source::System,
            &json!({"item_id":"overlap","audio_start_ms":0}),
            false,
        );
        tracker.started(Source::Microphone, &json!({"item_id":"local"}), true);
        tracker.stopped(
            Source::System,
            &json!({"item_id":"overlap","audio_end_ms":4000}),
        );
        tracker.transcribed("overlap", 1);
        assert!(
            tracker
                .segment(segment("overlap", 0, 4000, "anonymous-1"))
                .unwrap()
                .speaker
                .is_none()
        );
        speech(&mut tracker, "invalid-label", 4000, 8000);
        tracker.transcribed("invalid-label", 2);
        assert!(
            tracker
                .segment(segment("invalid-label", 4000, 8000, "Anna"))
                .unwrap()
                .speaker
                .is_none()
        );
        assert_eq!(speaker_label(Some("anonymous-2")), "Участник 2");
        assert_eq!(speaker_label(Some("anonymous-99")), Source::System.label());
    }

    #[test]
    fn incomplete_and_old_items_have_bounded_memory() {
        let mut tracker = SpeakerTracker::default();
        for i in 0..1000 {
            tracker.started(
                Source::System,
                &json!({"item_id":i.to_string(),"audio_start_ms":i*100}),
                false,
            );
        }
        assert_eq!(tracker.items.len(), MAX_ITEMS);
        assert!(tracker.transcribed("0", 1).is_none());
        assert!(
            tracker
                .segment(segment("999", 99900, 100000, "anonymous-1"))
                .is_none()
        );
    }
}
