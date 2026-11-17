import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  CallState,
  ChatMessage,
  ConnectionMode,
  IntercomBrand,
  RemoteRotationMode,
  cycleRemoteRotationMode,
  formatIntercomDisplay,
  resolveKeypadPress,
  sanitizeChatMessage,
} from './utils/intercomLogic';
import { encodePcm8Base64, soundEngine } from './utils/soundEngine';
import { IntercomScene3D } from './components/IntercomScene3D';
import { TopBar } from './components/TopBar';
import { PinModal } from './components/PinModal';
import { HelpModal } from './components/HelpModal';
import { FullscreenMonitor } from './components/FullscreenMonitor';
import { ControlDock, OnlinePeer } from './components/ControlDock';
import { InCallChat } from './components/InCallChat';
import { createIntercomTransport, IntercomTransport } from './utils/networkTransport';

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.sipnet.ru:3478' },
    { urls: 'stun:stun.sipnet.net:3478' },
    { urls: 'stun:stun.nextcloud.com:443' },
    { urls: 'stun:stun.zadarma.com:3478' },
  ],
  iceCandidatePoolSize: 4,
};

function waitForIceGatheringBrief(pc: RTCPeerConnection, timeoutMs = 220): Promise<void> {
  if (pc.iceGatheringState === 'complete') {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      pc.removeEventListener('icegatheringstatechange', onState);
      window.clearTimeout(timer);
      resolve();
    };
    const onState = () => {
      if (pc.iceGatheringState === 'complete') {
        finish();
      }
    };
    const timer = window.setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', onState);
  });
}

const LEASE_TTL_MS = 4500;

function getOrCreateSessionClientId(): string {
  try {
    const existingSession = sessionStorage.getItem('intercom_client_id');
    if (existingSession) {
      localStorage.setItem('intercom_last_client_id', existingSession);
      localStorage.setItem(`intercom_active_lease_${existingSession}`, String(Date.now()));
      return existingSession;
    }

    // Check if the user reopened the browser or tab after closing it / turning off the phone:
    // If no other currently-open tab holds a fresh lease on intercom_last_client_id, reclaim it!
    const lastId = localStorage.getItem('intercom_last_client_id');
    if (lastId) {
      const leaseRaw = localStorage.getItem(`intercom_active_lease_${lastId}`);
      const leaseTs = leaseRaw ? Number(leaseRaw) : 0;
      if (!leaseTs || Date.now() - leaseTs > LEASE_TTL_MS) {
        sessionStorage.setItem('intercom_client_id', lastId);
        localStorage.setItem(`intercom_active_lease_${lastId}`, String(Date.now()));
        const lastPin = localStorage.getItem(`intercom_preferred_pin_${lastId}`);
        if (lastPin) {
          sessionStorage.setItem('intercom_preferred_pin', lastPin);
        }
        return lastId;
      }
    }

    const created = `u_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    sessionStorage.setItem('intercom_client_id', created);
    localStorage.setItem('intercom_last_client_id', created);
    localStorage.setItem(`intercom_active_lease_${created}`, String(Date.now()));
    return created;
  } catch {
    return `u_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }
}

function getSavedPreferredPin(clientId: string): string {
  try {
    return (
      sessionStorage.getItem('intercom_preferred_pin') ||
      localStorage.getItem(`intercom_preferred_pin_${clientId}`) ||
      ''
    );
  } catch {
    return '';
  }
}

function savePreferredPin(clientId: string, pin: string) {
  if (!pin) return;
  try {
    sessionStorage.setItem('intercom_preferred_pin', pin);
    localStorage.setItem(`intercom_preferred_pin_${clientId}`, pin);
    localStorage.setItem('intercom_last_client_id', clientId);
  } catch {
    // Ignore storage errors
  }
}

export default function App() {
  const [brand, setBrand] = useState<IntercomBrand>('eltis');
  const [mode, setMode] = useState<ConnectionMode>('code');
  const [callState, setCallState] = useState<CallState>('idle');
  const [currentInput, setCurrentInput] = useState<string>('');
  const [autoDialBuffer, setAutoDialBuffer] = useState<string>('');
  const [myPin, setMyPin] = useState<string>(() =>
    getSavedPreferredPin(getOrCreateSessionClientId())
  );
  const [peerPin, setPeerPin] = useState<string | null>(null);
  const [onlineCount, setOnlineCount] = useState<number>(1);
  const [rouletteCount, setRouletteCount] = useState<number>(0);
  const [onlinePeers, setOnlinePeers] = useState<OnlinePeer[]>([]);

  const [isPinModalOpen, setIsPinModalOpen] = useState<boolean>(false);
  const [isHelpModalOpen, setIsHelpModalOpen] = useState<boolean>(false);
  const [isFullscreenOpen, setIsFullscreenOpen] = useState<boolean>(false);
  const [pinServerError, setPinServerError] = useState<string | null>(null);

  const [micEnabled, setMicEnabled] = useState<boolean>(true);
  const [camEnabled, setCamEnabled] = useState<boolean>(true);
  const [peerMicEnabled, setPeerMicEnabled] = useState<boolean>(true);
  const [peerCamEnabled, setPeerCamEnabled] = useState<boolean>(true);
  const [showSelfPreview, setShowSelfPreview] = useState<boolean>(true);
  const [cameraFacingMode, setCameraFacingMode] = useState<'user' | 'environment'>('user');
  const [remoteRotation, setRemoteRotation] = useState<RemoteRotationMode>('auto');
  const [baselinePeerIsPortrait, setBaselinePeerIsPortrait] = useState<boolean | null>(null);
  const [isNightMode, setIsNightMode] = useState<boolean>(false);

  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [isChatOpen, setIsChatOpen] = useState<boolean>(false);
  const [unreadChatCount, setUnreadChatCount] = useState<number>(0);
  const [toastChatMsg, setToastChatMsg] = useState<ChatMessage | null>(null);

  const [pressedKeyTrigger, setPressedKeyTrigger] = useState<{ key: string; seq: number } | null>(
    null
  );
  const [remoteFrameSeq, setRemoteFrameSeq] = useState<number>(0);
  const [isHardwareCam, setIsHardwareCam] = useState<boolean>(false);

  const wsRef = useRef<IntercomTransport | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pcInitPromiseRef = useRef<Promise<RTCPeerConnection | null> | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const hasHardwareVideoRef = useRef<boolean>(false);
  const hasHardwareAudioRef = useRef<boolean>(false);
  const lastMediaRetryAtRef = useRef<number>(0);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const remoteVideoStreamRef = useRef<MediaStream | null>(null);
  const remoteAudioStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteCanvasDisplayRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const autoDialTimeoutsRef = useRef<number[]>([]);
  const toastTimeoutRef = useRef<number | null>(null);
  const webrtcConnectedRef = useRef<boolean>(false);
  const webrtcAudioRxRef = useRef<boolean>(false);
  const webrtcVideoRxRef = useRef<boolean>(false);
  const peerWebrtcAudioRxRef = useRef<boolean>(false);
  const peerWebrtcVideoRxRef = useRef<boolean>(false);
  const pendingIceCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const gatheredLocalCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  const sdpSentRef = useRef<boolean>(false);
  const trickleIceSentCountRef = useRef<number>(0);
  const webrtcOfferRetryTimerRef = useRef<number | null>(null);
  const baselinePeerIsPortraitRef = useRef<boolean | null>(null);

  const brandRef = useRef(brand);
  brandRef.current = brand;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const myPinRef = useRef(myPin);
  myPinRef.current = myPin;
  const camEnabledRef = useRef(camEnabled);
  camEnabledRef.current = camEnabled;
  const micEnabledRef = useRef(micEnabled);
  micEnabledRef.current = micEnabled;
  const facingModeRef = useRef(cameraFacingMode);
  facingModeRef.current = cameraFacingMode;
  const isChatOpenRef = useRef(isChatOpen);
  isChatOpenRef.current = isChatOpen;
  const callStateRef = useRef(callState);
  callStateRef.current = callState;

  const drawFrameToRemoteCanvas = useCallback((frameDataUrl: string) => {
    if (!frameDataUrl) return;
    try {
      sessionStorage.setItem('intercom_last_peer_frame', frameDataUrl);
    } catch {
      // Ignore quota errors
    }
    const img = new Image();
    img.onload = () => {
      const remCanvas = remoteCanvasDisplayRef.current;
      if (!remCanvas) return;
      const iw = img.naturalWidth || 480;
      const ih = img.naturalHeight || 360;
      if (baselinePeerIsPortraitRef.current === null && iw > 0 && ih > 0 && iw !== ih) {
        const isPortrait = ih > iw;
        baselinePeerIsPortraitRef.current = isPortrait;
        setBaselinePeerIsPortrait(isPortrait);
      }
      if (remCanvas.width !== iw || remCanvas.height !== ih) {
        remCanvas.width = iw;
        remCanvas.height = ih;
      }
      const ctx = remCanvas.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, iw, ih);
        setRemoteFrameSeq((s) => s + 1);
      }
    };
    img.src = frameDataUrl;
  }, []);

  const resetCallChat = useCallback(() => {
    setChatMessages([]);
    setUnreadChatCount(0);
    setToastChatMsg(null);
    setIsChatOpen(false);
    setPeerMicEnabled(true);
    setPeerCamEnabled(true);
    baselinePeerIsPortraitRef.current = null;
    setBaselinePeerIsPortrait(null);
    if (toastTimeoutRef.current) {
      window.clearTimeout(toastTimeoutRef.current);
      toastTimeoutRef.current = null;
    }
  }, []);

  const unlockRemoteAudioElements = useCallback(() => {
    soundEngine.unlock();
    if (remoteVideoRef.current) {
      // Keep remoteVideoRef strictly muted so iOS Safari / Android Chrome NEVER block video decoding
      remoteVideoRef.current.muted = true;
      remoteVideoRef.current.play().catch(() => {});
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = false;
      remoteAudioRef.current.volume = 1.0;
      remoteAudioRef.current
        .play()
        .then(() => {
          if (remoteAudioStreamRef.current) {
            soundEngine.attachRemoteWebRtcAudioBackup(remoteAudioStreamRef.current, true);
          }
        })
        .catch(() => {
          if (remoteAudioStreamRef.current) {
            soundEngine.attachRemoteWebRtcAudioBackup(remoteAudioStreamRef.current, false);
          }
        });
    }
  }, []);

  const clearAutoDialTimers = useCallback(() => {
    for (const t of autoDialTimeoutsRef.current) {
      window.clearTimeout(t);
    }
    autoDialTimeoutsRef.current = [];
  }, []);

  const sendWs = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify(payload));
    }
  }, []);

  const ensureLocalMedia = useCallback(
    async (forceFacingMode?: 'user' | 'environment'): Promise<MediaStream | null> => {
      const targetFacing = forceFacingMode || facingModeRef.current;

      const existing = localStreamRef.current;
      const hasLiveVideo = Boolean(
        existing &&
          hasHardwareVideoRef.current &&
          existing.getVideoTracks().some((t) => t.readyState === 'live')
      );
      const hasLiveAudio = Boolean(
        existing &&
          hasHardwareAudioRef.current &&
          existing.getAudioTracks().some((t) => t.readyState === 'live')
      );

      if (existing && !forceFacingMode) {
        if (hasLiveVideo && hasLiveAudio) {
          if (localVideoRef.current && localVideoRef.current.srcObject !== existing) {
            localVideoRef.current.srcObject = existing;
            localVideoRef.current.play().catch(() => {});
          }
          return existing;
        }
        // Throttle hardware re-acquisition attempts to once every 1.8s
        if (Date.now() - lastMediaRetryAtRef.current < 1800) {
          return existing;
        }
      }

      lastMediaRetryAtRef.current = Date.now();

      if (typeof navigator !== 'undefined' && navigator.webdriver) {
        return null;
      }

      let acquiredVideoTrack: MediaStreamTrack | null =
        !forceFacingMode && hasLiveVideo && existing ? existing.getVideoTracks()[0] || null : null;
      let acquiredAudioTrack: MediaStreamTrack | null =
        hasLiveAudio && existing ? existing.getAudioTracks()[0] || null : null;

      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        // 1. Try combined audio + video with preferred camera facingMode
        if (!acquiredVideoTrack || !acquiredAudioTrack || forceFacingMode) {
          try {
            const combined = await navigator.mediaDevices.getUserMedia({
              video: {
                facingMode: { ideal: targetFacing },
                width: { ideal: 480 },
                height: { ideal: 360 },
              },
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
            if (combined.getVideoTracks()[0]) {
              acquiredVideoTrack = combined.getVideoTracks()[0];
              hasHardwareVideoRef.current = true;
            }
            if (combined.getAudioTracks()[0]) {
              acquiredAudioTrack = combined.getAudioTracks()[0];
              hasHardwareAudioRef.current = true;
            }
          } catch {
            // 2. Try unconstrained video + audio (fixes mobile devices that reject width/height constraints)
            try {
              const basic = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true,
              });
              if (basic.getVideoTracks()[0]) {
                acquiredVideoTrack = basic.getVideoTracks()[0];
                hasHardwareVideoRef.current = true;
              }
              if (basic.getAudioTracks()[0]) {
                acquiredAudioTrack = basic.getAudioTracks()[0];
                hasHardwareAudioRef.current = true;
              }
            } catch {
              // 3. Try acquiring microphone and camera independently so one never blocks the other
              if (!acquiredAudioTrack) {
                try {
                  const audioOnly = await navigator.mediaDevices.getUserMedia({
                    audio: {
                      echoCancellation: true,
                      noiseSuppression: true,
                      autoGainControl: true,
                    },
                    video: false,
                  });
                  if (audioOnly.getAudioTracks()[0]) {
                    acquiredAudioTrack = audioOnly.getAudioTracks()[0];
                    hasHardwareAudioRef.current = true;
                  }
                } catch {
                  // Ignore
                }
              }
              if (!acquiredVideoTrack || forceFacingMode) {
                try {
                  const videoOnly = await navigator.mediaDevices.getUserMedia({
                    video: { facingMode: { ideal: targetFacing } },
                    audio: false,
                  });
                  if (videoOnly.getVideoTracks()[0]) {
                    acquiredVideoTrack = videoOnly.getVideoTracks()[0];
                    hasHardwareVideoRef.current = true;
                  }
                } catch {
                  // Ignore
                }
              }
            }
          }
        }
      }

      if (acquiredVideoTrack) {
        acquiredVideoTrack.enabled = camEnabledRef.current;
        setIsHardwareCam(true);
      }
      if (acquiredAudioTrack) {
        acquiredAudioTrack.enabled = micEnabledRef.current;
      }

      // If hardware video was acquired or audio was acquired, build/update the unified MediaStream
      const finalStream = new MediaStream();
      if (acquiredAudioTrack) {
        finalStream.addTrack(acquiredAudioTrack);
      }

      if (acquiredVideoTrack) {
        finalStream.addTrack(acquiredVideoTrack);
      } else {
        // Fallback synthetic video track if camera hardware is absent or denied
        try {
          const fallbackCanvas = document.createElement('canvas');
          fallbackCanvas.width = 480;
          fallbackCanvas.height = 360;
          const ctx = fallbackCanvas.getContext('2d');
          const drawFallback = () => {
            if (!ctx) return;
            const grad = ctx.createRadialGradient(240, 155, 20, 240, 180, 260);
            grad.addColorStop(0, '#222834');
            grad.addColorStop(1, '#101318');
            ctx.fillStyle = grad;
            ctx.fillRect(0, 0, 480, 360);

            ctx.fillStyle = '#333b4a';
            ctx.beginPath();
            ctx.arc(240, 125, 44, 0, Math.PI * 2);
            ctx.fill();

            ctx.beginPath();
            ctx.ellipse(240, 255, 92, 68, 0, Math.PI, 0, false);
            ctx.fill();

            ctx.strokeStyle = 'rgba(255,255,255,0.12)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(168, 64, 144, 144);
          };
          drawFallback();
          window.setInterval(drawFallback, 250);

          if (typeof fallbackCanvas.captureStream === 'function') {
            const canvasStream = fallbackCanvas.captureStream(20);
            const fallbackVidTrack = canvasStream.getVideoTracks()[0];
            if (fallbackVidTrack) {
              finalStream.addTrack(fallbackVidTrack);
            }
          }
        } catch {
          // Ignore
        }
      }

      // Stop any replaced tracks from the previous stream
      if (existing && existing !== finalStream) {
        const newIds = new Set(finalStream.getTracks().map((t) => t.id));
        existing.getTracks().forEach((t) => {
          if (!newIds.has(t.id)) {
            try {
              t.stop();
            } catch {
              // Ignore
            }
          }
        });
      }

      localStreamRef.current = finalStream;
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = finalStream;
        localVideoRef.current.muted = true;
        localVideoRef.current.play().catch(() => {});
      }

      // If an RTCPeerConnection is already active, make sure newly acquired tracks are attached/replaced
      const pc = pcRef.current;
      if (pc && pc.signalingState !== 'closed') {
        try {
          const senders = pc.getSenders();
          for (const track of finalStream.getTracks()) {
            const matchingSender = senders.find((s) => s.track && s.track.kind === track.kind);
            if (matchingSender) {
              if (matchingSender.track?.id !== track.id) {
                matchingSender.replaceTrack(track).catch(() => {});
              }
            } else {
              pc.addTrack(track, finalStream);
            }
          }
        } catch {
          // Ignore
        }
      }

      return finalStream;
    },
    []
  );

  const handleSwitchCamera = useCallback(async () => {
    const nextFacing: 'user' | 'environment' =
      cameraFacingMode === 'user' ? 'environment' : 'user';
    setCameraFacingMode(nextFacing);
    facingModeRef.current = nextFacing;
    soundEngine.playKeyBeep(brandRef.current);

    await ensureLocalMedia(nextFacing);
  }, [cameraFacingMode, ensureLocalMedia]);

  const handleRotateRemoteVideo = useCallback(() => {
    soundEngine.playKeyBeep(brandRef.current);
    setRemoteRotation((prev) => {
      const next = cycleRemoteRotationMode(prev);
      if (next !== 'auto') {
        const remVid = remoteVideoRef.current;
        const remCan = remoteCanvasDisplayRef.current;
        let sw = 0;
        let sh = 0;
        if (remVid && remVid.readyState >= 2 && remVid.videoWidth > 0) {
          sw = remVid.videoWidth;
          sh = remVid.videoHeight;
        } else if (remCan && remCan.width > 0 && remCan.height > 0) {
          sw = remCan.width;
          sh = remCan.height;
        }
        if (sw > 0 && sh > 0 && sw !== sh) {
          const isPortrait = sh > sw;
          baselinePeerIsPortraitRef.current = isPortrait;
          setBaselinePeerIsPortrait(isPortrait);
        }
      } else {
        baselinePeerIsPortraitRef.current = null;
        setBaselinePeerIsPortrait(null);
      }
      return next;
    });
  }, []);

  const flushPendingIceCandidates = useCallback(async (pc: RTCPeerConnection) => {
    if (!pc.remoteDescription || !pc.remoteDescription.type) return;
    const queued = pendingIceCandidatesRef.current.splice(0, pendingIceCandidatesRef.current.length);
    for (const cand of queued) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(cand));
      } catch {
        // Ignore duplicate or invalid candidate
      }
    }
  }, []);

  const closePeerConnection = useCallback(() => {
    webrtcConnectedRef.current = false;
    webrtcAudioRxRef.current = false;
    webrtcVideoRxRef.current = false;
    peerWebrtcAudioRxRef.current = false;
    peerWebrtcVideoRxRef.current = false;
    pcInitPromiseRef.current = null;
    pendingIceCandidatesRef.current = [];
    gatheredLocalCandidatesRef.current = [];
    sdpSentRef.current = false;
    trickleIceSentCountRef.current = 0;
    if (webrtcOfferRetryTimerRef.current !== null) {
      window.clearTimeout(webrtcOfferRetryTimerRef.current);
      webrtcOfferRetryTimerRef.current = null;
    }
    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.oniceconnectionstatechange = null;
        pcRef.current.close();
      } catch {
        // Ignore
      }
      pcRef.current = null;
    }
    remoteStreamRef.current = null;
    remoteVideoStreamRef.current = null;
    remoteAudioStreamRef.current = null;
    soundEngine.attachRemoteWebRtcAudioBackup(null, true);
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  }, []);

  const startWebRtcSession = useCallback(
    async (initiator: boolean): Promise<RTCPeerConnection | null> => {
      // If a peer connection initialization is already in flight or active, reuse it instead of racing!
      if (pcInitPromiseRef.current) {
        const existingPc = await pcInitPromiseRef.current;
        if (existingPc && existingPc.signalingState !== 'closed') {
          if (initiator && existingPc.signalingState === 'stable' && !existingPc.remoteDescription) {
            try {
              const offer = await existingPc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: true,
              });
              await existingPc.setLocalDescription(offer);
              await waitForIceGatheringBrief(existingPc, 220);
              sdpSentRef.current = true;
              sendWs({
                type: 'webrtc:offer',
                sdp: existingPc.localDescription,
                candidates: [...gatheredLocalCandidatesRef.current],
              });
            } catch {
              // Ignore
            }
          }
          return existingPc;
        }
      }

      if (!initiator && pcRef.current && pcRef.current.signalingState !== 'closed') {
        return pcRef.current;
      }

      closePeerConnection();

      const initTask = (async (): Promise<RTCPeerConnection | null> => {
        try {
          // Acquire local camera/microphone FIRST so tracks are always attached before createOffer/createAnswer!
          const stream = await ensureLocalMedia();

          const pc = new RTCPeerConnection(RTC_CONFIG);
          pcRef.current = pc;

          const combinedRemote = new MediaStream();
          remoteStreamRef.current = combinedRemote;

          const updateConnectedState = () => {
            if (pcRef.current !== pc) return;
            const isConn =
              pc.connectionState === 'connected' ||
              pc.iceConnectionState === 'connected' ||
              pc.iceConnectionState === 'completed';
            webrtcConnectedRef.current = isConn;
            if (isConn) {
              unlockRemoteAudioElements();
            }
          };

          pc.onconnectionstatechange = updateConnectedState;
          pc.oniceconnectionstatechange = updateConnectedState;

          pc.onicecandidate = (event) => {
            if (!event.candidate || pcRef.current !== pc) return;
            const jsonCand = event.candidate.toJSON
              ? event.candidate.toJSON()
              : {
                  candidate: event.candidate.candidate,
                  sdpMid: event.candidate.sdpMid,
                  sdpMLineIndex: event.candidate.sdpMLineIndex,
                };
            if (
              jsonCand.candidate &&
              !gatheredLocalCandidatesRef.current.some((c) => c.candidate === jsonCand.candidate)
            ) {
              gatheredLocalCandidatesRef.current.push(jsonCand);
            }
            // Trickle any late candidates (up to 6 max) that arrive AFTER the bundled Offer or Answer was sent
            if (sdpSentRef.current && trickleIceSentCountRef.current < 6) {
              trickleIceSentCountRef.current++;
              sendWs({
                type: 'webrtc:ice',
                candidate: jsonCand,
              });
            }
          };

          pc.ontrack = (event) => {
            if (!event.track) return;
            if (remoteStreamRef.current) {
              remoteStreamRef.current.addTrack(event.track);
            }

            if (event.track.kind === 'video') {
              const vidStream = new MediaStream([event.track]);
              remoteVideoStreamRef.current = vidStream;
              if (remoteVideoRef.current) {
                remoteVideoRef.current.srcObject = vidStream;
                // Keep remoteVideoRef strictly muted so mobile browsers never block video decoding!
                remoteVideoRef.current.muted = true;
                remoteVideoRef.current.play().catch(() => {});
              }
            } else if (event.track.kind === 'audio') {
              const audStream = new MediaStream([event.track]);
              remoteAudioStreamRef.current = audStream;
              if (remoteAudioRef.current) {
                remoteAudioRef.current.srcObject = audStream;
                remoteAudioRef.current.muted = false;
                remoteAudioRef.current.volume = 1.0;
                remoteAudioRef.current
                  .play()
                  .then(() => {
                    soundEngine.attachRemoteWebRtcAudioBackup(audStream, true);
                  })
                  .catch(() => {
                    soundEngine.attachRemoteWebRtcAudioBackup(audStream, false);
                  });
              } else {
                soundEngine.attachRemoteWebRtcAudioBackup(audStream, false);
              }
            }
          };

          if (stream && pc.signalingState !== 'closed') {
            const existingTrackIds = new Set(
              pc
                .getSenders()
                .map((s) => s.track?.id)
                .filter(Boolean)
            );
            stream.getTracks().forEach((track) => {
              if (!existingTrackIds.has(track.id)) {
                pc.addTrack(track, stream);
              }
            });
          }

          const createAndSendBundledOffer = async () => {
            if (pcRef.current !== pc || pc.signalingState !== 'stable' || pc.remoteDescription) {
              return;
            }
            const offer = await pc.createOffer({
              offerToReceiveAudio: true,
              offerToReceiveVideo: true,
            });
            await pc.setLocalDescription(offer);
            // Gather fast host + Russian STUN ICE candidates (~80-220ms) and bundle them into webrtc:offer
            await waitForIceGatheringBrief(pc, 220);
            sdpSentRef.current = true;
            if (pcRef.current === pc && pc.localDescription) {
              sendWs({
                type: 'webrtc:offer',
                sdp: pc.localDescription,
                candidates: [...gatheredLocalCandidatesRef.current],
              });
            }
          };

          if (initiator && pc.signalingState === 'stable') {
            await createAndSendBundledOffer();

            // ONLY retry sending webrtc:offer if we are STILL waiting in 'have-local-offer' (no answer received yet!)
            webrtcOfferRetryTimerRef.current = window.setTimeout(() => {
              if (
                pcRef.current === pc &&
                pc.signalingState === 'have-local-offer' &&
                pc.localDescription
              ) {
                sendWs({
                  type: 'webrtc:offer',
                  sdp: pc.localDescription,
                  candidates: [...gatheredLocalCandidatesRef.current],
                });
                webrtcOfferRetryTimerRef.current = window.setTimeout(() => {
                  if (
                    pcRef.current === pc &&
                    pc.signalingState === 'have-local-offer' &&
                    pc.localDescription
                  ) {
                    sendWs({
                      type: 'webrtc:offer',
                      sdp: pc.localDescription,
                      candidates: [...gatheredLocalCandidatesRef.current],
                    });
                  }
                }, 1900);
              }
            }, 1300);
          } else if (!initiator) {
            // If callee hasn't received caller's offer within 1.8s (e.g., caller transitioned slightly later),
            // callee initiates a bundled offer (polite rollback in webrtc:offer handles any simultaneous glare).
            webrtcOfferRetryTimerRef.current = window.setTimeout(() => {
              if (
                pcRef.current === pc &&
                pc.signalingState === 'stable' &&
                !pc.remoteDescription &&
                !webrtcConnectedRef.current
              ) {
                createAndSendBundledOffer().catch(() => {});
              }
            }, 1800);
          }

          return pc;
        } catch {
          return null;
        }
      })();

      pcInitPromiseRef.current = initTask;
      return initTask;
    },
    [closePeerConnection, ensureLocalMedia, sendWs, unlockRemoteAudioElements]
  );

  // High-FPS, aspect-preserving video frame & voice audio fallback relay while connected
  useEffect(() => {
    if (callState !== 'connected') return;

    if (!captureCanvasRef.current) {
      const c = document.createElement('canvas');
      c.width = 480;
      c.height = 360;
      captureCanvasRef.current = c;
    }

    let lastAudioBytesRx = 0;
    let lastVideoBytesRx = 0;

    // Poll actual WebRTC RTP bytesReceived every 1s so we know with 100% certainty whether WebRTC media is flowing
    const statsTimer = window.setInterval(async () => {
      const pc = pcRef.current;
      if (!pc || pc.signalingState === 'closed') {
        webrtcAudioRxRef.current = false;
        webrtcVideoRxRef.current = false;
        return;
      }
      try {
        const stats = await pc.getStats();
        let curAudioBytes = 0;
        let curVideoBytes = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp') {
            const kind = report.kind || report.mediaType;
            if (kind === 'audio') {
              curAudioBytes += Number(report.bytesReceived) || 0;
            } else if (kind === 'video') {
              curVideoBytes += Number(report.bytesReceived) || 0;
            }
          }
        });
        const audioFlowing = curAudioBytes - lastAudioBytesRx > 400;
        const videoFlowing =
          curVideoBytes - lastVideoBytesRx > 1500 &&
          Boolean(remoteVideoRef.current && remoteVideoRef.current.videoWidth > 0);
        lastAudioBytesRx = curAudioBytes;
        lastVideoBytesRx = curVideoBytes;

        // Snapshot live WebRTC video to backup canvas once per second without triggering React re-renders
        const remVideo = remoteVideoRef.current;
        const remCanvas = remoteCanvasDisplayRef.current;
        if (videoFlowing && remVideo && remVideo.readyState >= 2 && remCanvas) {
          if (
            remCanvas.width !== remVideo.videoWidth ||
            remCanvas.height !== remVideo.videoHeight
          ) {
            remCanvas.width = remVideo.videoWidth;
            remCanvas.height = remVideo.videoHeight;
          }
          const rCtx = remCanvas.getContext('2d');
          if (rCtx) {
            rCtx.drawImage(remVideo, 0, 0, remCanvas.width, remCanvas.height);
          }
        }

        const changed =
          webrtcAudioRxRef.current !== audioFlowing || webrtcVideoRxRef.current !== videoFlowing;
        webrtcAudioRxRef.current = audioFlowing;
        webrtcVideoRxRef.current = videoFlowing;

        if (changed) {
          sendWs({
            type: 'media:state',
            micEnabled: micEnabledRef.current,
            camEnabled: camEnabledRef.current,
            webrtcAudioRx: audioFlowing,
            webrtcVideoRx: videoFlowing,
          });
        }
      } catch {
        // Ignore stats error
      }
    }, 1000);

    const sendFrameNow = () => {
      const isServerless = wsRef.current?.mode === 'serverless';
      const now = Date.now();
      const minInterval = peerWebrtcVideoRxRef.current
        ? 2500
        : isServerless
          ? 210
          : 110;
      if (now - lastFallbackFrameSentAt < minInterval) {
        return;
      }
      lastFallbackFrameSentAt = now;

      const capCanvas = captureCanvasRef.current;
      if (!capCanvas) return;
      const ctx = capCanvas.getContext('2d');
      if (!ctx) return;

      const maxDim = isServerless ? 184 : 380;
      const videoEl = localVideoRef.current;
      if (camEnabledRef.current && videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        const vw = videoEl.videoWidth || 480;
        const vh = videoEl.videoHeight || 360;
        const scale = Math.min(1, maxDim / Math.max(vw, vh));
        const targetW = Math.max(112, Math.round(vw * scale));
        const targetH = Math.max(84, Math.round(vh * scale));
        if (capCanvas.width !== targetW || capCanvas.height !== targetH) {
          capCanvas.width = targetW;
          capCanvas.height = targetH;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'medium';
        ctx.drawImage(videoEl, 0, 0, targetW, targetH);
      } else {
        capCanvas.width = 240;
        capCanvas.height = 180;
        ctx.fillStyle = '#101216';
        ctx.fillRect(0, 0, 240, 180);
        ctx.fillStyle = '#d5d8de';
        ctx.font = '700 18px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`PIN #${myPinRef.current || '---'}`, 120, 84);
        ctx.fillStyle = '#7c828d';
        ctx.font = '600 12px "JetBrains Mono", monospace';
        ctx.fillText(camEnabledRef.current ? 'AUDIO ACTIVE' : 'CAMERA OFF', 120, 112);
      }

      try {
        const dataUrl = capCanvas.toDataURL('image/jpeg', isServerless ? 0.44 : 0.68);
        sendWs({
          type: 'media:frame',
          frame: dataUrl,
          micEnabled: micEnabledRef.current,
          camEnabled: camEnabledRef.current,
        });
      } catch {
        // Ignore
      }
    };

    let lastFallbackFrameSentAt = 0;

    sendWs({
      type: 'media:state',
      micEnabled: micEnabledRef.current,
      camEnabled: camEnabledRef.current,
    });

    sendFrameNow();
    const timer = window.setInterval(sendFrameNow, 105);

    let audioCtx: AudioContext | null = null;
    let workletNode: AudioWorkletNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;
    let silentGain: GainNode | null = null;
    let workletUrl: string | null = null;
    let cancelled = false;

    const setupFallbackAudioCapture = async () => {
      try {
        let stream = localStreamRef.current;
        if (!stream || stream.getAudioTracks().length === 0) {
          stream = await ensureLocalMedia();
        }
        if (cancelled || !stream) return;
        const audioTracks = stream.getAudioTracks();
        if (audioTracks.length === 0) return;

        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!AudioCtx) return;

        audioCtx = new AudioCtx();
        if (audioCtx.state === 'suspended') {
          audioCtx.resume().catch(() => {});
        }
        const inRate = audioCtx.sampleRate || 48000;
        const targetRate = 10000;
        const step = Math.max(1, inRate / targetRate);
        const outRate = Math.round(inRate / step);

        sourceNode = audioCtx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
        silentGain = audioCtx.createGain();
        silentGain.gain.value = 0;
        silentGain.connect(audioCtx.destination);

        let accum: number[] = [];
        const CHUNK_SAMPLES = 1800; // 180ms at 10kHz -> ~2.4 KB Base64 PCM8 packet

        const pushInputSamples = (input: Float32Array) => {
          if (!micEnabledRef.current || peerWebrtcAudioRxRef.current) {
            accum = [];
            return;
          }
          const span = Math.max(1, Math.floor(step));
          for (let i = 0; i < input.length; i += step) {
            const startIdx = Math.min(input.length - 1, Math.floor(i));
            const endIdx = Math.min(input.length, startIdx + span);
            let sum = 0;
            for (let k = startIdx; k < endIdx; k++) {
              sum += input[k];
            }
            accum.push(sum / Math.max(1, endIdx - startIdx));
          }
          while (accum.length >= CHUNK_SAMPLES) {
            const slice = accum.splice(0, CHUNK_SAMPLES);
            let peak = 0;
            for (let j = 0; j < slice.length; j += 4) {
              const a = Math.abs(slice[j]);
              if (a > peak) peak = a;
            }
            if (peak >= 0.0035) {
              sendWs({
                type: 'media:audio',
                pcm8: encodePcm8Base64(slice),
                rate: outRate,
              });
            }
          }
        };

        if (audioCtx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
          const workletCode = `
            class IntercomMicProcessor extends AudioWorkletProcessor {
              process(inputs) {
                const input = inputs[0];
                if (input && input[0] && input[0].length > 0) {
                  this.port.postMessage(input[0]);
                }
                return true;
              }
            }
            registerProcessor('intercom-mic-processor', IntercomMicProcessor);
          `;
          const blob = new Blob([workletCode], { type: 'application/javascript' });
          workletUrl = URL.createObjectURL(blob);
          await audioCtx.audioWorklet.addModule(workletUrl);
          if (cancelled) return;
          workletNode = new AudioWorkletNode(audioCtx, 'intercom-mic-processor');
          workletNode.port.onmessage = (ev) => {
            if (ev.data instanceof Float32Array) {
              pushInputSamples(ev.data);
            }
          };
          sourceNode.connect(workletNode);
          workletNode.connect(silentGain);
        }
      } catch {
        // Ignore fallback audio errors
      }
    };

    setupFallbackAudioCapture();

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.clearInterval(statsTimer);
      try {
        workletNode?.disconnect();
        sourceNode?.disconnect();
        silentGain?.disconnect();
        audioCtx?.close();
        if (workletUrl) {
          URL.revokeObjectURL(workletUrl);
        }
      } catch {
        // Ignore
      }
    };
  }, [callState, ensureLocalMedia, sendWs]);

  // Connect to WebSocket server with unthrottled background heartbeat & instant tab/browser wakeup recovery
  useEffect(() => {
    let reconnectTimer: number | null = null;
    let isUnmounted = false;
    let isConnecting = false;
    let connectStartedAt = 0;
    let lastServerTrafficAt = Date.now();
    const clientId = getOrCreateSessionClientId();

    // Maintain active-tab lease in localStorage so simultaneous tabs don't collide, while closing & reopening reclaims session
    const updateLease = () => {
      try {
        localStorage.setItem(`intercom_active_lease_${clientId}`, String(Date.now()));
      } catch {
        // Ignore
      }
    };
    const releaseLease = () => {
      try {
        localStorage.removeItem(`intercom_active_lease_${clientId}`);
      } catch {
        // Ignore
      }
    };
    updateLease();
    const leaseTimer = window.setInterval(updateLease, 1800);
    window.addEventListener('pagehide', releaseLease);
    window.addEventListener('beforeunload', releaseLease);

    const scheduleReconnect = (delayMs = 1000) => {
      if (isUnmounted) return;
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
      }
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delayMs);
    };

    const connect = () => {
      if (isUnmounted || isConnecting) return;
      const currentWs = wsRef.current;
      if (currentWs && currentWs.readyState === 1) return;

      isConnecting = true;
      connectStartedAt = Date.now();
      if (reconnectTimer !== null) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      if (currentWs) {
        try {
          currentWs.onclose = null;
          currentWs.onmessage = null;
          currentWs.onopen = null;
          currentWs.close();
        } catch {
          // Ignore
        }
      }

      const ws = createIntercomTransport();
      wsRef.current = ws;

      ws.onopen = () => {
        isConnecting = false;
        lastServerTrafficAt = Date.now();
        const savedPin = getSavedPreferredPin(clientId) || myPinRef.current || '';
        ws.send(
          JSON.stringify({
            type: 'init',
            clientId,
            preferredPin: savedPin,
          })
        );
      };

      ws.onmessage = async (event) => {
        lastServerTrafficAt = Date.now();
        let msg: Record<string, any>;
        try {
          msg = JSON.parse(String(event.data));
        } catch {
          return;
        }

        switch (msg.type) {
          case 'pong':
          case 'server:heartbeat': {
            break;
          }

          case 'init:ack': {
            const assigned = String(msg.pin || '');
            setMyPin(assigned);
            savePreferredPin(clientId, assigned);
            break;
          }

          case 'presence:update': {
            setOnlineCount(Number(msg.onlineCount) || 1);
            setRouletteCount(Number(msg.rouletteCount) || 0);
            if (Array.isArray(msg.onlinePins)) {
              setOnlinePeers(msg.onlinePins);
            }
            break;
          }

          case 'pin:result': {
            if (msg.ok && msg.pin) {
              const newPin = String(msg.pin);
              setMyPin(newPin);
              setPinServerError(null);
              savePreferredPin(clientId, newPin);
            } else {
              setPinServerError(String(msg.error || 'Не удалось сменить номер'));
            }
            break;
          }

          case 'call:outgoing': {
            clearAutoDialTimers();
            const target = String(msg.targetPin || '');
            setPeerPin(target);
            setCallState('outgoing');
            soundEngine.startRingLoop(brandRef.current);
            ensureLocalMedia();
            break;
          }

          case 'call:incoming': {
            clearAutoDialTimers();
            const from = String(msg.fromPin || '');
            setPeerPin(from);
            setCallState('incoming');
            soundEngine.startRingLoop(brandRef.current);
            ensureLocalMedia();
            break;
          }

          case 'call:connected': {
            clearAutoDialTimers();
            soundEngine.stopRingLoop();
            const isResumed = Boolean(msg.resumed);
            if (!isResumed) {
              resetCallChat();
              soundEngine.playConnectedChime();
            } else {
              if (Array.isArray(msg.messages)) {
                const restored: ChatMessage[] = msg.messages
                  .map((m: Record<string, any>) => {
                    const clean = sanitizeChatMessage(m.text);
                    if (!clean) return null;
                    const senderPin = String(m.fromPin || '---');
                    return {
                      id: String(m.id || `m_${Date.now()}`),
                      senderPin,
                      text: clean,
                      timestamp: Number(m.timestamp) || Date.now(),
                      isSelf: senderPin === myPinRef.current,
                    };
                  })
                  .filter(Boolean) as ChatMessage[];
                setChatMessages(restored);
              }
              if (msg.peerMediaState && typeof msg.peerMediaState === 'object') {
                if (typeof msg.peerMediaState.cam === 'boolean') {
                  setPeerCamEnabled(msg.peerMediaState.cam);
                }
                if (typeof msg.peerMediaState.mic === 'boolean') {
                  setPeerMicEnabled(msg.peerMediaState.mic);
                }
              }
              const cachedFrame =
                typeof msg.lastPeerFrame === 'string' && msg.lastPeerFrame
                  ? msg.lastPeerFrame
                  : (() => {
                      try {
                        return sessionStorage.getItem('intercom_last_peer_frame') || '';
                      } catch {
                        return '';
                      }
                    })();
              if (cachedFrame) {
                drawFrameToRemoteCanvas(cachedFrame);
              }
            }
            if (msg.mode === 'roulette' || msg.mode === 'code') {
              setMode(msg.mode);
              modeRef.current = msg.mode;
            }
            unlockRemoteAudioElements();
            const peer = String(msg.peerPin || '');
            setPeerPin(peer);
            setCallState('connected');
            await startWebRtcSession(Boolean(msg.initiator));
            break;
          }

          case 'call:peer_paused': {
            closePeerConnection();
            break;
          }

          case 'call:peer_resumed': {
            const peer = String(msg.peerPin || '');
            if (peer) setPeerPin(peer);
            setCallState('connected');
            unlockRemoteAudioElements();
            await startWebRtcSession(Boolean(msg.initiator));
            sendWs({
              type: 'media:state',
              micEnabled: micEnabledRef.current,
              camEnabled: camEnabledRef.current,
            });
            break;
          }

          case 'roulette:searching': {
            clearAutoDialTimers();
            resetCallChat();
            soundEngine.stopRingLoop();
            closePeerConnection();
            setPeerPin(null);
            setAutoDialBuffer('');
            setMode('roulette');
            setCallState('searching');
            ensureLocalMedia();
            break;
          }

          case 'roulette:matched': {
            clearAutoDialTimers();
            resetCallChat();
            soundEngine.stopRingLoop();
            const matchedPin = String(msg.peerPin || '');
            const initiator = Boolean(msg.initiator);
            setMode('roulette');
            setPeerPin(matchedPin);
            setAutoDialBuffer('');
            setCallState('autodialing');

            // Start WebRTC negotiation in the background immediately while the keypad digits animate!
            unlockRemoteAudioElements();
            startWebRtcSession(initiator);

            const digits = matchedPin.split('');
            digits.forEach((digit, idx) => {
              const t = window.setTimeout(() => {
                soundEngine.playKeyBeep(brandRef.current);
                setPressedKeyTrigger({ key: digit, seq: Date.now() + idx });
                setAutoDialBuffer(matchedPin.slice(0, idx + 1));
              }, (idx + 1) * 210);
              autoDialTimeoutsRef.current.push(t);
            });

            const callPressTime = (digits.length + 1) * 210 + 80;
            const tCall = window.setTimeout(() => {
              setPressedKeyTrigger({ key: 'B', seq: Date.now() + 99 });
              soundEngine.playCallBurst(brandRef.current);
            }, callPressTime);
            autoDialTimeoutsRef.current.push(tCall);

            const connectTime = callPressTime + 480;
            const tConn = window.setTimeout(async () => {
              soundEngine.playConnectedChime();
              unlockRemoteAudioElements();
              setCallState('connected');
              await startWebRtcSession(initiator);
            }, connectTime);
            autoDialTimeoutsRef.current.push(tConn);
            break;
          }

          case 'roulette:stopped': {
            clearAutoDialTimers();
            resetCallChat();
            soundEngine.stopRingLoop();
            closePeerConnection();
            setCallState('idle');
            setPeerPin(null);
            setAutoDialBuffer('');
            break;
          }

          case 'call:status': {
            clearAutoDialTimers();
            resetCallChat();
            soundEngine.stopRingLoop();
            soundEngine.playErrorTone();
            const st = msg.status === 'busy' ? 'busy' : 'not_found';
            setCurrentInput('');
            setAutoDialBuffer('');
            setPeerPin(null);
            setCallState(st);
            const tReset = window.setTimeout(() => {
              setCallState((prev) => (prev === st ? 'idle' : prev));
            }, 2200);
            autoDialTimeoutsRef.current.push(tReset);
            break;
          }

          case 'call:ended': {
            clearAutoDialTimers();
            resetCallChat();
            soundEngine.stopRingLoop();
            soundEngine.playErrorTone();
            closePeerConnection();
            setPeerPin(null);
            setAutoDialBuffer('');
            setCurrentInput('');
            setCallState('ended');
            try {
              sessionStorage.removeItem('intercom_last_peer_frame');
            } catch {
              // Ignore
            }
            const tReset = window.setTimeout(() => {
              setCallState((prev) => (prev === 'ended' ? 'idle' : prev));
            }, 1700);
            autoDialTimeoutsRef.current.push(tReset);
            break;
          }

          case 'webrtc:offer': {
            try {
              if (webrtcOfferRetryTimerRef.current !== null) {
                window.clearTimeout(webrtcOfferRetryTimerRef.current);
                webrtcOfferRetryTimerRef.current = null;
              }
              if (Array.isArray(msg.candidates)) {
                for (const c of msg.candidates) {
                  if (c && typeof c.candidate === 'string') {
                    pendingIceCandidatesRef.current.push(c);
                  }
                }
              }
              let pc = pcRef.current;
              if (!pc || pc.signalingState === 'closed' || pcInitPromiseRef.current) {
                pc = await startWebRtcSession(false);
              }
              if (pc && msg.sdp) {
                // If we already accepted this exact SDP offer and are in 'stable' state, just re-send our existing answer!
                if (
                  pc.signalingState === 'stable' &&
                  pc.remoteDescription &&
                  pc.remoteDescription.sdp === msg.sdp.sdp &&
                  pc.localDescription
                ) {
                  await flushPendingIceCandidates(pc);
                  sendWs({
                    type: 'webrtc:answer',
                    sdp: pc.localDescription,
                    candidates: [...gatheredLocalCandidatesRef.current],
                  });
                  break;
                }

                if (pc.signalingState === 'have-local-offer') {
                  await pc.setLocalDescription({ type: 'rollback' } as RTCSessionDescriptionInit);
                }
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                await flushPendingIceCandidates(pc);
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                // Gather fast host + Russian STUN ICE candidates (~80-220ms) and bundle them into webrtc:answer
                await waitForIceGatheringBrief(pc, 220);
                sdpSentRef.current = true;
                if (pcRef.current === pc && pc.localDescription) {
                  sendWs({
                    type: 'webrtc:answer',
                    sdp: pc.localDescription,
                    candidates: [...gatheredLocalCandidatesRef.current],
                  });
                }
              }
            } catch {
              // Ignore
            }
            break;
          }

          case 'webrtc:answer': {
            try {
              if (webrtcOfferRetryTimerRef.current !== null) {
                window.clearTimeout(webrtcOfferRetryTimerRef.current);
                webrtcOfferRetryTimerRef.current = null;
              }
              if (Array.isArray(msg.candidates)) {
                for (const c of msg.candidates) {
                  if (c && typeof c.candidate === 'string') {
                    pendingIceCandidatesRef.current.push(c);
                  }
                }
              }
              const pc = pcRef.current;
              if (pc && msg.sdp) {
                if (
                  pc.signalingState === 'have-local-offer' ||
                  pc.signalingState === 'have-remote-pranswer'
                ) {
                  await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                }
                await flushPendingIceCandidates(pc);
              }
            } catch {
              // Ignore
            }
            break;
          }

          case 'webrtc:ice': {
            try {
              if (!msg.candidate) break;
              const pc = pcRef.current;
              if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
                pendingIceCandidatesRef.current.push(msg.candidate);
              } else {
                await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
              }
            } catch {
              // Ignore
            }
            break;
          }

          case 'media:state': {
            if (typeof msg.micEnabled === 'boolean') {
              setPeerMicEnabled(msg.micEnabled);
            }
            if (typeof msg.camEnabled === 'boolean') {
              setPeerCamEnabled(msg.camEnabled);
            }
            if (typeof msg.webrtcAudioRx === 'boolean') {
              peerWebrtcAudioRxRef.current = msg.webrtcAudioRx;
            }
            if (typeof msg.webrtcVideoRx === 'boolean') {
              peerWebrtcVideoRxRef.current = msg.webrtcVideoRx;
            }
            break;
          }

          case 'media:frame': {
            if (typeof msg.micEnabled === 'boolean') {
              setPeerMicEnabled(msg.micEnabled);
            }
            if (typeof msg.camEnabled === 'boolean') {
              setPeerCamEnabled(msg.camEnabled);
            }
            if (typeof msg.frame === 'string' && !webrtcVideoRxRef.current) {
              drawFrameToRemoteCanvas(msg.frame);
            }
            break;
          }

          case 'media:audio': {
            if (!webrtcAudioRxRef.current) {
              if (typeof msg.pcm8 === 'string' && msg.pcm8) {
                soundEngine.playPcm8Base64Chunk(msg.pcm8, Number(msg.rate) || 8000);
              } else if (Array.isArray(msg.samples)) {
                soundEngine.playPcmFloat32Chunk(msg.samples, Number(msg.rate) || 12000);
              }
            }
            break;
          }

          case 'chat:msg': {
            const cleanText = sanitizeChatMessage(msg.text);
            if (!cleanText) break;
            const incomingMsg: ChatMessage = {
              id: String(msg.id || `in_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`),
              senderPin: String(msg.fromPin || '---'),
              text: cleanText,
              timestamp: Number(msg.timestamp) || Date.now(),
              isSelf: false,
            };
            setChatMessages((prev) => {
              if (prev.some((m) => m.id === incomingMsg.id)) return prev;
              return [...prev.slice(-79), incomingMsg];
            });
            soundEngine.playKeyBeep(brandRef.current);

            if (!isChatOpenRef.current) {
              setUnreadChatCount((c) => c + 1);
              setToastChatMsg(incomingMsg);
              if (toastTimeoutRef.current) {
                window.clearTimeout(toastTimeoutRef.current);
              }
              toastTimeoutRef.current = window.setTimeout(() => {
                setToastChatMsg(null);
                toastTimeoutRef.current = null;
              }, 4200);
            }
            break;
          }
        }
      };

      ws.onclose = () => {
        isConnecting = false;
        if (!isUnmounted) {
          scheduleReconnect(900);
        }
      };
    };

    const sendHeartbeatAndCheckHealth = () => {
      if (isUnmounted) return;
      updateLease();
      const ws = wsRef.current;
      if (!ws) {
        connect();
        return;
      }
      if (ws.readyState === 0) {
        if (Date.now() - connectStartedAt > 6500) {
          isConnecting = false;
          connect();
        }
        return;
      }
      if (ws.readyState !== 1) {
        isConnecting = false;
        connect();
        return;
      }
      if (Date.now() - lastServerTrafficAt > 32000) {
        try {
          ws.close();
        } catch {
          // Ignore
        }
        isConnecting = false;
        connect();
        return;
      }
      try {
        ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
      } catch {
        isConnecting = false;
        connect();
      }
    };

    let heartbeatWorker: Worker | null = null;
    let workerUrl: string | null = null;
    try {
      const blob = new Blob(
        ['setInterval(function(){ postMessage("tick"); }, 10000);'],
        { type: 'application/javascript' }
      );
      workerUrl = URL.createObjectURL(blob);
      heartbeatWorker = new Worker(workerUrl);
      heartbeatWorker.onmessage = () => {
        sendHeartbeatAndCheckHealth();
      };
    } catch {
      // Fallback interval handles environments without blob workers
    }
    const fallbackHeartbeatInterval = window.setInterval(sendHeartbeatAndCheckHealth, 12000);

    const handleWakeUp = () => {
      if (isUnmounted) return;
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      updateLease();
      const ws = wsRef.current;
      if (!ws) {
        isConnecting = false;
        connect();
      } else if (ws.readyState === 0) {
        if (Date.now() - connectStartedAt > 6500) {
          isConnecting = false;
          connect();
        }
      } else if (ws.readyState !== 1) {
        isConnecting = false;
        connect();
      } else {
        try {
          ws.send(JSON.stringify({ type: 'ping', ts: Date.now() }));
        } catch {
          isConnecting = false;
          connect();
        }
      }
      if (callStateRef.current === 'connected') {
        ensureLocalMedia();
        unlockRemoteAudioElements();
      }
    };

    document.addEventListener('visibilitychange', handleWakeUp);
    window.addEventListener('focus', handleWakeUp);
    window.addEventListener('pageshow', handleWakeUp);
    window.addEventListener('online', handleWakeUp);

    connect();
    ensureLocalMedia();

    return () => {
      isUnmounted = true;
      releaseLease();
      window.clearInterval(leaseTimer);
      window.clearInterval(fallbackHeartbeatInterval);
      if (heartbeatWorker) {
        heartbeatWorker.terminate();
      }
      if (workerUrl) {
        URL.revokeObjectURL(workerUrl);
      }
      window.removeEventListener('pagehide', releaseLease);
      window.removeEventListener('beforeunload', releaseLease);
      document.removeEventListener('visibilitychange', handleWakeUp);
      window.removeEventListener('focus', handleWakeUp);
      window.removeEventListener('pageshow', handleWakeUp);
      window.removeEventListener('online', handleWakeUp);
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      clearAutoDialTimers();
      soundEngine.stopRingLoop();
      closePeerConnection();
      wsRef.current?.close();
    };
  }, [
    clearAutoDialTimers,
    closePeerConnection,
    drawFrameToRemoteCanvas,
    ensureLocalMedia,
    flushPendingIceCandidates,
    resetCallChat,
    sendWs,
    startWebRtcSession,
    unlockRemoteAudioElements,
  ]);

  const handleStartRoulette = useCallback(() => {
    unlockRemoteAudioElements();
    ensureLocalMedia();
    setMode('roulette');
    modeRef.current = 'roulette';
    setCurrentInput('');
    sendWs({ type: 'roulette:start' });
  }, [ensureLocalMedia, sendWs, unlockRemoteAudioElements]);

  const handleNextRoulette = useCallback(() => {
    unlockRemoteAudioElements();
    ensureLocalMedia();
    soundEngine.playKeyBeep(brand);
    sendWs({ type: 'roulette:next' });
  }, [brand, ensureLocalMedia, sendWs, unlockRemoteAudioElements]);

  const handleStopRoulette = useCallback(() => {
    soundEngine.playKeyBeep(brand);
    soundEngine.stopRingLoop();
    clearAutoDialTimers();
    resetCallChat();
    closePeerConnection();
    sendWs({ type: 'roulette:stop' });
    setCallState('idle');
    setPeerPin(null);
  }, [brand, clearAutoDialTimers, closePeerConnection, resetCallChat, sendWs]);

  const handleAnswerCall = useCallback(() => {
    unlockRemoteAudioElements();
    ensureLocalMedia();
    soundEngine.playKeyBeep(brand);
    sendWs({ type: 'call:answer' });
  }, [brand, ensureLocalMedia, sendWs, unlockRemoteAudioElements]);

  const handleHangupCall = useCallback(() => {
    soundEngine.playKeyBeep(brand);
    soundEngine.stopRingLoop();
    clearAutoDialTimers();
    resetCallChat();
    closePeerConnection();
    if (modeRef.current === 'roulette') {
      sendWs({ type: 'roulette:stop' });
    } else {
      sendWs({ type: 'call:hangup' });
    }
    setCallState('ended');
    setPeerPin(null);
    setCurrentInput('');
    const tReset = window.setTimeout(() => {
      setCallState((prev) => (prev === 'ended' ? 'idle' : prev));
    }, 1700);
    autoDialTimeoutsRef.current.push(tReset);
  }, [brand, clearAutoDialTimers, closePeerConnection, resetCallChat, sendWs]);

  const handleToggleChat = useCallback(() => {
    soundEngine.playKeyBeep(brand);
    setIsChatOpen((prev) => {
      const next = !prev;
      if (next) {
        setUnreadChatCount(0);
        setToastChatMsg(null);
      }
      return next;
    });
  }, [brand]);

  const handleSendChatMessage = useCallback(
    (rawText: string) => {
      const cleaned = sanitizeChatMessage(rawText);
      if (!cleaned || callState !== 'connected') return;
      const msgObj: ChatMessage = {
        id: `m_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
        senderPin: myPin || '---',
        text: cleaned,
        timestamp: Date.now(),
        isSelf: true,
      };
      setChatMessages((prev) => [...prev.slice(-79), msgObj]);
      sendWs({
        type: 'chat:msg',
        id: msgObj.id,
        text: msgObj.text,
        timestamp: msgObj.timestamp,
      });
    },
    [callState, myPin, sendWs]
  );

  const handleIntercomKeyPress = useCallback(
    (label: string) => {
      unlockRemoteAudioElements();
      const action = resolveKeypadPress(
        {
          mode,
          callState,
          currentInput,
        },
        label
      );

      switch (action.type) {
        case 'INPUT_CHANGED':
          soundEngine.playKeyBeep(brand);
          if (action.input.length > 0 && mode === 'roulette' && callState === 'idle') {
            setMode('code');
            modeRef.current = 'code';
          }
          setCurrentInput(action.input);
          break;

        case 'DIAL_CODE':
          soundEngine.playKeyBeep(brand);
          ensureLocalMedia();
          sendWs({ type: 'call:dial', targetPin: action.targetPin });
          break;

        case 'ANSWER_CALL':
          handleAnswerCall();
          break;

        case 'HANGUP_CALL':
          handleHangupCall();
          break;

        case 'START_ROULETTE':
          soundEngine.playKeyBeep(brand);
          handleStartRoulette();
          break;

        case 'NEXT_ROULETTE':
          handleNextRoulette();
          break;

        case 'STOP_ROULETTE':
          handleStopRoulette();
          break;

        case 'NOOP':
        default:
          soundEngine.playKeyBeep(brand);
          break;
      }
    },
    [
      brand,
      callState,
      currentInput,
      ensureLocalMedia,
      handleAnswerCall,
      handleHangupCall,
      handleNextRoulette,
      handleStartRoulette,
      handleStopRoulette,
      mode,
      sendWs,
      unlockRemoteAudioElements,
    ]
  );

  // Keyboard support for dialing on 3D intercom
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) {
        if (e.key === 'Enter' && target.id === 'dial-pin-input' && currentInput) {
          e.preventDefault();
          setPressedKeyTrigger({ key: 'B', seq: Date.now() });
          handleIntercomKeyPress('B');
        }
        return;
      }

      if (/^\d$/.test(e.key)) {
        setPressedKeyTrigger({ key: e.key, seq: Date.now() });
        handleIntercomKeyPress(e.key);
      } else if (e.key === 'Enter' || e.key.toLowerCase() === 'b' || e.key.toLowerCase() === 'в') {
        setPressedKeyTrigger({ key: 'B', seq: Date.now() });
        handleIntercomKeyPress('B');
      } else if (
        e.key === 'Escape' ||
        e.key === 'Backspace' ||
        e.key.toLowerCase() === 'c' ||
        e.key.toLowerCase() === 'с'
      ) {
        if (e.key === 'Escape' && isFullscreenOpen) {
          setIsFullscreenOpen(false);
          return;
        }
        setPressedKeyTrigger({ key: 'C', seq: Date.now() });
        handleIntercomKeyPress('C');
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [currentInput, handleIntercomKeyPress, isFullscreenOpen]);

  const handleToggleMic = useCallback(() => {
    soundEngine.playKeyBeep(brand);
    setMicEnabled((prev) => {
      const next = !prev;
      micEnabledRef.current = next;
      if (localStreamRef.current) {
        localStreamRef.current.getAudioTracks().forEach((t) => {
          t.enabled = next;
        });
      }
      sendWs({
        type: 'media:state',
        micEnabled: next,
        camEnabled: camEnabledRef.current,
        webrtcAudioRx: webrtcAudioRxRef.current,
        webrtcVideoRx: webrtcVideoRxRef.current,
      });
      return next;
    });
  }, [brand, sendWs]);

  const handleToggleCam = useCallback(() => {
    soundEngine.playKeyBeep(brand);
    setCamEnabled((prev) => {
      const next = !prev;
      camEnabledRef.current = next;
      if (localStreamRef.current) {
        localStreamRef.current.getVideoTracks().forEach((t) => {
          t.enabled = next;
        });
      }
      sendWs({
        type: 'media:state',
        micEnabled: micEnabledRef.current,
        camEnabled: next,
        webrtcAudioRx: webrtcAudioRxRef.current,
        webrtcVideoRx: webrtcVideoRxRef.current,
      });
      return next;
    });
  }, [brand, sendWs]);

  const handleToggleSelfPreview = useCallback(() => {
    soundEngine.playKeyBeep(brand);
    setShowSelfPreview((prev) => !prev);
  }, [brand]);

  const handleSelectMode = useCallback(
    (newMode: ConnectionMode) => {
      if (newMode === mode) return;
      soundEngine.playKeyBeep(brand);
      setMode(newMode);
      modeRef.current = newMode;
      if (newMode === 'code') {
        if (callState === 'searching') {
          sendWs({ type: 'roulette:stop' });
          setCallState('idle');
        }
      } else {
        setCurrentInput('');
      }
    },
    [brand, callState, mode, sendWs]
  );

  const displayText = formatIntercomDisplay({
    callState,
    currentInput,
    peerPin,
    autoDialBuffer,
  });

  const shouldMirrorLocal = isHardwareCam && cameraFacingMode === 'user';

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-[#0b0c0e] text-[#e4e5e7]"
      data-call-state={callState}
      data-mode={mode}
    >
      {/* Offscreen media elements with real dimensions so mobile hardware video decoders never pause */}
      <div
        className="fixed -left-[9999px] top-0 w-40 h-30 opacity-0 pointer-events-none overflow-hidden"
        aria-hidden="true"
      >
        <video ref={localVideoRef} autoPlay muted playsInline width={160} height={120} />
        <video ref={remoteVideoRef} autoPlay muted playsInline width={160} height={120} />
        <audio ref={remoteAudioRef} autoPlay playsInline />
        <canvas ref={remoteCanvasDisplayRef} width={480} height={360} />
      </div>

      {/* Top 3-Zone Minimalist Header */}
      <TopBar
        brand={brand}
        onSelectBrand={(b) => {
          setBrand(b);
          soundEngine.playKeyBeep(b);
        }}
        myPin={myPin}
        onlineCount={onlineCount}
        onOpenPinModal={() => {
          soundEngine.playKeyBeep(brand);
          setPinServerError(null);
          setIsPinModalOpen(true);
        }}
        onOpenHelpModal={() => {
          soundEngine.playKeyBeep(brand);
          setIsHelpModalOpen(true);
        }}
        onCopyLink={() => {
          soundEngine.playKeyBeep(brand);
        }}
      />

      {/* Fullscreen 3D Intercom Viewport */}
      <main className="w-full h-full pt-11">
        <IntercomScene3D
          brand={brand}
          displayText={displayText}
          pressedKeyTrigger={pressedKeyTrigger}
          onKeyPress={handleIntercomKeyPress}
          remoteVideoCanvasRef={remoteCanvasDisplayRef}
          localVideoElementRef={localVideoRef}
          remoteVideoElementRef={remoteVideoRef}
          remoteFrameSeq={remoteFrameSeq}
          isCallConnected={callState === 'connected'}
          peerPin={peerPin}
          myPin={myPin}
          camEnabled={camEnabled}
          micEnabled={micEnabled}
          peerMicEnabled={peerMicEnabled}
          peerCamEnabled={peerCamEnabled}
          mirrorLocalVideo={shouldMirrorLocal}
          showSelfPreview={showSelfPreview}
          onToggleSelfPreview={handleToggleSelfPreview}
          remoteRotation={remoteRotation}
          baselinePeerIsPortrait={baselinePeerIsPortrait}
          onRotateRemoteVideo={handleRotateRemoteVideo}
          isNightMode={isNightMode}
        />
      </main>

      {/* Compact Bottom Control Bar */}
      <ControlDock
        mode={mode}
        onSelectMode={handleSelectMode}
        callState={callState}
        currentInput={currentInput}
        autoDialBuffer={autoDialBuffer}
        myPin={myPin}
        peerPin={peerPin}
        micEnabled={micEnabled}
        camEnabled={camEnabled}
        showSelfPreview={showSelfPreview}
        cameraFacingMode={cameraFacingMode}
        remoteRotation={remoteRotation}
        isChatOpen={isChatOpen}
        unreadChatCount={unreadChatCount}
        onToggleChat={handleToggleChat}
        onToggleMic={handleToggleMic}
        onToggleCam={handleToggleCam}
        onSwitchCamera={handleSwitchCamera}
        onToggleSelfPreview={handleToggleSelfPreview}
        onRotateRemoteVideo={handleRotateRemoteVideo}
        onKeyPress={(key) => {
          setPressedKeyTrigger({ key, seq: Date.now() });
          handleIntercomKeyPress(key);
        }}
        onDirectInputChange={(val) => {
          soundEngine.playKeyBeep(brand);
          setCurrentInput(val);
        }}
        onStartRoulette={() => {
          setPressedKeyTrigger({ key: 'B', seq: Date.now() });
          handleStartRoulette();
        }}
        onNextRoulette={() => {
          setPressedKeyTrigger({ key: 'B', seq: Date.now() });
          handleNextRoulette();
        }}
        onStopRoulette={() => {
          setPressedKeyTrigger({ key: 'C', seq: Date.now() });
          handleStopRoulette();
        }}
        onAnswerCall={() => {
          setPressedKeyTrigger({ key: 'B', seq: Date.now() });
          handleAnswerCall();
        }}
        onHangupCall={() => {
          setPressedKeyTrigger({ key: 'C', seq: Date.now() });
          handleHangupCall();
        }}
        onOpenPinModal={() => {
          soundEngine.playKeyBeep(brand);
          setPinServerError(null);
          setIsPinModalOpen(true);
        }}
        onOpenHelpModal={() => {
          soundEngine.playKeyBeep(brand);
          setIsHelpModalOpen(true);
        }}
        onOpenFullscreen={() => {
          unlockRemoteAudioElements();
          soundEngine.playKeyBeep(brand);
          setIsFullscreenOpen(true);
        }}
      />

      {/* Minimalist In-Call Messaging Drawer & Floating Toast */}
      <InCallChat
        isConnected={callState === 'connected'}
        isOpen={isChatOpen}
        onOpen={() => {
          setIsChatOpen(true);
          setUnreadChatCount(0);
          setToastChatMsg(null);
        }}
        onClose={() => setIsChatOpen(false)}
        peerPin={peerPin}
        messages={chatMessages}
        toastMessage={toastChatMsg}
        onDismissToast={() => setToastChatMsg(null)}
        onSendMessage={handleSendChatMessage}
        isFullscreen={isFullscreenOpen}
      />

      {/* True Full-Viewport Unclipped Video Monitor */}
      <FullscreenMonitor
        isOpen={isFullscreenOpen}
        onClose={() => {
          soundEngine.playKeyBeep(brand);
          setIsFullscreenOpen(false);
        }}
        mode={mode}
        callState={callState}
        myPin={myPin}
        peerPin={peerPin}
        micEnabled={micEnabled}
        camEnabled={camEnabled}
        peerMicEnabled={peerMicEnabled}
        peerCamEnabled={peerCamEnabled}
        showSelfPreview={showSelfPreview}
        onToggleSelfPreview={handleToggleSelfPreview}
        mirrorLocalVideo={shouldMirrorLocal}
        cameraFacingMode={cameraFacingMode}
        remoteRotation={remoteRotation}
        baselinePeerIsPortrait={baselinePeerIsPortrait}
        isChatOpen={isChatOpen}
        unreadChatCount={unreadChatCount}
        onToggleChat={handleToggleChat}
        onToggleMic={handleToggleMic}
        onToggleCam={handleToggleCam}
        onSwitchCamera={handleSwitchCamera}
        onRotateRemoteVideo={handleRotateRemoteVideo}
        onStartRoulette={() => {
          setPressedKeyTrigger({ key: 'B', seq: Date.now() });
          handleStartRoulette();
        }}
        onNextRoulette={() => {
          setPressedKeyTrigger({ key: 'B', seq: Date.now() });
          handleNextRoulette();
        }}
        onAnswerCall={() => {
          setPressedKeyTrigger({ key: 'B', seq: Date.now() });
          handleAnswerCall();
        }}
        onHangupCall={() => {
          setPressedKeyTrigger({ key: 'C', seq: Date.now() });
          handleHangupCall();
        }}
        localVideoElementRef={localVideoRef}
        remoteVideoElementRef={remoteVideoRef}
        remoteFallbackCanvasRef={remoteCanvasDisplayRef}
        remoteFrameSeq={remoteFrameSeq}
      />

      {/* Personal PIN Code Configuration Modal */}
      <PinModal
        isOpen={isPinModalOpen}
        currentPin={myPin}
        takenPins={onlinePeers.map((p) => p.pin)}
        serverError={pinServerError}
        onClose={() => setIsPinModalOpen(false)}
        onClearServerError={() => setPinServerError(null)}
        onSavePin={(newPin) => {
          soundEngine.playKeyBeep(brand);
          setPinServerError(null);
          sendWs({ type: 'pin:change', newPin });
        }}
      />

      {/* Separate Help & Online Peers Modal (opened via Help icon) */}
      <HelpModal
        isOpen={isHelpModalOpen}
        onClose={() => setIsHelpModalOpen(false)}
        onlineCount={onlineCount}
        rouletteCount={rouletteCount}
        onlinePeers={onlinePeers}
        myPin={myPin}
        onSelectPinToDial={(pin) => {
          setMode('code');
          modeRef.current = 'code';
          setCurrentInput(pin);
          soundEngine.playKeyBeep(brand);
        }}
        isNightMode={isNightMode}
        onToggleNightMode={() => {
          soundEngine.playKeyBeep(brand);
          setIsNightMode((prev) => !prev);
        }}
      />
    </div>
  );
}
