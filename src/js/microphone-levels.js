const unit = value => typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;

/** Native signal data only; meters never synthesize microphone activity. */
export function microphoneLevels(value = {}, { active = true, testing = false, at = Date.now() } = {}) {
  const rms = unit(value.rms);
  return {
    rms,
    rawRms: unit(value.raw_rms ?? value.rawRms ?? rms),
    peak: unit(value.peak),
    inputPeak: unit(value.input_peak ?? value.inputPeak ?? value.peak),
    clippedRatio: unit(value.clipped_ratio ?? value.clippedRatio),
    waveform: Array.isArray(value.waveform) ? value.waveform.slice(0, 64).map(sample =>
      typeof sample === 'number' && Number.isFinite(sample) ? Math.max(-1, Math.min(1, sample)) : 0) : [],
    bands: Array.isArray(value.bands) ? value.bands.slice(0, 16).map(unit) : [],
    active: Boolean(active),
    testing: Boolean(testing),
    at: Number.isFinite(at) ? at : Date.now(),
  };
}

export function emptyMicrophoneLevels() {
  return microphoneLevels({}, { active: false });
}
