import React, { useRef, useState } from 'react';
import {
  PhoneCall,
  PhoneOff,
  SkipForward,
  Shuffle,
  Video,
  VideoOff,
  Mic,
  MicOff,
  ChevronDown,
  ChevronUp,
  Maximize2,
  SwitchCamera,
  Eye,
  EyeOff,
  RotateCw,
  MessageSquare,
} from 'lucide-react';
import {
  CallState,
  ConnectionMode,
  RemoteRotationMode,
  formatRotationLabel,
} from '../utils/intercomLogic';

export interface OnlinePeer {
  pin: string;
  status: 'free' | 'roulette' | 'busy';
}

interface ControlDockProps {
  mode: ConnectionMode;
  onSelectMode: (mode: ConnectionMode) => void;
  callState: CallState;
  currentInput: string;
  autoDialBuffer: string;
  myPin: string;
  peerPin: string | null;
  micEnabled: boolean;
  camEnabled: boolean;
  showSelfPreview: boolean;
  cameraFacingMode: 'user' | 'environment';
  remoteRotation: RemoteRotationMode;
  isChatOpen: boolean;
  unreadChatCount: number;
  onToggleChat: () => void;
  onToggleMic: () => void;
  onToggleCam: () => void;
  onSwitchCamera: () => void;
  onToggleSelfPreview: () => void;
  onRotateRemoteVideo: () => void;
  onKeyPress: (key: string) => void;
  onDirectInputChange: (val: string) => void;
  onStartRoulette: () => void;
  onNextRoulette: () => void;
  onStopRoulette: () => void;
  onAnswerCall: () => void;
  onHangupCall: () => void;
  onOpenPinModal: () => void;
  onOpenHelpModal: () => void;
  onOpenFullscreen: () => void;
}

export const ControlDock: React.FC<ControlDockProps> = ({
  mode,
  onSelectMode,
  callState,
  currentInput,
  autoDialBuffer,
  myPin,
  peerPin,
  micEnabled,
  camEnabled,
  showSelfPreview,
  cameraFacingMode,
  remoteRotation,
  isChatOpen,
  unreadChatCount,
  onToggleChat,
  onToggleMic,
  onToggleCam,
  onSwitchCamera,
  onToggleSelfPreview,
  onRotateRemoteVideo,
  onKeyPress,
  onDirectInputChange,
  onStartRoulette,
  onNextRoulette,
  onStopRoulette,
  onAnswerCall,
  onHangupCall,
  onOpenPinModal,
  onOpenHelpModal,
  onOpenFullscreen,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  const [dragOffsetY, setDragOffsetY] = useState(0);
  const [isSwiping, setIsSwiping] = useState(false);
  const lastToggleTimeRef = useRef<number>(0);

  const swipeRef = useRef<{
    active: boolean;
    startY: number;
    startX: number;
    startTime: number;
    moved: boolean;
    lastDeltaY: number;
    fromHandle: boolean;
  }>({
    active: false,
    startY: 0,
    startX: 0,
    startTime: 0,
    moved: false,
    lastDeltaY: 0,
    fromHandle: false,
  });

  const isCallActive =
    callState === 'outgoing' ||
    callState === 'incoming' ||
    callState === 'connected' ||
    callState === 'autodialing';

  const safeToggleCollapsed = () => {
    const now = performance.now();
    if (now - lastToggleTimeRef.current < 160) return;
    lastToggleTimeRef.current = now;
    setCollapsed((prev) => !prev);
  };

  const beginSwipe = (clientX: number, clientY: number, fromHandle: boolean) => {
    swipeRef.current = {
      active: true,
      startY: clientY,
      startX: clientX,
      startTime: performance.now(),
      moved: false,
      lastDeltaY: 0,
      fromHandle,
    };
    setIsSwiping(true);
  };

  const moveSwipe = (clientX: number, clientY: number) => {
    if (!swipeRef.current.active) return;
    const dy = clientY - swipeRef.current.startY;
    const dx = clientX - swipeRef.current.startX;

    if (Math.abs(dy) > 5 && Math.abs(dy) >= Math.abs(dx) * 0.85) {
      swipeRef.current.moved = true;
    }
    swipeRef.current.lastDeltaY = dy;

    if (!swipeRef.current.moved) return;

    if (!collapsed) {
      // Smooth rubber-band resistance upward, fluid 1:1 follow downward
      const damped = dy < 0 ? Math.max(-14, dy * 0.25) : Math.min(130, dy * 0.88);
      setDragOffsetY(damped);
    } else {
      // Smooth follow upward when pulling panel open from collapsed state
      const damped = dy > 0 ? Math.min(10, dy * 0.2) : Math.max(-110, dy * 0.85);
      setDragOffsetY(damped);
    }
  };

  const endSwipe = () => {
    if (!swipeRef.current.active) return;
    const { lastDeltaY, moved, startTime } = swipeRef.current;
    const dt = Math.max(16, performance.now() - startTime);
    const velocityY = lastDeltaY / dt; // px per ms
    swipeRef.current.active = false;
    setIsSwiping(false);
    setDragOffsetY(0);

    if (moved) {
      if (!collapsed && (lastDeltaY > 22 || velocityY > 0.28)) {
        lastToggleTimeRef.current = performance.now();
        setCollapsed(true);
      } else if (collapsed && (lastDeltaY < -18 || velocityY < -0.25)) {
        lastToggleTimeRef.current = performance.now();
        setCollapsed(false);
      }
    }
  };

  const handleToggleClick = () => {
    if (swipeRef.current.moved && Math.abs(swipeRef.current.lastDeltaY) > 8) {
      return;
    }
    safeToggleCollapsed();
  };

  const swipeProgress =
    isSwiping && dragOffsetY !== 0
      ? !collapsed
        ? Math.max(0, Math.min(1, dragOffsetY / 115))
        : Math.max(0, Math.min(1, -dragOffsetY / 95))
      : 0;

  return (
    <div
      data-testid="control-dock"
      data-collapsed={collapsed ? 'true' : 'false'}
      style={
        isSwiping && dragOffsetY !== 0
          ? {
              transform: `translate3d(0, ${dragOffsetY}px, 0)`,
            }
          : undefined
      }
      className={`fixed bottom-2.5 sm:bottom-3 left-1/2 -translate-x-1/2 z-20 w-[95vw] max-w-[560px] flex flex-col items-center pointer-events-none select-none ${
        isSwiping
          ? ''
          : 'transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
      }`}
      role="region"
      aria-label="Пульт домофона"
    >
      {/* Toggle Button on PC; Tactile Swipe Handle + Tap Toggle Button on Mobile */}
      <div
        data-testid="dock-swipe-handle"
        onPointerDown={(e) => {
          beginSwipe(e.clientX, e.clientY, true);
        }}
        onPointerMove={(e) => {
          if (!swipeRef.current.active) return;
          if (Math.abs(e.clientY - swipeRef.current.startY) > 6) {
            try {
              e.currentTarget.setPointerCapture(e.pointerId);
            } catch {
              // Ignore
            }
          }
          moveSwipe(e.clientX, e.clientY);
        }}
        onPointerUp={() => endSwipe()}
        onPointerCancel={() => endSwipe()}
        onTouchStart={(e) => {
          const t = e.touches[0];
          if (t) beginSwipe(t.clientX, t.clientY, true);
        }}
        onTouchMove={(e) => {
          const t = e.touches[0];
          if (t) moveSwipe(t.clientX, t.clientY);
        }}
        onTouchEnd={() => endSwipe()}
        className="pointer-events-auto mb-1.5 flex items-center justify-center touch-none"
      >
        <button
          type="button"
          data-testid="dock-toggle-btn"
          onClick={handleToggleClick}
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Показать панель' : 'Скрыть панель'}
          className="flex flex-col items-center gap-0.5 px-3.5 py-1 text-[11px] font-medium text-[#a3aab8] hover:text-white bg-[#14161a]/95 border border-[#2a2d36] rounded-full shadow-lg transition-all duration-200 active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
        >
          <span className="w-7 h-1 rounded-full bg-[#434957] sm:hidden" aria-hidden="true" />
          <span className="inline-flex items-center gap-1">
            {collapsed ? (
              <ChevronUp className="w-3 h-3 transition-transform duration-300" />
            ) : (
              <ChevronDown className="w-3 h-3 transition-transform duration-300" />
            )}
            <span>{collapsed ? 'Пульт' : 'Скрыть'}</span>
          </span>
        </button>
      </div>

      {/* Smooth Height & Opacity Animated Drawer Wrapper */}
      <div
        className={`w-full grid ${
          isSwiping
            ? ''
            : 'transition-[grid-template-rows,opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]'
        } ${
          collapsed
            ? 'grid-rows-[0fr] opacity-0 translate-y-3 pointer-events-none'
            : 'grid-rows-[1fr] opacity-100 translate-y-0 pointer-events-auto'
        }`}
        style={
          isSwiping && !collapsed && swipeProgress > 0
            ? { opacity: Math.max(0.25, 1 - swipeProgress * 0.7) }
            : undefined
        }
      >
        <div className="overflow-hidden min-h-0">
          {/* Compact Single-Box Control Bar (swipe-enabled on mobile, button-toggled on PC) */}
          <div
            data-testid="control-dock-panel"
            onTouchStart={(e) => {
              const target = e.target as HTMLElement | null;
              if (target && target.tagName === 'INPUT') return;
              const t = e.touches[0];
              if (t) beginSwipe(t.clientX, t.clientY, false);
            }}
            onTouchMove={(e) => {
              const t = e.touches[0];
              if (t) moveSwipe(t.clientX, t.clientY);
            }}
            onTouchEnd={() => endSwipe()}
            className="w-full bg-[#131518]/98 border border-[#272a32] rounded-xl shadow-2xl p-2.5 sm:p-3"
          >
            {/* Incoming Call Alert */}
            {callState === 'incoming' && (
              <div className="mb-2.5 flex items-center justify-between gap-2 bg-[#19221c] border border-[#2d4635] rounded-lg px-3 py-2">
                <div className="text-xs font-medium text-[#eceef0] truncate">
                  Вызов от <span className="font-mono font-bold">#{peerPin || '---'}</span>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    type="button"
                    onClick={onAnswerCall}
                    className="flex items-center gap-1 px-3 py-1 text-xs font-semibold bg-[#2ea043] hover:bg-[#36b34d] text-white rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <PhoneCall className="w-3.5 h-3.5" />
                    <span>Ответить (В)</span>
                  </button>
                  <button
                    type="button"
                    onClick={onHangupCall}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs font-semibold bg-[#b93829] hover:bg-[#cf4332] text-white rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <PhoneOff className="w-3.5 h-3.5" />
                    <span>Сброс (С)</span>
                  </button>
                </div>
              </div>
            )}

            {/* Row 1: Mode Tabs + Media Controls (Mic, Cam, Switch Cam, Rotate Peer, Chat, Self-PiP Toggle, Fullscreen) */}
            <div className="flex items-center justify-between gap-1 sm:gap-2 min-w-0">
              <div
                className="inline-flex items-center gap-0.5 p-0.5 bg-[#0c0d0f] border border-[#22252b] rounded-lg shrink-0"
                role="tablist"
                aria-label="Режим подключения"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'code'}
                  onClick={() => onSelectMode('code')}
                  className={`px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    mode === 'code'
                      ? 'bg-[#23272f] text-white'
                      : 'text-[#8b9098] hover:text-[#d5d8de]'
                  }`}
                >
                  По коду
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={mode === 'roulette'}
                  onClick={() => onSelectMode('roulette')}
                  className={`px-2 sm:px-3 py-1 text-[11px] sm:text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                    mode === 'roulette'
                      ? 'bg-[#23272f] text-white'
                      : 'text-[#8b9098] hover:text-[#d5d8de]'
                  }`}
                >
                  Рулетка
                </button>
              </div>

              <div className="flex items-center gap-1 sm:gap-1.5 shrink-0">
                <button
                  type="button"
                  onClick={onOpenPinModal}
                  className="hidden sm:inline-flex items-center px-2 py-1 text-xs font-mono font-semibold text-[#d5d8de] hover:text-white bg-[#1a1d22] hover:bg-[#23272e] border border-[#2c3039] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer tabular-nums"
                  title="Ваш личный номер домофона"
                >
                  #{myPin || '...'}
                </button>

                <button
                  type="button"
                  onClick={onToggleMic}
                  className={`p-1 sm:p-1.5 rounded-md border transition-colors cursor-pointer ${
                    micEnabled
                      ? 'bg-[#1a1d22] border-[#2c3039] text-[#d5d8de] hover:text-white hover:bg-[#23272e]'
                      : 'bg-[#381d1d] border-[#5e2b2b] text-[#fca5a5]'
                  }`}
                  aria-label={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
                  title={micEnabled ? 'Выключить микрофон' : 'Включить микрофон'}
                >
                  {micEnabled ? <Mic className="w-3.5 h-3.5" /> : <MicOff className="w-3.5 h-3.5" />}
                </button>

                <button
                  type="button"
                  onClick={onToggleCam}
                  className={`p-1 sm:p-1.5 rounded-md border transition-colors cursor-pointer ${
                    camEnabled
                      ? 'bg-[#1a1d22] border-[#2c3039] text-[#d5d8de] hover:text-white hover:bg-[#23272e]'
                      : 'bg-[#381d1d] border-[#5e2b2b] text-[#fca5a5]'
                  }`}
                  aria-label={camEnabled ? 'Выключить камеру' : 'Включить камеру'}
                  title={camEnabled ? 'Выключить камеру' : 'Включить камеру'}
                >
                  {camEnabled ? (
                    <Video className="w-3.5 h-3.5" />
                  ) : (
                    <VideoOff className="w-3.5 h-3.5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={onSwitchCamera}
                  className="p-1 sm:p-1.5 rounded-md bg-[#1a1d22] hover:bg-[#23272e] border border-[#2c3039] text-[#d5d8de] hover:text-white transition-colors cursor-pointer"
                  aria-label="Переключить камеру (фронтальная / основная)"
                  title={
                    cameraFacingMode === 'user'
                      ? 'Переключить на основную камеру'
                      : 'Переключить на фронтальную камеру'
                  }
                >
                  <SwitchCamera className="w-3.5 h-3.5" />
                </button>

                <button
                  type="button"
                  data-testid="rotate-remote-btn"
                  data-rotation-mode={String(remoteRotation)}
                  onClick={onRotateRemoteVideo}
                  className={`p-1 sm:p-1.5 rounded-md border transition-colors cursor-pointer ${
                    remoteRotation === 'auto'
                      ? 'bg-[#1f3327] border-[#355942] text-[#8ce99a] hover:bg-[#264030]'
                      : 'bg-[#1a1d22] hover:bg-[#23272e] border-[#2c3039] text-[#d5d8de] hover:text-white'
                  }`}
                  aria-label="Поворот видео собеседника"
                  title={
                    remoteRotation === 'auto'
                      ? 'Автоповорот видео включён (нажмите для ручного поворота)'
                      : `Поворот видео: ${formatRotationLabel(remoteRotation)}`
                  }
                >
                  <RotateCw className="w-3.5 h-3.5" />
                </button>

                {callState === 'connected' && (
                  <button
                    type="button"
                    onClick={onToggleChat}
                    data-testid="toggle-chat-btn"
                    className={`relative p-1 sm:p-1.5 rounded-md border transition-colors cursor-pointer ${
                      isChatOpen
                        ? 'bg-[#1f3327] border-[#355942] text-[#8ce99a]'
                        : 'bg-[#1a1d22] hover:bg-[#23272e] border-[#2c3039] text-[#d5d8de] hover:text-white'
                    }`}
                    aria-label={isChatOpen ? 'Скрыть сообщения' : 'Сообщения во время звонка'}
                    title="Сообщения во время звонка"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    {unreadChatCount > 0 && !isChatOpen && (
                      <span
                        data-testid="chat-unread-badge"
                        className="absolute -top-1.5 -right-1.5 min-w-[15px] h-[15px] px-1 rounded-full bg-[#2ea043] text-[9px] font-mono font-bold text-white flex items-center justify-center shadow"
                      >
                        {unreadChatCount > 9 ? '9+' : unreadChatCount}
                      </span>
                    )}
                  </button>
                )}

                <button
                  type="button"
                  data-testid="dock-toggle-self-btn"
                  onClick={onToggleSelfPreview}
                  className={`p-1 sm:p-1.5 rounded-md border transition-colors cursor-pointer ${
                    showSelfPreview
                      ? 'bg-[#1a1d22] border-[#2c3039] text-[#d5d8de] hover:text-white hover:bg-[#23272e]'
                      : 'bg-[#121418] border-[#23262e] text-[#686d76] hover:text-[#b0b5be]'
                  }`}
                  aria-label={
                    showSelfPreview
                      ? 'Скрыть окошко с собой на домофоне'
                      : 'Показать окошко с собой на домофоне'
                  }
                  title={
                    showSelfPreview
                      ? 'Скрыть окошко с собой на экранчике домофона'
                      : 'Показать окошко с собой на экранчике домофона'
                  }
                >
                  {showSelfPreview ? (
                    <Eye className="w-3.5 h-3.5" />
                  ) : (
                    <EyeOff className="w-3.5 h-3.5" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={onOpenFullscreen}
                  data-testid="open-fullscreen-btn"
                  className="p-1 sm:p-1.5 rounded-md bg-[#1a1d22] hover:bg-[#23272e] border border-[#2c3039] text-[#d5d8de] hover:text-white transition-colors cursor-pointer"
                  aria-label="Развернуть видео на весь экран"
                  title="Полноэкранный видеорежим"
                >
                  <Maximize2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

        {/* Row 2: Direct Call Input OR Roulette Controls */}
        <div className="mt-2">
          {mode === 'code' ? (
            <div className="flex items-center gap-1.5">
              <label htmlFor="dial-pin-input" className="sr-only">
                Код домофона друга
              </label>
              <input
                id="dial-pin-input"
                data-testid="dial-code-input"
                type="text"
                inputMode="numeric"
                maxLength={5}
                disabled={isCallActive}
                value={currentInput}
                onChange={(e) => {
                  const val = e.target.value.replace(/\D/g, '').replace(/^0+/, '').slice(0, 5);
                  onDirectInputChange(val);
                }}
                placeholder="Код друга..."
                className="flex-1 min-w-0 bg-[#0d0f12] border border-[#262a32] focus:border-[#5c6270] rounded-lg px-3 py-1.5 text-xs sm:text-sm font-mono tabular-nums text-white placeholder:text-[#636872] outline-none disabled:opacity-50"
              />

              {!isCallActive ? (
                <>
                  <button
                    type="button"
                    data-testid="dial-call-btn"
                    onClick={() => onKeyPress('B')}
                    disabled={!currentInput}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-[#2ea043] hover:bg-[#36b34d] disabled:bg-[#1c1f24] disabled:text-[#585c66] text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer disabled:cursor-not-allowed"
                  >
                    <PhoneCall className="w-3.5 h-3.5" />
                    <span>Вызов (В)</span>
                  </button>
                  <button
                    type="button"
                    data-testid="dial-reset-btn"
                    onClick={() => onKeyPress('C')}
                    className="px-2.5 sm:px-3 py-1.5 text-xs font-medium bg-[#1b1e24] hover:bg-[#252932] text-[#d0d4dc] border border-[#2c3039] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    Сброс (С)
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  data-testid="dial-hangup-btn"
                  onClick={onHangupCall}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-[#b93829] hover:bg-[#cf4332] text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <PhoneOff className="w-3.5 h-3.5" />
                  <span>Сброс (С)</span>
                </button>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-between gap-2 bg-[#0d0f12] border border-[#22252c] rounded-lg px-3 py-1.5">
              <div className="text-xs font-mono text-[#d0d4dc] truncate tabular-nums">
                {callState === 'searching' && 'ПОИСК АБОНЕНТА...'}
                {callState === 'autodialing' && `АВТОВБИТИЕ #${autoDialBuffer || peerPin || '...'}`}
                {callState === 'connected' && `НА СВЯЗИ · #${peerPin || '---'}`}
                {(callState === 'idle' ||
                  callState === 'ended' ||
                  callState === 'busy' ||
                  callState === 'not_found') &&
                  'АВТОПОИСК СВОБОДНОЙ ЛИНИИ'}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {callState === 'idle' ||
                callState === 'ended' ||
                callState === 'busy' ||
                callState === 'not_found' ? (
                  <button
                    type="button"
                    onClick={onStartRoulette}
                    className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold bg-[#2ea043] hover:bg-[#36b34d] text-white rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Shuffle className="w-3.5 h-3.5" />
                    <span>Включить автовбитие (В)</span>
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={onNextRoulette}
                      className="flex items-center gap-1 px-3 py-1 text-xs font-semibold bg-[#2ea043] hover:bg-[#36b34d] text-white rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <SkipForward className="w-3.5 h-3.5" />
                      <span>Следующий (В)</span>
                    </button>
                    <button
                      type="button"
                      onClick={onStopRoulette}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs font-medium bg-[#b93829] hover:bg-[#cf4332] text-white rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <PhoneOff className="w-3.5 h-3.5" />
                      <span>Стоп (С)</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
