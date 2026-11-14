import React, { useState, useEffect, useRef } from 'react';
import { generateFreePin, validatePin } from '../utils/intercomLogic';
import { Shuffle, Copy, Check, X } from 'lucide-react';

interface PinModalProps {
  isOpen: boolean;
  currentPin: string;
  takenPins?: string[];
  serverError: string | null;
  onClose: () => void;
  onSavePin: (newPin: string) => void;
  onClearServerError?: () => void;
}

export const PinModal: React.FC<PinModalProps> = ({
  isOpen,
  currentPin,
  takenPins = [],
  serverError,
  onClose,
  onSavePin,
  onClearServerError,
}) => {
  const [draftPin, setDraftPin] = useState(currentPin);
  const [localError, setLocalError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setDraftPin(currentPin);
    setLocalError(null);
  }, [currentPin, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const res = validatePin(draftPin);
    if (!res.valid) {
      setLocalError(res.error || 'Некорректный номер');
      return;
    }
    setLocalError(null);
    onSavePin(res.normalized);
  };

  const handleFillRandomDraftPin = () => {
    setLocalError(null);
    onClearServerError?.();
    const excludeSet = new Set<string>(takenPins);
    if (currentPin) excludeSet.add(currentPin);
    if (draftPin) excludeSet.add(draftPin);
    const candidate = generateFreePin(excludeSet);
    setDraftPin(candidate);
    inputRef.current?.focus();
  };

  const handleCopy = () => {
    if (!currentPin) return;
    navigator.clipboard?.writeText(currentPin).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1800);
  };

  const displayedError = localError || serverError;
  const isDraftChanged = draftPin.trim() !== '' && draftPin.trim() !== currentPin;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-3 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="pin-modal-title"
    >
      <div className="w-full max-w-sm sm:max-w-md bg-[#141619] border border-[#2a2d34] rounded-xl p-4 sm:p-5 text-[#e4e5e7] shadow-2xl">
        <div className="flex items-start justify-between gap-2 pb-3 border-b border-[#22252b]">
          <div>
            <h2 id="pin-modal-title" className="text-sm sm:text-base font-semibold text-[#eceef0]">
              Личный номер домофона
            </h2>
            <p className="text-[11px] sm:text-xs text-[#8b9098] mt-0.5">
              По этому коду друзья могут позвонить вам напрямую
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть окно номера"
            className="p-1.5 text-[#8b9098] hover:text-white rounded-md hover:bg-[#1f2228] transition-colors cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Active PIN Display + Actions */}
        <div className="mt-3.5 bg-[#0e1012] border border-[#22252b] rounded-lg p-3 sm:px-4 sm:py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center justify-between sm:block">
            <div className="text-[11px] sm:text-xs text-[#8b9098]">Активный код</div>
            <div
              data-testid="active-pin-value"
              className="text-xl sm:text-2xl font-bold font-mono tabular-nums text-[#eceef0] tracking-wider sm:mt-0.5"
            >
              #{currentPin || '---'}
            </div>
          </div>

          <div className="grid grid-cols-2 sm:flex items-center gap-2">
            <button
              type="button"
              onClick={handleCopy}
              className="flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs font-medium bg-[#1c1f24] hover:bg-[#262a30] text-[#d5d8de] border border-[#2e323b] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-[#4ade80]" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
              <span>{copied ? 'Скопировано' : 'Копировать'}</span>
            </button>
            <button
              type="button"
              onClick={handleFillRandomDraftPin}
              data-testid="random-pin-btn"
              className="flex items-center justify-center gap-1.5 px-2.5 sm:px-3 py-2 text-xs font-medium bg-[#1c1f24] hover:bg-[#262a30] text-[#d5d8de] border border-[#2e323b] rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              title="Подобрать случайный свободный номер в поле ввода"
            >
              <Shuffle className="w-3.5 h-3.5" />
              <span>Случайный</span>
            </button>
          </div>
        </div>

        <form onSubmit={handleSubmit} className="mt-3.5 sm:mt-4">
          <label
            htmlFor="custom-pin-input"
            className="block text-xs font-medium text-[#b0b5be] mb-1.5"
          >
            Свой или сгенерированный номер (1–5 цифр)
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={inputRef}
              id="custom-pin-input"
              type="text"
              inputMode="numeric"
              maxLength={5}
              value={draftPin}
              onChange={(e) => {
                const digitsOnly = e.target.value.replace(/\D/g, '').slice(0, 5);
                setDraftPin(digitsOnly);
                setLocalError(null);
                onClearServerError?.();
              }}
              placeholder="Напр: 50 или 1254"
              className="flex-1 min-w-0 bg-[#0e1012] border border-[#2c3038] focus:border-[#707785] rounded-lg px-3 py-2 text-sm font-mono tabular-nums text-white outline-none transition-colors"
            />
            <button
              type="submit"
              data-testid="claim-pin-btn"
              className={`px-3.5 sm:px-4 py-2 text-xs font-semibold rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                isDraftChanged
                  ? 'bg-[#2ea043] hover:bg-[#36b34d] text-white'
                  : 'bg-[#e4e5e7] hover:bg-white text-[#0c0d0e]'
              }`}
            >
              Занять номер
            </button>
          </div>

          {isDraftChanged && !displayedError && (
            <p className="mt-1.5 text-[11px] text-[#93c5fd] font-mono">
              Нажмите «Занять номер», чтобы применить код #{draftPin}
            </p>
          )}

          {displayedError && (
            <p role="alert" className="mt-2 text-xs text-[#f87171]">
              {displayedError}
            </p>
          )}
        </form>

        <div className="mt-4 pt-3 border-t border-[#22252b] flex items-center justify-between gap-2 text-[11px] sm:text-xs text-[#8b9098]">
          <span className="truncate">Номер сменится после нажатия «Занять номер»</span>
          <button
            type="button"
            onClick={onClose}
            className="px-3.5 py-1.5 text-xs font-medium text-[#d0d4dc] hover:text-white bg-[#1e2025] hover:bg-[#282b32] rounded-md transition-colors shrink-0 cursor-pointer"
          >
            Готово
          </button>
        </div>
      </div>
    </div>
  );
};
