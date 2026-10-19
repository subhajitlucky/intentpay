const WHISPER_TRANSFORMERS_CDN = 'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2';
const WHISPER_MODEL_ID = 'Xenova/whisper-base.en';
const TARGET_SAMPLE_RATE = 16000;

let whisperPipelinePromise = null;

async function getWhisperPipeline() {
  if (!whisperPipelinePromise) {
    whisperPipelinePromise = (async () => {
      const { pipeline, env } = await import(/* @vite-ignore */ WHISPER_TRANSFORMERS_CDN);
      env.allowLocalModels = false;
      return pipeline('automatic-speech-recognition', WHISPER_MODEL_ID);
    })();
  }
  return whisperPipelinePromise;
}

function flattenChunks(chunks) {
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function resampleLinear(input, inputRate, outputRate) {
  if (!input || input.length === 0) return new Float32Array(0);
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outLen = Math.max(1, Math.floor(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const left = Math.floor(pos);
    const right = Math.min(left + 1, input.length - 1);
    const frac = pos - left;
    out[i] = input[left] * (1 - frac) + input[right] * frac;
  }
  return out;
}

function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / samples.length);
}

// Level above which a frame counts as someone talking rather than room tone.
export const VOICE_ACTIVITY_RMS = 0.015;

export function sanitizeVoiceTranscript(text) {
  if (typeof text !== 'string') return '';
  return text.trim();
}

export class IntentVoiceEngine {
  constructor() {
    this.audioContext = null;
    this.mediaStream = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
    this.chunks = [];
    this.sampleRate = null;
    this.silenceTimeoutMs = 0;
    this.onSilence = null;
    this.hasSpoken = false;
    this.lastVoiceAt = null;
  }

  /**
   * @param {object} [options]
   * @param {number} [options.silenceTimeoutMs] Auto-stop after this much silence
   *   once speech has been detected. This is what lets the Whisper fallback work
   *   without a second tap on the mic.
   * @param {Function} [options.onSilence] Called once when that silence is reached.
   */
  async start({ silenceTimeoutMs = 0, onSilence = null } = {}) {
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    this.audioContext = new AudioContextCtor({ latencyHint: 'interactive' });
    this.sampleRate = this.audioContext.sampleRate;
    this.silenceTimeoutMs = silenceTimeoutMs;
    this.onSilence = onSilence;
    this.hasSpoken = false;
    this.lastVoiceAt = null;

    this.mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        channelCount: 1
      },
      video: false
    });

    this.source = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.sink = this.audioContext.createGain();
    this.sink.gain.value = 0;
    this.chunks = [];

    this.processor.onaudioprocess = (event) => {
      const mono = event.inputBuffer.getChannelData(0);
      this.chunks.push(new Float32Array(mono));
      this.trackSilence(mono);
    };

    this.source.connect(this.processor);
    this.processor.connect(this.sink);
    this.sink.connect(this.audioContext.destination);
  }

  trackSilence(mono) {
    if (!this.silenceTimeoutMs) return;

    const now = Date.now();
    if (rms(mono) >= VOICE_ACTIVITY_RMS) {
      this.hasSpoken = true;
      this.lastVoiceAt = now;
      return;
    }

    if (!this.hasSpoken || !this.lastVoiceAt) return;
    if (now - this.lastVoiceAt < this.silenceTimeoutMs) return;

    // Fire exactly once; a later call would re-trigger while the caller stops.
    this.hasSpoken = false;
    this.lastVoiceAt = null;
    if (typeof this.onSilence === 'function') this.onSilence();
  }

  async stopAndTranscribe() {
    try {
      if (this.processor) this.processor.disconnect();
      if (this.source) this.source.disconnect();
      if (this.sink) this.sink.disconnect();
      this.mediaStream?.getTracks?.().forEach((t) => t.stop());
      await this.audioContext?.close();
    } catch {
      // no-op cleanup
    }

    const raw = flattenChunks(this.chunks || []);
    this.chunks = [];

    if (!raw.length || rms(raw) < 0.008) {
      return '';
    }

    const pcm16k = resampleLinear(raw, this.sampleRate || TARGET_SAMPLE_RATE, TARGET_SAMPLE_RATE);
    const pipe = await getWhisperPipeline();
    const result = await pipe(pcm16k, {
      chunk_length_s: 20,
      stride_length_s: 5,
      return_timestamps: false,
      language: 'english'
    });

    return sanitizeVoiceTranscript(result?.text || '');
  }
}
