import { ResidentBot } from './residentBots';

export interface BotRenderState {
  isSpeaking: boolean;
  speechEnergy: number; // 0..1
  mood?: 'neutral' | 'happy' | 'curious';
  lastSubtitle?: string;
}

/**
 * Renders a minimalist, atmospheric geometric portrait of the resident bot inside their apartment
 * onto the intercom's remote video canvas.
 */
export function renderBotVideoFrame(
  canvas: HTMLCanvasElement,
  bot: ResidentBot,
  state: BotRenderState,
  nowMs: number = performance.now()
) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;

  const w = canvas.width || 320;
  const h = canvas.height || 240;
  const t = nowMs * 0.001;
  const theme = bot.visualTheme;

  ctx.save();

  // 1. Apartment background gradient
  const bgGrad = ctx.createLinearGradient(0, 0, 0, h);
  bgGrad.addColorStop(0, theme.bgTop);
  bgGrad.addColorStop(1, theme.bgBottom);
  ctx.fillStyle = bgGrad;
  ctx.fillRect(0, 0, w, h);

  // Soft ambient light halo behind character
  const glowGrad = ctx.createRadialGradient(
    w * 0.5,
    h * 0.44,
    w * 0.04,
    w * 0.5,
    h * 0.44,
    w * 0.55
  );
  glowGrad.addColorStop(0, `${theme.accent}26`);
  glowGrad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glowGrad;
  ctx.fillRect(0, 0, w, h);

  // 2. Minimalist apartment interior details per resident
  ctx.save();
  ctx.globalAlpha = 0.35;
  if (theme.decorType === 'hallway-Soviet') {
    // Warm hallway wall paneling & vintage radio meter on shelf
    ctx.strokeStyle = '#524131';
    ctx.lineWidth = 2;
    for (let x = 28; x < w; x += 48) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    ctx.fillStyle = '#382a1e';
    ctx.fillRect(18, h * 0.24, 62, 34);
    ctx.fillStyle = '#f59e0b';
    ctx.fillRect(26, h * 0.27, 46, 12);
  } else if (theme.decorType === 'studio-plants') {
    // Hanging plant leaves & canvas frame in background
    ctx.fillStyle = '#2d231b';
    ctx.fillRect(w - 86, h * 0.18, 58, 74);
    ctx.fillStyle = '#e7e5e4';
    ctx.fillRect(w - 82, h * 0.2, 50, 66);
    // Monstera-inspired minimalist leaves on left
    ctx.fillStyle = '#059669';
    for (let i = 0; i < 4; i++) {
      ctx.beginPath();
      ctx.ellipse(
        38 + i * 8,
        36 + i * 22 + Math.sin(t * 1.4 + i) * 2,
        18,
        10,
        0.4 + i * 0.2,
        0,
        Math.PI * 2
      );
      ctx.fill();
    }
  } else if (theme.decorType === 'bookshelf-study') {
    // Minimalist bookshelves & warm desk lamp orb
    ctx.fillStyle = '#2e2942';
    ctx.fillRect(18, h * 0.18, 72, 8);
    ctx.fillRect(18, h * 0.42, 72, 8);
    const bookColors = ['#6366f1', '#ec4899', '#f59e0b', '#14b8a6', '#a855f7'];
    for (let i = 0; i < 5; i++) {
      ctx.fillStyle = bookColors[i];
      ctx.fillRect(24 + i * 12, h * 0.18 - 22, 9, 22);
      ctx.fillRect(26 + i * 11, h * 0.42 - 20, 8, 20);
    }
    ctx.fillStyle = '#fde68a';
    ctx.beginPath();
    ctx.arc(w - 48, h * 0.26, 16, 0, Math.PI * 2);
    ctx.fill();
  } else if (theme.decorType === 'neon-desk') {
    // Neon LED strip & acoustic foam tiles
    ctx.fillStyle = '#1f2937';
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        ctx.fillRect(22 + c * 22, 26 + r * 22, 18, 18);
      }
    }
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(w - 85, 22);
    ctx.lineTo(w - 24, 52);
    ctx.lineTo(w - 72, 88);
    ctx.stroke();
  } else {
    // Architectural concrete grid & red Bauhaus circle
    ctx.strokeStyle = '#3f3f46';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(26, 22, w - 52, h - 44);
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(w - 58, 54, 18, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();

  // 3. Character head & torso animation parameters
  const breathY = Math.sin(t * 2.1) * 2.2;
  const talkBobY = state.isSpeaking ? Math.sin(t * 14) * state.speechEnergy * 2.5 : 0;
  const headTilt = Math.sin(t * 0.9) * 0.028 + (state.isSpeaking ? Math.cos(t * 6.5) * 0.025 : 0);
  const cx = w * 0.5;
  const cy = h * 0.53 + breathY + talkBobY;

  // Shoulders / Torso
  ctx.save();
  ctx.translate(cx, cy + 78);
  ctx.fillStyle = theme.clothing;
  ctx.beginPath();
  ctx.ellipse(0, 14, 78, 54, 0, Math.PI, 0, false);
  ctx.closePath();
  ctx.fill();

  // Collar / Shirt accent
  ctx.fillStyle = theme.clothingAccent;
  ctx.beginPath();
  ctx.moveTo(-24, -34);
  ctx.lineTo(24, -34);
  ctx.lineTo(0, -4);
  ctx.closePath();
  ctx.fill();

  // Neck
  ctx.fillStyle = theme.skinShadow;
  ctx.beginPath();
  ctx.roundRect(-15, -52, 30, 26, 8);
  ctx.fill();
  ctx.restore();

  // 4. Head Group
  ctx.save();
  ctx.translate(cx, cy - 6);
  ctx.rotate(headTilt);

  // Back hair (for bob / wavy / bun styles)
  if (theme.hairStyle === 'bob-bangs') {
    ctx.fillStyle = theme.hair;
    ctx.beginPath();
    ctx.roundRect(-48, -46, 96, 96, 36);
    ctx.fill();
  } else if (theme.hairStyle === 'sleek-bun') {
    ctx.fillStyle = theme.hair;
    ctx.beginPath();
    ctx.arc(0, -56, 20, 0, Math.PI * 2);
    ctx.fill();
  } else if (theme.hairStyle === 'wavy-prof') {
    ctx.fillStyle = theme.hair;
    ctx.beginPath();
    ctx.ellipse(0, -18, 49, 44, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Headphone headband (if applicable, e.g., Max #402)
  if (theme.headphones) {
    ctx.strokeStyle = '#374151';
    ctx.lineWidth = 8;
    ctx.beginPath();
    ctx.arc(0, -4, 48, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
  }

  // Ears
  ctx.fillStyle = theme.skinShadow;
  ctx.beginPath();
  ctx.ellipse(-41, 2, 7, 13, 0, 0, Math.PI * 2);
  ctx.ellipse(41, 2, 7, 13, 0, 0, Math.PI * 2);
  ctx.fill();

  if (theme.earrings) {
    ctx.fillStyle = theme.accent;
    ctx.beginPath();
    ctx.arc(-42, 15, 3.5, 0, Math.PI * 2);
    ctx.arc(42, 15, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  if (theme.headphones) {
    ctx.fillStyle = '#111827';
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.roundRect(-52, -14, 14, 32, 6);
    ctx.roundRect(38, -14, 14, 32, 6);
    ctx.fill();
    ctx.stroke();
  }

  // Face base shape
  ctx.fillStyle = theme.skin;
  ctx.beginPath();
  ctx.roundRect(-39, -46, 78, 92, [34, 34, 38, 38]);
  ctx.fill();

  // Subtle cheek shading
  ctx.fillStyle = `${theme.skinShadow}55`;
  ctx.beginPath();
  ctx.ellipse(-22, 10, 9, 5, 0, 0, Math.PI * 2);
  ctx.ellipse(22, 10, 9, 5, 0, 0, Math.PI * 2);
  ctx.fill();

  // Beard (if applicable, e.g. Lev #315)
  if (theme.beard) {
    ctx.fillStyle = theme.hair;
    ctx.beginPath();
    ctx.arc(0, 12, 37, 0.15 * Math.PI, 0.85 * Math.PI);
    ctx.lineTo(-26, 20);
    ctx.quadraticCurveTo(0, 28, 26, 20);
    ctx.closePath();
    ctx.fill();
  }

  // Eyes & Blinking logic
  const blinkCycle = (t + Number(bot.pin) * 0.17) % 4.2;
  const isBlinking = blinkCycle > 4.04;
  const eyeLookX = Math.sin(t * 0.75) * 2.2;
  const eyeLookY = Math.cos(t * 0.6) * 1.0;

  // Eyebrows
  const browLift = state.isSpeaking ? state.speechEnergy * 3.5 : 0;
  ctx.strokeStyle = theme.hairStyle === 'balding-neat' ? '#6b7280' : theme.hair;
  ctx.lineWidth = 3.2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(-26, -15 - browLift);
  ctx.quadraticCurveTo(-17, -19 - browLift, -9, -15 - browLift * 0.5);
  ctx.moveTo(9, -15 - browLift * 0.5);
  ctx.quadraticCurveTo(17, -19 - browLift, 26, -15 - browLift);
  ctx.stroke();

  if (isBlinking) {
    ctx.strokeStyle = '#1f2937';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-24, -4);
    ctx.lineTo(-10, -4);
    ctx.moveTo(10, -4);
    ctx.lineTo(24, -4);
    ctx.stroke();
  } else {
    // Sclera
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.ellipse(-17, -4, 7.5, 5.2, 0, 0, Math.PI * 2);
    ctx.ellipse(17, -4, 7.5, 5.2, 0, 0, Math.PI * 2);
    ctx.fill();

    // Iris
    ctx.fillStyle = theme.eyeColor;
    ctx.beginPath();
    ctx.arc(-17 + eyeLookX, -4 + eyeLookY, 3.6, 0, Math.PI * 2);
    ctx.arc(17 + eyeLookX, -4 + eyeLookY, 3.6, 0, Math.PI * 2);
    ctx.fill();

    // Pupil & highlight
    ctx.fillStyle = '#09090b';
    ctx.beginPath();
    ctx.arc(-17 + eyeLookX, -4 + eyeLookY, 1.8, 0, Math.PI * 2);
    ctx.arc(17 + eyeLookX, -4 + eyeLookY, 1.8, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(-18.2 + eyeLookX, -5.4 + eyeLookY, 1.1, 0, Math.PI * 2);
    ctx.arc(15.8 + eyeLookX, -5.4 + eyeLookY, 1.1, 0, Math.PI * 2);
    ctx.fill();
  }

  // Glasses (if applicable)
  if (theme.glasses) {
    ctx.strokeStyle = bot.pin === '518' ? '#18181b' : '#d97706';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.roundRect(-29, -12, 23, 16, 4);
    ctx.roundRect(6, -12, 23, 16, 4);
    ctx.moveTo(-6, -5);
    ctx.lineTo(6, -5);
    ctx.stroke();
  }

  // Minimalist nose
  ctx.strokeStyle = theme.skinShadow;
  ctx.lineWidth = 2.2;
  ctx.beginPath();
  ctx.moveTo(0, -4);
  ctx.lineTo(-3, 9);
  ctx.lineTo(2, 10);
  ctx.stroke();

  // Mustache (if applicable, e.g., Zakhar Ilyich #104)
  if (theme.mustache) {
    ctx.fillStyle = '#9ca3af';
    ctx.beginPath();
    ctx.roundRect(-16, 14, 32, 7, 4);
    ctx.fill();
  }

  // Mouth (lip-synced to speechEnergy)
  const mouthY = theme.mustache ? 25 : 22;
  const openAmount = state.isSpeaking
    ? Math.max(0.12, Math.min(1, state.speechEnergy * (0.7 + 0.3 * Math.sin(t * 28))))
    : 0;

  if (openAmount > 0.08) {
    const mw = 11 + openAmount * 5;
    const mh = 2.5 + openAmount * 8.5;
    ctx.fillStyle = '#451a1c';
    ctx.beginPath();
    ctx.ellipse(0, mouthY, mw, mh, 0, 0, Math.PI * 2);
    ctx.fill();

    // Upper teeth hint
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(-mw * 0.65, mouthY - mh + 1, mw * 1.3, 2.2);
  } else {
    ctx.strokeStyle = '#7c2d12';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(-10, mouthY);
    ctx.quadraticCurveTo(0, mouthY + 3.5, 10, mouthY);
    ctx.stroke();
  }

  // Front hair / Top hair styles
  ctx.fillStyle = theme.hair;
  if (theme.hairStyle === 'balding-neat') {
    // Side hair tufts for Zakhar Ilyich
    ctx.beginPath();
    ctx.roundRect(-41, -30, 9, 22, 4);
    ctx.roundRect(32, -30, 9, 22, 4);
    ctx.fill();
  } else if (theme.hairStyle === 'bob-bangs') {
    ctx.beginPath();
    ctx.arc(0, -24, 41, Math.PI, 0, false);
    ctx.fill();
  } else if (theme.hairStyle === 'wavy-prof') {
    ctx.beginPath();
    ctx.ellipse(-12, -40, 26, 12, -0.15, 0, Math.PI * 2);
    ctx.ellipse(16, -39, 22, 11, 0.2, 0, Math.PI * 2);
    ctx.fill();
  } else if (theme.hairStyle === 'messy-short') {
    ctx.beginPath();
    ctx.arc(0, -26, 40, Math.PI * 1.02, Math.PI * 1.98, false);
    ctx.fill();
  } else if (theme.hairStyle === 'sleek-bun') {
    ctx.beginPath();
    ctx.arc(0, -26, 40, Math.PI * 1.05, Math.PI * 1.95, false);
    ctx.fill();
  }

  ctx.restore(); // end head group

  // 5. Subtle Intercom Camera Overlay (scanlines + apartment HUD badge)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.12)';
  for (let y = 0; y < h; y += 4) {
    ctx.fillRect(0, y, w, 1);
  }

  // Top-left apartment badge
  ctx.fillStyle = 'rgba(9, 13, 22, 0.72)';
  ctx.beginPath();
  ctx.roundRect(8, 8, 136, 22, 4);
  ctx.fill();

  // Speaking indicator dot
  ctx.fillStyle = state.isSpeaking ? '#34d399' : theme.accent;
  ctx.beginPath();
  ctx.arc(18, 19, 3.5, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#f8fafc';
  ctx.font = 'bold 10px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillText(`КВ.${bot.pin} · ${bot.name.toUpperCase()}`, 26, 19.5);

  ctx.restore();
}

let activeStopCallback: (() => void) | null = null;

export function stopBotSpeech() {
  if (activeStopCallback) {
    activeStopCallback();
    activeStopCallback = null;
  }
  try {
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  } catch {
    // ignore
  }
}

/**
 * Speaks the bot's reply using Web Speech API (Russian voice) when available,
 * combined with a pleasant formant-filtered syllable synthesizer for guaranteed
 * audible voice character and real-time lip-sync energy across all browsers.
 */
export function speakBotText(
  bot: ResidentBot,
  text: string,
  options: {
    volume?: number;
    muted?: boolean;
    onEnergy?: (energy: number, isSpeaking: boolean) => void;
    onEnd?: () => void;
  } = {}
): () => void {
  stopBotSpeech();

  const cleanText = (text || '').trim();
  if (!cleanText) {
    options.onEnergy?.(0, false);
    options.onEnd?.();
    return () => {};
  }

  let cancelled = false;
  let energyTimer: number | null = null;
  let synthFinishTimer: number | null = null;
  let audioCtx: AudioContext | null = null;

  const durationMs = Math.min(9500, Math.max(1800, cleanText.length * 62));
  const startTime = performance.now();

  const finish = () => {
    if (cancelled) return;
    cancelled = true;
    if (energyTimer !== null) window.clearInterval(energyTimer);
    if (synthFinishTimer !== null) window.clearTimeout(synthFinishTimer);
    if (audioCtx) {
      audioCtx.close().catch(() => {});
      audioCtx = null;
    }
    options.onEnergy?.(0, false);
    options.onEnd?.();
  };

  activeStopCallback = () => {
    try {
      if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel();
      }
    } catch {
      // ignore
    }
    finish();
  };

  // Start animated lip-sync envelope loop
  options.onEnergy?.(0.55, true);
  energyTimer = window.setInterval(() => {
    if (cancelled) return;
    const elapsed = performance.now() - startTime;
    if (elapsed >= durationMs) {
      finish();
      return;
    }
    const charIdx = Math.floor((elapsed / durationMs) * cleanText.length);
    const ch = cleanText[charIdx] || 'а';
    const isPause = ch === ' ' || ch === ',' || ch === '.' || ch === '—' || ch === '!';
    const syllabicWave =
      0.45 +
      0.35 * Math.sin(elapsed * 0.024) +
      0.2 * Math.cos(elapsed * 0.041);
    const energy = isPause ? 0.12 : Math.max(0.2, Math.min(1, syllabicWave));
    options.onEnergy?.(energy, true);
  }, 50);

  const effectiveVol = options.muted ? 0 : Math.max(0, Math.min(1, options.volume ?? 0.8));

  // 1. Try browser native SpeechSynthesis in Russian
  let nativeSpeechStarted = false;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window && effectiveVol > 0.01) {
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(cleanText);
      utter.lang = 'ru-RU';
      utter.pitch = bot.voiceProfile.pitch;
      utter.rate = bot.voiceProfile.rate;
      utter.volume = effectiveVol;

      const voices = window.speechSynthesis.getVoices();
      const ruVoices = voices.filter((v) => v.lang.toLowerCase().startsWith('ru'));
      if (ruVoices.length > 0) {
        const wantFemale = bot.voiceProfile.gender === 'female';
        const genderMatch = ruVoices.find((v) => {
          const n = v.name.toLowerCase();
          return wantFemale
            ? n.includes('irina') || n.includes('milena') || n.includes('katya') || n.includes('female') || n.includes('google')
            : n.includes('pavel') || n.includes('yuri') || n.includes('dmitry') || n.includes('male');
        });
        utter.voice = genderMatch || ruVoices[0];
      }

      utter.onstart = () => {
        nativeSpeechStarted = true;
      };
      utter.onend = () => {
        finish();
      };
      utter.onerror = () => {
        // Let fallback timer finish gracefully
      };

      window.speechSynthesis.speak(utter);
    } catch {
      // Ignore native speech errors
    }
  }

  // 2. Subtle intercom line voice formant murmur (provides characteristic intercom speaker timber
  // and guarantees audible voice feedback even if OS lacks Russian TTS pack)
  if (typeof window !== 'undefined' && effectiveVol > 0.01) {
    try {
      const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (Ctx) {
        audioCtx = new Ctx();
        const now = audioCtx.currentTime;
        const totalSec = durationMs / 1000;

        const osc = audioCtx.createOscillator();
        const formant = audioCtx.createBiquadFilter();
        const bandpass = audioCtx.createBiquadFilter();
        const gain = audioCtx.createGain();

        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(bot.voiceProfile.baseFreq, now);

        // Intercom speaker bandpass (350Hz - 2800Hz)
        bandpass.type = 'bandpass';
        bandpass.frequency.setValueAtTime(950 * bot.voiceProfile.formantShift, now);
        bandpass.Q.setValueAtTime(2.2, now);

        formant.type = 'peaking';
        formant.frequency.setValueAtTime(1650 * bot.voiceProfile.formantShift, now);
        formant.gain.setValueAtTime(8, now);

        const baseGain = (nativeSpeechStarted ? 0.012 : 0.028) * effectiveVol;
        gain.gain.setValueAtTime(0.0001, now);

        // Modulate syllables across the sentence
        const steps = Math.max(6, Math.min(36, Math.floor(totalSec * 7)));
        const stepDur = totalSec / steps;
        for (let i = 0; i < steps; i++) {
          const tStep = now + i * stepDur;
          const ch = cleanText[Math.floor((i / steps) * cleanText.length)] || 'а';
          const isPause = ch === ' ' || ch === '.' || ch === ',' || ch === '!';
          const pitchMod = 1 + Math.sin(i * 1.7) * 0.08 - (i / steps) * 0.06;
          osc.frequency.setValueAtTime(bot.voiceProfile.baseFreq * pitchMod, tStep);
          gain.gain.linearRampToValueAtTime(isPause ? 0.0005 : baseGain, tStep + stepDur * 0.3);
          gain.gain.linearRampToValueAtTime(0.001, tStep + stepDur * 0.95);
        }

        gain.gain.linearRampToValueAtTime(0.0001, now + totalSec);

        osc.connect(bandpass);
        bandpass.connect(formant);
        formant.connect(gain);
        gain.connect(audioCtx.destination);

        osc.start(now);
        osc.stop(now + totalSec + 0.05);
      }
    } catch {
      // Ignore AudioContext restrictions
    }
  }

  synthFinishTimer = window.setTimeout(() => {
    finish();
  }, durationMs + 120);

  return () => {
    if (activeStopCallback) activeStopCallback();
  };
}
