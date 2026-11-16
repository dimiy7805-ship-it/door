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
const NTFY_SIGNAL_TOPIC = 'domofon_liniya_v1_sig_2026';
const PUBLIC_MQTT_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/mqtt',
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

function buildMqttConnectPacket(clientId: string): Uint8Array {
  const idBytes = encodeUtf8(clientId);
  const varHeader = [
    0x00,
    0x04,
    0x4d, // 'M'
    0x51, // 'Q'
    0x54, // 'T'
    0x54, // 'T'
    0x04, // Protocol level 4 (MQTT 3.1.1)
    0x02, // Clean session
    0x01,
    0x2c, // Keep-alive 300s (5 minutes) for backgrounded mobile/desktop tabs
  ];
  const payload = [(idBytes.length >> 8) & 0xff, idBytes.length & 0xff, ...idBytes];
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
}

/**
 * Serverless P2P / Multi-Broker + Port-443 Mesh Coordinator so the entire 3D Intercom works on
 * static hosts like GitHub Pages (*.github.io) across both Wi-Fi and Mobile Data (4G/LTE/5G).
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
  private partnerClientId: string | null = null;
  private partnerPin: string | null = null;
  private lastPartnerClientId: string | null = null;
  private lastSkippedAt: number | null = null;

  private peers = new Map<string, MeshPeerState>();
  private mqttSockets = new Map<string, WebSocket>();
  private ntfyWs: WebSocket | null = null;
  private bc: BroadcastChannel | null = null;
  private heartbeatTimer: number | null = null;
  private pingTimer: number | null = null;
  private seenPacketIds = new Set<string>();
  private pktSeq = 0;
  private lastNtfyPresencePostAt = 0;
  private lastMediaPublishAt = 0;
  private lastMediaRelayAt = 0;
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
    }, 22000);

    window.setTimeout(() => {
      if (!this.closed) {
        this.onopen?.();
      }
    }, 30);
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

    // 1. Connect to ALL public MQTT brokers simultaneously so Wi-Fi and Mobile clients never split onto different servers
    for (const brokerUrl of PUBLIC_MQTT_BROKERS) {
      this.connectSingleMqttBroker(brokerUrl);
    }

    // 2. Connect to Port-443 WebSocket Bridge (ntfy.sh over standard port 443) so mobile carriers blocking 8084/8884/8081 still work
    this.connectPort443Bridge();
  }

  private connectSingleMqttBroker(url: string) {
    if (this.closed) return;
    const existing = this.mqttSockets.get(url);
    if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      const ws = new WebSocket(url, 'mqtt');
      ws.binaryType = 'arraybuffer';
      this.mqttSockets.set(url, ws);

      let rxBuffer = new Uint8Array(0);

      ws.onopen = () => {
        if (this.closed) return;
        const mqttClientId = `dl_${Math.random().toString(36).slice(2, 10)}_${Date.now() % 10000}`;
        ws.send(buildMqttConnectPacket(mqttClientId).buffer as ArrayBuffer);
        window.setTimeout(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(buildMqttSubscribePacket(MESH_TOPIC, 1).buffer as ArrayBuffer);
            this.broadcastPresencePacket(true);
          }
        }, 180);
      };

      ws.onmessage = (ev) => {
        if (!(ev.data instanceof ArrayBuffer)) return;
        const chunk = new Uint8Array(ev.data);
        const merged = new Uint8Array(rxBuffer.length + chunk.length);
        merged.set(rxBuffer, 0);
        merged.set(chunk, rxBuffer.length);

        const { messages, consumed } = parseMqttPublishPayloads(merged);
        rxBuffer = merged.slice(consumed);

        for (const raw of messages) {
          this.handleWirePacket(raw);
        }
      };

      ws.onerror = () => {
        // Handled in onclose
      };

      ws.onclose = () => {
        if (this.mqttSockets.get(url) === ws) {
          this.mqttSockets.delete(url);
        }
        if (this.closed) return;
        window.setTimeout(() => this.connectSingleMqttBroker(url), 3500);
      };
    } catch {
      // Ignore individual broker failure
    }
  }

  private connectPort443Bridge() {
    if (this.closed) return;
    if (
      this.ntfyWs &&
      (this.ntfyWs.readyState === WebSocket.OPEN || this.ntfyWs.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    try {
      const ws = new WebSocket(`wss://ntfy.sh/${NTFY_SIGNAL_TOPIC}/ws`);
      this.ntfyWs = ws;

      ws.onopen = () => {
        if (this.closed) return;
        this.broadcastPresencePacket(true);
      };

      ws.onmessage = (ev) => {
        if (typeof ev.data !== 'string') return;
        try {
          const wrapper = JSON.parse(ev.data);
          if (wrapper && wrapper.event === 'message' && typeof wrapper.message === 'string') {
            this.handleWirePacket(wrapper.message);
          }
        } catch {
          // Ignore malformed bridge packet
        }
      };

      ws.onerror = () => {
        // Handled in onclose
      };

      ws.onclose = () => {
        if (this.ntfyWs === ws) {
          this.ntfyWs = null;
        }
        if (this.closed) return;
        window.setTimeout(() => this.connectPort443Bridge(), 4000);
      };
    } catch {
      // Ignore bridge failure
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

  private publishWire(payload: Record<string, unknown>, options?: { isHighRateMedia?: boolean; forcePort443?: boolean }) {
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

    const mqttPacket = buildMqttPublishPacket(MESH_TOPIC, raw).buffer as ArrayBuffer;
    for (const ws of this.mqttSockets.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(mqttPacket);
        } catch {
          // Ignore
        }
      }
    }

    // Also send control/signaling/presence packets over standard HTTPS Port 443 so mobile carrier firewalls never block discovery or call setup
    if (
      !options?.isHighRateMedia &&
      !(typeof navigator !== 'undefined' && navigator.webdriver)
    ) {
      const isPresence = payload._mesh === 'presence';
      const now = Date.now();
      if (!isPresence || options?.forcePort443 || now - this.lastNtfyPresencePostAt >= 9500) {
        if (isPresence) {
          this.lastNtfyPresencePostAt = now;
        }
        fetch(`https://ntfy.sh/${NTFY_SIGNAL_TOPIC}`, {
          method: 'POST',
          body: raw,
          keepalive: payload._mesh === 'leave',
        }).catch(() => {
          // Ignore
        });
      }
    }
  }

  private emitToApp(payload: Record<string, unknown>) {
    if (this.closed) return;
    this.onmessage?.({ data: JSON.stringify(payload) });
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

  private broadcastPresencePacket(forcePort443 = false) {
    if (!this.clientId || !this.pin) return;
    this.publishWire(
      {
        _mesh: 'presence',
        pin: this.pin,
        inRoulette: this.inRoulette,
        rouletteJoinedAt: this.rouletteJoinedAt,
        callId: this.callId,
      },
      { forcePort443 }
    );
    this.emitPresenceToApp();
  }

  private handlePartnerLeftCall() {
    const wasRoulette = this.callMode === 'roulette' || this.inRoulette;
    if (this.partnerClientId) {
      this.lastPartnerClientId = this.partnerClientId;
      this.lastSkippedAt = Date.now();
    }
    this.callId = null;
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
      this.broadcastPresencePacket(true);
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
      this.broadcastPresencePacket(true);
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
        { forcePort443: true }
      );

      this.emitToApp({
        type: 'roulette:matched',
        callId,
        peerPin: partner.pin,
        initiator: true,
      });
      this.broadcastPresencePacket(true);
    }
  }

  private handleWirePacket(raw: string) {
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

    if (meshType === 'presence') {
      const peerPin = String(pkt.pin || '');
      if (!peerPin) return;

      const isNewPeer = !this.peers.has(fromId);

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
        callId: pkt.callId ? String(pkt.callId) : null,
        lastSeen: Date.now(),
      });

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
            isReply: true,
          },
          { forcePort443: true }
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
      this.broadcastPresencePacket(true);
      return;
    }

    if (meshType === 'call:invite') {
      if (this.callId) {
        this.publishWire(
          {
            _mesh: 'call:busy',
            targetId: fromId,
            callId: pkt.callId,
          },
          { forcePort443: true }
        );
        return;
      }
      const callId = String(pkt.callId || '');
      const callerPin = String(pkt._fromPin || '');
      this.inRoulette = false;
      this.callId = callId;
      this.callMode = 'code';
      this.partnerClientId = fromId;
      this.partnerPin = callerPin;

      this.emitToApp({
        type: 'call:incoming',
        callId,
        fromPin: callerPin,
      });
      this.broadcastPresencePacket(true);
      return;
    }

    if (meshType === 'call:busy') {
      if (this.callId && this.partnerClientId === fromId) {
        const targetPin = this.partnerPin || '';
        this.callId = null;
        this.partnerClientId = null;
        this.partnerPin = null;
        this.clearActiveMeshCall();
        this.emitToApp({
          type: 'call:status',
          status: 'busy',
          targetPin,
        });
        this.broadcastPresencePacket(true);
      }
      return;
    }

    if (meshType === 'call:accept') {
      if (this.callId && this.partnerClientId === fromId) {
        this.partnerPin = String(pkt._fromPin || this.partnerPin || '');
        this.saveActiveMeshCall();
        this.emitToApp({
          type: 'call:connected',
          callId: this.callId,
          peerPin: this.partnerPin,
          initiator: true,
          mode: this.callMode,
        });
        this.broadcastPresencePacket(true);
      }
      return;
    }

    if (meshType === 'call:resume') {
      const resumeCallId = String(pkt.callId || '');
      const peerPin = String(pkt._fromPin || this.partnerPin || '');
      if (this.callId === resumeCallId || !this.callId) {
        this.callId = resumeCallId;
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
        this.broadcastPresencePacket(true);
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
      this.sendMqttPingAll();
      this.pruneStalePeers();
      this.broadcastPresencePacket(false);
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
                  { forcePort443: true }
                );
              }
            }, 320);
          }
        }
      } catch {
        // Ignore
      }

      this.broadcastPresencePacket(true);
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
      this.broadcastPresencePacket(true);
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

      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      this.inRoulette = false;
      this.callId = callId;
      this.callMode = 'code';
      this.partnerClientId = targetPeer.clientId;
      this.partnerPin = targetPeer.pin;

      this.publishWire(
        {
          _mesh: 'call:invite',
          targetId: targetPeer.clientId,
          callId,
        },
        { forcePort443: true }
      );

      this.emitToApp({
        type: 'call:outgoing',
        callId,
        targetPin: targetPeer.pin,
      });
      this.broadcastPresencePacket(true);
      return;
    }

    if (type === 'call:answer') {
      if (!this.callId || !this.partnerClientId) return;
      this.saveActiveMeshCall();
      this.publishWire(
        {
          _mesh: 'call:accept',
          targetId: this.partnerClientId,
          callId: this.callId,
        },
        { forcePort443: true }
      );

      this.emitToApp({
        type: 'call:connected',
        callId: this.callId,
        peerPin: this.partnerPin || '---',
        initiator: false,
        mode: this.callMode,
      });
      this.broadcastPresencePacket(true);
      return;
    }

    if (type === 'call:hangup') {
      if (this.partnerClientId && this.callId) {
        this.publishWire(
          {
            _mesh: 'call:end',
            targetId: this.partnerClientId,
            callId: this.callId,
          },
          { forcePort443: true }
        );
      }
      this.callId = null;
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
      this.broadcastPresencePacket(true);
      return;
    }

    if (type === 'roulette:start' || type === 'roulette:next') {
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
          { forcePort443: true }
        );
      } else if (type === 'roulette:start') {
        this.lastPartnerClientId = null;
        this.lastSkippedAt = null;
      }
      this.callId = null;
      this.partnerClientId = null;
      this.partnerPin = null;
      this.clearActiveMeshCall();
      this.inRoulette = true;
      this.rouletteJoinedAt = now;
      this.emitToApp({
        type: 'roulette:searching',
      });
      this.broadcastPresencePacket(true);
      this.tryMatchRouletteInMesh(true);
      return;
    }

    if (type === 'roulette:stop') {
      if (this.partnerClientId && this.callId) {
        this.publishWire(
          {
            _mesh: 'call:end',
            targetId: this.partnerClientId,
            callId: this.callId,
          },
          { forcePort443: true }
        );
      }
      this.callId = null;
      this.partnerClientId = null;
      this.partnerPin = null;
      this.lastPartnerClientId = null;
      this.lastSkippedAt = null;
      this.inRoulette = false;
      this.clearActiveMeshCall();
      this.emitToApp({
        type: 'roulette:stopped',
      });
      this.broadcastPresencePacket(true);
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
          { forcePort443: true }
        );
        return;
      }

      if (type === 'media:frame' || type === 'media:audio') {
        const now = Date.now();
        if (now - this.lastMediaRelayAt < 240) {
          return;
        }
        this.lastMediaRelayAt = now;
        this.publishWire(
          {
            _mesh: 'relay',
            targetId: this.partnerClientId,
            payload: msg,
          },
          { isHighRateMedia: true }
        );
        return;
      }

      this.publishWire(
        {
          _mesh: 'relay',
          targetId: this.partnerClientId,
          payload: msg,
        },
        { forcePort443: true }
      );
    }
  }

  public close() {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WS_CLOSED;
    this.publishWire({ _mesh: 'leave' }, { forcePort443: true });
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer);
    if (this.pingTimer) window.clearInterval(this.pingTimer);
    for (const ws of this.mqttSockets.values()) {
      try {
        ws.close();
      } catch {
        // Ignore
      }
    }
    this.mqttSockets.clear();
    try {
      this.ntfyWs?.close();
    } catch {
      // Ignore
    }
    this.ntfyWs = null;
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
        if (!connectedOnce && !closed) {
          window.clearTimeout(fallbackTimer);
          triggerFailureOnce();
        }
      };

      ws.onclose = () => {
        window.clearTimeout(fallbackTimer);
        if (!connectedOnce && !closed) {
          triggerFailureOnce();
        } else if (!closed) {
          wrapper.onclose?.();
        }
      };
    } catch {
      handleInitialConnectFailure();
    }
  }, 15);

  return wrapper;
}

