import React, { useEffect, useRef, useState } from 'react';
import { MessageSquare, Move, Send, X } from 'lucide-react';
import { ChatMessage, sanitizeChatMessage } from '../utils/intercomLogic';

interface InCallChatProps {
  isConnected: boolean;
  isOpen: boolean;
  onOpen: () => void;
  onClose: () => void;
  peerPin: string | null;
  messages: ChatMessage[];
  toastMessage: ChatMessage | null;
  onDismissToast: () => void;
  onSendMessage: (text: string) => void;
  isFullscreen?: boolean;
}

function formatMessageTime(ts: number): string {
  try {
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  } catch {
    return '';
  }
}

export const InCallChat: React.FC<InCallChatProps> = ({
  isConnected,
  isOpen,
  onOpen,
  onClose,
  peerPin,
  messages,
  toastMessage,
  onDismissToast,
  onSendMessage,
  isFullscreen = false,
}) => {
  const [draft, setDraft] = useState('');
  const [chatPos, setChatPos] = useState<{ left: number; top: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const panelRef = useRef<HTMLElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const dragStateRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    origLeft: number;
    origTop: number;
    curLeft: number;
    curTop: number;
    panelW: number;
    panelH: number;
  }>({
    active: false,
    startX: 0,
    startY: 0,
    origLeft: 0,
    origTop: 0,
    curLeft: 0,
    curTop: 0,
    panelW: 260,
    panelH: 220,
  });

  // Scroll to newest message when messages arrive or chat opens (NOTE: Never auto-focus input so mobile keyboard doesn't pop up automatically!)
  useEffect(() => {
    if (isOpen && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  // Keep custom position clamped inside viewport on window resize
  useEffect(() => {
    if (!isOpen) return;
    const handleResize = () => {
      const panel = panelRef.current;
      if (!panel) return;
      setChatPos((prev) => {
        if (!prev) return null;
        const maxLeft = Math.max(8, window.innerWidth - panel.offsetWidth - 8);
        const maxTop = Math.max(46, window.innerHeight - panel.offsetHeight - 8);
        return {
          left: Math.min(maxLeft, Math.max(8, prev.left)),
          top: Math.min(maxTop, Math.max(46, prev.top)),
        };
      });
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isOpen]);

  // Global window pointer/touch listeners for zero-latency 60fps dragging of the chat window
  useEffect(() => {
    if (!isOpen || !isConnected) return;

    const applyMove = (clientX: number, clientY: number) => {
      const st = dragStateRef.current;
      if (!st.active) return;
      const panel = panelRef.current;
      const panelW = panel ? panel.offsetWidth : st.panelW;
      const panelH = panel ? panel.offsetHeight : st.panelH;

      const dx = clientX - st.startX;
      const dy = clientY - st.startY;

      const maxLeft = Math.max(8, window.innerWidth - panelW - 8);
      const maxTop = Math.max(46, window.innerHeight - panelH - 8);

      const nextLeft = Math.min(maxLeft, Math.max(8, st.origLeft + dx));
      const nextTop = Math.min(maxTop, Math.max(46, st.origTop + dy));
      st.curLeft = nextLeft;
      st.curTop = nextTop;

      if (panel) {
        panel.style.left = `${nextLeft}px`;
        panel.style.top = `${nextTop}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
        panel.style.transform = 'none';
      }
    };

    const finishDrag = () => {
      const st = dragStateRef.current;
      if (!st.active) return;
      st.active = false;
      setIsDragging(false);
      setChatPos({ left: st.curLeft, top: st.curTop });
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
  }, [isOpen, isConnected]);

  if (!isConnected) return null;

  const submitMessage = () => {
    const cleaned = sanitizeChatMessage(draft);
    if (!cleaned) return;
    onSendMessage(cleaned);
    setDraft('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitMessage();
  };

  const beginHeaderDrag = (clientX: number, clientY: number) => {
    const panel = panelRef.current;
    if (!panel) return;
    const rect = panel.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
    const maxTop = Math.max(46, window.innerHeight - rect.height - 8);
    const curLeft = Math.min(maxLeft, Math.max(8, chatPos ? chatPos.left : rect.left));
    const curTop = Math.min(maxTop, Math.max(46, chatPos ? chatPos.top : rect.top));

    dragStateRef.current = {
      active: true,
      startX: clientX,
      startY: clientY,
      origLeft: curLeft,
      origTop: curTop,
      curLeft,
      curTop,
      panelW: rect.width,
      panelH: rect.height,
    };
    setChatPos({ left: curLeft, top: curTop });
    setIsDragging(true);
  };

  return (
    <>
      {/* Subtle floating incoming message toast when chat is closed */}
      {!isOpen && toastMessage && (
        <div
          data-testid="chat-toast-preview"
          className={`fixed left-1/2 -translate-x-1/2 ${
            isFullscreen ? 'bottom-20 sm:bottom-22 z-[55]' : 'bottom-32 sm:bottom-28 z-30'
          } max-w-[86vw] sm:max-w-xs pointer-events-auto`}
        >
          <button
            type="button"
            onClick={() => {
              onDismissToast();
              onOpen();
            }}
            className="flex items-center gap-2 px-3 py-1.5 bg-[#14171d]/95 hover:bg-[#1b1f27] border border-[#313744] rounded-full shadow-2xl text-xs text-[#eceef2] transition-colors cursor-pointer max-w-full"
          >
            <MessageSquare className="w-3.5 h-3.5 text-[#8ce99a] shrink-0" />
            <span className="font-mono font-semibold text-[#9ca3af] shrink-0">
              #{toastMessage.senderPin}:
            </span>
            <span className="truncate text-[#f1f3f5]">{toastMessage.text}</span>
          </button>
        </div>
      )}

      {/* Compact, Smoothly Draggable In-Call Chat Window (centered by default, remembers last position) */}
      {isOpen && (
        <aside
          ref={panelRef}
          data-testid="in-call-chat-panel"
          aria-label="Сообщения во время звонка"
          style={
            chatPos
              ? {
                  left: `${chatPos.left}px`,
                  top: `${chatPos.top}px`,
                  right: 'auto',
                  bottom: 'auto',
                  transform: 'none',
                  willChange: isDragging ? 'left, top' : 'auto',
                }
              : undefined
          }
          className={`fixed ${
            chatPos
              ? ''
              : isFullscreen
                ? 'left-1/2 -translate-x-1/2 bottom-20 sm:bottom-22'
                : 'left-1/2 -translate-x-1/2 bottom-[112px] sm:bottom-24'
          } ${
            isFullscreen ? 'z-[55]' : 'z-30'
          } w-[248px] max-w-[78vw] sm:w-[296px] bg-[#121419]/96 border ${
            isDragging ? 'border-[#8ce99a]/70' : 'border-[#282c36]'
          } rounded-xl shadow-2xl flex flex-col overflow-hidden pointer-events-auto select-text`}
        >
          {/* Smoothly Draggable Header */}
          <div
            data-testid="chat-drag-handle"
            onPointerDown={(e) => {
              const target = e.target as HTMLElement | null;
              if (target && target.closest('button')) return;
              e.stopPropagation();
              beginHeaderDrag(e.clientX, e.clientY);
            }}
            onTouchStart={(e) => {
              const target = e.target as HTMLElement | null;
              if (target && target.closest('button')) return;
              const t = e.touches[0];
              if (t) beginHeaderDrag(t.clientX, t.clientY);
            }}
            title="Перетащите окно чата в удобное место"
            className="flex flex-col bg-[#0e1014] border-b border-[#22262f] select-none cursor-grab active:cursor-grabbing touch-none"
          >
            <div className="flex items-center justify-between gap-1.5 px-2.5 py-1.5 sm:px-3 sm:py-2">
              <div className="flex items-center gap-1.5 min-w-0">
                <Move className="w-3 h-3 text-[#6e7585] shrink-0" />
                <span className="text-[10px] sm:text-[11px] font-mono font-semibold tracking-wider text-[#e4e6eb] uppercase truncate">
                  ЧАТ · #{peerPin || '---'}
                </span>
              </div>
              <button
                type="button"
                onClick={onClose}
                data-testid="close-chat-btn"
                aria-label="Скрыть сообщения"
                className="p-1 text-[#8b9098] hover:text-white rounded-md hover:bg-[#1e222b] transition-colors cursor-pointer shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Messages Feed — Messenger-style multi-line word wrapping with hidden scrollbar */}
          <div
            ref={listRef}
            data-testid="in-call-chat-messages"
            className="no-scrollbar px-2.5 py-2 overflow-y-auto overflow-x-hidden flex flex-col gap-1.5 max-h-[20vh] sm:max-h-[210px] min-h-[78px] sm:min-h-[104px]"
          >
            {messages.length === 0 ? (
              <div className="my-auto py-4 text-center text-[10px] sm:text-[11px] text-[#6e7480] font-mono select-none">
                Напишите абоненту #{peerPin || '---'}
              </div>
            ) : (
              messages.map((m) => (
                <div
                  key={m.id}
                  data-testid="chat-message-item"
                  className={`flex flex-col max-w-[88%] min-w-0 ${
                    m.isSelf ? 'self-end items-end' : 'self-start items-start'
                  }`}
                >
                  <div className="flex items-baseline gap-1.5 mb-0.5 px-0.5">
                    <span className="text-[9px] sm:text-[10px] font-mono font-medium text-[#7d8492]">
                      {m.isSelf ? 'Вы' : `#${m.senderPin}`}
                    </span>
                    <span className="text-[8px] sm:text-[9px] font-mono text-[#565b66]">
                      {formatMessageTime(m.timestamp)}
                    </span>
                  </div>
                  <div
                    data-testid="chat-message-bubble"
                    className={`max-w-full px-2.5 py-1.5 rounded-lg text-[11px] sm:text-xs leading-snug whitespace-pre-wrap break-words [overflow-wrap:anywhere] [word-break:break-word] ${
                      m.isSelf
                        ? 'bg-[#1b2e23] text-[#eef5f0] border border-[#2d4d3a] rounded-br-xs'
                        : 'bg-[#1b1e26] text-[#e5e7ec] border border-[#2c313d] rounded-bl-xs'
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Message Input Form — Does NOT auto-focus on open; Enter inserts newline, Ctrl+Enter / Send button sends */}
          <form
            onSubmit={handleSubmit}
            className="flex items-end gap-1.5 p-1.5 sm:p-2 bg-[#0e1014] border-t border-[#22262f]"
          >
            <textarea
              ref={textareaRef}
              rows={1}
              data-testid="in-call-chat-input"
              maxLength={280}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(64, e.target.scrollHeight)}px`;
              }}
              onKeyDown={(e) => {
                // Prevent global intercom hotkeys from firing while typing
                e.stopPropagation();
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  submitMessage();
                }
              }}
              placeholder="Сообщение (Ctrl+Enter)..."
              title="Enter — перенос строки, Ctrl+Enter — отправить"
              className="no-scrollbar flex-1 min-w-0 max-h-16 resize-none bg-[#15181f] border border-[#282d37] focus:border-[#525b6e] rounded-lg px-2.5 py-1 text-xs leading-snug text-white placeholder:text-[#636975] outline-none transition-colors overflow-y-auto"
            />
            <button
              type="submit"
              data-testid="in-call-chat-send"
              disabled={!draft.trim()}
              aria-label="Отправить сообщение"
              title="Отправить сообщение (Ctrl+Enter)"
              className="p-1.5 rounded-lg bg-[#2ea043] hover:bg-[#36b34d] disabled:bg-[#1c1f26] disabled:text-[#525763] text-white transition-colors shrink-0 cursor-pointer disabled:cursor-not-allowed"
            >
              <Send className="w-3.5 h-3.5" />
            </button>
          </form>
        </aside>
      )}
    </>
  );
};

