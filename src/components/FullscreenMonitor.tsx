import React, { useEffect, useRef, useState } from 'react';
import {
  Mic,
  MicOff,
  Video,
  VideoOff,
  Minimize2,
  PhoneOff,
  SkipForward,
  PhoneCall,
  Shuffle,
  SwitchCamera,
  Move,
  RotateCw,
  MessageSquare,
  Eye,
  EyeOff,
  X,
} from 'lucide-react';
import {
  CallState,
  ConnectionMode,
  RemoteRotationMode,
  formatRotationLabel,
  resolveEffectiveRotation,
} from '../utils/intercomLogic';

interface FullscreenMonitorProps {
  isOpen: boolean;
  onClose: () => void;
  mode: ConnectionMode;
  callState: CallState;
  myPin: string;
  peerPin: string | null;
  micEnabled: boolean;
  camEnabled: boolean;
  peerMicEnabled?: boolean;
  peerCamEnabled?: boolean;
  showSelfPreview: boolean;
  onToggleSelfPreview: () => void;
  mirrorLocalVideo: boolean;
  cameraFacingMode: 'user' | 'environment';
  remoteRotation: RemoteRotationMode;
  baselinePeerIsPortrait?: boolean | null;
  isChatOpen: boolean;
  unreadChatCount: number;
  onToggleChat: () => void;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onSwitchCamera: () => void;
  onRotateRemoteVideo: () => void;
  onStartRoulette: () => void;
  onNextRoulette: () => void;
  onAnswerCall: () => void;
  onHangupCall: () => void;
  localVideoElementRef: React.RefObject<HTMLVideoElement | null>;
  remoteVideoElementRef: React.RefObject<HTMLVideoElement | null>;
  remoteFallbackCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  remoteFrameSeq: number;
}

export const FullscreenMonitor: React.FC<FullscreenMonitorProps> = ({
  isOpen,
  onClose,
  mode,
  callState,
  myPin,
  peerPin,
  micEnabled,
  camEnabled,
  peerMicEnabled = true,
  peerCamEnabled = true,
  showSelfPreview,
  onToggleSelfPreview,
  mirrorLocalVideo,
  cameraFacingMode,
  remoteRotation,
  baselinePeerIsPortrait = null,
  isChatOpen,
  unreadChatCount,
  onToggleChat,
  onToggleMic,
  onToggleCam,
  onSwitchCamera,
  onRotateRemoteVideo,
  onStartRoulette,
  onNextRoulette,
  onAnswerCall,
  onHangupCall,
  localVideoElementRef,
  remoteVideoElementRef,
  remoteFallbackCanvasRef,
  remoteFrameSeq,
}) => {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const fieldRef = useRef<HTMLDivElement | null>(null);
  const pipRef = useRef<HTMLDivElement | null>(null);
  const mainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pipCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Sub-pixel draggable PiP coordinates inside fieldRef (null = default top-right corner)
  const [pipPos, setPipPos] = useState<{ left: number; top: number } | null>(null);
  const [isDraggingPip, setIsDraggingPip] = useState(false);
  const dragStartRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
    curLeft: number;
    curTop: number;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    origLeft: 0,
    origTop: 0,
    curLeft: 0,
    curTop: 0,
  });

  const liveStateRef = useRef({
    callState,
    myPin,
    peerPin,
    camEnabled,
    peerCamEnabled,
    showSelfPreview,
    mirrorLocalVideo,
    remoteRotation,
    baselinePeerIsPortrait,
  });
  liveStateRef.current = {
    callState,
    myPin,
    peerPin,
    camEnabled,
    peerCamEnabled,
    showSelfPreview,
    mirrorLocalVideo,
    remoteRotation,
    baselinePeerIsPortrait,
  };

  const clampPipCoords = (rawLeft: number, rawTop: number) => {
    const field = fieldRef.current;
    const pip = pipRef.current;
    if (!field || !pip) {
      return { left: Math.max(8, rawLeft), top: Math.max(8, rawTop) };
    }
    const pad = 8;
    const fieldW = field.clientWidth;
    const fieldH = field.clientHeight;
    const pipW = pip.offsetWidth;
    const pipH = pip.offsetHeight;
    const maxLeft = Math.max(pad, fieldW - pipW - pad);
    const maxTop = Math.max(pad, fieldH - pipH - pad);
    return {
      left: Math.min(maxLeft, Math.max(pad, rawLeft)),
      top: Math.min(maxTop, Math.max(pad, rawTop)),
    };
  };

  // Re-clamp PiP position if viewport resizes
  useEffect(() => {
    if (!isOpen) return;
    const onResize = () => {
      setPipPos((prev) => {
        if (!prev) return null;
        return clampPipCoords(prev.left, prev.top);
      });
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [isOpen]);

  // Global window pointer/touch listeners for ultra-smooth 60fps PiP dragging strictly clamped inside fieldRef
  useEffect(() => {
    if (!isOpen) return;

    const applyMove = (clientX: number, clientY: number) => {
      const st = dragStartRef.current;
      if (!st.active) return;
      const dx = clientX - st.startX;
      const dy = clientY - st.startY;
      const clamped = clampPipCoords(st.origLeft + dx, st.origTop + dy);
      st.curLeft = clamped.left;
      st.curTop = clamped.top;

      const pip = pipRef.current;
      if (pip) {
        pip.style.left = `${clamped.left}px`;
        pip.style.top = `${clamped.top}px`;
        pip.style.right = 'auto';
        pip.style.bottom = 'auto';
      }
    };

    const finishDrag = () => {
      const st = dragStartRef.current;
      if (!st.active) return;
      st.active = false;
      setIsDraggingPip(false);
      setPipPos({ left: st.curLeft, top: st.curTop });
    };

    const onWinPointerMove = (e: PointerEvent) => applyMove(e.clientX, e.clientY);
    const onWinPointerUp = () => finishDrag();
    const onWinTouchMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (t) applyMove(t.clientX, t.clientY);
    };
    const onWinTouchEnd = () => finishDrag();

    window.addEventListener('pointermove', onWinPointerMove, { passive: true });
    window.addEventListener('pointerup', onWinPointerUp);
    window.addEventListener('pointercancel', onWinPointerUp);
    window.addEventListener('touchmove', onWinTouchMove, { passive: true });
    window.addEventListener('touchend', onWinTouchEnd);
    window.addEventListener('touchcancel', onWinTouchEnd);

    return () => {
      window.removeEventListener('pointermove', onWinPointerMove);
      window.removeEventListener('pointerup', onWinPointerUp);
      window.removeEventListener('pointercancel', onWinPointerUp);
      window.removeEventListener('touchmove', onWinTouchMove);
      window.removeEventListener('touchend', onWinTouchEnd);
      window.removeEventListener('touchcancel', onWinTouchEnd);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    let animId = 0;
    let active = true;

    const renderLoop = () => {
      if (!active) return;

      const {
        callState: st,
        peerPin: peer,
        camEnabled: isCamOn,
        peerCamEnabled: isPeerCamOn,
        showSelfPreview: showSelf,
        mirrorLocalVideo: mirrorSelf,
        remoteRotation: rotMode,
        baselinePeerIsPortrait: basePortrait,
      } = liveStateRef.current;

      const mainCanvas = mainCanvasRef.current;
      if (mainCanvas && st === 'connected') {
        const ctx = mainCanvas.getContext('2d');
        if (ctx) {
          let sourceMedia: HTMLVideoElement | HTMLCanvasElement | null = null;
          let sw = 0;
          let sh = 0;

          if (isPeerCamOn) {
            const remVid = remoteVideoElementRef.current;
            if (remVid && remVid.readyState >= 2 && remVid.videoWidth > 0) {
              sourceMedia = remVid;
              sw = remVid.videoWidth;
              sh = remVid.videoHeight;
            } else {
              const remCan = remoteFallbackCanvasRef.current;
              if (remCan && remCan.width > 0 && remCan.height > 0) {
                sourceMedia = remCan;
                sw = remCan.width;
                sh = remCan.height;
              }
            }
          }

          if (sourceMedia && sw > 0 && sh > 0) {
            const fieldW = fieldRef.current?.clientWidth || 640;
            const fieldH = fieldRef.current?.clientHeight || 480;
            const rotDeg = resolveEffectiveRotation(
              rotMode,
              sw,
              sh,
              fieldW,
              fieldH,
              basePortrait
            );
            const isQuarterTurn = rotDeg === 90 || rotDeg === 270;
            const targetW = isQuarterTurn ? sh : sw;
            const targetH = isQuarterTurn ? sw : sh;

            if (mainCanvas.width !== targetW || mainCanvas.height !== targetH) {
              mainCanvas.width = targetW;
              mainCanvas.height = targetH;
            }
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.fillStyle = '#08090b';
            ctx.fillRect(0, 0, targetW, targetH);

            ctx.save();
            ctx.translate(targetW / 2, targetH / 2);
            if (rotDeg !== 0) {
              ctx.rotate((rotDeg * Math.PI) / 180);
            }
            try {
              ctx.drawImage(sourceMedia, -sw / 2, -sh / 2, sw, sh);
            } catch {
              // Ignore
            }
            ctx.restore();
          } else {
            const w = mainCanvas.width;
            const h = mainCanvas.height;
            ctx.fillStyle = '#08090b';
            ctx.fillRect(0, 0, w, h);
            ctx.fillStyle = '#d0d4dc';
            ctx.font = '700 22px "JetBrains Mono", monospace';
            ctx.textAlign = 'center';
            ctx.fillText(
              isPeerCamOn ? `LINE #${peer || '---'} CONNECTED` : `АБОНЕНТ #${peer || '---'} · КАМЕРА ВЫКЛ`,
              w / 2,
              h / 2
            );
          }
        }
      }

      const pipCanvas = pipCanvasRef.current;
      if (pipCanvas && showSelf) {
        const pCtx = pipCanvas.getContext('2d');
        if (pCtx) {
          const locVid = localVideoElementRef.current;
          if (isCamOn && locVid && locVid.readyState >= 2) {
            const lw = locVid.videoWidth || 320;
            const lh = locVid.videoHeight || 240;
            if (pipCanvas.width !== lw || pipCanvas.height !== lh) {
              pipCanvas.width = lw;
              pipCanvas.height = lh;
            }
            pCtx.imageSmoothingEnabled = true;
            pCtx.imageSmoothingQuality = 'high';
            pCtx.fillStyle = '#101216';
            pCtx.fillRect(0, 0, lw, lh);
            pCtx.save();
            if (mirrorSelf) {
              pCtx.translate(lw, 0);
              pCtx.scale(-1, 1);
            }
            try {
              pCtx.drawImage(locVid, 0, 0, lw, lh);
            } catch {
              // Ignore
            }
            pCtx.restore();
          }
        }
      }

      animId = requestAnimationFrame(renderLoop);
    };

    animId = requestAnimationFrame(renderLoop);
    return () => {
      active = false;
      cancelAnimationFrame(animId);
    };
  }, [
    isOpen,
    callState,
    camEnabled,
    peerCamEnabled,
    showSelfPreview,
    mirrorLocalVideo,
    remoteRotation,
    baselinePeerIsPortrait,
  ]);

  if (!isOpen) return null;

  const beginPipDrag = (clientX: number, clientY: number) => {
    const field = fieldRef.current;
    const pip = pipRef.current;
    if (!field || !pip) return;

    const fieldRect = field.getBoundingClientRect();
    const pipRect = pip.getBoundingClientRect();
    const rawLeft = pipPos ? pipPos.left : pipRect.left - fieldRect.left;
    const rawTop = pipPos ? pipPos.top : pipRect.top - fieldRect.top;
    const clamped = clampPipCoords(rawLeft, rawTop);

    dragStartRef.current = {
      active: true,
      startX: clientX,
      startY: clientY,
      origLeft: clamped.left,
      origTop: clamped.top,
      curLeft: clamped.left,
      curTop: clamped.top,
    };
    setPipPos(clamped);
    setIsDraggingPip(true);
  };

  return (
    <div
      data-testid="fullscreen-monitor"
      className="fixed top-0 left-0 right-0 bottom-0 z-50 w-full h-[100dvh] max-h-screen bg-[#08090b] flex flex-col justify-between overflow-hidden select-none"
      role="dialog"
      aria-modal="true"
      aria-label="Полноэкранный видеорежим домофона"
    >
      {/* Top Overlay Header */}
      <div className="relative z-20 flex items-center justify-between gap-2 px-3 sm:px-6 py-3 bg-gradient-to-b from-black/90 via-black/55 to-transparent shrink-0">
        <div className="flex items-center gap-2 sm:gap-3 font-mono text-xs sm:text-sm text-[#eceef0] tabular-nums min-w-0">
          <span className="font-bold truncate">
            {callState === 'connected'
              ? `КВ. #${peerPin || '---'} · НА СВЯЗИ`
              : callState === 'incoming'
                ? `ВХОДЯЩИЙ ВЫЗОВ #${peerPin || '---'}`
                : callState === 'outgoing' || callState === 'autodialing'
                  ? `ВЫЗОВ #${peerPin || '...'}`
                  : callState === 'searching'
                    ? 'РУЛЕТКА · ПОИСК'
                    : callState === 'ended'
                      ? 'RESET · ВЫЗОВ СБРОШЕН'
                      : 'КАМЕРА ДОМОФОНА'}
          </span>
          <span className="hidden sm:inline text-[#686d76]" aria-hidden="true">
            ·
          </span>
          <span className="hidden sm:inline text-[#9ca3af] shrink-0">
            Ваш код: #{myPin || '---'}
          </span>
        </div>

        <button
          type="button"
          data-testid="close-fullscreen-btn"
          onClick={onClose}
          className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1.5 text-xs font-medium text-[#eceef0] bg-[#1b1e24]/90 hover:bg-[#272b33] border border-[#323640] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          aria-label="Выйти из полноэкранного режима"
        >
          <Minimize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
          <span>К 3D домофону</span>
        </button>
      </div>

      {/* Main Fullscreen Video Stage */}
      <div
        ref={stageRef}
        data-testid="fullscreen-video-stage"
        className="relative flex-1 min-h-0 w-full flex items-center justify-center bg-[#08090b] px-2 sm:px-6 py-1 sm:py-2 overflow-hidden"
      >
        {/* Bounded Video Field — PiP is strictly clamped inside this exact frame */}
        <div
          ref={fieldRef}
          data-testid="fullscreen-video-field"
          className="relative w-full h-full rounded-lg border border-[#1d2028] bg-[#050608] flex items-center justify-center overflow-hidden"
        >
          <canvas
            ref={mainCanvasRef}
            width={640}
            height={480}
            data-testid="fullscreen-remote-canvas"
            className={`w-full h-full object-contain ${
              callState === 'connected' ? 'block' : 'hidden'
            }`}
          />

          {/* Remote Peer Muted Mic / Camera Off Small Status Icons */}
          {callState === 'connected' && (!peerMicEnabled || !peerCamEnabled) && (
            <div
              data-testid="fullscreen-peer-status-icons"
              className="absolute top-2.5 left-2.5 z-20 flex items-center gap-1.5 pointer-events-none"
            >
              {!peerMicEnabled && (
                <div
                  data-testid="peer-mic-off-icon"
                  title="У собеседника выключен микрофон"
                  className="flex items-center gap-1 px-2 py-1 rounded-md bg-black/75 border border-[#5c2626] text-[#f87171] shadow-md"
                >
                  <MicOff className="w-3.5 h-3.5" />
                </div>
              )}
              {!peerCamEnabled && (
                <div
                  data-testid="peer-cam-off-icon"
                  title="У собеседника выключена камера"
                  className="flex items-center gap-1 px-2 py-1 rounded-md bg-black/75 border border-[#5c2626] text-[#f87171] shadow-md"
                >
                  <VideoOff className="w-3.5 h-3.5" />
                </div>
              )}
            </div>
          )}

          {callState !== 'connected' && (
            <div className="text-center px-6 z-10">
              <div className="text-base sm:text-xl font-mono font-bold text-[#d0d4dc] tracking-wide">
                {callState === 'searching'
                  ? 'ПОИСК СОБЕСЕДНИКА В РУЛЕТКЕ...'
                  : callState === 'autodialing'
                    ? `АВТОВБИТИЕ КОДА #${peerPin || '...'}...`
                    : callState === 'outgoing'
                      ? `ВЫЗОВ АБОНЕНТА #${peerPin || '...'}...`
                      : callState === 'incoming'
                        ? `ВХОДЯЩИЙ ВЫЗОВ ОТ #${peerPin || '...'}`
                        : callState === 'ended'
                          ? 'RESET · ВЫЗОВ СБРОШЕН'
                          : 'ВИДЕОКАНАЛ СВОБОДЕН'}
              </div>
              <p className="text-xs text-[#7c828d] mt-1.5 font-mono">
                ЛИНИЯ ДОМОФОНА #{myPin || '---'}
              </p>
            </div>
          )}

          {/* Smoothly Draggable & Hideable Picture-in-Picture Local Camera Window (strictly inside fieldRef) */}
          {showSelfPreview && (
            <div
              ref={pipRef}
              data-testid="fullscreen-pip-window"
              onPointerDown={(e) => {
                const target = e.target as HTMLElement | null;
                if (target && target.closest('button')) return;
                e.stopPropagation();
                beginPipDrag(e.clientX, e.clientY);
              }}
              onTouchStart={(e) => {
                const target = e.target as HTMLElement | null;
                if (target && target.closest('button')) return;
                e.stopPropagation();
                const t = e.touches[0];
                if (t) beginPipDrag(t.clientX, t.clientY);
              }}
              style={
                pipPos
                  ? {
                      left: `${pipPos.left}px`,
                      top: `${pipPos.top}px`,
                      right: 'auto',
                      bottom: 'auto',
                      touchAction: 'none',
                      willChange: isDraggingPip ? 'left, top' : 'auto',
                    }
                  : {
                      touchAction: 'none',
                    }
              }
              title="Перетащите окошко в любое место экрана"
              className={`absolute ${
                pipPos ? '' : 'top-2 right-2 sm:top-3 sm:right-3'
              } w-28 h-22 sm:w-48 sm:h-36 bg-[#101216] border ${
                isDraggingPip ? 'border-[#93c5fd]' : 'border-[#323642]'
              } rounded-lg overflow-hidden shadow-2xl flex items-center justify-center z-20 cursor-grab active:cursor-grabbing`}
            >
              <canvas
                ref={pipCanvasRef}
                width={320}
                height={240}
                className={`w-full h-full object-contain bg-[#090a0d] ${
                  camEnabled ? 'block' : 'hidden'
                }`}
              />
              {!camEnabled && (
                <span className="text-[10px] sm:text-[11px] font-mono text-[#787d87]">
                  КАМЕРА ВЫКЛ
                </span>
              )}
              <div className="absolute top-1 left-1 bg-black/60 p-1 rounded text-[#9ca3af] pointer-events-none">
                <Move className="w-3 h-3" />
              </div>
              <button
                type="button"
                data-testid="fullscreen-pip-hide-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleSelfPreview();
                }}
                aria-label="Скрыть своё окно"
                title="Скрыть своё окно"
                className="absolute top-1 right-1 bg-black/70 hover:bg-black/90 p-1 rounded text-[#d1d5db] hover:text-white transition-colors cursor-pointer"
              >
                <X className="w-3 h-3" />
              </button>
              <div className="absolute bottom-1 left-1.5 right-1.5 flex items-center justify-between text-[9px] sm:text-[10px] font-mono text-[#d0d4dc] bg-black/65 px-1.5 py-0.5 rounded-xs pointer-events-none">
                <span>ВЫ #{myPin}</span>
                <span className="flex items-center gap-1">
                  {!micEnabled && <MicOff className="w-2.5 h-2.5 text-[#f87171]" />}
                  {!camEnabled && <VideoOff className="w-2.5 h-2.5 text-[#f87171]" />}
                  {micEnabled && camEnabled && 'MIC'}
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom Control Bar — Minimalist Icon-Only Controls on both PC and Mobile */}
      <div className="relative z-20 flex items-center justify-center px-3 sm:px-4 pt-2 pb-5 sm:pb-6 bg-gradient-to-t from-black/95 via-black/70 to-transparent shrink-0">
        <div
          data-testid="fullscreen-controls"
          className="flex flex-wrap items-center justify-center gap-1.5 sm:gap-2 bg-[#14161a]/95 border border-[#2a2e37] rounded-xl px-2.5 sm:px-3.5 py-2 sm:py-2.5 shadow-2xl max-w-full"
        >
          <button
            type="button"
            onClick={onToggleMic}
            className={`flex items-center justify-center p-2.5 rounded-lg border transition-colors shrink-0 cursor-pointer ${
              micEnabled
                ? 'bg-[#1d2026] border-[#313640] text-[#e4e5e7] hover:bg-[#262a32]'
                : 'bg-[#3b1d1d] border-[#632d2d] text-[#fca5a5]'
            }`}
            aria-label={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
            title={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
          >
            {micEnabled ? <Mic className="w-4 h-4" /> : <MicOff className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={onToggleCam}
            className={`flex items-center justify-center p-2.5 rounded-lg border transition-colors shrink-0 cursor-pointer ${
              camEnabled
                ? 'bg-[#1d2026] border-[#313640] text-[#e4e5e7] hover:bg-[#262a32]'
                : 'bg-[#3b1d1d] border-[#632d2d] text-[#fca5a5]'
            }`}
            aria-label={camEnabled ? 'Выключить камеру' : 'Включить камеру'}
            title={camEnabled ? 'Выключить камеру' : 'Включить камеру'}
          >
            {camEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
          </button>

          <button
            type="button"
            onClick={onSwitchCamera}
            className="flex items-center justify-center p-2.5 rounded-lg bg-[#1d2026] hover:bg-[#262a32] border border-[#313640] text-[#e4e5e7] transition-colors shrink-0 cursor-pointer"
            aria-label="Переключить камеру (фронтальная / основная)"
            title={
              cameraFacingMode === 'user'
                ? 'Переключить на основную камеру'
                : 'Переключить на фронтальную камеру'
            }
          >
            <SwitchCamera className="w-4 h-4" />
          </button>

          <button
            type="button"
            data-testid="fullscreen-rotate-btn"
            data-rotation-mode={String(remoteRotation)}
            onClick={onRotateRemoteVideo}
            className={`flex items-center justify-center p-2.5 rounded-lg border transition-colors shrink-0 cursor-pointer ${
              remoteRotation === 'auto'
                ? 'bg-[#1f3327] border-[#355942] text-[#8ce99a] hover:bg-[#264030]'
                : 'bg-[#1d2026] hover:bg-[#262a32] border-[#313640] text-[#e4e5e7]'
            }`}
            aria-label="Поворот видео собеседника"
            title={
              remoteRotation === 'auto'
                ? 'Автоповорот видео включён (нажмите для ручного поворота)'
                : `Поворот видео: ${formatRotationLabel(remoteRotation)}`
            }
          >
            <RotateCw className="w-4 h-4" />
          </button>

          {callState === 'connected' && (
            <button
              type="button"
              onClick={onToggleChat}
              data-testid="fullscreen-toggle-chat-btn"
              className={`relative flex items-center justify-center p-2.5 rounded-lg border transition-colors shrink-0 cursor-pointer ${
                isChatOpen
                  ? 'bg-[#1f3327] border-[#355942] text-[#8ce99a]'
                  : 'bg-[#1d2026] hover:bg-[#262a32] border-[#313640] text-[#e4e5e7]'
              }`}
              aria-label="Сообщения во время звонка"
              title="Сообщения во время звонка"
            >
              <MessageSquare className="w-4 h-4" />
              {unreadChatCount > 0 && !isChatOpen && (
                <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-[16px] px-1 rounded-full bg-[#2ea043] text-[9px] font-mono font-bold text-white flex items-center justify-center shadow">
                  {unreadChatCount > 9 ? '9+' : unreadChatCount}
                </span>
              )}
            </button>
          )}

          <button
            type="button"
            data-testid="fullscreen-toggle-self-btn"
            onClick={onToggleSelfPreview}
            className={`flex items-center justify-center p-2.5 rounded-lg border transition-colors shrink-0 cursor-pointer ${
              showSelfPreview
                ? 'bg-[#1d2026] hover:bg-[#262a32] border-[#313640] text-[#e4e5e7]'
                : 'bg-[#13151a] border-[#252932] text-[#7c8390] hover:text-[#d0d5df]'
            }`}
            aria-label={showSelfPreview ? 'Скрыть своё окно' : 'Показать своё окно'}
            title={showSelfPreview ? 'Скрыть своё окно' : 'Показать своё окно'}
          >
            {showSelfPreview ? <Eye className="w-4 h-4" /> : <EyeOff className="w-4 h-4" />}
          </button>

          {callState === 'incoming' && (
            <button
              type="button"
              onClick={onAnswerCall}
              className="flex items-center justify-center p-2.5 bg-[#2ea043] hover:bg-[#36b34d] text-white rounded-lg transition-colors shrink-0 cursor-pointer"
              aria-label="Ответить (В)"
              title="Ответить (В)"
            >
              <PhoneCall className="w-4 h-4" />
            </button>
          )}

          {mode === 'roulette' &&
            (callState === 'idle' ||
            callState === 'ended' ||
            callState === 'busy' ||
            callState === 'not_found' ? (
              <button
                type="button"
                onClick={onStartRoulette}
                className="flex items-center justify-center p-2.5 bg-[#2ea043] hover:bg-[#36b34d] text-white rounded-lg transition-colors shrink-0 cursor-pointer"
                aria-label="Автовбитие (В)"
                title="Автовбитие (В)"
              >
                <Shuffle className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={onNextRoulette}
                className="flex items-center justify-center p-2.5 bg-[#2ea043] hover:bg-[#36b34d] text-white rounded-lg transition-colors shrink-0 cursor-pointer"
                aria-label="Следующий (В)"
                title="Следующий (В)"
              >
                <SkipForward className="w-4 h-4" />
              </button>
            ))}

          {(callState === 'connected' ||
            callState === 'outgoing' ||
            callState === 'incoming' ||
            callState === 'searching' ||
            callState === 'autodialing') && (
            <button
              type="button"
              onClick={onHangupCall}
              className="flex items-center justify-center p-2.5 bg-[#b93829] hover:bg-[#cf4332] text-white rounded-lg transition-colors shrink-0 cursor-pointer"
              aria-label="Сброс (С)"
              title="Сброс (С)"
            >
              <PhoneOff className="w-4 h-4" />
            </button>
          )}

          {/* Hidden on mobile (<640px) because the top header already has "К 3D домофону" */}
          <button
            type="button"
            data-testid="fullscreen-bottom-minimize-btn"
            onClick={onClose}
            className="hidden sm:flex items-center justify-center p-2.5 rounded-lg bg-[#1d2026] hover:bg-[#262a32] border border-[#313640] text-[#e4e5e7] transition-colors shrink-0 cursor-pointer"
            aria-label="Свернуть полноэкранный режим"
            title="Свернуть"
          >
            <Minimize2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
