export type IntercomBrand = 'eltis' | 'vizit' | 'cyfral';

export type ConnectionMode = 'code' | 'roulette';

export type CallState =
  | 'idle'
  | 'searching'
  | 'autodialing'
  | 'outgoing'
  | 'incoming'
  | 'connected'
  | 'busy'
  | 'not_found'
  | 'ended';

export interface BrandSpec {
  id: IntercomBrand;
  codeName: string;
  fullName: string;
  ledColor: string;
  keyFreq: number;
  ringIntervalMs: number;
}

export const BRAND_SPECS: Record<IntercomBrand, BrandSpec> = {
  eltis: {
    id: 'eltis',
    codeName: 'ELTIS',
    fullName: 'ELTIS DP400',
    ledColor: '#e03e2d',
    keyFreq: 1100,
    ringIntervalMs: 1800,
  },
  vizit: {
    id: 'vizit',
    codeName: 'VIZIT',
    fullName: 'VIZIT BVD-343',
    ledColor: '#2ea043',
    keyFreq: 1400,
    ringIntervalMs: 1200,
  },
  cyfral: {
    id: 'cyfral',
    codeName: 'CYFRAL',
    fullName: 'CYFRAL CCD-2094',
    ledColor: '#d94e28',
    keyFreq: 900,
    ringIntervalMs: 2000,
  },
};

export interface PinValidationResult {
  valid: boolean;
  normalized: string;
  error?: string;
}

/**
 * Validates a user-chosen intercom PIN / apartment number.
 * Allowed: 1 to 5 numeric digits, not all zeros.
 */
export function validatePin(raw: string): PinValidationResult {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) {
    return { valid: false, normalized: '', error: 'Введите номер от 1 до 5 цифр' };
  }
  if (!/^\d{1,5}$/.test(trimmed)) {
    return { valid: false, normalized: trimmed, error: 'Номер должен содержать только цифры (1–5 знаков)' };
  }
  if (/^0+$/.test(trimmed)) {
    return { valid: false, normalized: trimmed, error: 'Номер не может состоять только из нулей' };
  }
  // Normalize leading zeros if more than 1 digit? Keep exact digits unless leading zero on 1-digit,
  // actually in intercoms apartment numbers don't start with 0 (e.g. 1..99999). Let's disallow leading zero.
  if (trimmed.startsWith('0')) {
    return { valid: false, normalized: trimmed, error: 'Номер квартиры/кода не должен начинаться с 0' };
  }
  return { valid: true, normalized: trimmed };
}

/**
 * Generates an available PIN code not present in `takenPins`.
 */
export function generateFreePin(
  takenPins: ReadonlySet<string>,
  randomFn: () => number = Math.random
): string {
  // Prefer clean 3-digit intercom numbers (101 - 999) first
  for (let attempt = 0; attempt < 150; attempt++) {
    const num = Math.floor(101 + randomFn() * 899);
    const candidate = String(num);
    if (!takenPins.has(candidate)) {
      return candidate;
    }
  }
  // Fallback to 4-digit numbers (1001 - 9999)
  for (let attempt = 0; attempt < 500; attempt++) {
    const num = Math.floor(1001 + randomFn() * 8999);
    const candidate = String(num);
    if (!takenPins.has(candidate)) {
      return candidate;
    }
  }
  // Deterministic scan if heavily populated
  for (let i = 101; i <= 99999; i++) {
    const candidate = String(i);
    if (!takenPins.has(candidate)) {
      return candidate;
    }
  }
  return '99999';
}

export interface RouletteCandidate {
  clientId: string;
  pin: string;
  joinedAt: number;
  lastPartnerClientId?: string | null;
  lastSkippedAt?: number | null;
}

/**
 * Selects the best matching partner in Roulette queue for `selfClientId`.
 * - Never matches a user with themselves.
 * - Strongly avoids `lastPartnerClientId` whenever any other candidate is available.
 * - First prefers a candidate who is neither `lastPartnerClientId` nor has `selfClientId` as their `lastPartnerClientId`.
 * - Second prefers ANY candidate who is not `lastPartnerClientId` (e.g. in a 3-user cycle after skipping the current partner).
 * - Only falls back to `lastPartnerClientId` if they are the sole candidate AND the repeat-partner cooldown has elapsed.
 */
export function findRouletteMatch(
  selfClientId: string,
  candidates: readonly RouletteCandidate[],
  lastPartnerClientId?: string | null,
  options?: {
    selfLastSkippedAt?: number | null;
    now?: number;
    repeatPartnerCooldownMs?: number;
  }
): RouletteCandidate | null {
  const others = candidates
    .filter((c) => c.clientId !== selfClientId)
    .sort((a, b) => a.joinedAt - b.joinedAt);

  if (others.length === 0) {
    return null;
  }

  // 1. Best match: neither side just skipped the other
  const mutuallyFresh = others.find(
    (c) =>
      c.clientId !== lastPartnerClientId &&
      (!c.lastPartnerClientId || c.lastPartnerClientId !== selfClientId)
  );
  if (mutuallyFresh) {
    return mutuallyFresh;
  }

  // 2. Next best: not the partner that `selfClientId` just skipped
  if (lastPartnerClientId) {
    const freshForSelf = others.find((c) => c.clientId !== lastPartnerClientId);
    if (freshForSelf) {
      return freshForSelf;
    }
  }

  // 3. Sole candidate is `lastPartnerClientId`: respect repeat-partner cooldown if configured
  const fallback = others[0];
  if (
    lastPartnerClientId &&
    fallback.clientId === lastPartnerClientId &&
    options?.repeatPartnerCooldownMs &&
    options.repeatPartnerCooldownMs > 0
  ) {
    const now = options.now ?? Date.now();
    const selfSkippedAt = options.selfLastSkippedAt ?? 0;
    const peerSkippedAt = fallback.lastSkippedAt ?? 0;
    const latestSkip = Math.max(selfSkippedAt, peerSkippedAt);
    if (latestSkip > 0 && now - latestSkip < options.repeatPartnerCooldownMs) {
      return null;
    }
  }

  return fallback;
}

export interface RouletteMatchPair {
  seeker: RouletteCandidate;
  partner: RouletteCandidate;
}

/**
 * Matches all waiting Roulette candidates while guaranteeing that if `priorityClientId`
 * (the user who actively pressed "Next" / "Start") is in the queue, they are matched FIRST
 * ahead of their previous partner.
 */
export function matchRouletteQueue(
  candidates: readonly RouletteCandidate[],
  priorityClientId?: string | null,
  now: number = Date.now(),
  repeatPartnerCooldownMs: number = 1800
): RouletteMatchPair[] {
  if (candidates.length < 2) {
    return [];
  }

  const sorted = [...candidates].sort((a, b) => a.joinedAt - b.joinedAt);
  const seekers: RouletteCandidate[] = [];

  if (priorityClientId) {
    const priorityEntry = sorted.find((c) => c.clientId === priorityClientId);
    if (priorityEntry) {
      seekers.push(priorityEntry);
    }
  }
  for (const c of sorted) {
    if (c.clientId !== priorityClientId) {
      seekers.push(c);
    }
  }

  const matchedIds = new Set<string>();
  const pairs: RouletteMatchPair[] = [];

  for (const seeker of seekers) {
    if (matchedIds.has(seeker.clientId)) continue;

    const availablePool = sorted.filter((c) => !matchedIds.has(c.clientId));
    const partner = findRouletteMatch(seeker.clientId, availablePool, seeker.lastPartnerClientId, {
      selfLastSkippedAt: seeker.lastSkippedAt,
      now,
      repeatPartnerCooldownMs,
    });

    if (!partner) continue;

    matchedIds.add(seeker.clientId);
    matchedIds.add(partner.clientId);
    pairs.push({ seeker, partner });
  }

  return pairs;
}

export interface KeypadContext {
  mode: ConnectionMode;
  callState: CallState;
  currentInput: string;
}

export type KeypadAction =
  | { type: 'INPUT_CHANGED'; input: string }
  | { type: 'DIAL_CODE'; targetPin: string }
  | { type: 'ANSWER_CALL' }
  | { type: 'HANGUP_CALL' }
  | { type: 'START_ROULETTE' }
  | { type: 'NEXT_ROULETTE' }
  | { type: 'STOP_ROULETTE' }
  | { type: 'NOOP' };

/**
 * Pure state machine deciding what pressing a 3D intercom key ('0'-'9', 'C', 'B') does.
 */
export function resolveKeypadPress(ctx: KeypadContext, label: string): KeypadAction {
  const key = label.toUpperCase();

  // Key 'C' = Сброс (Reset / Clear / Hangup / Stop Roulette)
  if (key === 'C') {
    if (
      ctx.callState === 'outgoing' ||
      ctx.callState === 'incoming' ||
      ctx.callState === 'connected' ||
      ctx.callState === 'autodialing'
    ) {
      return { type: 'HANGUP_CALL' };
    }
    if (ctx.callState === 'searching') {
      return { type: 'STOP_ROULETTE' };
    }
    if (ctx.currentInput.length > 0) {
      return { type: 'INPUT_CHANGED', input: '' };
    }
    return { type: 'INPUT_CHANGED', input: '' };
  }

  // Key 'B' = Вызов (Call / Answer / Next in Roulette)
  if (key === 'B') {
    if (ctx.callState === 'incoming') {
      return { type: 'ANSWER_CALL' };
    }
    if (ctx.mode === 'roulette') {
      if (ctx.callState === 'connected' || ctx.callState === 'outgoing' || ctx.callState === 'autodialing') {
        return { type: 'NEXT_ROULETTE' };
      }
      if (ctx.callState === 'idle' || ctx.callState === 'ended' || ctx.callState === 'busy' || ctx.callState === 'not_found') {
        return { type: 'START_ROULETTE' };
      }
      if (ctx.callState === 'searching') {
        return { type: 'NEXT_ROULETTE' };
      }
    }
    // Direct code mode
    if (ctx.callState === 'connected' || ctx.callState === 'outgoing') {
      return { type: 'NOOP' };
    }
    if (ctx.currentInput.length > 0) {
      return { type: 'DIAL_CODE', targetPin: ctx.currentInput };
    }
    return { type: 'NOOP' };
  }

  // Numeric keys '0'-'9'
  if (/^\d$/.test(key)) {
    if (ctx.callState !== 'idle' && ctx.callState !== 'ended' && ctx.callState !== 'busy' && ctx.callState !== 'not_found') {
      return { type: 'NOOP' };
    }
    // Disallow leading 0
    if (ctx.currentInput.length === 0 && key === '0') {
      return { type: 'NOOP' };
    }
    if (ctx.currentInput.length >= 5) {
      return { type: 'NOOP' };
    }
    return { type: 'INPUT_CHANGED', input: ctx.currentInput + key };
  }

  return { type: 'NOOP' };
}

/**
 * Formats the 7-segment LED display text (up to 6 characters) for the 3D intercom panel.
 */
export function formatIntercomDisplay(params: {
  callState: CallState;
  currentInput: string;
  peerPin?: string | null;
  autoDialBuffer?: string;
}): string {
  const { callState, currentInput, peerPin, autoDialBuffer } = params;

  switch (callState) {
    case 'searching':
      return 'SCAN';
    case 'autodialing':
      return autoDialBuffer && autoDialBuffer.length > 0 ? autoDialBuffer : 'AUTO';
    case 'outgoing':
      return 'CALL';
    case 'incoming':
      return peerPin ? `IN ${peerPin}` : 'RING';
    case 'connected':
      return 'TALK';
    case 'busy':
      return 'BUSY';
    case 'not_found':
      return 'ERR';
    case 'ended':
      return 'RESET';
    case 'idle':
    default:
      return currentInput.length > 0 ? currentInput : 'READY';
  }
}

export interface ChatMessage {
  id: string;
  senderPin: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
}

export type RemoteRotationMode = 'auto' | 0 | 90 | 180 | 270;

export function cycleRemoteRotationMode(current: RemoteRotationMode): RemoteRotationMode {
  switch (current) {
    case 'auto':
      return 0;
    case 0:
      return 90;
    case 90:
      return 180;
    case 180:
      return 270;
    case 270:
    default:
      return 'auto';
  }
}

export function formatRotationLabel(mode: RemoteRotationMode): string {
  return mode === 'auto' ? 'AUTO' : `${mode}°`;
}

export function resolveEffectiveRotation(
  mode: RemoteRotationMode,
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  baselineIsPortrait?: boolean | null
): 0 | 90 | 180 | 270 {
  if (mode !== 'auto') {
    if (
      baselineIsPortrait !== undefined &&
      baselineIsPortrait !== null &&
      sourceWidth > 0 &&
      sourceHeight > 0 &&
      sourceWidth !== sourceHeight
    ) {
      const currentIsPortrait = sourceHeight > sourceWidth;
      if (currentIsPortrait !== baselineIsPortrait) {
        // Peer rotated their phone (swapping portrait <-> landscape) while a fixed manual angle is locked:
        // counter-rotate by -90 deg (+270 deg) so the displayed image does not rotate.
        return ((mode + 270) % 360) as 0 | 90 | 180 | 270;
      }
    }
    return mode;
  }
  if (sourceWidth <= 0 || sourceHeight <= 0 || targetWidth <= 0 || targetHeight <= 0) {
    return 0;
  }
  return 0;
}

/**
 * Validates and normalizes an in-call text message (1..280 chars, preserves line breaks, strips control chars).
 */
export function sanitizeChatMessage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ')
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 280);
}

export const PUBLIC_SITE_URL = 'https://dimiy7805-ship-it.github.io/door/';

/**
 * Resolves the canonical shareable URL for the intercom app when the user clicks the brand title.
 * On GitHub Pages or custom production domains, returns the clean origin + pathname with trailing slash;
 * in local dev or temporary preview containers, returns the official GitHub Pages deployment URL.
 */
export function resolveShareableSiteUrl(currentHref?: string | null): string {
  if (!currentHref) return PUBLIC_SITE_URL;
  try {
    const parsed = new URL(currentHref);
    const host = parsed.hostname.toLowerCase();
    if (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.endsWith('.run.app') ||
      host.endsWith('.usercontent.goog')
    ) {
      return PUBLIC_SITE_URL;
    }
    if (host === 'dimiy7805-ship-it.github.io') {
      return PUBLIC_SITE_URL;
    }
    const cleanPath = parsed.pathname.endsWith('/') ? parsed.pathname : `${parsed.pathname}/`;
    return `${parsed.origin}${cleanPath}`;
  } catch {
    return PUBLIC_SITE_URL;
  }
}



