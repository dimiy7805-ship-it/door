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
import { soundEngine } from './utils/soundEngine';
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
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    {
      urls: [
        'turn:openrelay.metered.ca:80',
        'turn:openrelay.metered.ca:443',
        'turn:openrelay.metered.ca:443?transport=tcp',
        'turns:openrelay.metered.ca:443?transport=tcp',
      ],
      username: 'openrelayproject',
      credential: 'openrelayproject',
    },
  ],
  iceCandidatePoolSize: 4,
};

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
  const localStreamRef = useRef<MediaStream | null>(null);
  const remoteStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const remoteCanvasDisplayRef = useRef<HTMLCanvasElement | null>(null);
  const captureCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const autoDialTimeoutsRef = useRef<number[]>([]);
  const toastTimeoutRef = useRef<number | null>(null);
  const webrtcConnectedRef = useRef<boolean>(false);
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
    if (remoteAudioRef.current) {
      remoteAudioRef.current.muted = false;
      remoteAudioRef.current.volume = 1.0;
      remoteAudioRef.current.play().catch(() => {});
    }
    if (remoteVideoRef.current) {
      remoteVideoRef.current.muted = false;
      remoteVideoRef.current.volume = 1.0;
      remoteVideoRef.current.play().catch(() => {});
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

      if (localStreamRef.current && !forceFacingMode) {
        if (localVideoRef.current && localVideoRef.current.srcObject !== localStreamRef.current) {
          localVideoRef.current.srcObject = localStreamRef.current;
          localVideoRef.current.play().catch(() => {});
        }
        return localStreamRef.current;
      }

      if (typeof navigator !== 'undefined' && navigator.webdriver) {
        return null;
      }

      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: targetFacing },
              width: { ideal: 640 },
              height: { ideal: 480 },
              frameRate: { ideal: 30, max: 30 },
            },
            audio: {
              echoCancellation: true,
              noiseSuppression: true,
              autoGainControl: true,
            },
          });

          stream.getAudioTracks().forEach((t) => {
            t.enabled = micEnabledRef.current;
          });
          stream.getVideoTracks().forEach((t) => {
            t.enabled = camEnabledRef.current;
          });

          if (localStreamRef.current && forceFacingMode) {
            localStreamRef.current.getTracks().forEach((t) => t.stop());
          }

          localStreamRef.current = stream;
          setIsHardwareCam(true);
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = stream;
            localVideoRef.current.play().catch(() => {});
          }
          return stream;
        } catch {
          try {
            const audioOnlyStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
              video: false,
            });
            audioOnlyStream.getAudioTracks().forEach((t) => {
              t.enabled = micEnabledRef.current;
            });
            localStreamRef.current = audioOnlyStream;
          } catch {
            // Ignore
          }
        }
      }

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
          const canvasStream = fallbackCanvas.captureStream(24);
          if (localStreamRef.current) {
            const existingAudio = localStreamRef.current.getAudioTracks();
            existingAudio.forEach((at) => canvasStream.addTrack(at));
          }
          localStreamRef.current = canvasStream;
          if (localVideoRef.current) {
            localVideoRef.current.srcObject = canvasStream;
            localVideoRef.current.play().catch(() => {});
          }
          return canvasStream;
        }
      } catch {
        // Ignore
      }
      return localStreamRef.current;
    },
    []
  );

  const handleSwitchCamera = useCallback(async () => {
    const nextFacing: 'user' | 'environment' =
      cameraFacingMode === 'user' ? 'environment' : 'user';
    setCameraFacingMode(nextFacing);
    facingModeRef.current = nextFacing;
    soundEngine.playKeyBeep(brandRef.current);

    const newStream = await ensureLocalMedia(nextFacing);
    if (newStream && pcRef.current) {
      const newVideoTrack = newStream.getVideoTracks()[0];
      if (newVideoTrack) {
        const videoSender = pcRef.current
          .getSenders()
          .find((s) => s.track && s.track.kind === 'video');
        if (videoSender) {
          videoSender.replaceTrack(newVideoTrack).catch(() => {});
        }
      }
    }
  }, [cameraFacingMode, ensureLocalMedia]);

  const handleRotateRemoteVideo = useCallback(() => {
    soundEngine.playKeyBeep(brandRef.current);
    setRemoteRotation((prev) => {
      const next = cycleRemoteRotationMode(prev);
      if (next !== 'auto') {
        // Lock the current stream's portrait/landscape orientation as the baseline for manual rotation
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


  const closePeerConnection = useCallback(() => {
    webrtcConnectedRef.current = false;
    if (pcRef.current) {
      try {
        pcRef.current.onicecandidate = null;
        pcRef.current.ontrack = null;
        pcRef.current.onconnectionstatechange = null;
        pcRef.current.close();
      } catch {
        // Ignore
      }
      pcRef.current = null;
    }
    remoteStreamRef.current = null;
    if (remoteVideoRef.current) {
      remoteVideoRef.current.srcObject = null;
    }
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  }, []);

  const startWebRtcSession = useCallback(
    async (initiator: boolean) => {
      closePeerConnection();
      const stream = await ensureLocalMedia();

      try {
        const pc = new RTCPeerConnection(RTC_CONFIG);
        pcRef.current = pc;

        const combinedRemote = new MediaStream();
        remoteStreamRef.current = combinedRemote;

        if (stream) {
          stream.getTracks().forEach((track) => {
            pc.addTrack(track, stream);
          });
        }

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            sendWs({
              type: 'webrtc:ice',
              candidate: event.candidate,
            });
          }
        };

        pc.onconnectionstatechange = () => {
          webrtcConnectedRef.current =
            pc.connectionState === 'connected' || pc.iceConnectionState === 'connected';
        };

        pc.ontrack = (event) => {
          if (event.track && remoteStreamRef.current) {
            remoteStreamRef.current.addTrack(event.track);
          }
          const targetStream =
            event.streams && event.streams[0] ? event.streams[0] : remoteStreamRef.current;

          if (targetStream) {
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = targetStream;
              remoteVideoRef.current.muted = false;
              remoteVideoRef.current.volume = 1.0;
              remoteVideoRef.current.play().catch(() => {});
            }
            if (remoteAudioRef.current) {
              remoteAudioRef.current.srcObject = targetStream;
              remoteAudioRef.current.muted = false;
              remoteAudioRef.current.volume = 1.0;
              remoteAudioRef.current.play().catch(() => {});
            }
          }
        };

        if (initiator) {
          const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: true,
          });
          await pc.setLocalDescription(offer);
          sendWs({
            type: 'webrtc:offer',
            sdp: pc.localDescription,
          });
        }
      } catch {
        // Frame relay fallback handles video even if RTCPeerConnection fails
      }
    },
    [closePeerConnection, ensureLocalMedia, sendWs]
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

    const sendFrameNow = () => {
      const remVideo = remoteVideoRef.current;
      const remCanvas = remoteCanvasDisplayRef.current;

      if (remVideo && remVideo.readyState >= 2 && remVideo.videoWidth > 0 && remCanvas) {
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
          setRemoteFrameSeq((s) => s + 1);
        }
      }

      const isServerless = wsRef.current?.mode === 'serverless';
      const now = Date.now();
      if (isServerless) {
        const minInterval = webrtcConnectedRef.current ? 2500 : 280;
        if (now - lastFallbackFrameSentAt < minInterval) {
          return;
        }
      }
      lastFallbackFrameSentAt = now;

      const capCanvas = captureCanvasRef.current;
      if (!capCanvas) return;
      const ctx = capCanvas.getContext('2d');
      if (!ctx) return;

      const maxDim = isServerless ? 260 : 480;
      const videoEl = localVideoRef.current;
      if (camEnabledRef.current && videoEl && videoEl.readyState >= 2) {
        const vw = videoEl.videoWidth || 480;
        const vh = videoEl.videoHeight || 360;
        const scale = Math.min(1, maxDim / Math.max(vw, vh));
        const targetW = Math.max(140, Math.round(vw * scale));
        const targetH = Math.max(105, Math.round(vh * scale));
        if (capCanvas.width !== targetW || capCanvas.height !== targetH) {
          capCanvas.width = targetW;
          capCanvas.height = targetH;
        }
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(videoEl, 0, 0, targetW, targetH);
      } else {
        capCanvas.width = 320;
        capCanvas.height = 240;
        ctx.fillStyle = '#101216';
        ctx.fillRect(0, 0, 320, 240);
        ctx.fillStyle = '#d5d8de';
        ctx.font = '700 20px "JetBrains Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText(`PIN #${myPinRef.current || '---'}`, 160, 110);
        ctx.fillStyle = '#7c828d';
        ctx.font = '600 13px "JetBrains Mono", monospace';
        ctx.fillText(camEnabledRef.current ? 'AUDIO ACTIVE' : 'CAMERA OFF', 160, 140);
      }

      try {
        const dataUrl = capCanvas.toDataURL('image/jpeg', isServerless ? 0.52 : 0.72);
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
    const timer = window.setInterval(sendFrameNow, 95);

    let audioCtx: AudioContext | null = null;
    let processor: ScriptProcessorNode | null = null;
    let sourceNode: MediaStreamAudioSourceNode | null = null;

    try {
      const stream = localStreamRef.current;
      const audioTracks = stream ? stream.getAudioTracks() : [];
      if (audioTracks.length > 0) {
        const AudioCtx =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (AudioCtx) {
          audioCtx = new AudioCtx({ sampleRate: 16000 });
          sourceNode = audioCtx.createMediaStreamSource(new MediaStream([audioTracks[0]]));
          processor = audioCtx.createScriptProcessor(2048, 1, 1);
          processor.onaudioprocess = (e) => {
            if (!micEnabledRef.current || webrtcConnectedRef.current) return;
            const input = e.inputBuffer.getChannelData(0);
            let sum = 0;
            for (let i = 0; i < input.length; i += 4) {
              sum += Math.abs(input[i]);
            }
            if (sum / (input.length / 4) < 0.004) return;

            const quantized = new Array(input.length);
            for (let i = 0; i < input.length; i++) {
              quantized[i] = Math.round(input[i] * 1000) / 1000;
            }
            sendWs({
              type: 'media:audio',
              samples: quantized,
              rate: audioCtx?.sampleRate || 16000,
            });
          };
          sourceNode.connect(processor);
          processor.connect(audioCtx.destination);
        }
      }
    } catch {
      // Ignore fallback audio errors
    }

    return () => {
      window.clearInterval(timer);
      try {
        processor?.disconnect();
        sourceNode?.disconnect();
        audioCtx?.close();
      } catch {
        // Ignore
      }
    };
  }, [callState, sendWs]);

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
            // Partner temporarily closed browser, locked phone, or refreshed page:
            // Keep the call active and keep their last video frame frozen on screen!
            closePeerConnection();
            break;
          }

          case 'call:peer_resumed': {
            // Partner returned to the call! Re-establish WebRTC session and resume streaming without resetting chat or screen
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
              let pc = pcRef.current;
              if (!pc || pc.signalingState === 'closed') {
                await startWebRtcSession(false);
                pc = pcRef.current;
              }
              if (pc && msg.sdp) {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendWs({
                  type: 'webrtc:answer',
                  sdp: pc.localDescription,
                });
              }
            } catch {
              // Ignore
            }
            break;
          }

          case 'webrtc:answer': {
            try {
              const pc = pcRef.current;
              if (pc && msg.sdp && pc.signalingState !== 'stable') {
                await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
              }
            } catch {
              // Ignore
            }
            break;
          }

          case 'webrtc:ice': {
            try {
              const pc = pcRef.current;
              if (pc && msg.candidate) {
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
            break;
          }

          case 'media:frame': {
            if (typeof msg.micEnabled === 'boolean') {
              setPeerMicEnabled(msg.micEnabled);
            }
            if (typeof msg.camEnabled === 'boolean') {
              setPeerCamEnabled(msg.camEnabled);
            }
            if (typeof msg.frame === 'string') {
              drawFrameToRemoteCanvas(msg.frame);
            }
            break;
          }

          case 'media:audio': {
            if (!webrtcConnectedRef.current && Array.isArray(msg.samples)) {
              soundEngine.playPcmFloat32Chunk(msg.samples, Number(msg.rate) || 16000);
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
      // If socket claims to be open but we haven't received any server traffic for >32s, force a fresh connection
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

    // Unthrottled Web Worker timer so background tabs continue sending keepalive pings
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
    resetCallChat,
    sendWs,
    startWebRtcSession,
    unlockRemoteAudioElements,
  ]);

  const handleStartRoulette = useCallback(() => {
    unlockRemoteAudioElements();
    setMode('roulette');
    modeRef.current = 'roulette';
    setCurrentInput('');
    sendWs({ type: 'roulette:start' });
  }, [sendWs, unlockRemoteAudioElements]);

  const handleNextRoulette = useCallback(() => {
    unlockRemoteAudioElements();
    soundEngine.playKeyBeep(brand);
    sendWs({ type: 'roulette:next' });
  }, [brand, sendWs, unlockRemoteAudioElements]);

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
    soundEngine.playKeyBeep(brand);
    sendWs({ type: 'call:answer' });
  }, [brand, sendWs, unlockRemoteAudioElements]);

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
      {/* Hidden offscreen media elements feeding the 3D Intercom screen, Audio output & Fullscreen Monitor */}
      <div className="sr-only pointer-events-none" aria-hidden="true">
        <video ref={localVideoRef} autoPlay muted playsInline />
        <video ref={remoteVideoRef} autoPlay playsInline />
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
