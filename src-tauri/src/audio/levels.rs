//! Levels from the same 24 kHz stream used by Realtime; no second microphone stream.
use serde::Serialize;

const WINDOW: usize = 1200;

#[derive(Clone, Debug, Default, Serialize)]
pub struct AudioLevels {
    pub rms: f32,
    pub raw_rms: f32,
    pub peak: f32,
    pub input_peak: f32,
    pub clipped_ratio: f32,
    pub waveform: Vec<f32>,
}

pub(super) struct AudioAnalyzer {
    samples: [f32; WINDOW],
    filled: usize,
}
impl AudioAnalyzer {
    pub fn new() -> Self {
        Self {
            samples: [0.0; WINDOW],
            filled: 0,
        }
    }
    pub fn push(&mut self, samples: &[i16]) -> Option<AudioLevels> {
        let mut latest = None;
        for sample in samples {
            self.samples[self.filled] = *sample as f32 / 32768.0;
            self.filled += 1;
            if self.filled == WINDOW {
                latest = Some(self.analyze());
                self.filled = 0;
            }
        }
        latest
    }
    fn analyze(&self) -> AudioLevels {
        let mean = self.samples.iter().sum::<f32>() / WINDOW as f32;
        let mut sum = 0.0;
        let mut peak = 0.0_f32;
        for sample in self.samples {
            let ac = sample - mean;
            sum += ac * ac;
            peak = peak.max(ac.abs());
        }
        // Signed bucket peaks preserve transients without transporting raw audio for a test.
        let waveform = (0..64)
            .map(|index| {
                let first = index * WINDOW / 64;
                let last = ((index + 1) * WINDOW / 64).max(first + 1);
                self.samples[first..last]
                    .iter()
                    .map(|v| v - mean)
                    .max_by(|a, b| a.abs().total_cmp(&b.abs()))
                    .unwrap_or(0.0)
                    .clamp(-1.0, 1.0)
            })
            .collect();
        AudioLevels {
            rms: (sum / WINDOW as f32).sqrt().clamp(0.0, 1.0),
            peak: peak.clamp(0.0, 1.0),
            waveform,
            ..AudioLevels::default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn same_stream_levels_track_tone_and_ignore_dc_without_rewriting_pcm() {
        let input: Vec<i16> = (0..WINDOW)
            .map(|i| {
                ((std::f32::consts::TAU * 1000.0 * i as f32 / 24000.0).sin() * 0.25 * 32767.0)
                    as i16
            })
            .collect();
        let copy = input.clone();
        let level = AudioAnalyzer::new().push(&input).unwrap();
        assert!((level.rms - 0.25 / 2.0_f32.sqrt()).abs() < 0.001);
        assert_eq!(level.waveform.len(), 64);
        assert!(level.waveform.iter().any(|v| v.abs() > 0.2));
        assert_eq!(input, copy);
        let dc = AudioAnalyzer::new().push(&vec![4000; WINDOW]).unwrap();
        assert_eq!(dc.rms, 0.0);
        assert!(dc.waveform.iter().all(|v| v.abs() < 0.000001));
    }
}
