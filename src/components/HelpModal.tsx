import React from 'react';
import { Moon, Sun, X } from 'lucide-react';
import { OnlinePeer } from './ControlDock';

interface HelpModalProps {
  isOpen: boolean;
  onClose: () => void;
  onlineCount: number;
  rouletteCount: number;
  onlinePeers: OnlinePeer[];
  myPin: string;
  onSelectPinToDial: (pin: string) => void;
  isNightMode: boolean;
  onToggleNightMode: () => void;
}

export const HelpModal: React.FC<HelpModalProps> = ({
  isOpen,
  onClose,
  onlineCount,
  rouletteCount,
  onlinePeers,
  myPin,
  onSelectPinToDial,
  isNightMode,
  onToggleNightMode,
}) => {
  if (!isOpen) return null;

  const otherOnlinePeers = onlinePeers.filter((p) => p.pin !== myPin);

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/75 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="help-modal-title"
    >
      <div className="w-full max-w-md bg-[#141619] border border-[#2a2d34] rounded-xl p-5 sm:p-6 text-[#e4e5e7] shadow-2xl max-h-[88vh] overflow-y-auto">
        <div className="flex items-center justify-between pb-3.5 border-b border-[#22252b]">
          <h2 id="help-modal-title" className="text-base font-semibold text-[#eceef0]">
            Справка и линия связи
          </h2>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              data-testid="toggle-lighting-btn"
              data-night-mode={isNightMode ? 'true' : 'false'}
              onClick={onToggleNightMode}
              aria-label={
                isNightMode ? 'Включить освещённость' : 'Выключить освещённость (темнота)'
              }
              title={
                isNightMode
                  ? 'Включить освещённость сцены'
                  : 'Выключить освещённость (посмотреть как домофон отображается в темноте)'
              }
              className={`p-1.5 rounded-md border transition-colors cursor-pointer ${
                isNightMode
                  ? 'bg-[#1a2234] border-[#3b5280] text-[#93c5fd] hover:bg-[#222d44]'
                  : 'bg-[#1c1f26] border-[#2c313b] text-[#fbbf24] hover:text-[#fde68a] hover:bg-[#252932]'
              }`}
            >
              {isNightMode ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            </button>
            <button
              type="button"
              data-testid="close-help-btn"
              onClick={onClose}
              aria-label="Закрыть справку"
              title="Закрыть окно"
              className="p-1.5 text-[#8b9098] hover:text-white rounded-md hover:bg-[#1f2228] transition-colors cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="mt-4 space-y-4 text-xs leading-relaxed text-[#b5bac2]">
          <div>
            <h3 className="text-xs font-semibold text-[#eceef0] mb-1">1. Прямой видеозвонок по коду</h3>
            <p>
              У каждого пользователя есть свой номер домофона (например,{' '}
              <span className="font-mono text-white">#{myPin || '---'}</span>). Нажмите кнопки с
              цифрами прямо на 3D-панели домофона (или введите с клавиатуры) и нажмите кнопку{' '}
              <span className="font-mono font-semibold text-[#8ce99a]">«В»</span> для вызова либо{' '}
              <span className="font-mono font-semibold text-[#ffa8a8]">«С»</span> для сброса.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-[#eceef0] mb-1">2. Автовбитие (Чат-рулетка)</h3>
            <p>
              Переключитесь в режим <strong>«Рулетка»</strong> и нажмите{' '}
              <span className="font-mono font-semibold text-[#8ce99a]">«В»</span>. Домофон сам
              найдет свободного человека в режиме рулетки, автоматически наберет его код на
              клавиатуре и включит видеосвязь. Повторное нажатие{' '}
              <span className="font-mono font-semibold text-[#8ce99a]">«В»</span> переключает на
              следующего собеседника.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-[#eceef0] mb-1">3. Горячие клавиши</h3>
            <div className="bg-[#0e1012] border border-[#22252b] rounded-lg p-3 font-mono text-[11px] space-y-1.5 text-[#d0d4dc]">
              <div className="flex justify-between">
                <span className="text-[#8b9098]">Цифры 0–9</span>
                <span>Набор кода на домофоне</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8b9098]">Enter / В</span>
                <span>Вызов / Ответить / Следующий</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8b9098]">Esc / Backspace / С</span>
                <span>Сброс / Очистка</span>
              </div>
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <h3 className="text-xs font-semibold text-[#eceef0]">Активные домофоны в сети</h3>
              <span className="font-mono text-[11px] text-[#8b9098] tabular-nums">
                Онлайн: {onlineCount} · В рулетке: {rouletteCount}
              </span>
            </div>
            <div className="bg-[#0e1012] border border-[#22252b] rounded-lg p-3">
              {otherOnlinePeers.length === 0 ? (
                <p className="text-[#787d87] text-xs">
                  Сейчас на линии только ваш домофон #{myPin}. Откройте ссылку у друга или во
                  второй вкладке для звонка.
                </p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {otherOnlinePeers.map((p) => (
                    <button
                      key={p.pin}
                      type="button"
                      onClick={() => {
                        onSelectPinToDial(p.pin);
                        onClose();
                      }}
                      className="px-2.5 py-1 bg-[#181b20] hover:bg-[#23272f] border border-[#2c3038] rounded-md font-mono text-xs text-[#eceef0] transition-colors cursor-pointer tabular-nums"
                    >
                      #{p.pin} {p.status === 'roulette' ? '· рулетка' : p.status === 'busy' ? '· занят' : ''}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="mt-5 pt-3.5 border-t border-[#22252b] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs font-medium text-[#eceef0] bg-[#1e2025] hover:bg-[#282b32] border border-[#32363f] rounded-md transition-colors cursor-pointer"
          >
            Понятно
          </button>
        </div>
      </div>
    </div>
  );
};
