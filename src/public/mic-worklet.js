// Browser mic -> 24 kHz, mono, little-endian PCM16 in ~100 ms chunks.
class PCM24kRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.frame = new Int16Array(2400);
    this.position = 0;
    this.phase = 0;
    this.port.onmessage = (event) => {
      if (event.data?.type === 'flush' && this.position) {
        const bytes = this.frame.buffer.slice(0, this.position * 2);
        this.port.postMessage({type: 'pcm', buffer: bytes}, [bytes]);
        this.frame = new Int16Array(2400);
        this.position = 0;
      }
      if (event.data?.type === 'flush') this.port.postMessage({type: 'flushed'});
    };
  }
  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.phase += 24000;
      while (this.phase >= sampleRate) {
        this.phase -= sampleRate;
        const sample = Math.max(-1, Math.min(1, channel[i]));
        this.frame[this.position++] = sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
        if (this.position === 2400) {
          const bytes = this.frame.buffer;
          this.port.postMessage({type: 'pcm', buffer: bytes}, [bytes]);
          this.frame = new Int16Array(2400);
          this.position = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm24k-recorder', PCM24kRecorder);
