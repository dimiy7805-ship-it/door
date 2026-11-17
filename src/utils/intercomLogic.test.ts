import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validatePin,
  generateFreePin,
  findRouletteMatch,
  matchRouletteQueue,
  resolveKeypadPress,
  formatIntercomDisplay,
  sanitizeChatMessage,
  cycleRemoteRotationMode,
  formatRotationLabel,
  resolveEffectiveRotation,
  PUBLIC_SITE_URL,
  resolveShareableSiteUrl,
} from './intercomLogic';
import { encodePcm8Base64, decodePcm8Base64 } from './soundEngine';

test('validatePin accepts 1 to 5 digits without leading zero', () => {
  assert.deepEqual(validatePin('50'), { valid: true, normalized: '50' });
  assert.deepEqual(validatePin(' 777 '), { valid: true, normalized: '777' });
  assert.deepEqual(validatePin('12548'), { valid: true, normalized: '12548' });
  assert.equal(validatePin('').valid, false);
  assert.equal(validatePin('0').valid, false);
  assert.equal(validatePin('012').valid, false);
  assert.equal(validatePin('123456').valid, false);
  assert.equal(validatePin('12a4').valid, false);
});

test('generateFreePin produces an untaken 3-digit PIN', () => {
  const taken = new Set(['101', '102', '103']);
  const pin = generateFreePin(taken, () => 0); // 101 + 0 = 101 (taken), fallback deterministic if needed
  assert.equal(taken.has(pin), false);
  assert.equal(validatePin(pin).valid, true);
});

test('findRouletteMatch avoids self and deprioritizes last partner when possible', () => {
  const candidates = [
    { clientId: 'me', pin: '101', joinedAt: 100 },
    { clientId: 'u2', pin: '202', joinedAt: 200 },
    { clientId: 'u3', pin: '303', joinedAt: 300 },
  ];

  // Without lastPartner, picks oldest waiting ('u2')
  const firstMatch = findRouletteMatch('me', candidates, null);
  assert.equal(firstMatch?.clientId, 'u2');

  // With lastPartner = 'u2', picks 'u3' instead
  const secondMatch = findRouletteMatch('me', candidates, 'u2');
  assert.equal(secondMatch?.clientId, 'u3');

  // If only 'u2' is available, falls back to 'u2'
  const fallbackMatch = findRouletteMatch('me', candidates.slice(0, 2), 'u2');
  assert.equal(fallbackMatch?.clientId, 'u2');
});

test('matchRouletteQueue prioritizes the user who clicked Next over their previous partner', () => {
  // Scenario 1: 'me' and 'prevPartner' were in a call; 'waitingPeer' was already waiting since t=500
  // (and even had 'me' as lastPartnerClientId from an earlier round).
  // Now 'me' clicks Next at t=1000. 'me' MUST be matched with 'waitingPeer', NOT 'prevPartner'!
  const queueWithWaitingPeer = [
    {
      clientId: 'waitingPeer',
      pin: '303',
      joinedAt: 500,
      lastPartnerClientId: 'me',
      lastSkippedAt: 400,
    },
    {
      clientId: 'prevPartner',
      pin: '202',
      joinedAt: 1500,
      lastPartnerClientId: 'me',
      lastSkippedAt: 1000,
    },
    {
      clientId: 'me',
      pin: '101',
      joinedAt: 1000,
      lastPartnerClientId: 'prevPartner',
      lastSkippedAt: 1000,
    },
  ];

  const pairs1 = matchRouletteQueue(queueWithWaitingPeer, 'me', 1000, 1800);
  assert.equal(pairs1.length, 1);
  assert.equal(pairs1[0].seeker.clientId, 'me');
  assert.equal(pairs1[0].partner.clientId, 'waitingPeer');

  // Scenario 2: Only 'me' and 'prevPartner' are in the queue right when 'me' clicks Next at t=1000.
  // During the 1800ms cooldown, they do NOT immediately re-match so a joining 3rd user can match with 'me' first.
  const twoOnlyQueue = [
    {
      clientId: 'me',
      pin: '101',
      joinedAt: 1000,
      lastPartnerClientId: 'prevPartner',
      lastSkippedAt: 1000,
    },
    {
      clientId: 'prevPartner',
      pin: '202',
      joinedAt: 1500,
      lastPartnerClientId: 'me',
      lastSkippedAt: 1000,
    },
  ];
  const pairsDuringCooldown = matchRouletteQueue(twoOnlyQueue, 'me', 1200, 1800);
  assert.equal(pairsDuringCooldown.length, 0);

  // When a 3rd user 'newPeer' joins at t=1400, 'me' (joinedAt=1000 < prevPartner joinedAt=1500) matches with 'newPeer' first!
  const pairsWhenThirdJoins = matchRouletteQueue(
    [
      ...twoOnlyQueue,
      { clientId: 'newPeer', pin: '404', joinedAt: 1400, lastPartnerClientId: null },
    ],
    'newPeer',
    1400,
    1800
  );
  assert.equal(pairsWhenThirdJoins.length, 1);
  const matchedIds = new Set([
    pairsWhenThirdJoins[0].seeker.clientId,
    pairsWhenThirdJoins[0].partner.clientId,
  ]);
  assert.equal(matchedIds.has('me'), true);
  assert.equal(matchedIds.has('newPeer'), true);
  assert.equal(matchedIds.has('prevPartner'), false);

  // After cooldown expires (t=3000), if only 'me' and 'prevPartner' are online, they can match again
  const pairsAfterCooldown = matchRouletteQueue(twoOnlyQueue, undefined, 3000, 1800);
  assert.equal(pairsAfterCooldown.length, 1);
});

test('resolveKeypadPress handles digits, B (call/answer/next), and C (clear/hangup)', () => {
  // Digit entry in idle state
  const d1 = resolveKeypadPress({ mode: 'code', callState: 'idle', currentInput: '42' }, '7');
  assert.deepEqual(d1, { type: 'INPUT_CHANGED', input: '427' });

  // Disallow leading zero
  const d0 = resolveKeypadPress({ mode: 'code', callState: 'idle', currentInput: '' }, '0');
  assert.deepEqual(d0, { type: 'NOOP' });

  // Pressing B with input dials code
  const dial = resolveKeypadPress({ mode: 'code', callState: 'idle', currentInput: '427' }, 'B');
  assert.deepEqual(dial, { type: 'DIAL_CODE', targetPin: '427' });

  // Pressing B on incoming call answers it
  const ans = resolveKeypadPress({ mode: 'code', callState: 'incoming', currentInput: '' }, 'B');
  assert.deepEqual(ans, { type: 'ANSWER_CALL' });

  // Pressing B in roulette while connected switches to next partner
  const next = resolveKeypadPress({ mode: 'roulette', callState: 'connected', currentInput: '' }, 'B');
  assert.deepEqual(next, { type: 'NEXT_ROULETTE' });

  // Pressing C while connected hangs up
  const hangup = resolveKeypadPress({ mode: 'code', callState: 'connected', currentInput: '' }, 'C');
  assert.deepEqual(hangup, { type: 'HANGUP_CALL' });
});

test('formatIntercomDisplay returns clean LED strings', () => {
  assert.equal(formatIntercomDisplay({ callState: 'idle', currentInput: '' }), 'READY');
  assert.equal(formatIntercomDisplay({ callState: 'idle', currentInput: '504' }), '504');
  assert.equal(formatIntercomDisplay({ callState: 'searching', currentInput: '' }), 'SCAN');
  assert.equal(formatIntercomDisplay({ callState: 'autodialing', currentInput: '', autoDialBuffer: '77' }), '77');
  assert.equal(formatIntercomDisplay({ callState: 'connected', currentInput: '' }), 'TALK');
  assert.equal(formatIntercomDisplay({ callState: 'ended', currentInput: '' }), 'RESET');
});

test('sanitizeChatMessage normalizes text, preserves line breaks, and rejects empty or invalid messages', () => {
  assert.equal(sanitizeChatMessage('  Привет, открывай!  '), 'Привет, открывай!');
  assert.equal(sanitizeChatMessage('Код\nдомофона\t123'), 'Код\nдомофона 123');
  assert.equal(sanitizeChatMessage('   '), null);
  assert.equal(sanitizeChatMessage(null), null);
  assert.equal(sanitizeChatMessage('a'.repeat(350))?.length, 280);
});

test('cycleRemoteRotationMode and formatRotationLabel cycle through auto and 90-degree increments', () => {
  assert.equal(cycleRemoteRotationMode('auto'), 0);
  assert.equal(cycleRemoteRotationMode(0), 90);
  assert.equal(cycleRemoteRotationMode(90), 180);
  assert.equal(cycleRemoteRotationMode(180), 270);
  assert.equal(cycleRemoteRotationMode(270), 'auto');

  assert.equal(formatRotationLabel('auto'), 'AUTO');
  assert.equal(formatRotationLabel(0), '0°');
  assert.equal(formatRotationLabel(90), '90°');

  assert.equal(resolveEffectiveRotation('auto', 720, 1280, 512, 320), 0);
  assert.equal(resolveEffectiveRotation(180, 720, 1280, 512, 320), 180);

  // When a fixed angle (e.g. 0 or 90) is locked with a portrait baseline (baselineIsPortrait = true),
  // if the peer rotates their phone to landscape (1280x720), resolveEffectiveRotation counter-rotates by 270 (-90)
  // so the image does not rotate on screen:
  assert.equal(resolveEffectiveRotation(0, 720, 1280, 512, 320, true), 0);
  assert.equal(resolveEffectiveRotation(0, 1280, 720, 512, 320, true), 270);
  assert.equal(resolveEffectiveRotation(90, 1280, 720, 512, 320, true), 0);
  assert.equal(resolveEffectiveRotation('auto', 1280, 720, 512, 320, true), 0);
});

test('resolveShareableSiteUrl returns clean GitHub Pages URL or custom production URL', () => {
  assert.equal(resolveShareableSiteUrl(), PUBLIC_SITE_URL);
  assert.equal(resolveShareableSiteUrl('http://localhost:3000/?serverless=1#top'), 'https://dimiy7805-ship-it.github.io/door/');
  assert.equal(resolveShareableSiteUrl('https://dimiy7805-ship-it.github.io/door/#top'), 'https://dimiy7805-ship-it.github.io/door/');
  assert.equal(resolveShareableSiteUrl('https://dimiy7805-ship-it.github.io/door'), 'https://dimiy7805-ship-it.github.io/door/');
  assert.equal(resolveShareableSiteUrl('https://domofon.example.com/app?foo=bar'), 'https://domofon.example.com/app/');
});

test('encodePcm8Base64 and decodePcm8Base64 roundtrip voice waveform accurately with compact payload', () => {
  const input = new Float32Array(1280);
  for (let i = 0; i < input.length; i++) {
    input[i] = Math.sin((i / 20) * Math.PI * 2) * 0.65;
  }
  const encoded = encodePcm8Base64(input);
  assert.equal(encoded.length < 1800, true);
  const decoded = decodePcm8Base64(encoded);
  assert.equal(decoded.length, input.length);
  for (let i = 0; i < input.length; i++) {
    assert.equal(Math.abs(decoded[i] - input[i]) < 0.03, true);
  }
});
