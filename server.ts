import express from 'express';
import http from 'http';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer as createViteServer } from 'vite';
import {
  validatePin,
  generateFreePin,
  matchRouletteQueue,
  type RouletteCandidate,
} from './src/utils/intercomLogic.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = path.join(__dirname, '.data');
const PINS_FILE = path.join(DATA_DIR, 'pins.json');

interface PersistedPinStore {
  clientToPin: Record<string, string>;
}

function loadPinStore(): PersistedPinStore {
  try {
    if (fs.existsSync(PINS_FILE)) {
      const raw = fs.readFileSync(PINS_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.clientToPin === 'object') {
        return parsed;
      }
    }
  } catch {
    // Ignore read errors
  }
  return { clientToPin: {} };
}

function savePinStore(store: PersistedPinStore) {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(PINS_FILE, JSON.stringify(store, null, 2), 'utf-8');
  } catch {
    // Ignore write errors
  }
}

interface ChatMessageRecord {
  id: string;
  text: string;
  timestamp: number;
  fromPin: string;
}

interface MediaStateRecord {
  cam: boolean;
  mic: boolean;
  portrait?: boolean;
}

interface ConnectedClient {
  ws: WebSocket;
  clientId: string;
  pin: string;
  inRoulette: boolean;
  rouletteJoinedAt: number;
  callId: string | null;
  lastPartnerClientId: string | null;
  lastSkippedAt: number | null;
  connectedAt: number;
  lastSeenAt: number;
  disconnectedAt: number | null;
}

interface ActiveCall {
  callId: string;
  callerClientId: string;
  calleeClientId: string;
  callerPin: string;
  calleePin: string;
  mode: 'code' | 'roulette';
  status: 'ringing' | 'autodialing' | 'connected';
  createdAt: number;
  messages: ChatMessageRecord[];
  lastFrames: Record<string, string>;
  mediaState: Record<string, MediaStateRecord>;
}

const IDLE_GRACE_MS = 3 * 60 * 1000; // 3 minutes grace for backgrounded/switched mobile tabs
const CALL_SINGLE_WAIT_MS = 60 * 60 * 1000; // 60 minutes while one partner waits in the call
const CALL_BOTH_OFFLINE_MS = 10 * 60 * 1000; // 10 minutes when both participants closed browser / refreshed

async function startServer() {
  const app = express();
  app.use(express.json());

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  const pinStore = loadPinStore();
  const clientsById = new Map<string, ConnectedClient>();
  const clientsByWs = new Map<WebSocket, ConnectedClient>();
  const activeCalls = new Map<string, ActiveCall>();

  function isClientActiveOrGrace(c: ConnectedClient, now = Date.now()): boolean {
    if (c.ws.readyState === WebSocket.OPEN && c.disconnectedAt === null) return true;
    if (c.callId && activeCalls.has(c.callId)) return true;
    if (c.disconnectedAt !== null && now - c.disconnectedAt < IDLE_GRACE_MS) return true;
    return false;
  }

  function getActiveTakenPins(excludeClientId?: string): Set<string> {
    const now = Date.now();
    const set = new Set<string>();
    for (const c of clientsById.values()) {
      if (c.clientId !== excludeClientId && c.pin && isClientActiveOrGrace(c, now)) {
        set.add(c.pin);
      }
    }
    return set;
  }

  function findClientByPin(pin: string): ConnectedClient | undefined {
    const now = Date.now();
    // Prefer currently open socket first
    for (const c of clientsById.values()) {
      if (c.pin === pin && c.ws.readyState === WebSocket.OPEN && c.disconnectedAt === null) {
        return c;
      }
    }
    // Fallback to client within grace window or active call
    for (const c of clientsById.values()) {
      if (c.pin === pin && isClientActiveOrGrace(c, now)) {
        return c;
      }
    }
    return undefined;
  }

  function sendJson(ws: WebSocket, payload: Record<string, unknown>) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // Ignore send errors on closing sockets
      }
    }
  }

  function buildPresencePayload() {
    const now = Date.now();
    const onlineList = Array.from(clientsById.values())
      .filter((c) => isClientActiveOrGrace(c, now))
      .map((c) => ({
        pin: c.pin,
        status: c.callId ? 'busy' : c.inRoulette ? 'roulette' : 'free',
      }));
    const rouletteCount = onlineList.filter((u) => u.status === 'roulette').length;

    return {
      type: 'presence:update',
      onlineCount: onlineList.length,
      rouletteCount,
      onlinePins: onlineList.slice(0, 50),
    };
  }

  function broadcastPresence() {
    const msg = JSON.stringify(buildPresencePayload());

    for (const c of clientsById.values()) {
      if (c.ws.readyState === WebSocket.OPEN) {
        try {
          c.ws.send(msg);
        } catch {
          // Ignore
        }
      }
    }
  }

  let rouletteCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  const REPEAT_PARTNER_COOLDOWN_MS = 1800;

  function cleanupCall(
    callId: string,
    endedByClientId?: string,
    reason: string = 'hangup',
    keepPeerInRoulette: boolean = true
  ) {
    const call = activeCalls.get(callId);
    if (!call) return;
    activeCalls.delete(callId);

    const now = Date.now();
    const participants = [
      clientsById.get(call.callerClientId),
      clientsById.get(call.calleeClientId),
    ];

    for (const participant of participants) {
      if (!participant || participant.callId !== callId) continue;
      participant.callId = null;

      if (participant.clientId === endedByClientId) continue;

      if (keepPeerInRoulette && (call.mode === 'roulette' || participant.inRoulette)) {
        if (endedByClientId) {
          participant.lastPartnerClientId = endedByClientId;
          participant.lastSkippedAt = now;
        }
        participant.inRoulette = true;
        // Place the passive partner slightly behind the active skipper in queue order
        // so the user who pressed "Next" always gets matched first!
        participant.rouletteJoinedAt = now + 500;
        sendJson(participant.ws, {
          type: 'roulette:searching',
          reason: 'Собеседник покинул чат, ищем следующего',
        });
      } else {
        sendJson(participant.ws, {
          type: 'call:ended',
          callId,
          reason,
          wasRoulette: call.mode === 'roulette',
        });
      }
    }

    broadcastPresence();
  }

  function tryMatchRoulette(priorityClientId?: string) {
    const now = Date.now();
    const waiting: RouletteCandidate[] = [];
    for (const c of clientsById.values()) {
      if (
        c.inRoulette &&
        !c.callId &&
        c.ws.readyState === WebSocket.OPEN &&
        c.disconnectedAt === null
      ) {
        waiting.push({
          clientId: c.clientId,
          pin: c.pin,
          joinedAt: c.rouletteJoinedAt,
          lastPartnerClientId: c.lastPartnerClientId,
          lastSkippedAt: c.lastSkippedAt,
        });
      }
    }

    if (waiting.length < 2) return;

    const pairs = matchRouletteQueue(
      waiting,
      priorityClientId,
      now,
      REPEAT_PARTNER_COOLDOWN_MS
    );

    for (const { seeker, partner } of pairs) {
      const seekerClient = clientsById.get(seeker.clientId);
      const partnerClient = clientsById.get(partner.clientId);
      if (
        !seekerClient ||
        !partnerClient ||
        seekerClient.callId ||
        partnerClient.callId ||
        !seekerClient.inRoulette ||
        !partnerClient.inRoulette
      ) {
        continue;
      }

      const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const call: ActiveCall = {
        callId,
        callerClientId: seekerClient.clientId,
        calleeClientId: partnerClient.clientId,
        callerPin: seekerClient.pin,
        calleePin: partnerClient.pin,
        mode: 'roulette',
        status: 'connected',
        createdAt: Date.now(),
        messages: [],
        lastFrames: {},
        mediaState: {},
      };

      activeCalls.set(callId, call);
      seekerClient.callId = callId;
      partnerClient.callId = callId;
      seekerClient.lastPartnerClientId = partnerClient.clientId;
      partnerClient.lastPartnerClientId = seekerClient.clientId;
      seekerClient.lastSkippedAt = null;
      partnerClient.lastSkippedAt = null;

      sendJson(seekerClient.ws, {
        type: 'roulette:matched',
        callId,
        peerPin: partnerClient.pin,
        initiator: true,
      });

      sendJson(partnerClient.ws, {
        type: 'roulette:matched',
        callId,
        peerPin: seekerClient.pin,
        initiator: false,
      });
    }

    // If 2+ clients are still waiting because they are within the repeat-partner cooldown window,
    // schedule a re-check right after the cooldown expires so 2-person roulette still reconnects.
    const remainingWaiting = waiting.length - pairs.length * 2;
    if (remainingWaiting >= 2 && !rouletteCooldownTimer) {
      rouletteCooldownTimer = setTimeout(() => {
        rouletteCooldownTimer = null;
        tryMatchRoulette();
      }, REPEAT_PARTNER_COOLDOWN_MS + 60);
    }

    broadcastPresence();
  }

  // Periodic 15-second heartbeat & stale session maintenance
  const heartbeatInterval = setInterval(() => {
    const now = Date.now();
    let presenceChanged = false;

    // 1. Check active calls for expired abandonments
    for (const [callId, call] of activeCalls.entries()) {
      const caller = clientsById.get(call.callerClientId);
      const callee = clientsById.get(call.calleeClientId);
      const callerOff = !caller || caller.disconnectedAt !== null || caller.ws.readyState !== WebSocket.OPEN;
      const calleeOff = !callee || callee.disconnectedAt !== null || callee.ws.readyState !== WebSocket.OPEN;

      if (callerOff && calleeOff) {
        const bothOffSince = Math.max(
          caller?.disconnectedAt || 0,
          callee?.disconnectedAt || 0
        );
        if (bothOffSince > 0 && now - bothOffSince > CALL_BOTH_OFFLINE_MS) {
          cleanupCall(callId, undefined, 'timeout', false);
          presenceChanged = true;
        }
      } else if (callerOff || calleeOff) {
        const offClient = callerOff ? caller : callee;
        if (offClient?.disconnectedAt && now - offClient.disconnectedAt > CALL_SINGLE_WAIT_MS) {
          cleanupCall(callId, offClient.clientId, 'peer_disconnected', true);
          presenceChanged = true;
        }
      }
    }

    // 2. Sweep disconnected idle clients past grace window and ping active sockets
    for (const [id, c] of clientsById.entries()) {
      if (c.disconnectedAt !== null) {
        if (!c.callId && now - c.disconnectedAt >= IDLE_GRACE_MS) {
          clientsById.delete(id);
          presenceChanged = true;
        }
        continue;
      }

      if (c.ws.readyState === WebSocket.OPEN) {
        try {
          c.ws.ping();
        } catch {
          // Ignore
        }
        sendJson(c.ws, {
          type: 'server:heartbeat',
          ts: now,
        });
      }
    }

    if (presenceChanged) {
      broadcastPresence();
      tryMatchRoulette();
    } else {
      // Keep all connected clients' presence lists fresh
      broadcastPresence();
    }
  }, 15000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  // Health & stats endpoint
  app.get('/api/status', (_req, res) => {
    const payload = buildPresencePayload();
    res.json({
      ok: true,
      onlineCount: payload.onlineCount,
      rouletteCount: payload.rouletteCount,
      onlinePins: payload.onlinePins,
    });
  });

  wss.on('connection', (ws) => {
    ws.on('pong', () => {
      const c = clientsByWs.get(ws);
      if (c) {
        c.lastSeenAt = Date.now();
        c.disconnectedAt = null;
      }
    });

    ws.on('message', (rawData) => {
      let msg: Record<string, any>;
      try {
        msg = JSON.parse(String(rawData));
      } catch {
        return;
      }

      const type = String(msg.type || '');

      if (type === 'ping') {
        const c = clientsByWs.get(ws);
        if (c) {
          c.lastSeenAt = Date.now();
          c.disconnectedAt = null;
        }
        sendJson(ws, {
          type: 'pong',
          ts: Date.now(),
          callId: c?.callId || null,
        });
        sendJson(ws, buildPresencePayload());
        return;
      }

      if (type === 'init') {
        const rawClientId = String(msg.clientId || '').trim();
        let clientId =
          rawClientId && /^[a-zA-Z0-9_-]{4,64}$/.test(rawClientId)
            ? rawClientId
            : `u_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

        const requestedPin = String(msg.preferredPin || pinStore.clientToPin[clientId] || '').trim();

        let existingClient = clientsById.get(clientId);

        // If client reopened browser with a fresh clientId but same preferredPin that is currently waiting in an active call or grace period, reclaim it!
        if (!existingClient && requestedPin) {
          for (const candidate of clientsById.values()) {
            if (
              candidate.pin === requestedPin &&
              (candidate.disconnectedAt !== null || candidate.ws.readyState !== WebSocket.OPEN)
            ) {
              existingClient = candidate;
              clientId = candidate.clientId;
              break;
            }
          }
        }

        // Preserve any active call when the same client reconnects or refreshes!
        let preservedCallId: string | null = null;
        let preservedInRoulette = false;
        let preservedRouletteJoinedAt = 0;
        let preservedLastPartnerId: string | null = null;

        if (existingClient) {
          if (existingClient.callId && activeCalls.has(existingClient.callId)) {
            preservedCallId = existingClient.callId;
          }
          preservedInRoulette = existingClient.inRoulette;
          preservedRouletteJoinedAt = existingClient.rouletteJoinedAt;
          preservedLastPartnerId = existingClient.lastPartnerClientId;

          if (existingClient.ws !== ws) {
            clientsByWs.delete(existingClient.ws);
            try {
              existingClient.ws.close();
            } catch {
              // Ignore
            }
          }
        }

        const takenPins = getActiveTakenPins(clientId);
        const candidatePin = existingClient?.pin || requestedPin;
        const validated = validatePin(candidatePin);

        let assignedPin: string;
        if (validated.valid && !takenPins.has(validated.normalized)) {
          assignedPin = validated.normalized;
        } else {
          assignedPin = generateFreePin(takenPins);
        }

        pinStore.clientToPin[clientId] = assignedPin;
        savePinStore(pinStore);

        const now = Date.now();
        const clientObj: ConnectedClient = {
          ws,
          clientId,
          pin: assignedPin,
          inRoulette: preservedCallId ? false : preservedInRoulette,
          rouletteJoinedAt: preservedRouletteJoinedAt || (preservedInRoulette ? now : 0),
          callId: preservedCallId,
          lastPartnerClientId: preservedLastPartnerId,
          lastSkippedAt: existingClient?.lastSkippedAt || null,
          connectedAt: existingClient?.connectedAt || now,
          lastSeenAt: now,
          disconnectedAt: null,
        };

        clientsById.set(clientId, clientObj);
        clientsByWs.set(ws, clientObj);

        sendJson(ws, {
          type: 'init:ack',
          clientId,
          pin: assignedPin,
        });

        // If this client is in an active call, immediately restore the call for both sides!
        if (preservedCallId) {
          const call = activeCalls.get(preservedCallId);
          if (call) {
            if (call.callerClientId === clientId) {
              call.callerPin = assignedPin;
            } else if (call.calleeClientId === clientId) {
              call.calleePin = assignedPin;
            }

            const isCaller = call.callerClientId === clientId;
            const partnerId = isCaller ? call.calleeClientId : call.callerClientId;
            const partnerClient = clientsById.get(partnerId);
            const partnerPin = partnerClient?.pin || (isCaller ? call.calleePin : call.callerPin);

            if (call.status === 'connected') {
              sendJson(ws, {
                type: 'call:connected',
                callId: call.callId,
                peerPin: partnerPin,
                initiator: true,
                mode: call.mode,
                resumed: true,
                messages: call.messages,
                peerMediaState: call.mediaState[partnerId] || null,
                lastPeerFrame: call.lastFrames[partnerId] || null,
              });

              if (partnerClient && partnerClient.ws.readyState === WebSocket.OPEN) {
                sendJson(partnerClient.ws, {
                  type: 'call:peer_resumed',
                  callId: call.callId,
                  peerPin: assignedPin,
                  initiator: false,
                  mode: call.mode,
                });
              }
            } else if (call.status === 'ringing') {
              if (isCaller) {
                sendJson(ws, {
                  type: 'call:outgoing',
                  callId: call.callId,
                  targetPin: partnerPin,
                });
              } else {
                sendJson(ws, {
                  type: 'call:incoming',
                  callId: call.callId,
                  fromPin: partnerPin,
                });
              }
            }
          }
        } else if (clientObj.inRoulette) {
          sendJson(ws, {
            type: 'roulette:searching',
          });
        }

        broadcastPresence();
        if (clientObj.inRoulette && !clientObj.callId) {
          tryMatchRoulette();
        }
        return;
      }

      const client = clientsByWs.get(ws);
      if (!client) return;
      client.lastSeenAt = Date.now();
      client.disconnectedAt = null;

      if (type === 'pin:change') {
        if (client.callId) {
          sendJson(ws, {
            type: 'pin:result',
            ok: false,
            pin: client.pin,
            error: 'Нельзя менять номер во время активного вызова',
          });
          return;
        }

        const rawNewPin = String(msg.newPin || '').trim();
        const validation = validatePin(rawNewPin);
        if (!validation.valid) {
          sendJson(ws, {
            type: 'pin:result',
            ok: false,
            pin: client.pin,
            error: validation.error || 'Некорректный номер',
          });
          return;
        }

        const taken = getActiveTakenPins(client.clientId);
        if (taken.has(validation.normalized)) {
          sendJson(ws, {
            type: 'pin:result',
            ok: false,
            pin: client.pin,
            error: `Номер ${validation.normalized} сейчас занят другим абонентом`,
          });
          return;
        }

        client.pin = validation.normalized;
        pinStore.clientToPin[client.clientId] = client.pin;
        savePinStore(pinStore);

        sendJson(ws, {
          type: 'pin:result',
          ok: true,
          pin: client.pin,
        });
        broadcastPresence();
        return;
      }

      if (type === 'pin:random') {
        if (client.callId) {
          sendJson(ws, {
            type: 'pin:result',
            ok: false,
            pin: client.pin,
            error: 'Нельзя менять номер во время активного вызова',
          });
          return;
        }

        const taken = getActiveTakenPins();
        taken.add(client.pin); // ensure a different pin is generated
        const newPin = generateFreePin(taken);
        client.pin = newPin;
        pinStore.clientToPin[client.clientId] = newPin;
        savePinStore(pinStore);

        sendJson(ws, {
          type: 'pin:result',
          ok: true,
          pin: client.pin,
        });
        broadcastPresence();
        return;
      }

      if (type === 'call:dial') {
        const targetPin = String(msg.targetPin || '').trim();
        const validation = validatePin(targetPin);
        if (!validation.valid) {
          sendJson(ws, {
            type: 'call:status',
            status: 'not_found',
            targetPin,
            reason: 'Некорректный номер квартиры',
          });
          return;
        }

        if (targetPin === client.pin) {
          sendJson(ws, {
            type: 'call:status',
            status: 'busy',
            targetPin,
            reason: 'Это ваш собственный номер домофона',
          });
          return;
        }

        if (client.callId) {
          cleanupCall(client.callId, client.clientId, 'new_dial', true);
          tryMatchRoulette();
        }
        client.inRoulette = false;

        const targetClient = findClientByPin(validation.normalized);
        if (!targetClient) {
          sendJson(ws, {
            type: 'call:status',
            status: 'not_found',
            targetPin: validation.normalized,
            reason: `Абонент с кодом ${validation.normalized} сейчас не в сети`,
          });
          return;
        }

        if (targetClient.callId && activeCalls.has(targetClient.callId)) {
          sendJson(ws, {
            type: 'call:status',
            status: 'busy',
            targetPin: validation.normalized,
            reason: `Линия абонента ${validation.normalized} занята`,
          });
          return;
        }

        // If target was waiting in roulette, pull them out for the incoming direct call
        targetClient.inRoulette = false;

        const callId = `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const call: ActiveCall = {
          callId,
          callerClientId: client.clientId,
          calleeClientId: targetClient.clientId,
          callerPin: client.pin,
          calleePin: targetClient.pin,
          mode: 'code',
          status: 'ringing',
          createdAt: Date.now(),
          messages: [],
          lastFrames: {},
          mediaState: {},
        };

        activeCalls.set(callId, call);
        client.callId = callId;
        targetClient.callId = callId;

        sendJson(client.ws, {
          type: 'call:outgoing',
          callId,
          targetPin: targetClient.pin,
        });

        sendJson(targetClient.ws, {
          type: 'call:incoming',
          callId,
          fromPin: client.pin,
        });

        broadcastPresence();
        return;
      }

      if (type === 'call:answer') {
        const callId = client.callId;
        if (!callId) return;
        const call = activeCalls.get(callId);
        if (!call || call.calleeClientId !== client.clientId) return;

        call.status = 'connected';
        const caller = clientsById.get(call.callerClientId);
        if (!caller) {
          cleanupCall(callId, client.clientId, 'peer_disconnected', true);
          return;
        }

        sendJson(caller.ws, {
          type: 'call:connected',
          callId,
          peerPin: client.pin,
          initiator: true,
          mode: call.mode,
        });

        sendJson(client.ws, {
          type: 'call:connected',
          callId,
          peerPin: caller.pin,
          initiator: false,
          mode: call.mode,
        });

        broadcastPresence();
        return;
      }

      if (type === 'call:hangup') {
        if (client.callId) {
          const call = activeCalls.get(client.callId);
          const wasRoulette = call?.mode === 'roulette';
          cleanupCall(client.callId, client.clientId, 'hangup', true);
          sendJson(ws, {
            type: 'call:ended',
            reason: 'hangup',
            wasRoulette,
          });
        }
        client.inRoulette = false;
        client.lastPartnerClientId = null;
        client.lastSkippedAt = null;
        broadcastPresence();
        tryMatchRoulette();
        return;
      }

      if (type === 'roulette:start') {
        if (client.callId) {
          cleanupCall(client.callId, client.clientId, 'roulette_switch', true);
        }
        client.inRoulette = true;
        client.rouletteJoinedAt = Date.now();
        client.lastPartnerClientId = null;
        client.lastSkippedAt = null;
        sendJson(ws, {
          type: 'roulette:searching',
        });
        broadcastPresence();
        tryMatchRoulette(client.clientId);
        return;
      }

      if (type === 'roulette:next') {
        const now = Date.now();
        if (client.callId) {
          const call = activeCalls.get(client.callId);
          if (call) {
            const prevPartnerId =
              call.callerClientId === client.clientId ? call.calleeClientId : call.callerClientId;
            client.lastPartnerClientId = prevPartnerId;
            client.lastSkippedAt = now;
          }
          cleanupCall(client.callId, client.clientId, 'roulette_next', true);
        }
        client.inRoulette = true;
        // Active skipper gets `now` (while passive partner got `now + 500` in cleanupCall)
        // AND is passed as `priorityClientId` to `tryMatchRoulette` so they always match first!
        client.rouletteJoinedAt = now;
        sendJson(ws, {
          type: 'roulette:searching',
        });
        broadcastPresence();
        tryMatchRoulette(client.clientId);
        return;
      }

      if (type === 'roulette:stop') {
        if (client.callId) {
          cleanupCall(client.callId, client.clientId, 'roulette_stop', true);
        }
        client.inRoulette = false;
        client.lastPartnerClientId = null;
        client.lastSkippedAt = null;
        sendJson(ws, {
          type: 'roulette:stopped',
        });
        broadcastPresence();
        tryMatchRoulette();
        return;
      }

      // Relay WebRTC signaling, media fallback frames/audio/state, and sanitized in-call chat messages between call peers
      if (
        type === 'webrtc:offer' ||
        type === 'webrtc:answer' ||
        type === 'webrtc:ice' ||
        type === 'media:frame' ||
        type === 'media:audio' ||
        type === 'media:state' ||
        type === 'chat:msg'
      ) {
        if (!client.callId) return;
        const call = activeCalls.get(client.callId);
        if (!call) return;

        // Cache latest frame, media state, and chat history on the call so reconnections/reloads restore seamlessly
        const rawFrame =
          typeof msg.frame === 'string'
            ? msg.frame
            : typeof msg.data === 'string'
              ? msg.data
              : null;
        if (type === 'media:frame' && rawFrame && rawFrame.length < 300_000) {
          call.lastFrames[client.clientId] = rawFrame;
          call.mediaState[client.clientId] = {
            cam: msg.camEnabled !== false && msg.cam !== false,
            mic: msg.micEnabled !== false && msg.mic !== false,
            portrait: typeof msg.portrait === 'boolean' ? msg.portrait : undefined,
          };
        } else if (type === 'media:state') {
          call.mediaState[client.clientId] = {
            cam: msg.camEnabled !== false && msg.cam !== false,
            mic: msg.micEnabled !== false && msg.mic !== false,
            portrait: typeof msg.portrait === 'boolean' ? msg.portrait : undefined,
          };
        }

        const targetId =
          call.callerClientId === client.clientId ? call.calleeClientId : call.callerClientId;
        const targetClient = clientsById.get(targetId);

        if (type === 'chat:msg') {
          const rawText = typeof msg.text === 'string' ? msg.text.trim().slice(0, 280) : '';
          if (!rawText) return;
          const chatItem: ChatMessageRecord = {
            id: String(msg.id || `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
            text: rawText,
            timestamp: Number(msg.timestamp) || Date.now(),
            fromPin: client.pin,
          };
          call.messages.push(chatItem);
          if (call.messages.length > 100) {
            call.messages.shift();
          }
          if (targetClient && targetClient.ws.readyState === WebSocket.OPEN) {
            sendJson(targetClient.ws, {
              type: 'chat:msg',
              ...chatItem,
            });
          }
          return;
        }

        if (!targetClient || targetClient.ws.readyState !== WebSocket.OPEN) return;

        sendJson(targetClient.ws, {
          ...msg,
          fromPin: client.pin,
        });
        return;
      }
    });

    ws.on('close', () => {
      const client = clientsByWs.get(ws);
      if (!client) return;

      clientsByWs.delete(ws);

      // Only mark disconnected if this socket is still the active socket for the client
      if (clientsById.get(client.clientId)?.ws === ws) {
        client.disconnectedAt = Date.now();

        // If the client was in an active call, DO NOT drop the call!
        // Keep the call open so the waiting partner keeps their frozen frame, and when this client
        // refreshes the page, switches back to the browser tab, or re-opens the browser, the call resumes!
        if (client.callId) {
          const call = activeCalls.get(client.callId);
          if (call) {
            const partnerId =
              call.callerClientId === client.clientId ? call.calleeClientId : call.callerClientId;
            const partnerClient = clientsById.get(partnerId);
            if (partnerClient && partnerClient.ws.readyState === WebSocket.OPEN) {
              sendJson(partnerClient.ws, {
                type: 'call:peer_paused',
                callId: call.callId,
                peerPin: client.pin,
              });
            }
          }
        }
      }

      broadcastPresence();
      tryMatchRoulette();
    });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true, hmr: false },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Intercom server running on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
});
