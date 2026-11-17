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

const PUBLIC_MQTT_BROKERS: MqttBrokerConfig[] = [
  // Primary Port-443 broker: bypasses mobile carrier (MTS/MegaFon/Beeline/Tele2) non-443 port blocks
  {
    url: 'wss://public.cloud.shiftr.io:443/mqtt',
    username: 'public',
    password: 'public',
    isPort443: true,
  },
  { url: 'wss://broker.emqx.io:8084/mqtt' },
  { url: 'wss://broker.hivemq.com:8884/mqtt' },
  { url: 'wss://test.mosquitto.org:8081/mqtt' },
];

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

function buildMqttSubscribePacket(topic: string, packetId = 1): Uint8Array {
  const tBytes = encodeUtf8(topic);
  const varHeader = [(packetId >> 8) & 0xff, packetId & 0xff];
  const payload = [(tBytes.length >> 8) & 0xff, tBytes.length & 0xff, ...tBytes, 0x00];
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
}

interface SocketOutbox {
  urgentQueue: ArrayBuffer[];
  audioQueue: ArrayBuffer[];
  latestFrame: ArrayBuffer | null;
  latestPresence: ArrayBuffer | null;
  lastSentAt: number;
  timer: number | null;
}

const SOCKET_MIN_PACE_MS = 55;

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
  private mqttConnackSet = new Set<string>();
  private mqttSubscribedDirect = new Set<string>();
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
    const ws = this.mqttSockets.get(url);
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

    let nextPacket: ArrayBuffer | null = null;
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
    packet: ArrayBuffer,
    category: 'urgent' | 'audio' | 'frame' | 'presence'
  ) {
    if (ws.readyState !== WebSocket.OPEN) return;
    const box = this.getOrCreateOutbox(url);

    if (category === 'urgent') {
      box.urgentQueue.push(packet);
      if (box.urgentQueue.length > 20) {
        box.urgentQueue.shift();
      }
    } else if (category === 'audio') {
      box.audioQueue.push(packet);
      // Keep audio real-time: cap buffered audio chunks at 4 (~880ms max)
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

  private subscribeClientDirectOnSocket(url: string, ws: WebSocket) {
    if (!this.clientId || ws.readyState !== WebSocket.OPEN || !this.mqttConnackSet.has(url)) {
      return;
    }
    const key = `${url}::${this.clientId}`;
    if (this.mqttSubscribedDirect.has(key)) return;
    this.mqttSubscribedDirect.add(key);
    try {
      ws.send(buildMqttSubscribePacket(getDirectTopic(this.clientId), 2).buffer as ArrayBuffer);
    } catch {
      // Ignore
    }
  }

  private subscribeClientDirectAll() {
    if (!this.clientId) return;
    for (const [url, ws] of this.mqttSockets.entries()) {
      this.subscribeClientDirectOnSocket(url, ws);
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
        if (this.clientId) {
          this.mqttSubscribedDirect.delete(`${url}::${this.clientId}`);
        }
        try {
          ws.send(buildMqttSubscribePacket(MESH_TOPIC, 1).buffer as ArrayBuffer);
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
        if (!(ev.data instanceof ArrayBuffer)) return;
        const chunk = new Uint8Array(ev.data);
        if (chunk.length >= 2 && chunk[0] >> 4 === 2) {
          // Authentic MQTT CONNACK received: always send SUBSCRIBE now that session is active
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
  }

  private selectMediaSockets(targetId?: string): Array<[string, WebSocket]> {
    const openEntries: Array<[string, WebSocket]> = [];
    for (const [url, ws] of this.mqttSockets.entries()) {
      if (
        ws.readyState === WebSocket.OPEN &&
        this.mqttConnackSet.has(url) &&
        ws.bufferedAmount < 64000
      ) {
        openEntries.push([url, ws]);
      }
    }
    if (openEntries.length <= 2) {
      return openEntries;
    }

    const chosen: Array<[string, WebSocket]> = [];
    const chosenUrls = new Set<string>();

    // 1. Prefer the broker over which we most recently heard from this peer
    const peerLastBroker = targetId ? this.peers.get(targetId)?.lastBrokerUrl : undefined;
    if (peerLastBroker) {
      const found = openEntries.find(([u]) => u === peerLastBroker);
      if (found) {
        chosen.push(found);
        chosenUrls.add(found[0]);
      }
    }

    // 2. Always include Port-443 shiftr.io if open (passes through mobile carrier firewalls)
    for (const entry of openEntries) {
      const [u] = entry;
      if (!chosenUrls.has(u) && u.includes(':443')) {
        chosen.push(entry);
        chosenUrls.add(u);
        break;
      }
    }

    // 3. Fill up to 2 sockets for redundancy without flooding all 4 brokers
    for (const entry of openEntries) {
      if (chosen.length >= 2) break;
      if (!chosenUrls.has(entry[0])) {
        chosen.push(entry);
        chosenUrls.add(entry[0]);
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
      // High-rate video frames and voice audio chunks use the paced socket outbox on top 2 brokers.
      // If we haven't received media from partner yet during the first 3.5s of the call, use MESH_TOPIC
      // so media flows immediately even if a mobile carrier delayed topic #2 subscription.
      const useMeshTopicFallback =
        Date.now() - this.callConnectedAt < 3500 &&
        Date.now() - this.lastPartnerMediaRxAt > 2500;
      const topic = useMeshTopicFallback ? MESH_TOPIC : getDirectTopic(targetId);
      const mediaPacket = buildMqttPublishPacket(topic, raw).buffer as ArrayBuffer;
      const category = options.mediaKind === 'audio' ? 'audio' : 'frame';
      const sockets = this.selectMediaSockets(targetId);
      for (const [url, ws] of sockets) {
        this.enqueueSocketSend(url, ws, mediaPacket, category);
      }
      return;
    }

    // Send a SINGLE packet per broker socket on MESH_TOPIC (never send both directPacket + roomPacket,
    // which previously doubled packet bursts and triggered shiftr.io/emqx.io rate limiters!).
    const roomPacket = buildMqttPublishPacket(MESH_TOPIC, raw).buffer as ArrayBuffer;
    const isPresence = payload._mesh === 'presence';
    const category = isPresence ? 'presence' : 'urgent';

    for (const [url, ws] of this.mqttSockets.entries()) {
      if (ws.readyState === WebSocket.OPEN && this.mqttConnackSet.has(url)) {
        this.enqueueSocketSend(url, ws, roomPacket, category);
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

    const existingPeer = this.peers.get(fromId);
    if (existingPeer) {
      existingPeer.lastSeen = Date.now();
      if (sourceBrokerUrl) {
        existingPeer.lastBrokerUrl = sourceBrokerUrl;
      }
    }

    const meshType = String(pkt._mesh || '');

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

      this.peers.set(fromId, {
        clientId: fromId,
        pin: peerPin,
        inRoulette: Boolean(pkt.inRoulette),
        rouletteJoinedAt: Number(pkt.rouletteJoinedAt) || Date.now(),
        callId: peerCallId,
        lastSeen: Date.now(),
        lastBrokerUrl: sourceBrokerUrl || existingPeer?.lastBrokerUrl,
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
      if (this.callId === resumeCallId || !this.callId) {
        this.callId = resumeCallId;
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
      }
      return;
    }

    if (meshType === 'call:end') {
      if (this.partnerClientId === fromId && this.callId) {
        this.handlePartnerLeftCall();
      }
      return;
    }

    if (meshType === 'relay') {
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
      type === 'media:frame' ||
      type === 'media:audio' ||
      type === 'media:state' ||
      type === 'chat:msg'
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
        if (now - this.lastFrameRelayAt < 175) {
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
