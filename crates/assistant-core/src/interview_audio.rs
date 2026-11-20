//! In-memory PCM window for source-labelled speaker segments. No audio files.
use std::collections::VecDeque;

const BYTES_PER_MS: u64 = 48; // PCM16 mono, 24 kHz.
const RETAIN_MS: u64 = 40_000;
const MAX_SEGMENT_MS: u64 = 30_000;

#[derive(Default)]
pub(crate) struct AudioWindow {
    bytes: VecDeque<u8>,
    start: u64,
    end: u64,
}
impl AudioWindow {
    pub fn push(&mut self, pcm: &[u8]) {
        self.bytes.extend(pcm);
        self.end = self.end.saturating_add(pcm.len() as u64);
        let limit = (RETAIN_MS * BYTES_PER_MS) as usize;
        if self.bytes.len() > limit {
            let discard = self.bytes.len() - limit;
            self.bytes.drain(..discard);
            self.start = self.start.saturating_add(discard as u64);
        }
    }
    /// Clear retained voice data, but preserve the provider session's timeline.
    pub fn clear(&mut self) {
        self.bytes.clear();
        self.start = self.end;
    }
    pub fn extract(&self, start_ms: u64, end_ms: u64) -> Option<Vec<u8>> {
        let duration = end_ms.checked_sub(start_ms)?;
        if duration == 0 || duration > MAX_SEGMENT_MS {
            return None;
        }
        let start = start_ms.checked_mul(BYTES_PER_MS)?;
        let end = end_ms.checked_mul(BYTES_PER_MS)?;
        if start < self.start || end > self.end || end <= start {
            return None;
        }
        let offset = usize::try_from(start - self.start).ok()?;
        let len = usize::try_from(end - start).ok()?;
        Some(self.bytes.iter().skip(offset).take(len).copied().collect())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn slicing_uses_provider_sample_timeline_and_rejects_missing_audio() {
        let mut audio = AudioWindow::default();
        audio.push(&vec![1; 4800]);
        audio.push(&vec![2; 4800]);
        audio.push(&vec![3; 4800]);
        assert_eq!(audio.extract(100, 200).unwrap(), vec![2; 4800]);
        assert!(audio.extract(300, 400).is_none());
        assert!(audio.extract(200, 100).is_none());
        assert!(audio.extract(u64::MAX - 1, u64::MAX).is_none());
    }
    #[test]
    fn pause_discards_pcm_without_relabelling_late_previous_segments() {
        let mut audio = AudioWindow::default();
        audio.push(&vec![1; 4800]);
        audio.clear();
        audio.push(&vec![2; 4800]);
        assert!(audio.extract(0, 100).is_none());
        assert_eq!(audio.extract(100, 200).unwrap(), vec![2; 4800]);
    }
    #[test]
    fn long_meetings_have_fixed_memory_and_unavailable_old_segments() {
        let mut audio = AudioWindow::default();
        for _ in 0..1000 {
            audio.push(&[0; 4800]);
        }
        assert_eq!(audio.bytes.len(), (RETAIN_MS * BYTES_PER_MS) as usize);
        assert!(audio.extract(0, 4000).is_none());
        assert!(audio.extract(60_000, 91_000).is_none());
        assert_eq!(audio.extract(90_000, 94_000).unwrap().len(), 192_000);
        audio.clear();
        assert!(audio.bytes.is_empty());
    }
}
