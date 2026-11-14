import { BRAND_SPECS, IntercomBrand } from './intercomLogic';

export interface ToneStep {
  freq: number;
  durationMs: number;
  delayMs?: number;
  type?: OscillatorType;
  gain?: number;
}

class IntercomSoundEngine {
  private ctx: AudioContext | null = null;
  private ringTimer: number | null = null;
  private muted = false;
  private nextPcmPlayTime = 0;

  public setVoiceCallActive(_active: boolean) {
    // All sounds share the unified Web Audio context stream with call/ring audio
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
   * Plays incoming fallback PCM float32 voice audio chunks when direct WebRTC media is unavailable.
   */
  public playPcmFloat32Chunk(samples: number[], sampleRate = 16000) {
    if (this.muted || !samples || samples.length === 0) return;
    const ctx = this.getContext();
    if (!ctx) return;

    try {
      const buffer = ctx.createBuffer(1, samples.length, sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        channel[i] = samples[i];
      }

      const source = ctx.createBufferSource();
      source.buffer = buffer;

      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.25;

      source.connect(gainNode);
      gainNode.connect(ctx.destination);

      const now = ctx.currentTime;
      if (this.nextPcmPlayTime < now || this.nextPcmPlayTime > now + 0.6) {
        this.nextPcmPlayTime = now + 0.02;
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
