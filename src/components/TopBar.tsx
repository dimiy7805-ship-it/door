import React, { useState, useRef, useEffect } from 'react';
import { HelpCircle, Check } from 'lucide-react';
import { IntercomBrand, resolveShareableSiteUrl } from '../utils/intercomLogic';

interface TopBarProps {
  brand: IntercomBrand;
  onSelectBrand: (brand: IntercomBrand) => void;
  myPin: string;
  onlineCount: number;
  onOpenPinModal: () => void;
  onOpenHelpModal: () => void;
  onCopyLink?: () => void;
}

const BRANDS: { id: IntercomBrand; label: string; shortLabel: string }[] = [
  { id: 'eltis', label: 'ELTIS DP400', shortLabel: 'ELTIS' },
  { id: 'vizit', label: 'VIZIT BVD-343', shortLabel: 'VIZIT' },
  { id: 'cyfral', label: 'CYFRAL CCD-2094', shortLabel: 'CYFRAL' },
];

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fallback below if Clipboard API is restricted in iframe/context
  }

  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

export const TopBar: React.FC<TopBarProps> = ({
  brand,
  onSelectBrand,
  myPin,
  onlineCount,
  onOpenPinModal,
  onOpenHelpModal,
  onCopyLink,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const copyTimerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current !== null) {
        window.clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const handleCopyBrandLink = async () => {
    onCopyLink?.();
    const urlToCopy = resolveShareableSiteUrl(
      typeof window !== 'undefined' ? window.location.href : undefined
    );
    await copyTextToClipboard(urlToCopy);
    setCopiedLink(true);
    if (copyTimerRef.current !== null) {
      window.clearTimeout(copyTimerRef.current);
    }
    copyTimerRef.current = window.setTimeout(() => {
      setCopiedLink(false);
      copyTimerRef.current = null;
    }, 2200);
  };

  return (
    <header className="fixed top-0 left-0 right-0 z-20 flex items-center justify-between gap-2 sm:gap-6 px-3 sm:px-6 py-2.5 bg-[#101215] border-b border-[#22252b]">
      {/* Zone 1: Brand Title — "ДОМОФОН.ЛИНИЯ" on PC with larger dot separator, "ДОМОФОН" on mobile; click copies site URL */}
      <h1 className="m-0 p-0 text-xs sm:text-[15px] font-extrabold leading-none shrink-0">
        <button
          type="button"
          onClick={handleCopyBrandLink}
          data-testid="brand-title"
          title="Нажмите, чтобы скопировать ссылку на домофон"
          aria-label={
            copiedLink
              ? 'Ссылка на домофон скопирована'
              : 'Домофон.Линия — скопировать ссылку на домофон'
          }
          className="group relative font-brand text-xs sm:text-[15px] font-extrabold text-[#f1f3f5] hover:text-white active:scale-[0.98] transition-all whitespace-nowrap shrink-0 select-none flex items-center gap-1.5 cursor-pointer bg-transparent border-0 p-0 text-left"
        >
          <span data-testid="brand-title-pc" className="hidden sm:inline-flex items-baseline">
            <span>ДОМОФОН</span>
            <span
              data-testid="brand-dot-separator"
              className="inline-block text-[22px] font-black leading-none text-[#8ce99a] mx-[2px] -translate-y-[0.5px]"
            >
              .
            </span>
            <span>ЛИНИЯ</span>
          </span>
          <span data-testid="brand-title-mobile" className="sm:hidden">
            ДОМОФОН
          </span>

          {copiedLink && (
            <span
              data-testid="brand-copied-badge"
              role="status"
              aria-live="polite"
              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] sm:text-[11px] font-sans font-semibold text-[#8ce99a] bg-[#16281c] border border-[#2b5237] rounded transition-opacity"
            >
              <Check className="w-3 h-3 shrink-0" />
              <span className="hidden md:inline">Ссылка скопирована</span>
              <span className="md:hidden">Скопировано</span>
            </span>
          )}
        </button>
      </h1>

      {/* Zone 2: Centered model switcher buttons */}
      <nav
        aria-label="Модели домофона"
        className="flex items-center justify-center gap-3 sm:gap-6 text-[11px] sm:text-xs font-medium text-[#8b9098]"
      >
        {BRANDS.map((item) => {
          const active = brand === item.id;
          return (
            <button
              key={item.id}
              type="button"
              data-testid={`brand-btn-${item.id}`}
              onClick={() => onSelectBrand(item.id)}
              className={`py-1 transition-colors whitespace-nowrap shrink-0 border-b-2 cursor-pointer ${
                active
                  ? 'text-[#eceef0] border-[#eceef0] font-semibold'
                  : 'text-[#8b9098] border-transparent hover:text-[#d0d4dc]'
              }`}
            >
              <span className="hidden sm:inline">{item.label}</span>
              <span className="sm:hidden">{item.shortLabel}</span>
            </button>
          );
        })}
        <span className="hidden md:inline text-[#42464f] select-none" aria-hidden="true">
          ·
        </span>
        <span className="hidden md:inline text-xs text-[#8b9098] font-mono tabular-nums whitespace-nowrap shrink-0">
          Онлайн: {onlineCount}
        </span>
      </nav>

      {/* Zone 3: Personal PIN Code button + Info/Help button right next to it */}
      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        <button
          type="button"
          onClick={onOpenPinModal}
          data-testid="open-pin-modal-btn"
          className="px-2 sm:px-3.5 py-1 sm:py-1.5 text-[10px] sm:text-xs font-medium text-[#eceef0] bg-[#1c1f24] hover:bg-[#262a31] border border-[#30343d] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer font-mono tabular-nums"
          aria-label={`Мой код: #${myPin || '...'} — Изменить личный номер домофона`}
        >
          <span className="hidden sm:inline">Мой код: </span>#{myPin || '...'}
        </button>

        <button
          type="button"
          onClick={onOpenHelpModal}
          data-testid="open-help-modal-btn"
          className="p-1.5 sm:p-1.5 text-[#a3aab8] hover:text-white bg-[#1c1f24] hover:bg-[#262a31] border border-[#30343d] rounded-md transition-colors shrink-0 cursor-pointer"
          aria-label="Открыть справку и список абонентов"
          title="Справка и активные номера"
        >
          <HelpCircle className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>
      </div>
    </header>
  );
};

