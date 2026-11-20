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
  private remotePresenceFilter: BiquadFilterNode | null = null;
  private remoteHissCutFilter: BiquadFilterNode | null = null;
  private remoteCompressor: DynamicsCompressorNode | null = null;
  private remoteStreamGain: GainNode | null = null;
  private remoteHtmlAudioEl: HTMLAudioElement | null = null;

  public setVoiceCallActive(_active: boolean) {
    // All sounds share the unified Web Audio context stream with call/ring audio
  }

  public unlock(): AudioContext | null {
    const ctx = this.getContext();
    if (ctx && ctx.state === 'suspended') {
      ctx
        .resume()
        .then(() => {
          this.syncRemoteAudioRouting();
        })
        .catch(() => {});
    } else {
      this.syncRemoteAudioRouting();
    }
    return ctx;
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
      this.ctx
        .resume()
        .then(() => {
          this.syncRemoteAudioRouting();
        })
        .catch(() => {});
    }
    return this.ctx;
  }

  private syncRemoteAudioRouting() {
    if (!this.remoteStreamGain) return;
    const isRunning = Boolean(this.ctx && this.ctx.state === 'running');
    if (isRunning) {
      // Single clean path via WebAudio vocal EQ + anti-hiss lowpass + gentle compressor
      // (mute HTMLAudioElement to prevent comb-filtering / phase cancellation while keeping Chrome's WebRTC decoder active)
      if (this.remoteHtmlAudioEl) {
        this.remoteHtmlAudioEl.muted = true;
      }
      this.remoteStreamGain.gain.value = 1.5;
    } else {
      // AudioContext not yet unlocked by user gesture: play via HTMLAudioElement cleanly until unlocked
      if (this.remoteHtmlAudioEl) {
        this.remoteHtmlAudioEl.muted = false;
        this.remoteHtmlAudioEl.volume = 1.0;
      }
      this.remoteStreamGain.gain.value = 0.0;
    }
  }

  public attachRemoteWebRtcAudioBackup(
    stream: MediaStream | null,
    _htmlAudioPlaying: boolean,
    audioEl?: HTMLAudioElement | null
  ) {
    const ctx = this.getContext();
    this.remoteHtmlAudioEl = stream ? (audioEl ?? this.remoteHtmlAudioEl) : null;
    try {
      if (this.remoteStreamSource) {
        this.remoteStreamSource.disconnect();
        this.remoteStreamSource = null;
      }
      if (this.remotePresenceFilter) {
        this.remotePresenceFilter.disconnect();
        this.remotePresenceFilter = null;
      }
      if (this.remoteHissCutFilter) {
        this.remoteHissCutFilter.disconnect();
        this.remoteHissCutFilter = null;
      }
      if (this.remoteCompressor) {
        this.remoteCompressor.disconnect();
        this.remoteCompressor = null;
      }
      if (this.remoteStreamGain) {
        this.remoteStreamGain.disconnect();
        this.remoteStreamGain = null;
      }
      if (!ctx || !stream || stream.getAudioTracks().length === 0) return;

      this.remoteStreamSource = ctx.createMediaStreamSource(stream);

      // Gentle mid-range vocal clarity boost (1.8 kHz +1.8 dB) without boosting high-frequency mic hiss
      this.remotePresenceFilter = ctx.createBiquadFilter();
      this.remotePresenceFilter.type = 'peaking';
      this.remotePresenceFilter.frequency.value = 1800;
      this.remotePresenceFilter.Q.value = 0.9;
      this.remotePresenceFilter.gain.value = 1.8;

      // Soft anti-hiss lowpass rolloff above 7.2 kHz to suppress broadband white noise
      this.remoteHissCutFilter = ctx.createBiquadFilter();
      this.remoteHissCutFilter.type = 'lowpass';
      this.remoteHissCutFilter.frequency.value = 7200;
      this.remoteHissCutFilter.Q.value = 0.7;

      // Balanced voice compressor so speech stays clear and loud without pumping up silence/background hiss
      this.remoteCompressor = ctx.createDynamicsCompressor();
      this.remoteCompressor.threshold.value = -20;
      this.remoteCompressor.knee.value = 12;
      this.remoteCompressor.ratio.value = 2.2;
      this.remoteCompressor.attack.value = 0.008;
      this.remoteCompressor.release.value = 0.18;

      this.remoteStreamGain = ctx.createGain();
      this.remoteStreamSource.connect(this.remotePresenceFilter);
      this.remotePresenceFilter.connect(this.remoteHissCutFilter);
      this.remoteHissCutFilter.connect(this.remoteCompressor);
      this.remoteCompressor.connect(this.remoteStreamGain);
      this.remoteStreamGain.connect(ctx.destination);

      this.syncRemoteAudioRouting();
    } catch {
      if (this.remoteHtmlAudioEl) {
        this.remoteHtmlAudioEl.muted = false;
        this.remoteHtmlAudioEl.volume = 1.0;
      }
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
      const safeRate = Math.max(4000, Math.min(48000, sampleRate || 10000));
      const buffer = ctx.createBuffer(1, samples.length, safeRate);
      const channel = buffer.getChannelData(0);

      const now = ctx.currentTime;
      const isUnderrun = this.nextPcmPlayTime < now || this.nextPcmPlayTime > now + 0.55;
      if (isUnderrun) {
        // Tight 65ms jitter buffer keeps fallback voice responsive without sluggish delay
        this.nextPcmPlayTime = now + 0.065;
      }

      // Compute chunk RMS so pure 8-bit quantization hiss during silence is smoothly attenuated
      let sumSq = 0;
      for (let i = 0; i < samples.length; i++) {
        sumSq += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sumSq / samples.length);
      const noiseExpanderGain =
        rms < 0.012 ? 0.15 + 0.85 * Math.pow(rms / 0.012, 2) : 1.0;

      // Only apply a short ramp at the start of a new burst after an underrun
      const fadeInLen = isUnderrun ? Math.min(24, Math.floor(samples.length / 8)) : 0;
      for (let i = 0; i < samples.length; i++) {
        const env = i < fadeInLen ? i / fadeInLen : 1.0;
        channel[i] = samples[i] * env * noiseExpanderGain;
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      // 3.8 kHz lowpass cuts 8-bit PCM quantization white noise cleanly while preserving clear vocal tone
      const filterNode = ctx.createBiquadFilter();
      filterNode.type = 'lowpass';
      filterNode.frequency.value = Math.min(3800, safeRate * 0.45);

      const compNode = ctx.createDynamicsCompressor();
      compNode.threshold.value = -18;
      compNode.knee.value = 12;
      compNode.ratio.value = 2.2;
      compNode.attack.value = 0.008;
      compNode.release.value = 0.16;

      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.55;

      source.connect(filterNode);
      filterNode.connect(compNode);
      compNode.connect(gainNode);
      gainNode.connect(ctx.destination);

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
