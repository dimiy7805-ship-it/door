import { BRAND_SPECS, IntercomBrand } from './intercomLogic';

export interface ToneStep {
  freq: number;
  durationMs: number;
  delayMs?: number;
  type?: OscillatorType;
  gain?: number;
}

export function encodePcm8Base64(samples: Float32Array | number[]): string {
  const len = samples.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    // Slight non-linear companding (sign * sqrt(|x|)) for much clearer voice intelligibility at 8-bit
    const companded = Math.sign(clamped) * Math.sqrt(Math.abs(clamped));
    bytes[i] = Math.max(0, Math.min(255, Math.round((companded + 1) * 127.5)));
  }
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < len; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function decodePcm8Base64(b64: string): Float32Array {
  const binary = atob(b64);
  const len = binary.length;
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) {
    const companded = binary.charCodeAt(i) / 127.5 - 1;
    out[i] = Math.sign(companded) * companded * companded;
  }
  return out;
}

class IntercomSoundEngine {
  private ctx: AudioContext | null = null;
  private ringTimer: number | null = null;
  private muted = false;
  private nextPcmPlayTime = 0;
  private remoteStreamSource: MediaStreamAudioSourceNode | null = null;
  private remoteStreamGain: GainNode | null = null;

  public setVoiceCallActive(_active: boolean) {
    // All sounds share the unified Web Audio context stream with call/ring audio
  }

  public unlock(): AudioContext | null {
    return this.getContext();
  }

  private getContext(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (AudioCtx) {
        this.ctx = new AudioCtx();
      }
    }
    if (this.ctx && this.ctx.state === 'suspended') {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }

  public attachRemoteWebRtcAudioBackup(stream: MediaStream | null, htmlAudioPlaying: boolean) {
    const ctx = this.getContext();
    if (!ctx) return;
    try {
      if (this.remoteStreamSource) {
        this.remoteStreamSource.disconnect();
        this.remoteStreamSource = null;
      }
      if (this.remoteStreamGain) {
        this.remoteStreamGain.disconnect();
        this.remoteStreamGain = null;
      }
      if (!stream || stream.getAudioTracks().length === 0) return;

      this.remoteStreamSource = ctx.createMediaStreamSource(stream);
      this.remoteStreamGain = ctx.createGain();
      // Only amplify via WebAudio if HTMLAudioElement is blocked/paused by mobile browser policy
      this.remoteStreamGain.gain.value = htmlAudioPlaying ? 0.0 : 1.35;
      this.remoteStreamSource.connect(this.remoteStreamGain);
      this.remoteStreamGain.connect(ctx.destination);
    } catch {
      // Ignore if stream has no active audio tracks
    }
  }

  public setMuted(mute: boolean) {
    this.muted = mute;
    if (mute) {
      this.stopRingLoop();
    }
  }

  public isMuted(): boolean {
    return this.muted;
  }

  public playKeyBeep(brand: IntercomBrand) {
    if (this.muted) return;
    const spec = BRAND_SPECS[brand];
    this.playSequence([
      {
        freq: spec.keyFreq,
        durationMs: 65,
        type: 'square',
        gain: 0.11,
      },
    ]);
  }

  public playCallBurst(brand: IntercomBrand) {
    if (this.muted) return;
    if (brand === 'eltis') {
      this.playSequence([
        { freq: 980, durationMs: 140, delayMs: 0, type: 'square', gain: 0.13 },
        { freq: 1240, durationMs: 140, delayMs: 150, type: 'square', gain: 0.13 },
        { freq: 980, durationMs: 140, delayMs: 300, type: 'square', gain: 0.13 },
        { freq: 1240, durationMs: 180, delayMs: 450, type: 'square', gain: 0.13 },
      ]);
    } else if (brand === 'vizit') {
      this.playSequence([
        { freq: 1420, durationMs: 90, delayMs: 0, type: 'square', gain: 0.12 },
        { freq: 1120, durationMs: 90, delayMs: 95, type: 'square', gain: 0.12 },
        { freq: 1420, durationMs: 90, delayMs: 190, type: 'square', gain: 0.12 },
        { freq: 1120, durationMs: 90, delayMs: 285, type: 'square', gain: 0.12 },
        { freq: 1420, durationMs: 140, delayMs: 380, type: 'square', gain: 0.12 },
      ]);
    } else {
      this.playSequence([
        { freq: 780, durationMs: 220, delayMs: 0, type: 'sawtooth', gain: 0.12 },
        { freq: 920, durationMs: 260, delayMs: 240, type: 'sawtooth', gain: 0.12 },
      ]);
    }
  }

  public startRingLoop(brand: IntercomBrand) {
    this.stopRingLoop();
    this.playCallBurst(brand);
    const interval = BRAND_SPECS[brand].ringIntervalMs;
    this.ringTimer = window.setInterval(() => {
      this.playCallBurst(brand);
    }, interval);
  }

  public stopRingLoop() {
    if (this.ringTimer !== null) {
      clearInterval(this.ringTimer);
      this.ringTimer = null;
    }
  }

  /**
   * Classic electromagnetic door-strike / line-open chirp when connection succeeds.
   */
  public playConnectedChime() {
    if (this.muted) return;
    this.playSequence([
      { freq: 1560, durationMs: 160, delayMs: 0, type: 'square', gain: 0.13 },
      { freq: 1980, durationMs: 320, delayMs: 180, type: 'square', gain: 0.13 },
    ]);
  }

  /**
   * Low error / busy / hangup tone.
   */
  public playErrorTone() {
    if (this.muted) return;
    this.playSequence([
      { freq: 340, durationMs: 190, delayMs: 0, type: 'sawtooth', gain: 0.13 },
      { freq: 280, durationMs: 250, delayMs: 230, type: 'sawtooth', gain: 0.13 },
    ]);
  }

  /**
   * Plays incoming companded 8-bit PCM Base64 voice audio chunks smoothly with jitter buffering.
   */
  public playPcm8Base64Chunk(b64: string, sampleRate = 8000) {
    if (this.muted || !b64) return;
    try {
      const floatSamples = decodePcm8Base64(b64);
      this.scheduleFloat32Samples(floatSamples, sampleRate);
    } catch {
      // Ignore malformed chunk
    }
  }

  /**
   * Plays incoming fallback PCM float32 voice audio chunks when direct WebRTC media is unavailable.
   */
  public playPcmFloat32Chunk(samples: number[] | Float32Array, sampleRate = 12000) {
    if (this.muted || !samples || samples.length === 0) return;
    const arr = samples instanceof Float32Array ? samples : new Float32Array(samples);
    this.scheduleFloat32Samples(arr, sampleRate);
  }

  private scheduleFloat32Samples(samples: Float32Array, sampleRate: number) {
    const ctx = this.getContext();
    if (!ctx || samples.length === 0) return;

    try {
      const safeRate = Math.max(4000, Math.min(48000, sampleRate || 8000));
      const buffer = ctx.createBuffer(1, samples.length, safeRate);
      const channel = buffer.getChannelData(0);
      // Apply 4ms micro-fade at chunk edges to eliminate any click/pop if network packets jitter
      const fadeLen = Math.min(32, Math.floor(samples.length / 8));
      for (let i = 0; i < samples.length; i++) {
        let env = 1.0;
        if (i < fadeLen) {
          env = i / fadeLen;
        } else if (i >= samples.length - fadeLen) {
          env = (samples.length - 1 - i) / fadeLen;
        }
        channel[i] = samples[i] * env;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.55;

      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      const now = ctx.currentTime;
      if (this.nextPcmPlayTime < now || this.nextPcmPlayTime > now + 0.85) {
        // 75ms jitter buffer so consecutive network chunks play back-to-back seamlessly
        this.nextPcmPlayTime = now + 0.075;
      }
      source.start(this.nextPcmPlayTime);
      this.nextPcmPlayTime += buffer.duration;
    } catch {
      // Ignore audio scheduling errors
    }
  }

  private playSequence(steps: ToneStep[]) {
    const ctx = this.getContext();
    if (!ctx) return;
    const now = ctx.currentTime;

    for (const s of steps) {
      const start = now + (s.delayMs ?? 0) / 1000;
      const dur = Math.max(0.02, s.durationMs / 1000);

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type = s.type ?? 'square';
      osc.frequency.setValueAtTime(s.freq, start);

      const peak = s.gain ?? 0.12;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.linearRampToValueAtTime(peak, start + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.start(start);
      osc.stop(start + dur + 0.01);
    }
  }
}

export const soundEngine = new IntercomSoundEngine();
