//! Clock for idle WASAPI render endpoints. Silence completes VAD utterances even
//! when Windows emits no packets. Real capture timestamps prevent duplicate backlog.
use std::time::Duration;

const GRACE: Duration = Duration::from_millis(150);
const MAX_GAP: Duration = Duration::from_millis(500);

pub(super) struct Plan {
    pub silence: usize,
    pub skip: usize,
}

pub(super) struct LoopbackClock {
    rate: u32,
    anchor_time: Duration,
    anchor_frame: i128,
    next_frame: i128,
}

impl LoopbackClock {
    pub fn new(rate: u32) -> Self {
        Self {
            rate,
            anchor_time: Duration::ZERO,
            anchor_frame: 0,
            next_frame: 0,
        }
    }

    fn frames(&self, duration: Duration) -> i128 {
        (duration.as_nanos() * self.rate as u128 / 1_000_000_000) as i128
    }

    fn frame_at(&self, at: Duration) -> i128 {
        let delta = at.as_nanos() as i128 - self.anchor_time.as_nanos() as i128;
        self.anchor_frame + delta * self.rate as i128 / 1_000_000_000
    }

    fn rebase(&mut self, at: Duration) {
        self.anchor_time = at;
        self.anchor_frame = self.next_frame;
    }

    /// At most 100 ms per poll, never an unbounded post-suspend catch-up burst.
    pub fn idle(&mut self, now: Duration) -> usize {
        let at = now.saturating_sub(GRACE);
        let mut gap = (self.frame_at(at) - self.next_frame).max(0);
        if gap > self.frames(MAX_GAP) {
            self.rebase(at);
            gap = 0;
        }
        let count = gap.min(self.rate as i128 / 10) as usize;
        self.next_frame += count as i128;
        count
    }

    /// Align an actual packet to the same clock. Prefixes already represented by
    /// earlier audio or idle silence are skipped, never repeated after resume.
    pub fn capture(&mut self, at: Duration, frames: usize) -> Plan {
        let mut first = self.frame_at(at);
        if first - self.next_frame > self.frames(MAX_GAP) {
            self.rebase(at);
            first = self.next_frame;
        }
        let silence = (first - self.next_frame).max(0) as usize;
        let skip = (self.next_frame - first).max(0).min(frames as i128) as usize;
        self.next_frame = self.next_frame.max(first + frames as i128);
        Plan { silence, skip }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_tail_maintains_cadence_and_leaves_callback_grace() {
        let mut clock = LoopbackClock::new(48_000);
        let speech = clock.capture(Duration::ZERO, 48_000 * 3);
        assert_eq!((speech.silence, speech.skip), (0, 0));
        assert_eq!(clock.idle(Duration::from_millis(3_100)), 0);
        let mut silence = 0;
        for ms in (3_160..=4_160).step_by(20) {
            let frames = clock.idle(Duration::from_millis(ms));
            assert!(frames <= 4_800);
            silence += frames;
        }
        assert_eq!(silence, 48_480); // 1.01 seconds of real digital silence.
        assert_eq!(clock.idle(Duration::from_millis(4_160)), 0);
    }

    #[test]
    fn resumed_capture_fills_only_unrepresented_gap_without_duplicate_audio() {
        let mut clock = LoopbackClock::new(48_000);
        for ms in (20..=1_000).step_by(20) {
            clock.idle(Duration::from_millis(ms));
        }
        let resumed = clock.capture(Duration::from_millis(1_000), 960);
        assert_eq!(resumed.silence, 7_200);
        assert_eq!(resumed.skip, 0);
        let next = clock.capture(Duration::from_millis(1_020), 960);
        assert_eq!((next.silence, next.skip), (0, 0));
        let repeated = clock.capture(Duration::from_millis(1_020), 960);
        assert_eq!((repeated.silence, repeated.skip), (0, 960));
        let late_overlap = clock.capture(Duration::from_millis(1_030), 960);
        assert_eq!((late_overlap.silence, late_overlap.skip), (0, 480));
    }

    #[test]
    fn long_sleep_rebases_instead_of_queueing_hours_of_silence() {
        let mut clock = LoopbackClock::new(48_000);
        clock.capture(Duration::ZERO, 960);
        assert_eq!(clock.idle(Duration::from_secs(7_200)), 0);
        let due = clock.idle(Duration::from_millis(7_200_020));
        assert_eq!(due, 960);
        let resumed = clock.capture(Duration::from_millis(7_200_020), 960);
        assert_eq!((resumed.silence, resumed.skip), (7_200, 0));
        let old = clock.capture(Duration::from_secs(5), 960);
        assert_eq!((old.silence, old.skip), (0, 960));
    }
}
