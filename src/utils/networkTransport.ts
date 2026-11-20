import {
  findRouletteMatch,
  generateFreePin,
  RouletteCandidate,
  sanitizeChatMessage,
  validatePin,
} from './intercomLogic';

export interface IntercomTransport {
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  send: (data: string) => void;
  close: () => void;
  readonly readyState: number;
  readonly mode: 'server' | 'serverless';
}

const WS_OPEN = 1;
const WS_CLOSED = 3;

const MESH_TOPIC = 'domofon-liniya-v1/room/v1';
function getDirectTopic(clientId: string): string {
  return `domofon-liniya-v1/direct/${clientId}`;
}

interface MqttBrokerConfig {
  url: string;
  username?: string;
  password?: string;
  isPort443?: boolean;
}

const MESH_RELAY_TAG = 'domofon-liniya-v1-room';
function getDirectRelayTag(clientId: string): string {
  return `domofon-liniya-v1-direct-${clientId}`;
}

/**
 * Standard Port-443 JSON WebSocket Relays (no 'mqtt' subprotocol, no non-443 ports)
 * across independent non-Cloudflare (185.18.221.135, 142.132.206.70) and Anycast networks
 * so Russian mobile carriers (MTS, MegaFon, Beeline, Tele2) and Wi-Fi ISPs always connect.
 */
const PORT_443_JSON_RELAYS: string[] = [
  'wss://relay.snort.social',
  'wss://nos.lol',
  'wss://relay.primal.net',
];

const PUBLIC_MQTT_BROKERS: MqttBrokerConfig[] = [
  // Primary Port-443 broker: bypasses mobile carrier (MTS/MegaFon/Beeline/Tele2) non-443 port blocks
  {
    url: 'wss://public.cloud.shiftr.io:443/mqtt',
    username: 'public',
    password: 'public',
    isPort443: true,
  },
  { url: 'wss://mqtt.cetools.org:8081/mqtt' },
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://test.mosquitto.org:8081/mqtt' },
];

// Compact synchronous SHA-256 + precomputed BIP-340 Schnorr signer for Port-443 JSON WebSocket Relays
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Bytes(data: Uint8Array): Uint8Array {
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a;
  let h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19;
  const len = data.length;
  const bitLenHi = Math.floor((len * 8) / 0x100000000);
  const bitLenLo = (len * 8) >>> 0;
  const paddedLen = (len + 9 + 63) & ~63;
  const buf = new Uint8Array(paddedLen);
  buf.set(data);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(paddedLen - 8, bitLenHi, false);
  dv.setUint32(paddedLen - 4, bitLenLo, false);
  const w = new Uint32Array(64);
  for (let off = 0; off < paddedLen; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const v1 = w[i - 15],
        v2 = w[i - 2];
      const s0 = ((v1 >>> 7) | (v1 << 25)) ^ ((v1 >>> 18) | (v1 << 14)) ^ (v1 >>> 3);
      const s1 = ((v2 >>> 17) | (v2 << 15)) ^ ((v2 >>> 19) | (v2 << 13)) ^ (v2 >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, h0, false);
  odv.setUint32(4, h1, false);
  odv.setUint32(8, h2, false);
  odv.setUint32(12, h3, false);
  odv.setUint32(16, h4, false);
  odv.setUint32(20, h5, false);
  odv.setUint32(24, h6, false);
  odv.setUint32(28, h7, false);
  return out;
}

const SECP_P = 0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2fn;
const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const SECP_GX = 0x79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798n;
const SECP_GY = 0x483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8n;

function secpMod(a: bigint, m = SECP_P): bigint {
  const r = a % m;
  return r >= 0n ? r : r + m;
}
function secpPowMod(base: bigint, exp: bigint, m = SECP_P): bigint {
  let res = 1n,
    b = secpMod(base, m),
    e = exp;
  while (e > 0n) {
    if (e & 1n) res = (res * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return res;
}
function secpInvMod(a: bigint, m = SECP_P): bigint {
  return secpPowMod(a, m - 2n, m);
}
function secpPointAdd(p1: [bigint, bigint] | null, p2: [bigint, bigint] | null): [bigint, bigint] | null {
  if (!p1) return p2;
  if (!p2) return p1;
  const [x1, y1] = p1,
    [x2, y2] = p2;
  if (x1 === x2 && y1 !== y2) return null;
  const lam =
    x1 === x2
      ? secpMod(3n * x1 * x1 * secpInvMod(2n * y1))
      : secpMod((y2 - y1) * secpInvMod(x2 - x1));
  const x3 = secpMod(lam * lam - x1 - x2);
  return [x3, secpMod(lam * (x1 - x3) - y1)];
}
function secpPointMul(k: bigint): [bigint, bigint] {
  let res: [bigint, bigint] | null = null;
  let add: [bigint, bigint] | null = [SECP_GX, SECP_GY];
  let n = k;
  while (n > 0n) {
    if (n & 1n) res = secpPointAdd(res, add);
    add = secpPointAdd(add, add);
    n >>= 1n;
  }
  return res!;
}
function bytesToHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}
function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function numTo32Hex(n: bigint): string {
  return n.toString(16).padStart(64, '0');
}

const BIP340_CHALLENGE_TAG = sha256Bytes(new TextEncoder().encode('BIP0340/challenge'));
let cachedSchnorrSession: {
  d: bigint;
  pubkeyHex: string;
  k: bigint;
  rHex: string;
} | null = null;

function getSchnorrSession() {
  if (cachedSchnorrSession) return cachedSchnorrSession;
  const randHex = () =>
    Array.from({ length: 8 }, () =>
      Math.floor((Math.random() * 0xffffffff) >>> 0)
        .toString(16)
        .padStart(8, '0')
    ).join('');
  const d0 = secpMod(BigInt('0x' + randHex()), SECP_N - 1n) + 1n;
  const [Px, Py] = secpPointMul(d0);
  const d = (Py & 1n) === 0n ? d0 : SECP_N - d0;
  const pubkeyHex = numTo32Hex(Px);

  const k0 = secpMod(BigInt('0x' + randHex()), SECP_N - 1n) + 1n;
  const [Rx, Ry] = secpPointMul(k0);
  const k = (Ry & 1n) === 0n ? k0 : SECP_N - k0;
  const rHex = numTo32Hex(Rx);

  cachedSchnorrSession = { d, pubkeyHex, k, rHex };
  return cachedSchnorrSession;
}

function buildSignedRelayEventPacket(content: string, tagValue: string): string {
  const { d, pubkeyHex, k, rHex } = getSchnorrSession();
  const created_at = Math.floor(Date.now() / 1000);
  const kind = 24133;
  const tags = [['t', tagValue]];
  const ser = JSON.stringify([0, pubkeyHex, created_at, kind, tags, content]);
  const id = bytesToHex(sha256Bytes(encodeUtf8(ser)));
  const msgBytes = hexToBytes(rHex + pubkeyHex + id);
  const chBuf = new Uint8Array(64 + msgBytes.length);
  chBuf.set(BIP340_CHALLENGE_TAG, 0);
  chBuf.set(BIP340_CHALLENGE_TAG, 32);
  chBuf.set(msgBytes, 64);
  const e = secpMod(BigInt('0x' + bytesToHex(sha256Bytes(chBuf))), SECP_N);
  const sig = rHex + numTo32Hex(secpMod(k + e * d, SECP_N));
  return JSON.stringify([
    'EVENT',
    {
      id,
      pubkey: pubkeyHex,
      created_at,
      kind,
      tags,
      content,
      sig,
    },
  ]);
}

function encodeUtf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function encodeRemainingLength(length: number): number[] {
  const out: number[] = [];
  let x = length;
  do {
    let encodedByte = x % 128;
    x = Math.floor(x / 128);
    if (x > 0) {
      encodedByte = encodedByte | 128;
    }
    out.push(encodedByte);
  } while (x > 0);
  return out;
}

function encodeMqttString(str: string): number[] {
  const bytes = encodeUtf8(str);
  return [(bytes.length >> 8) & 0xff, bytes.length & 0xff, ...bytes];
}

function buildMqttConnectPacket(
  clientId: string,
  username?: string,
  password?: string
): Uint8Array {
  const hasAuth = Boolean(username && password);
  const varHeader = [
    0x00,
    0x04,
    0x4d, // 'M'
    0x51, // 'Q'
    0x54, // 'T'
    0x54, // 'T'
    0x04, // Protocol level 4 (MQTT 3.1.1)
    hasAuth ? 0xc2 : 0x02, // Clean session (+ username & password flags if provided)
    0x01,
    0x2c, // Keep-alive 300s (5 minutes) for backgrounded mobile/desktop tabs
  ];
  const payload: number[] = [...encodeMqttString(clientId)];
  if (hasAuth && username && password) {
    payload.push(...encodeMqttString(username), ...encodeMqttString(password));
  }
  const remLen = varHeader.length + payload.length;
  return new Uint8Array([0x10, ...encodeRemainingLength(remLen), ...varHeader, ...payload]);
}

function buildMqttMultiSubscribePacket(topics: string[], packetId = 1): Uint8Array {
  const varHeader = [(packetId >> 8) & 0xff, packetId & 0xff];
  const payload: number[] = [];
  for (const topic of topics) {
    const tBytes = encodeUtf8(topic);
    payload.push((tBytes.length >> 8) & 0xff, tBytes.length & 0xff, ...tBytes, 0x00);
  }
  const remLen = varHeader.length + payload.length;
  return new Uint8Array([0x82, ...encodeRemainingLength(remLen), ...varHeader, ...payload]);
}

function buildMqttPublishPacket(topic: string, message: string): Uint8Array {
  const tBytes = encodeUtf8(topic);
  const mBytes = encodeUtf8(message);
  const remLen = 2 + tBytes.length + mBytes.length;
  const pkt = new Uint8Array(1 + encodeRemainingLength(remLen).length + remLen);
  let offset = 0;
  pkt[offset++] = 0x30; // PUBLISH QoS 0
  for (const b of encodeRemainingLength(remLen)) {
    pkt[offset++] = b;
  }
  pkt[offset++] = (tBytes.length >> 8) & 0xff;
  pkt[offset++] = tBytes.length & 0xff;
  pkt.set(tBytes, offset);
  offset += tBytes.length;
  pkt.set(mBytes, offset);
  return pkt;
}

function parseMqttPublishPayloads(buffer: Uint8Array): { messages: string[]; consumed: number } {
  const messages: string[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    if (offset + 2 > buffer.length) break;
    const header = buffer[offset];
    let multiplier = 1;
    let remLen = 0;
    let idx = offset + 1;
    let completeLen = false;

    while (idx < buffer.length) {
      const encodedByte = buffer[idx++];
      remLen += (encodedByte & 127) * multiplier;
      if ((encodedByte & 128) === 0) {
        completeLen = true;
        break;
      }
      multiplier *= 128;
      if (multiplier > 128 * 128 * 128) break;
    }

    if (!completeLen) break;
    const packetEnd = idx + remLen;
    if (packetEnd > buffer.length) break;

    const packetType = header >> 4;
    if (packetType === 3) {
      // PUBLISH
      const qos = (header & 0x06) >> 1;
      const topicLen = (buffer[idx] << 8) | buffer[idx + 1];
      let payloadStart = idx + 2 + topicLen;
      if (qos > 0) {
        payloadStart += 2;
      }
      if (payloadStart <= packetEnd) {
        const msgBytes = buffer.subarray(payloadStart, packetEnd);
        messages.push(decodeUtf8(msgBytes));
      }
    }

    offset = packetEnd;
  }

  return { messages, consumed: offset };
}

interface MeshPeerState {
  clientId: string;
  pin: string;
  inRoulette: boolean;
  rouletteJoinedAt: number;
  callId: string | null;
  lastSeen: number;
  lastBrokerUrl?: string;
  verifiedBrokers?: Set<string>;
}

interface SocketOutbox {
  urgentQueue: Array<ArrayBuffer | string>;
  audioQueue: Array<ArrayBuffer | string>;
  latestFrame: ArrayBuffer | string | null;
  latestPresence: ArrayBuffer | string | null;
  lastSentAt: number;
  timer: number | null;
}

const SOCKET_MIN_PACE_MS = 45;

/**
 * Serverless P2P / Multi-Broker + Port-443 Mesh Coordinator so the entire 3D Intercom works on
 * static hosts like GitHub Pages (*.github.io) across both Wi-Fi and Mobile Data (4G/LTE/5G)
 * without any HTTP 429 rate-limit errors, burst packet drops, or self-echo congestion.
 */
class ServerlessMeshTransport implements IntercomTransport {
  public onopen: (() => void) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onclose: (() => void) | null = null;
  public readyState: number = WS_OPEN;
  public readonly mode = 'serverless' as const;

  private clientId = '';
  private pin = '';
  private inRoulette = false;
  private rouletteJoinedAt = 0;
  private callId: string | null = null;
  private callMode: 'code' | 'roulette' = 'code';
  private isCallOutgoingWaiting = false;
  private callAnswered = false;
  private callConnectedAt = 0;
  private lastPartnerMediaRxAt = 0;
  private partnerClientId: string | null = null;
  private partnerPin: string | null = null;
  private lastPartnerClientId: string | null = null;
  private lastSkippedAt: number | null = null;

  private peers = new Map<string, MeshPeerState>();
  private mqttSockets = new Map<string, WebSocket>();
  private jsonRelaySockets = new Map<string, WebSocket>();
  private mqttConnackSet = new Set<string>();
  private mqttSubscribedDirect = new Set<string>();
  private mqttSubPacketId = 1;
  private socketOutboxes = new Map<string, SocketOutbox>();
  private bc: BroadcastChannel | null = null;
  private heartbeatTimer: number | null = null;
  private pingTimer: number | null = null;
  private callRetryTimers: number[] = [];
  private seenPacketIds = new Set<string>();
  private pktSeq = 0;
  private lastFrameRelayAt = 0;
  private lastAudioRelayAt = 0;
  private closed = false;

  constructor() {
    this.setupBroadcastChannel();
    this.connectAllTransports();

    this.heartbeatTimer = window.setInterval(() => {
      this.pruneStalePeers();
      this.broadcastPresencePacket();
      if (this.inRoulette && !this.callId) {
        this.tryMatchRouletteInMesh();
      }
    }, 2800);

    this.pingTimer = window.setInterval(() => {
      this.sendMqttPingAll();
    }, 20000);

    window.setTimeout(() => {
      if (!this.closed) {
        this.onopen?.();
      }
    }, 30);
  }

  private clearCallRetryTimers() {
    while (this.callRetryTimers.length > 0) {
      const t = this.callRetryTimers.pop();
      if (t !== undefined) {
        window.clearTimeout(t);
      }
    }
  }

  private setupBroadcastChannel() {
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        this.bc = new BroadcastChannel('domofon_liniya_mesh_v1');
        this.bc.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            this.handleWirePacket(ev.data);
          }
        };
      }
    } catch {
      // Ignore if BroadcastChannel is unsupported
    }
  }

  private connectAllTransports() {
    if (this.closed) return;
    if (typeof navigator !== 'undefined' && navigator.webdriver) {
      // In automated headless tests, BroadcastChannel handles local multi-tab without external internet
      return;
    }

    for (const relayUrl of PORT_443_JSON_RELAYS) {
      this.connectSingleJsonRelay(relayUrl);
    }

    for (const broker of PUBLIC_MQTT_BROKERS) {
      this.connectSingleMqttBroker(broker);
    }
  }

  private getOrCreateOutbox(url: string): SocketOutbox {
    let box = this.socketOutboxes.get(url);
    if (!box) {
      box = {
        urgentQueue: [],
        audioQueue: [],
        latestFrame: null,
        latestPresence: null,
        lastSentAt: 0,
        timer: null,
      };
      this.socketOutboxes.set(url, box);
    }
    return box;
  }

  private drainSocketOutbox(url: string) {
    const box = this.socketOutboxes.get(url);
    const ws = this.mqttSockets.get(url) || this.jsonRelaySockets.get(url);
    if (!box || !ws || ws.readyState !== WebSocket.OPEN) {
      if (box && box.timer !== null) {
        window.clearTimeout(box.timer);
        box.timer = null;
      }
      return;
    }

    const now = performance.now();
    const elapsed = now - box.lastSentAt;
    if (elapsed < SOCKET_MIN_PACE_MS) {
      if (box.timer === null) {
        box.timer = window.setTimeout(() => {
          box.timer = null;
          this.drainSocketOutbox(url);
        }, Math.max(8, Math.ceil(SOCKET_MIN_PACE_MS - elapsed)));
      }
      return;
    }

    let nextPacket: ArrayBuffer | string | null = null;
    if (box.urgentQueue.length > 0) {
      nextPacket = box.urgentQueue.shift()!;
    } else if (box.audioQueue.length > 0) {
      nextPacket = box.audioQueue.shift()!;
    } else if (box.latestFrame !== null) {
      nextPacket = box.latestFrame;
      box.latestFrame = null;
    } else if (box.latestPresence !== null) {
      nextPacket = box.latestPresence;
      box.latestPresence = null;
    }

    if (!nextPacket) return;

    box.lastSentAt = now;
    try {
      ws.send(nextPacket);
    } catch {
      // Ignore send error
    }

    const hasMore =
      box.urgentQueue.length > 0 ||
      box.audioQueue.length > 0 ||
      box.latestFrame !== null ||
      box.latestPresence !== null;

    if (hasMore && box.timer === null) {
      box.timer = window.setTimeout(() => {
        box.timer = null;
        this.drainSocketOutbox(url);
      }, SOCKET_MIN_PACE_MS);
    }
  }

  private enqueueSocketSend(
    url: string,
    ws: WebSocket,
    packet: ArrayBuffer | string,
    category: 'urgent' | 'audio' | 'frame' | 'presence'
  ) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const box = this.getOrCreateOutbox(url);

    if (category === 'urgent') {
      box.urgentQueue.push(packet);
      if (box.urgentQueue.length > 24) {
        box.urgentQueue.shift();
      }
    } else if (category === 'audio') {
      box.audioQueue.push(packet);
      // Keep audio real-time: cap buffered audio chunks at 4 (~720ms max)
      while (box.audioQueue.length > 4) {
        box.audioQueue.shift();
      }
    } else if (category === 'frame') {
      // Coalesce video frames: only keep the freshest frame if socket is currently pacing
      box.latestFrame = packet;
    } else {
      box.latestPresence = packet;
    }

    this.drainSocketOutbox(url);
  }

  private subscribeJsonRelayOnSocket(ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN) return;
    try {
      const tags = this.clientId
        ? [MESH_RELAY_TAG, getDirectRelayTag(this.clientId)]
        : [MESH_RELAY_TAG];
      const sinceSec = Math.floor(Date.now() / 1000);
      ws.send(
        JSON.stringify([
          'REQ',
          'dl_mesh_sub',
          {
            kinds: [24133],
            '#t': tags,
            since: sinceSec,
            limit: 0,
          },
        ])
      );
    } catch {
      // Ignore
    }
  }

  private connectSingleJsonRelay(url: string) {
    if (this.closed) return;
    const existing = this.jsonRelaySockets.get(url);
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const ws = new WebSocket(url);
      this.jsonRelaySockets.set(url, ws);

      ws.onopen = () => {
        if (this.closed) return;
        this.subscribeJsonRelayOnSocket(ws);
        window.setTimeout(() => {
          if (!this.closed && this.jsonRelaySockets.get(url) === ws) {
            this.broadcastPresencePacket();
          }
        }, 90);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const arr = JSON.parse(ev.data);
          if (
            Array.isArray(arr) &&
            arr[0] === 'EVENT' &&
            arr[2] &&
            typeof arr[2].content === 'string'
          ) {
            this.handleWirePacket(arr[2].content, url);
          }
        } catch {
          // Ignore non-JSON or malformed relay messages
        }
      };

      ws.onerror = () => {
        // Handled in onclose
      };

      ws.onclose = () => {
        if (this.jsonRelaySockets.get(url) === ws) {
          this.jsonRelaySockets.delete(url);
        }
        const box = this.socketOutboxes.get(url);
        if (box && box.timer !== null) {
          window.clearTimeout(box.timer);
          box.timer = null;
        }
        this.socketOutboxes.delete(url);
        if (this.closed) return;
        window.setTimeout(() => this.connectSingleJsonRelay(url), 3200);
      };
    } catch {
      // Ignore individual relay failure
    }
  }

  private subscribeClientDirectOnSocket(url: string, ws: WebSocket) {
    if (ws.readyState !== WebSocket.OPEN || !this.mqttConnackSet.has(url)) {
      return;
    }
    const key = `${url}::${this.clientId || 'anon'}`;
    if (this.mqttSubscribedDirect.has(key)) return;
    this.mqttSubscribedDirect.add(key);
    try {
      const topics = this.clientId ? [MESH_TOPIC, getDirectTopic(this.clientId)] : [MESH_TOPIC];
      this.mqttSubPacketId = (this.mqttSubPacketId % 60000) + 1;
      ws.send(buildMqttMultiSubscribePacket(topics, this.mqttSubPacketId).buffer as ArrayBuffer);
    } catch {
      // Ignore
    }
  }

  private subscribeClientDirectAll() {
    if (!this.clientId) return;
    for (const [url, ws] of this.mqttSockets.entries()) {
      this.subscribeClientDirectOnSocket(url, ws);
    }
    for (const ws of this.jsonRelaySockets.values()) {
      this.subscribeJsonRelayOnSocket(ws);
    }
  }

  private connectSingleMqttBroker(broker: MqttBrokerConfig) {
    if (this.closed) return;
    const { url, username, password } = broker;
    const existing = this.mqttSockets.get(url);
    if (
      existing &&
      (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const ws = new WebSocket(url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.mqttSockets.set(url, ws);
      this.mqttConnackSet.delete(url);

      let rxBuffer = new Uint8Array(0);

      const sendSubscriptionsAfterConnack = () => {
        if (ws.readyState !== WebSocket.OPEN) return;
        this.mqttConnackSet.add(url);
        this.mqttSubscribedDirect.delete(`${url}::anon`);
        if (this.clientId) {
          this.mqttSubscribedDirect.delete(`${url}::${this.clientId}`);
        }
        try {
          this.subscribeClientDirectOnSocket(url, ws);
          window.setTimeout(() => {
            if (!this.closed && this.mqttSockets.get(url) === ws) {
              this.broadcastPresencePacket();
            }
          }, 120);
        } catch {
          // Ignore
        }
      };

      ws.onopen = () => {
        if (this.closed) return;
        const mqttClientId = `dl_${Math.random().toString(36).slice(2, 10)}_${Date.now() % 10000}`;
        ws.send(buildMqttConnectPacket(mqttClientId, username, password).buffer as ArrayBuffer);
        // Fallback in case a broker proxy omits standard CONNACK framing
        window.setTimeout(() => {
          if (!this.closed && this.mqttSockets.get(url) === ws && !this.mqttConnackSet.has(url)) {
            sendSubscriptionsAfterConnack();
          }
        }, 900);
      };

      ws.onmessage = (ev) => {
        const rawData = ev.data;
        let chunk: Uint8Array | null = null;
        if (rawData instanceof ArrayBuffer) {
          chunk = new Uint8Array(rawData);
        } else if (ArrayBuffer.isView(rawData)) {
          chunk = new Uint8Array(rawData.buffer, rawData.byteOffset, rawData.byteLength);
        }
        if (!chunk) return;
        if (chunk.length >= 2 && chunk[0] >> 4 === 2) {
          // Authentic MQTT CONNACK received: send atomic multi-topic SUBSCRIBE now that session is active
          sendSubscriptionsAfterConnack();
        }
        const merged = new Uint8Array(rxBuffer.length + chunk.length);
        merged.set(rxBuffer, 0);
        merged.set(chunk, rxBuffer.length);

        const { messages, consumed } = parseMqttPublishPayloads(merged);
        rxBuffer = merged.slice(consumed);

        for (const raw of messages) {
          this.handleWirePacket(raw, url);
        }
      };

      ws.onerror = () => {
        // Handled in onclose
      };

      ws.onclose = () => {
        if (this.mqttSockets.get(url) === ws) {
          this.mqttSockets.delete(url);
        }
        this.mqttConnackSet.delete(url);
        const box = this.socketOutboxes.get(url);
        if (box && box.timer !== null) {
          window.clearTimeout(box.timer);
          box.timer = null;
        }
        this.socketOutboxes.delete(url);
        this.mqttSubscribedDirect.delete(`${url}::anon`);
        if (this.clientId) {
          this.mqttSubscribedDirect.delete(`${url}::${this.clientId}`);
        }
        if (this.closed) return;
        window.setTimeout(() => this.connectSingleMqttBroker(broker), 3200);
      };
    } catch {
      // Ignore individual broker failure
    }
  }

  private sendMqttPingAll() {
    for (const ws of this.mqttSockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(new Uint8Array([0xc0, 0x00]).buffer as ArrayBuffer);
        } catch {
          // Ignore
        }
      }
    }
    for (const ws of this.jsonRelaySockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        this.subscribeJsonRelayOnSocket(ws);
      }
    }
  }

  private selectMediaSockets(
    targetId?: string
  ): Array<{ url: string; ws: WebSocket; isJsonRelay: boolean }> {
    const openEntries: Array<{ url: string; ws: WebSocket; isJsonRelay: boolean }> = [];
    // Put binary MQTT brokers first so same-Wi-Fi or open-MQTT networks use ultra-fast binary MQTT instead of rate-limited JSON relays
    for (const [url, ws] of this.mqttSockets.entries()) {
      if (
        ws.readyState === WebSocket.OPEN &&
        this.mqttConnackSet.has(url) &&
        ws.bufferedAmount < 64000
      ) {
        openEntries.push({ url, ws, isJsonRelay: false });
      }
    }
    for (const [url, ws] of this.jsonRelaySockets.entries()) {
      if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 64000) {
        openEntries.push({ url, ws, isJsonRelay: true });
      }
    }
    if (openEntries.length <= 2) {
      return openEntries;
    }

    const chosen: Array<{ url: string; ws: WebSocket; isJsonRelay: boolean }> = [];
    const chosenUrls = new Set<string>();
    const peer = targetId ? this.peers.get(targetId) : undefined;

    // 1. Prefer verified binary MQTT brokers from which we have received packets from this peer (lowest latency & zero event-rate throttling)
    if (peer?.verifiedBrokers) {
      for (const vb of peer.verifiedBrokers) {
        if (chosen.length >= 2) break;
        const found = openEntries.find((e) => e.url === vb && !e.isJsonRelay);
        if (found && !chosenUrls.has(found.url)) {
          chosen.push(found);
          chosenUrls.add(found.url);
        }
      }
    }

    // 2. Prefer the broker/relay over which we most recently heard from this peer
    if (peer?.lastBrokerUrl && chosen.length < 2 && !chosenUrls.has(peer.lastBrokerUrl)) {
      const found = openEntries.find((e) => e.url === peer.lastBrokerUrl);
      if (found) {
        chosen.push(found);
        chosenUrls.add(found.url);
      }
    }

    // 3. Include any other verified broker/relay from which we have received packets from this peer
    if (peer?.verifiedBrokers) {
      for (const vb of peer.verifiedBrokers) {
        if (chosen.length >= 2) break;
        if (!chosenUrls.has(vb)) {
          const found = openEntries.find((e) => e.url === vb);
          if (found) {
            chosen.push(found);
            chosenUrls.add(found.url);
          }
        }
      }
    }

    // 4. Include a Port-443 socket (JSON relay or shiftr:443) if we still need a 2nd redundant socket
    for (const entry of openEntries) {
      if (chosen.length >= 2) break;
      if (!chosenUrls.has(entry.url) && (entry.isJsonRelay || entry.url.includes(':443'))) {
        chosen.push(entry);
        chosenUrls.add(entry.url);
      }
    }

    // 5. Fill up to 2 sockets for redundancy
    for (const entry of openEntries) {
      if (chosen.length >= 2) break;
      if (!chosenUrls.has(entry.url)) {
        chosen.push(entry);
        chosenUrls.add(entry.url);
      }
    }

    return chosen;
  }

  private publishWire(
    payload: Record<string, unknown>,
    options?: {
      isHighRateMedia?: boolean;
      mediaKind?: 'frame' | 'audio';
      directTargetId?: string;
    }
  ) {
    if (!this.clientId) return;
    const pktId = `${this.clientId}_${++this.pktSeq}_${Math.random().toString(36).slice(2, 6)}`;
    this.seenPacketIds.add(pktId);
    if (this.seenPacketIds.size > 1500) {
      const first = this.seenPacketIds.values().next().value;
      if (first) this.seenPacketIds.delete(first);
    }

    const raw = JSON.stringify({
      ...payload,
      _id: pktId,
      _fromId: this.clientId,
      _fromPin: this.pin,
      _ts: Date.now(),
    });

    try {
      this.bc?.postMessage(raw);
    } catch {
      // Ignore
    }

    const targetId =
      options?.directTargetId || (typeof payload.targetId === 'string' ? payload.targetId : '');

    if (options?.isHighRateMedia && targetId) {
      // High-rate video frames and voice audio chunks go strictly to the partner's direct topic/tag
      // on the top 2 verified sockets via the paced outbox—zero self-echo on MESH_TOPIC!
      const category = options.mediaKind === 'audio' ? 'audio' : 'frame';
      const sockets = this.selectMediaSockets(targetId);
      let mqttDirectPacket: ArrayBuffer | null = null;
      let jsonRelayDirectPacket: string | null = null;

      for (const { url, ws, isJsonRelay } of sockets) {
        if (isJsonRelay) {
          if (!jsonRelayDirectPacket) {
            jsonRelayDirectPacket = buildSignedRelayEventPacket(raw, getDirectRelayTag(targetId));
          }
          this.enqueueSocketSend(url, ws, jsonRelayDirectPacket, category);
        } else {
          if (!mqttDirectPacket) {
            mqttDirectPacket = buildMqttPublishPacket(getDirectTopic(targetId), raw)
              .buffer as ArrayBuffer;
          }
          this.enqueueSocketSend(url, ws, mqttDirectPacket, category);
        }
      }
      return;
    }

    const isPresence = payload._mesh === 'presence';
    const category = isPresence ? 'presence' : 'urgent';
    const mqttRoomPacket = buildMqttPublishPacket(MESH_TOPIC, raw).buffer as ArrayBuffer;
    const jsonRoomPacket = buildSignedRelayEventPacket(raw, MESH_RELAY_TAG);

    // 1. Send room packet across all active MQTT brokers and Port-443 JSON WebSocket Relays
    for (const [url, ws] of this.mqttSockets.entries()) {
      if (ws.readyState === WebSocket.OPEN && this.mqttConnackSet.has(url)) {
        this.enqueueSocketSend(url, ws, mqttRoomPacket, category);
      }
    }
    for (const [url, ws] of this.jsonRelaySockets.entries()) {
      if (ws.readyState === WebSocket.OPEN) {
        this.enqueueSocketSend(url, ws, jsonRoomPacket, category);
      }
    }

    // 2. If this is a targeted signaling packet (call:invite, call:accept, webrtc:offer, webrtc:answer, webrtc:ice, chat:msg),
    // ALSO send on the partner's direct topic/tag on their verified broker/relay for redundant direct delivery!
    if (!isPresence && targetId) {
      const peer = this.peers.get(targetId);
      const verifiedUrls = new Set<string>();
      if (peer?.lastBrokerUrl) verifiedUrls.add(peer.lastBrokerUrl);
      if (peer?.verifiedBrokers) {
        for (const vb of peer.verifiedBrokers) verifiedUrls.add(vb);
      }
      if (verifiedUrls.size > 0) {
        let mqttDirectPacket: ArrayBuffer | null = null;
        let jsonDirectPacket: string | null = null;
        for (const vUrl of verifiedUrls) {
          const mWs = this.mqttSockets.get(vUrl);
          if (mWs && mWs.readyState === WebSocket.OPEN && this.mqttConnackSet.has(vUrl)) {
            if (!mqttDirectPacket) {
              mqttDirectPacket = buildMqttPublishPacket(getDirectTopic(targetId), raw)
                .buffer as ArrayBuffer;
            }
            this.enqueueSocketSend(vUrl, mWs, mqttDirectPacket, 'urgent');
          }
          const rWs = this.jsonRelaySockets.get(vUrl);
          if (rWs && rWs.readyState === WebSocket.OPEN) {
            if (!jsonDirectPacket) {
              jsonDirectPacket = buildSignedRelayEventPacket(raw, getDirectRelayTag(targetId));
            }
            this.enqueueSocketSend(vUrl, rWs, jsonDirectPacket, 'urgent');
          }
        }
      }
    }
  }

  private emitToApp(payload: Record<string, unknown>) {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(payload) });
  }

  private confirmOutgoingCallConnected(fromId: string, fromPin?: string) {
    if (!this.isCallOutgoingWaiting || !this.callId || this.partnerClientId !== fromId) {
      return;
    }
    this.isCallOutgoingWaiting = false;
    this.callAnswered = true;
    this.callConnectedAt = Date.now();
    this.clearCallRetryTimers();
    if (fromPin) {
      this.partnerPin = fromPin;
    }
    this.saveActiveMeshCall();
    this.emitToApp({
      type: 'call:connected',
      callId: this.callId,
      peerPin: this.partnerPin || '---',
      initiator: true,
      mode: this.callMode,
    });
    this.broadcastPresencePacket();
  }

  private getTakenPins(excludeClientId?: string): Set<string> {
    const set = new Set<string>();
    for (const p of this.peers.values()) {
      if (p.clientId !== excludeClientId && p.pin) {
        set.add(p.pin);
      }
    }
    return set;
  }

  private findPeerByPin(targetPin: string): MeshPeerState | undefined {
    for (const p of this.peers.values()) {
      if (p.pin === targetPin && p.clientId !== this.clientId) {
        return p;
      }
    }
    return undefined;
  }

  private saveActiveMeshCall() {
    if (!this.clientId) return;
    try {
      if (this.callId && this.partnerClientId && this.partnerPin) {
        localStorage.setItem(
          `intercom_mesh_call_${this.clientId}`,
          JSON.stringify({
            callId: this.callId,
            partnerClientId: this.partnerClientId,
            partnerPin: this.partnerPin,
            callMode: this.callMode,
            savedAt: Date.now(),
          })
        );
      } else {
        localStorage.removeItem(`intercom_mesh_call_${this.clientId}`);
      }
    } catch {
      // Ignore storage errors
    }
  }

  private clearActiveMeshCall() {
    if (!this.clientId) return;
    try {
      localStorage.removeItem(`intercom_mesh_call_${this.clientId}`);
    } catch {
      // Ignore
    }
  }

  private pruneStalePeers() {
    const now = Date.now();
    let changed = false;
    for (const [id, peer] of this.peers.entries()) {
      if (id === this.clientId) continue;
      const isCallPartner = Boolean(this.callId && this.partnerClientId === id);
      const maxIdleMs = isCallPartner ? 60 * 60 * 1000 : 3 * 60 * 1000;
      if (now - peer.lastSeen > maxIdleMs) {
        this.peers.delete(id);
        changed = true;
        if (isCallPartner) {
          this.handlePartnerLeftCall();
        }
      }
    }
    if (changed) {
      this.emitPresenceToApp();
    }
  }

  private emitPresenceToApp() {
    if (!this.clientId || !this.pin) return;
    this.peers.set(this.clientId, {
      clientId: this.clientId,
      pin: this.pin,
      inRoulette: this.inRoulette,
      rouletteJoinedAt: this.rouletteJoinedAt,
      callId: this.callId,
      lastSeen: Date.now(),
    });

    const onlineList = Array.from(this.peers.values()).map((c) => ({
      pin: c.pin,
      status: c.callId ? ('busy' as const) : c.inRoulette ? ('roulette' as const) : ('free' as const),
    }));
    const rouletteCount = onlineList.filter((u) => u.status === 'roulette').length;

    this.emitToApp({
      type: 'presence:update',
      onlineCount: onlineList.length,
      rouletteCount,
      onlinePins: onlineList.slice(0, 50),
    });
  }

  private broadcastPresencePacket() {
    if (!this.clientId || !this.pin) return;
    this.publishWire({
      _mesh: 'presence',
      pin: this.pin,
      inRoulette: this.inRoulette,
      rouletteJoinedAt: this.rouletteJoinedAt,
      callId: this.callId,
      callAnswered: this.callAnswered,
    });
    this.emitPresenceToApp();
  }

  private handlePartnerLeftCall() {
    this.clearCallRetryTimers();
    const wasRoulette = this.callMode === 'roulette' || this.inRoulette;
    if (this.partnerClientId) {
      this.lastPartnerClientId = this.partnerClientId;
      this.lastSkippedAt = Date.now();
    }
    this.callId = null;
    this.isCallOutgoingWaiting = false;
    this.callAnswered = false;
    this.partnerClientId = null;
    this.partnerPin = null;
    this.clearActiveMeshCall();

    if (wasRoulette) {
      this.inRoulette = true;
      // Place passive partner behind active skipper in queue order so the user who pressed "Next" matches first
      this.rouletteJoinedAt = Date.now() + 500;
      this.emitToApp({
        type: 'roulette:searching',
      });
      this.broadcastPresencePacket();
      window.setTimeout(() => {
        if (!this.closed && this.inRoulette && !this.callId) {
          this.tryMatchRouletteInMesh(false);
        }
      }, 380);
    } else {
      this.emitToApp({
        type: 'call:ended',
        reason: 'hangup',
      });
      this.broadcastPresencePacket();
    }
  }

  private tryMatchRouletteInMesh(forceInitiate = false) {
    if (!this.inRoulette || this.callId || !this.clientId) return;

    const candidates: RouletteCandidate[] = [];
    for (const p of this.peers.values()) {
      if (p.inRoulette && !p.callId) {
        candidates.push({
          clientId: p.clientId,
          pin: p.pin,
          joinedAt: p.rouletteJoinedAt || 1,
        });
      }
    }

    if (candidates.length < 2) return;

    const partner = findRouletteMatch(this.clientId, candidates, this.lastPartnerClientId, {
      selfLastSkippedAt: this.lastSkippedAt,
      now: Date.now(),
      repeatPartnerCooldownMs: 1800,
    });
    if (!partner) return;

    // Active skipper (`forceInitiate`) initiates immediately so they get first priority;
    // passive periodic checks use deterministic tie-breaker
    if (forceInitiate || this.clientId < partner.clientId) {
      const callId = `rcall_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.callId = callId;
      this.callMode = 'roulette';
      this.isCallOutgoingWaiting = false;
      this.callAnswered = true;
      this.callConnectedAt = Date.now();
      this.partnerClientId = partner.clientId;
      this.partnerPin = partner.pin;
      this.lastPartnerClientId = partner.clientId;
      this.lastSkippedAt = null;
      this.saveActiveMeshCall();

      this.publishWire(
        {
          _mesh: 'roulette:match',
          targetId: partner.clientId,
          callId,
          callerPin: this.pin,
        },
        { directTargetId: partner.clientId }
      );

      this.emitToApp({
        type: 'roulette:matched',
        callId,
        peerPin: partner.pin,
        initiator: true,
      });
      this.broadcastPresencePacket();
    }
  }

  private handleWirePacket(raw: string, sourceBrokerUrl?: string) {
    let pkt: Record<string, any>;
    try {
      pkt = JSON.parse(raw);
    } catch {
      return;
    }

    const pktId = String(pkt._id || '');
    if (pktId) {
      if (this.seenPacketIds.has(pktId)) return;
      this.seenPacketIds.add(pktId);
    }

    const fromId = String(pkt._fromId || '');
    if (!fromId || fromId === this.clientId) return;

    const meshType = String(pkt._mesh || '');
    const pktTs = Number(pkt._ts || 0);
    if (pktTs > 0) {
      const ageMs = Date.now() - pktTs;
      // Discard stale historical packets cached by JSON relays so page reload never triggers a phantom incoming call or stale audio/video!
      const maxAllowedAgeMs = meshType === 'presence' ? 40000 : 12000;
      if (ageMs > maxAllowedAgeMs) {
        return;
      }
    }

    const existingPeer = this.peers.get(fromId);
    if (existingPeer) {
      existingPeer.lastSeen = Date.now();
      if (sourceBrokerUrl) {
        existingPeer.lastBrokerUrl = sourceBrokerUrl;
        if (!existingPeer.verifiedBrokers) {
          existingPeer.verifiedBrokers = new Set<string>();
        }
        existingPeer.verifiedBrokers.add(sourceBrokerUrl);
      }
    }

    if (meshType === 'presence') {
      const peerPin = String(pkt.pin || '');
      if (!peerPin) return;

      const isNewPeer = !this.peers.has(fromId);
      const peerCallId = pkt.callId ? String(pkt.callId) : null;

      // Resolve rare PIN collision if another older peer already holds our PIN
      if (peerPin === this.pin && fromId < this.clientId && !this.callId) {
        const taken = this.getTakenPins(this.clientId);
        taken.add(peerPin);
        this.pin = generateFreePin(taken);
        try {
          localStorage.setItem('intercom_preferred_pin', this.pin);
        } catch {
          // Ignore
        }
        this.emitToApp({
          type: 'init:ack',
          clientId: this.clientId,
          pin: this.pin,
        });
      }

      const verifiedBrokers = existingPeer?.verifiedBrokers || new Set<string>();
      if (sourceBrokerUrl) {
        verifiedBrokers.add(sourceBrokerUrl);
      }

      this.peers.set(fromId, {
        clientId: fromId,
        pin: peerPin,
        inRoulette: Boolean(pkt.inRoulette),
        rouletteJoinedAt: Number(pkt.rouletteJoinedAt) || Date.now(),
        callId: peerCallId,
        lastSeen: Date.now(),
        lastBrokerUrl: sourceBrokerUrl || existingPeer?.lastBrokerUrl,
        verifiedBrokers,
      });

      // If we are waiting on an outgoing call to this peer and their presence confirms they answered this callId, connect immediately!
      if (
        this.isCallOutgoingWaiting &&
        this.callId &&
        this.partnerClientId === fromId &&
        peerCallId === this.callId &&
        Boolean(pkt.callAnswered)
      ) {
        this.confirmOutgoingCallConnected(fromId, peerPin);
      }

      this.emitPresenceToApp();

      // If this is a newly discovered peer (e.g., just joined from mobile data), immediately announce ourselves back
      if (isNewPeer && !pkt.isReply && this.clientId && this.pin) {
        this.publishWire(
          {
            _mesh: 'presence',
            pin: this.pin,
            inRoulette: this.inRoulette,
            rouletteJoinedAt: this.rouletteJoinedAt,
            callId: this.callId,
            callAnswered: this.callAnswered,
            isReply: true,
          },
          { directTargetId: fromId }
        );
      }

      if (this.inRoulette && !this.callId) {
        this.tryMatchRouletteInMesh();
      }
      return;
    }

    if (meshType === 'leave') {
      if (this.partnerClientId === fromId && this.callId) {
        // Partner closed/refreshed tab during active call: keep call open & freeze frame until they return!
        this.emitToApp({
          type: 'call:peer_paused',
          callId: this.callId,
          peerPin: this.partnerPin,
        });
      } else {
        this.peers.delete(fromId);
        this.emitPresenceToApp();
      }
      return;
    }

    // Targeted packets for this client
    if (pkt.targetId !== this.clientId) return;

    if (meshType === 'roulette:match') {
      if (!this.inRoulette || this.callId) return;
      const callId = String(pkt.callId || '');
      const callerPin = String(pkt.callerPin || pkt._fromPin || '');
      this.callId = callId;
      this.callMode = 'roulette';
      this.isCallOutgoingWaiting = false;
      this.callAnswered = true;
      this.callConnectedAt = Date.now();
      this.partnerClientId = fromId;
      this.partnerPin = callerPin;
      this.lastPartnerClientId = fromId;
      this.saveActiveMeshCall();

      this.emitToApp({
        type: 'roulette:matched',
        callId,
        peerPin: callerPin,
        initiator: false,
      });
      this.broadcastPresencePacket();
      return;
    }

    if (meshType === 'call:invite') {
      const inviteCallId = String(pkt.callId || '');
      if (this.callId) {
        if (this.callId === inviteCallId && this.partnerClientId === fromId) {
          // Duplicate invite for the SAME call: if we already answered, re-send call:accept!
          if (this.callAnswered) {
            this.publishWire(
              {
                _mesh: 'call:accept',
                targetId: fromId,
                callId: this.callId,
              },
              { directTargetId: fromId }
            );
          }
          return;
        }
        this.publishWire(
          {
            _mesh: 'call:busy',
            targetId: fromId,
            callId: inviteCallId,
          },
          { directTargetId: fromId }
        );
        return;
      }
      const callerPin = String(pkt._fromPin || '');
      this.inRoulette = false;
      this.callId = inviteCallId;
      this.callMode = 'code';
      this.isCallOutgoingWaiting = false;
      this.callAnswered = false;
      this.partnerClientId = fromId;
      this.partnerPin = callerPin;

      this.emitToApp({
        type: 'call:incoming',
        callId: inviteCallId,
        fromPin: callerPin,
      });
      this.broadcastPresencePacket();
      return;
    }

    if (meshType === 'call:busy') {
      if (this.callId && this.partnerClientId === fromId) {
        this.clearCallRetryTimers();
        const targetPin = this.partnerPin || '';
        this.callId = null;
        this.isCallOutgoingWaiting = false;
        this.callAnswered = false;
        this.partnerClientId = null;
        this.partnerPin = null;
        this.clearActiveMeshCall();
        this.emitToApp({
          type: 'call:status',
          status: 'busy',
          targetPin,
        });
        this.broadcastPresencePacket();
      }
      return;
    }

    if (meshType === 'call:accept') {
      if (this.callId && this.partnerClientId === fromId) {
        this.confirmOutgoingCallConnected(
          fromId,
          String(pkt._fromPin || this.partnerPin || '')
        );
      }
      return;
    }

    if (meshType === 'call:resume') {
      const resumeCallId = String(pkt.callId || '');
      const peerPin = String(pkt._fromPin || this.partnerPin || '');
      if (this.callId && this.callId === resumeCallId) {
        this.isCallOutgoingWaiting = false;
        this.callAnswered = true;
        this.callConnectedAt = Date.now();
        this.partnerClientId = fromId;
        this.partnerPin = peerPin;
        if (pkt.mode === 'roulette' || pkt.mode === 'code') {
          this.callMode = pkt.mode;
        }
        this.saveActiveMeshCall();
        this.emitToApp({
          type: 'call:peer_resumed',
          callId: this.callId,
          peerPin,
          initiator: false,
          mode: this.callMode,
        });
        this.broadcastPresencePacket();
      } else if (resumeCallId) {
        // We already ended this call — notify returning peer so they exit cleanly instead of resurrecting a dead call!
        this.publishWire(
          {
            _mesh: 'call:end',
            targetId: fromId,
            callId: resumeCallId,
          },
          { directTargetId: fromId }
        );
      }
      return;
    }

    if (meshType === 'call:end') {
      const endCallId = String(pkt.callId || '');
      if (
        this.partnerClientId === fromId &&
        this.callId &&
        (!endCallId || endCallId === this.callId)
      ) {
        this.handlePartnerLeftCall();
      }
      return;
    }

    if (meshType === 'relay') {
      // Only accept WebRTC / media / chat relay packets from our current active call partner!
      if (!this.callId || this.partnerClientId !== fromId) {
        return;
      }
      const inner = pkt.payload;
      if (inner && typeof inner === 'object') {
        // If we were still ringing on an outgoing call to this partner and start receiving WebRTC/media relay packets from them,
        // they have definitely answered—transition out of ringing into connected immediately!
        if (this.isCallOutgoingWaiting && this.callId && this.partnerClientId === fromId) {
          this.confirmOutgoingCallConnected(
            fromId,
            String(pkt._fromPin || this.partnerPin || '')
          );
        }
        if (inner.type === 'media:frame' || inner.type === 'media:audio') {
          this.lastPartnerMediaRxAt = Date.now();
        }
        this.emitToApp({
          ...inner,
          fromPin: String(pkt._fromPin || this.partnerPin || ''),
        });
      }
    }
  }

  public send(data: string) {
    if (this.closed) return;
    let msg: Record<string, any>;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    const type = String(msg.type || '');

    if (type === 'ping') {
      // Driven by App.tsx's unthrottled background Web Worker every 10s so background tabs stay connected on GitHub Pages
      this.connectAllTransports();
      this.subscribeClientDirectAll();
      this.sendMqttPingAll();
      this.pruneStalePeers();
      this.broadcastPresencePacket();
      this.emitToApp({
        type: 'pong',
        ts: Date.now(),
        callId: this.callId,
      });
      return;
    }

    if (type === 'init') {
      const rawClientId = String(msg.clientId || '').trim();
      this.clientId =
        rawClientId && /^[a-zA-Z0-9_-]{4,64}$/.test(rawClientId)
          ? rawClientId
          : `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

      this.subscribeClientDirectAll();

      let savedPin = String(msg.preferredPin || '').trim();
      if (!savedPin) {
        try {
          savedPin = localStorage.getItem('intercom_preferred_pin') || '';
        } catch {
          // Ignore
        }
      }

      const taken = this.getTakenPins(this.clientId);
      const val = validatePin(savedPin);
      if (val.valid && !taken.has(val.normalized)) {
        this.pin = val.normalized;
      } else {
        this.pin = generateFreePin(taken);
      }

      try {
        localStorage.setItem('intercom_preferred_pin', this.pin);
      } catch {
        // Ignore
      }

      this.emitToApp({
        type: 'init:ack',
        clientId: this.clientId,
        pin: this.pin,
      });

      // Check if this client had an active call before refreshing or reopening the browser on GitHub Pages
      try {
        const rawSavedCall = localStorage.getItem(`intercom_mesh_call_${this.clientId}`);
        if (rawSavedCall) {
          const parsedCall = JSON.parse(rawSavedCall);
          if (
            parsedCall &&
            parsedCall.callId &&
            parsedCall.partnerClientId &&
            parsedCall.partnerPin &&
            Date.now() - Number(parsedCall.savedAt || 0) < 60 * 60 * 1000
          ) {
            this.callId = String(parsedCall.callId);
            this.isCallOutgoingWaiting = false;
            this.callAnswered = true;
            this.callConnectedAt = Date.now();
            this.partnerClientId = String(parsedCall.partnerClientId);
            this.partnerPin = String(parsedCall.partnerPin);
            this.callMode = parsedCall.callMode === 'roulette' ? 'roulette' : 'code';

            this.emitToApp({
              type: 'call:connected',
              callId: this.callId,
              peerPin: this.partnerPin,
              initiator: true,
              mode: this.callMode,
              resumed: true,
            });

            window.setTimeout(() => {
              if (!this.closed && this.callId && this.partnerClientId) {
                this.publishWire(
                  {
                    _mesh: 'call:resume',
                    targetId: this.partnerClientId,
                    callId: this.callId,
                    mode: this.callMode,
                  },
                  { directTargetId: this.partnerClientId }
                );
              }
            }, 320);
          }
        }
      } catch {
        // Ignore
      }

      this.broadcastPresencePacket();
      return;
    }

    if (type === 'pin:change') {
      if (this.callId) {
        this.emitToApp({
          type: 'pin:result',
          ok: false,
          pin: this.pin,
          error: 'Нельзя менять номер во время активного вызова',
        });
        return;
      }

      const validation = validatePin(String(msg.newPin || ''));
      if (!validation.valid) {
        this.emitToApp({
          type: 'pin:result',
          ok: false,
          pin: this.pin,
          error: validation.error || 'Некорректный номер',
        });
        return;
      }

      const taken = this.getTakenPins(this.clientId);
      if (taken.has(validation.normalized)) {
        this.emitToApp({
          type: 'pin:result',
          ok: false,
          pin: this.pin,
          error: `Номер ${validation.normalized} сейчас занят другим абонентом`,
        });
        return;
      }

      this.pin = validation.normalized;
      try {
        localStorage.setItem('intercom_preferred_pin', this.pin);
      } catch {
        // Ignore
      }

      this.emitToApp({
        type: 'pin:result',
        ok: true,
        pin: this.pin,
      });
      this.broadcastPresencePacket();
      return;
    }

    if (type === 'call:dial') {
      const targetPin = String(msg.targetPin || '').trim();
      const validation = validatePin(targetPin);
      if (!validation.valid) {
        this.emitToApp({
          type: 'call:status',
          status: 'not_found',
          targetPin,
        });
        return;
      }

      if (validation.normalized === this.pin) {
        this.emitToApp({
          type: 'call:status',
          status: 'busy',
          targetPin: validation.normalized,
        });
        return;
      }

      const targetPeer = this.findPeerByPin(validation.normalized);
      if (!targetPeer) {
        this.emitToApp({
          type: 'call:status',
          status: 'not_found',
          targetPin: validation.normalized,
        });
        return;
      }

      if (targetPeer.callId) {
        this.emitToApp({
          type: 'call:status',
          status: 'busy',
          targetPin: validation.normalized,
        });
        return;
      }

      this.clearCallRetryTimers();
      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.inRoulette = false;
      this.callId = callId;
      this.callMode = 'code';
      this.isCallOutgoingWaiting = true;
      this.callAnswered = false;
      this.partnerClientId = targetPeer.clientId;
      this.partnerPin = targetPeer.pin;

      const sendInvite = () => {
        if (this.closed || !this.isCallOutgoingWaiting || this.callId !== callId) return;
        this.publishWire(
          {
            _mesh: 'call:invite',
            targetId: targetPeer.clientId,
            callId,
          },
          { directTargetId: targetPeer.clientId }
        );
      };

      sendInvite();
      this.callRetryTimers.push(window.setTimeout(sendInvite, 1200));
      this.callRetryTimers.push(window.setTimeout(sendInvite, 2800));

      this.emitToApp({
        type: 'call:outgoing',
        callId,
        targetPin: targetPeer.pin,
      });
      this.broadcastPresencePacket();
      return;
    }

    if (type === 'call:answer') {
      if (!this.callId || !this.partnerClientId) return;
      this.clearCallRetryTimers();
      const activeCallId = this.callId;
      const activePartnerId = this.partnerClientId;
      this.isCallOutgoingWaiting = false;
      this.callAnswered = true;
      this.callConnectedAt = Date.now();
      this.saveActiveMeshCall();

      const sendAccept = () => {
        if (this.closed || this.callId !== activeCallId || this.partnerClientId !== activePartnerId) {
          return;
        }
        this.publishWire(
          {
            _mesh: 'call:accept',
            targetId: activePartnerId,
            callId: activeCallId,
          },
          { directTargetId: activePartnerId }
        );
      };

      sendAccept();
      // Re-transmit call:accept at staggered intervals so mobile radio handovers never leave caller ringing!
      this.callRetryTimers.push(window.setTimeout(sendAccept, 380));
      this.callRetryTimers.push(window.setTimeout(sendAccept, 1050));
      this.callRetryTimers.push(window.setTimeout(sendAccept, 2100));

      this.emitToApp({
        type: 'call:connected',
        callId: this.callId,
        peerPin: this.partnerPin || '---',
        initiator: false,
        mode: this.callMode,
      });
      this.broadcastPresencePacket();
      return;
    }

    if (type === 'call:hangup') {
      this.clearCallRetryTimers();
      if (this.partnerClientId && this.callId) {
        this.publishWire(
          {
            _mesh: 'call:end',
            targetId: this.partnerClientId,
            callId: this.callId,
          },
          { directTargetId: this.partnerClientId }
        );
      }
      this.callId = null;
      this.isCallOutgoingWaiting = false;
      this.callAnswered = false;
      this.partnerClientId = null;
      this.partnerPin = null;
      this.lastPartnerClientId = null;
      this.lastSkippedAt = null;
      this.inRoulette = false;
      this.clearActiveMeshCall();
      this.emitToApp({
        type: 'call:ended',
        reason: 'hangup',
      });
      this.broadcastPresencePacket();
      return;
    }

    if (type === 'roulette:start' || type === 'roulette:next') {
      this.clearCallRetryTimers();
      const now = Date.now();
      if (this.partnerClientId && this.callId) {
        if (type === 'roulette:next') {
          this.lastPartnerClientId = this.partnerClientId;
          this.lastSkippedAt = now;
        }
        this.publishWire(
          {
            _mesh: 'call:end',
            targetId: this.partnerClientId,
            callId: this.callId,
          },
          { directTargetId: this.partnerClientId }
        );
      } else if (type === 'roulette:start') {
        this.lastPartnerClientId = null;
        this.lastSkippedAt = null;
      }
      this.callId = null;
      this.isCallOutgoingWaiting = false;
      this.callAnswered = false;
      this.partnerClientId = null;
      this.partnerPin = null;
      this.clearActiveMeshCall();
      this.inRoulette = true;
      this.rouletteJoinedAt = now;
      this.emitToApp({
        type: 'roulette:searching',
      });
      this.broadcastPresencePacket();
      this.tryMatchRouletteInMesh(true);
      return;
    }

    if (type === 'roulette:stop') {
      this.clearCallRetryTimers();
      if (this.partnerClientId && this.callId) {
        this.publishWire(
          {
            _mesh: 'call:end',
            targetId: this.partnerClientId,
            callId: this.callId,
          },
          { directTargetId: this.partnerClientId }
        );
      }
      this.callId = null;
      this.isCallOutgoingWaiting = false;
      this.callAnswered = false;
      this.partnerClientId = null;
      this.partnerPin = null;
      this.lastPartnerClientId = null;
      this.lastSkippedAt = null;
      this.inRoulette = false;
      this.clearActiveMeshCall();
      this.emitToApp({
        type: 'roulette:stopped',
      });
      this.broadcastPresencePacket();
      return;
    }

    if (
      type === 'webrtc:offer' ||
      type === 'webrtc:answer' ||
      type === 'webrtc:ice' ||
      type === 'webrtc:need_offer' ||
      type === 'media:frame' ||
      type === 'media:audio' ||
      type === 'media:state' ||
      type === 'chat:msg' ||
      type === 'chat:sync'
    ) {
      if (!this.partnerClientId || !this.callId) return;
      if (type === 'chat:msg') {
        const cleaned = sanitizeChatMessage(msg.text);
        if (!cleaned) return;
        this.publishWire(
          {
            _mesh: 'relay',
            targetId: this.partnerClientId,
            payload: {
              type: 'chat:msg',
              id: String(msg.id || `m_${Date.now()}`),
              text: cleaned,
              timestamp: Number(msg.timestamp) || Date.now(),
            },
          },
          { directTargetId: this.partnerClientId }
        );
        return;
      }

      if (type === 'media:frame') {
        const now = Date.now();
        if (now - this.lastFrameRelayAt < 100) {
          return;
        }
        this.lastFrameRelayAt = now;
        this.publishWire(
          {
            _mesh: 'relay',
            targetId: this.partnerClientId,
            payload: msg,
          },
          {
            isHighRateMedia: true,
            mediaKind: 'frame',
            directTargetId: this.partnerClientId,
          }
        );
        return;
      }

      if (type === 'media:audio') {
        const now = Date.now();
        if (now - this.lastAudioRelayAt < 45) {
          return;
        }
        this.lastAudioRelayAt = now;
        this.publishWire(
          {
            _mesh: 'relay',
            targetId: this.partnerClientId,
            payload: msg,
          },
          {
            isHighRateMedia: true,
            mediaKind: 'audio',
            directTargetId: this.partnerClientId,
          }
        );
        return;
      }

      this.publishWire(
        {
          _mesh: 'relay',
          targetId: this.partnerClientId,
          payload: msg,
        },
        { directTargetId: this.partnerClientId }
      );
    }
  }

  public close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WS_CLOSED;
    this.clearCallRetryTimers();
    this.publishWire({ _mesh: 'leave' });
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    for (const box of this.socketOutboxes.values()) {
      if (box.timer !== null) {
        window.clearTimeout(box.timer);
      }
    }
    this.socketOutboxes.clear();
    for (const ws of this.mqttSockets.values()) {
      try {
        ws.close();
      } catch {
        // Ignore
      }
    }
    this.mqttSockets.clear();
    this.mqttConnackSet.clear();
    this.mqttSubscribedDirect.clear();
    for (const ws of this.jsonRelaySockets.values()) {
      try {
        ws.close();
      } catch {
        // Ignore
      }
    }
    this.jsonRelaySockets.clear();
    try {
      this.bc?.close();
    } catch {
      // Ignore
    }
  }
}

/**
 * Creates a transport that uses the local/Cloud Run `/ws` server when available,
 * and automatically switches to Serverless Mesh Mode on GitHub Pages (`*.github.io`)
 * or any static hosting environment without a backend WebSocket server.
 */
let serverWsVerified = false;

export function createIntercomTransport(): IntercomTransport {
  const isStaticHost =
    typeof window !== 'undefined' &&
    (/\.github\.io$/i.test(window.location.hostname) ||
      window.location.protocol === 'file:' ||
      new URLSearchParams(window.location.search).get('serverless') === '1');

  if (isStaticHost) {
    return new ServerlessMeshTransport();
  }

  let activeDelegate: WebSocket | ServerlessMeshTransport | null = null;
  let mode: 'server' | 'serverless' = 'server';
  let closed = false;
  let openDelayTimer: number | null = null;
  const queuedMessages: string[] = [];

  const wrapper: IntercomTransport = {
    onopen: null,
    onmessage: null,
    onclose: null,
    get readyState() {
      if (closed) return WS_CLOSED;
      return activeDelegate ? activeDelegate.readyState : 0;
    },
    get mode() {
      return mode;
    },
    send(data: string) {
      if (closed) return;
      if (activeDelegate && activeDelegate.readyState === WS_OPEN) {
        activeDelegate.send(data);
      } else {
        queuedMessages.push(data);
      }
    },
    close() {
      closed = true;
      if (openDelayTimer !== null) {
        window.clearTimeout(openDelayTimer);
        openDelayTimer = null;
      }
      try {
        activeDelegate?.close();
      } catch {
        // Ignore
      }
    },
  };

  const switchToServerlessFallback = () => {
    if (closed || mode === 'serverless') return;
    mode = 'serverless';
    const mesh = new ServerlessMeshTransport();
    activeDelegate = mesh;
    mesh.onopen = () => {
      wrapper.onopen?.();
      while (queuedMessages.length > 0) {
        const next = queuedMessages.shift()!;
        mesh.send(next);
      }
    };
    mesh.onmessage = (ev) => wrapper.onmessage?.(ev);
    mesh.onclose = () => wrapper.onclose?.();
  };

  const handleInitialConnectFailure = () => {
    if (closed) return;
    if (serverWsVerified) {
      // Backend /ws server is known to exist; trigger normal reconnect instead of splitting onto serverless mesh
      wrapper.onclose?.();
      return;
    }
    fetch('/api/status', { cache: 'no-store' })
      .then((res) => {
        if (closed) return;
        if (res.ok) {
          serverWsVerified = true;
          wrapper.onclose?.();
        } else {
          switchToServerlessFallback();
        }
      })
      .catch(() => {
        if (closed) return;
        // If browser is offline or suspended, retry /ws via onclose rather than switching transport mode
        if (typeof navigator !== 'undefined' && navigator.onLine === false) {
          wrapper.onclose?.();
        } else {
          switchToServerlessFallback();
        }
      });
  };

  openDelayTimer = window.setTimeout(() => {
    openDelayTimer = null;
    if (closed) return;
    try {
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${proto}//${window.location.host}/ws`;
      const ws = new WebSocket(wsUrl);
      activeDelegate = ws;
      let connectedOnce = false;
      let failureHandled = false;

      const triggerFailureOnce = () => {
        if (failureHandled || closed) return;
        failureHandled = true;
        handleInitialConnectFailure();
      };

      const fallbackTimer = window.setTimeout(() => {
        if (!connectedOnce && !closed && ws.readyState !== WS_OPEN) {
          try {
            ws.close();
          } catch {
            // Ignore
          }
          triggerFailureOnce();
        }
      }, 6500);

      ws.onopen = () => {
        if (closed) {
          try {
            ws.close();
          } catch {
            // Ignore
          }
          return;
        }
        connectedOnce = true;
        serverWsVerified = true;
        window.clearTimeout(fallbackTimer);
        wrapper.onopen?.();
        while (queuedMessages.length > 0) {
          const next = queuedMessages.shift()!;
          ws.send(next);
        }
      };

      ws.onmessage = (ev) => {
        if (closed) return;
        wrapper.onmessage?.({ data: String(ev.data) });
      };

      ws.onerror = () => {
        if (!connectedOnce) {
          window.clearTimeout(fallbackTimer);
          triggerFailureOnce();
        }
      };

      ws.onclose = () => {
        window.clearTimeout(fallbackTimer);
        if (!connectedOnce) {
          triggerFailureOnce();
        } else if (!closed) {
          wrapper.onclose?.();
        }
      };
    } catch {
      handleInitialConnectFailure();
    }
  }, 50);

  return wrapper;
}
