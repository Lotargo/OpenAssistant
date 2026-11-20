//! Local CPU processing outside the capture callback. Source peaks precede all filters.
use super::{levels::AudioAnalyzer, AudioLevels};
use nnnoiseless::DenoiseState;
use std::f64::consts::PI;

pub struct Captured {
    pub mono: Vec<f32>,
    pub peak: f32,
    pub clipped: usize,
    pub samples: usize,
}

/// Stateful conversion; the FIR prevents high-frequency input folding into speech.
pub struct Resampler {
    step: f64,
    next: f64,
    index: u64,
    previous: f32,
    coefficients: Vec<f32>,
    history: Vec<f32>,
    cursor: usize,
}
impl Resampler {
    pub fn new(input: u32, output: u32) -> Self {
        let coefficients = if output < input {
            let cutoff = 0.47 * output as f64 / input as f64;
            let mut taps: Vec<f32> = (0..63)
                .map(|i| {
                    let x = i as f64 - 31.0;
                    let sinc = if x == 0.0 {
                        2.0 * cutoff
                    } else {
                        (2.0 * PI * cutoff * x).sin() / (PI * x)
                    };
                    (sinc * (0.54 - 0.46 * (2.0 * PI * i as f64 / 62.0).cos())) as f32
                })
                .collect();
            let sum: f32 = taps.iter().sum();
            taps.iter_mut().for_each(|x| *x /= sum);
            taps
        } else {
            Vec::new()
        };
        Self {
            step: input as f64 / output as f64,
            next: 0.0,
            index: 0,
            previous: 0.0,
            history: vec![0.0; coefficients.len()],
            coefficients,
            cursor: 0,
        }
    }
    pub fn push(&mut self, input: &[f32]) -> Vec<f32> {
        let mut output = Vec::new();
        for &raw in input {
            let mut sample = if raw.is_finite() {
                raw.clamp(-1.0, 1.0)
            } else {
                0.0
            };
            if !self.coefficients.is_empty() {
                self.history[self.cursor] = sample;
                sample = self
                    .coefficients
                    .iter()
                    .enumerate()
                    .map(|(i, c)| {
                        c * self.history
                            [(self.cursor + self.history.len() - i) % self.history.len()]
                    })
                    .sum();
                self.cursor = (self.cursor + 1) % self.history.len();
            }
            let index = self.index as f64;
            while self.next <= index {
                let value = if self.index == 0 {
                    sample
                } else {
                    self.previous
                        + (sample - self.previous)
                            * (self.next - (index - 1.0)).clamp(0.0, 1.0) as f32
                };
                output.push(value);
                self.next += self.step;
            }
            self.previous = sample;
            self.index += 1;
        }
        output
    }
}

/// A gentle 100 Hz high-pass targets low fan/desk rumble that can resemble pitch.
struct HighPass {
    b: [f32; 3],
    a: [f32; 2],
    x: [f32; 2],
    y: [f32; 2],
}
impl HighPass {
    fn new() -> Self {
        let w = 2.0 * std::f32::consts::PI * 100.0 / 48000.0;
        let alpha = w.sin() / (2.0 * std::f32::consts::FRAC_1_SQRT_2);
        let a0 = 1.0 + alpha;
        Self {
            b: [
                (1.0 + w.cos()) / (2.0 * a0),
                -(1.0 + w.cos()) / a0,
                (1.0 + w.cos()) / (2.0 * a0),
            ],
            a: [-2.0 * w.cos() / a0, (1.0 - alpha) / a0],
            x: [0.0; 2],
            y: [0.0; 2],
        }
    }
    fn push(&mut self, x: f32) -> f32 {
        let y = self.b[0] * x + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [x, self.x[0]];
        self.y = [y, self.y[0]];
        y
    }
}

pub struct Processor {
    source_rate: u32,
    input: Resampler,
    output: Resampler,
    denoiser: Option<Box<DenoiseState<'static>>>,
    high_pass: HighPass,
    frame: [f32; 480],
    filled: usize,
    analyzer: AudioAnalyzer,
    raw_peak: f32,
    raw_clipped: usize,
    raw_samples: usize,
    raw_energy: f64,
    raw_mono_count: usize,
}
impl Processor {
    pub fn new(source_rate: u32, denoise: bool) -> Self {
        Self {
            source_rate,
            input: Resampler::new(source_rate, if denoise { 48000 } else { 24000 }),
            output: Resampler::new(48000, 24000),
            denoiser: denoise.then(DenoiseState::new),
            high_pass: HighPass::new(),
            frame: [0.0; 480],
            filled: 0,
            analyzer: AudioAnalyzer::new(),
            raw_peak: 0.0,
            raw_clipped: 0,
            raw_samples: 0,
            raw_energy: 0.0,
            raw_mono_count: 0,
        }
    }
    /// Return delayed PCM from the old filter before resetting local DSP.
    /// No device, channel or capture lifetime is touched.
    pub fn set_noise_suppression(&mut self, enabled: bool) -> Vec<i16> {
        if self.denoiser.is_some() == enabled {
            return Vec::new();
        }
        let tail = self.finish();
        *self = Self::new(self.source_rate, enabled);
        tail
    }
    fn convert(&mut self, input: &[f32]) -> Vec<i16> {
        let samples = self.input.push(input);
        let mut result = Vec::new();
        if let Some(denoiser) = &mut self.denoiser {
            for sample in samples {
                self.frame[self.filled] = self.high_pass.push(sample) * 32768.0;
                self.filled += 1;
                if self.filled == 480 {
                    let mut cleaned = [0.0; 480];
                    denoiser.process_frame(&mut cleaned, &self.frame);
                    cleaned.iter_mut().for_each(|v| *v /= 32768.0);
                    result.extend(self.output.push(&cleaned).into_iter().map(pcm));
                    self.filled = 0;
                }
            }
        } else {
            result.extend(samples.into_iter().map(pcm));
        }
        result
    }
    pub fn push(&mut self, captured: Captured) -> (Vec<i16>, Option<AudioLevels>) {
        self.raw_peak = self.raw_peak.max(captured.peak);
        self.raw_clipped += captured.clipped;
        self.raw_samples += captured.samples;
        self.raw_energy += captured
            .mono
            .iter()
            .map(|x| (*x as f64).powi(2))
            .sum::<f64>();
        self.raw_mono_count += captured.mono.len();
        let samples = self.convert(&captured.mono);
        let levels = self.analyzer.push(&samples).map(|mut level| {
            level.input_peak = self.raw_peak;
            level.clipped_ratio = self.raw_clipped as f32 / self.raw_samples.max(1) as f32;
            level.raw_rms = (self.raw_energy / self.raw_mono_count.max(1) as f64).sqrt() as f32;
            self.raw_peak = 0.0;
            self.raw_clipped = 0;
            self.raw_samples = 0;
            self.raw_energy = 0.0;
            self.raw_mono_count = 0;
            level
        });
        (samples, levels)
    }
    pub fn finish(&mut self) -> Vec<i16> {
        // Drain filter history, the partial 10 ms frame and RNNoise's delayed output.
        let mut result = self.convert(&[0.0; 63]);
        if let Some(denoiser) = &mut self.denoiser {
            if self.filled > 0 {
                self.frame[self.filled..].fill(0.0);
                let mut tail = [0.0; 480];
                denoiser.process_frame(&mut tail, &self.frame);
                tail.iter_mut().for_each(|v| *v /= 32768.0);
                result.extend(self.output.push(&tail).into_iter().map(pcm));
            }
            let mut tail = [0.0; 480];
            denoiser.process_frame(&mut tail, &[0.0; 480]);
            tail.iter_mut().for_each(|v| *v /= 32768.0);
            result.extend(self.output.push(&tail).into_iter().map(pcm));
            result.extend(self.output.push(&[0.0; 63]).into_iter().map(pcm));
        }
        result
    }
}
fn pcm(value: f32) -> i16 {
    if value.is_finite() {
        (value.clamp(-1.0, 1.0) * 32767.0) as i16
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn continuous_resampling_targets_24k_and_filters_aliasing() {
        let signal: Vec<_> = (0..48000)
            .map(|i| (std::f32::consts::TAU * 18000.0 * i as f32 / 48000.0).sin() * 0.5)
            .collect();
        let whole = Resampler::new(48000, 24000).push(&signal);
        let mut split = Resampler::new(48000, 24000);
        let chunks: Vec<_> = signal
            .chunks(137)
            .flat_map(|chunk| split.push(chunk))
            .collect();
        assert_eq!(whole, chunks);
        assert_eq!(whole.len(), 24000);
        let rms =
            (whole[100..].iter().map(|x| x * x).sum::<f32>() / (whole.len() - 100) as f32).sqrt();
        assert!(rms < 0.01, "Aliased out-of-band tone: {rms}");
        assert_eq!(
            Resampler::new(44100, 24000).push(&vec![0.1; 44100]).len(),
            24000
        );
    }
    #[test]
    fn denoising_preserves_raw_clipping_and_produces_finite_24k_samples() {
        let mut processor = Processor::new(48000, true);
        let (samples, levels) = processor.push(Captured {
            mono: vec![1.0; 4800],
            peak: 1.0,
            clipped: 4800,
            samples: 4800,
        });
        let levels = levels.unwrap();
        assert_eq!(levels.input_peak, 1.0);
        assert_eq!(levels.clipped_ratio, 1.0);
        assert_eq!(levels.raw_rms, 1.0);
        assert!(levels.rms < levels.raw_rms);
        assert_eq!(samples.len(), 2400);
        assert!(levels.waveform.iter().all(|x| x.is_finite()));
        assert!(processor.finish().len() < 1000);
    }
}
