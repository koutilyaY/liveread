/**
 * AudioWorklet: downmix to mono, resample to 16 kHz (linear), emit
 * 100 ms Int16 PCM frames to the main thread.
 */
class PcmFrameProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.frameSamples = 1600; // 100 ms at 16 kHz
    this.buffer = new Float32Array(0);
    this.resamplePos = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    if (!ch0 || ch0.length === 0) return true;

    // downmix
    let mono = ch0;
    if (input.length > 1) {
      mono = new Float32Array(ch0.length);
      for (let i = 0; i < ch0.length; i++) {
        let sum = 0;
        for (let c = 0; c < input.length; c++) sum += input[c][i] || 0;
        mono[i] = sum / input.length;
      }
    }

    // linear resample from context rate to 16 kHz
    const ratio = sampleRate / this.targetRate;
    const outLen = Math.floor((mono.length - this.resamplePos) / ratio);
    const out = new Float32Array(Math.max(0, outLen));
    let pos = this.resamplePos;
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = mono[idx] || 0;
      const b = mono[idx + 1] !== undefined ? mono[idx + 1] : a;
      out[i] = a + (b - a) * frac;
      pos += ratio;
    }
    this.resamplePos = pos - mono.length;

    // accumulate and emit fixed-size frames
    const merged = new Float32Array(this.buffer.length + out.length);
    merged.set(this.buffer);
    merged.set(out, this.buffer.length);
    this.buffer = merged;

    while (this.buffer.length >= this.frameSamples) {
      const frame = this.buffer.slice(0, this.frameSamples);
      this.buffer = this.buffer.slice(this.frameSamples);
      const pcm = new Int16Array(this.frameSamples);
      let sumSq = 0;
      for (let i = 0; i < this.frameSamples; i++) {
        const s = Math.max(-1, Math.min(1, frame[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        sumSq += s * s;
      }
      const rms = Math.sqrt(sumSq / this.frameSamples);
      this.port.postMessage({ pcm: pcm.buffer, rms }, [pcm.buffer]);
    }
    return true;
  }
}

registerProcessor("pcm-frame-processor", PcmFrameProcessor);
