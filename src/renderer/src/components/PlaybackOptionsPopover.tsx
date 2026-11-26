import { useId, useRef, useState } from 'react';
import { Check, Repeat, Repeat1, SlidersHorizontal } from 'lucide-react';
import type { RepeatMode } from '../../../shared/types/player';
import { REPEAT_MODE_LABELS } from '../../../shared/utils/playback-controls';
import { AnchoredPopover } from './OverlayLayer';

function pickContrastTextOnHex(hex: string): string {
  const clean = hex.replace('#', '').trim();
  if (clean.length === 6) {
    const r = Number.parseInt(clean.slice(0, 2), 16) / 255;
    const g = Number.parseInt(clean.slice(2, 4), 16) / 255;
    const b = Number.parseInt(clean.slice(4, 6), 16) / 255;
    if (Number.isFinite(r) && Number.isFinite(g) && Number.isFinite(b)) {
      const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      return lum > 0.56 ? '#101219' : '#FFFFFF';
    }
  }
  return '#FFFFFF';
}

export interface PlaybackOptionsPopoverProps {
  repeatMode: RepeatMode;
  autoNextEnabled: boolean;
  remainingReplays: number | null;
  hasActiveTrack: boolean;
  accentColor: string;
  onSelectRepeat: (mode: RepeatMode) => void;
  onToggleAutoNext: () => void;
  size?: 'sm' | 'md';
  placement?: 'top' | 'bottom';
  testId?: string;
  neutralClassName?: string;
}

interface RepeatOptionItem {
  id: RepeatMode;
  label: string;
  subtitle: string;
  shortTag?: string;
}

const REPEAT_OPTIONS: readonly RepeatOptionItem[] = [
  { id: 'off', label: 'Tắt', subtitle: 'Không lặp lại' },
  { id: 'once', label: 'Lặp 1 lần', subtitle: 'Phát lại thêm 1 lượt (tổng 2 lần)', shortTag: '1×' },
  { id: 'twice', label: 'Lặp 2 lần', subtitle: 'Phát lại thêm 2 lượt (tổng 3 lần)', shortTag: '2×' },
  { id: 'one', label: 'Lặp vô hạn (1 bài)', subtitle: 'Luôn lặp lại bài đang phát', shortTag: '∞' },
  { id: 'all', label: 'Lặp toàn bộ danh sách', subtitle: 'Quay lại từ đầu khi hết danh sách' },
];

export function PlaybackOptionsPopover({
  repeatMode,
  autoNextEnabled,
  remainingReplays,
  hasActiveTrack,
  accentColor,
  onSelectRepeat,
  onToggleAutoNext,
  size = 'sm',
  placement = 'top',
  testId = 'btn-playback-options',
  neutralClassName = 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
}: PlaybackOptionsPopoverProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const isModifiedFromDefault = repeatMode !== 'off' || !autoNextEnabled;
  const sizeClass = size === 'sm' ? 'h-8 w-8 sm:h-9 sm:w-9' : 'h-9 w-9';
  const iconClass = size === 'sm' ? 'h-[16px] w-[16px]' : 'h-[17px] w-[17px]';
  const tooltipText = `Tùy chọn phát · ${REPEAT_MODE_LABELS[repeatMode]} · Tự động chuyển bài: ${
    autoNextEnabled ? 'Bật' : 'Tắt'
  }`;

  const shortRepeatBadge =
    repeatMode === 'once'
      ? '1×'
      : repeatMode === 'twice'
        ? '2×'
        : repeatMode === 'one'
          ? '∞'
          : repeatMode === 'all'
            ? 'All'
            : null;

  const autoNextHint =
    repeatMode === 'once' || repeatMode === 'twice'
      ? autoNextEnabled
        ? 'Tự động sang bài kế tiếp sau khi hoàn tất các lượt lặp'
        : 'Dừng lại sau khi hoàn tất các lượt lặp của bài hiện tại'
      : repeatMode === 'one'
        ? 'Lặp vô hạn đang bật: bài hiện tại phát lại liên tục'
        : autoNextEnabled
          ? 'Tự động chuyển sang bài kế tiếp khi hết bài'
          : 'Phát hết bài hiện tại rồi dừng lại';

  return (
    <div className="relative flex shrink-0 items-center">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        data-repeat-mode={repeatMode}
        data-auto-next={autoNextEnabled ? 'true' : 'false'}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((prev) => !prev)}
        title={tooltipText}
        aria-label={tooltipText}
        className={`relative flex ${sizeClass} items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 active:scale-95 ${
          open || isModifiedFromDefault ? 'bg-[var(--surface-hover)]' : neutralClassName
        }`}
        style={isModifiedFromDefault ? { color: accentColor } : undefined}
      >
        <SlidersHorizontal className={iconClass} />
        {shortRepeatBadge && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute -top-0.5 -right-0.5 rounded-full px-1 text-[8.5px] font-bold leading-tight shadow-sm"
            style={{
              backgroundColor: accentColor,
              color: pickContrastTextOnHex(accentColor),
            }}
          >
            {shortRepeatBadge}
          </span>
        )}
        {!shortRepeatBadge && isModifiedFromDefault && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute bottom-[3px] left-1/2 h-1 w-1 -translate-x-1/2 rounded-full"
            style={{ backgroundColor: accentColor }}
          />
        )}
      </button>

      <AnchoredPopover
        open={open}
        anchorRef={triggerRef}
        onClose={() => setOpen(false)}
        placement={placement}
        align={placement === 'top' ? 'end' : 'start'}
        id={menuId}
        role="menu"
        testId="playback-options-menu"
        ariaLabel="Tùy chọn phát nhạc"
        className="lp-glass-pill w-[288px] max-w-[calc(100vw-2rem)] rounded-2xl border border-[var(--border-glass)] bg-[var(--bg-elevated)] p-3 text-left shadow-2xl"
      >
        <div className="mb-2 flex items-center justify-between px-1">
          <span className="text-[11px] font-semibold tracking-[0.1em] text-[var(--text-muted)] uppercase">
            Chế độ lặp
          </span>
          {hasActiveTrack &&
            (repeatMode === 'once' || repeatMode === 'twice') &&
            typeof remainingReplays === 'number' && (
              <span
                data-testid="remaining-replays-badge"
                className="font-mono-tabular rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                style={{
                  backgroundColor: 'var(--surface-hover)',
                  color: accentColor,
                }}
              >
                {remainingReplays > 0
                  ? `Còn ${remainingReplays} lượt lặp`
                  : 'Đang phát lượt cuối'}
              </span>
            )}
        </div>

        <div role="radiogroup" aria-label="Chọn chế độ lặp" className="space-y-1">
          {REPEAT_OPTIONS.map((opt) => {
            const selected = repeatMode === opt.id;
            return (
              <button
                key={opt.id}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                data-testid={`playback-repeat-option-${opt.id}`}
                onClick={() => onSelectRepeat(opt.id)}
                className={`flex w-full items-center justify-between gap-2.5 rounded-xl px-2.5 py-2 text-left transition ${
                  selected
                    ? 'bg-[var(--surface-hover)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--surface-glass-light)] hover:text-[var(--text-primary)]'
                }`}
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border text-[10.5px] font-bold"
                    style={
                      selected
                        ? {
                            borderColor: accentColor,
                            color: accentColor,
                            backgroundColor: 'var(--surface-glass-light)',
                          }
                        : {
                            borderColor: 'var(--border-subtle)',
                            color: 'var(--text-muted)',
                          }
                    }
                  >
                    {opt.id === 'one' ? (
                      <Repeat1 className="h-3.5 w-3.5" />
                    ) : opt.shortTag ? (
                      opt.shortTag
                    ) : (
                      <Repeat className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <p className="truncate text-[12.5px] font-semibold leading-tight">
                      {opt.label}
                    </p>
                    <p className="truncate text-[11px] text-[var(--text-muted)]">
                      {opt.subtitle}
                    </p>
                  </div>
                </div>

                {selected && (
                  <Check className="h-4 w-4 shrink-0" style={{ color: accentColor }} />
                )}
              </button>
            );
          })}
        </div>

        <div className="my-2.5 border-t border-[var(--border-subtle)]" />

        <button
          type="button"
          role="switch"
          aria-checked={autoNextEnabled}
          data-testid="playback-autonext-switch"
          onClick={onToggleAutoNext}
          className="flex w-full items-center justify-between gap-3 rounded-xl px-2.5 py-2 text-left transition hover:bg-[var(--surface-glass-light)]"
        >
          <div className="min-w-0">
            <p className="text-[12.5px] font-semibold text-[var(--text-primary)]">
              Tự động chuyển bài
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-[var(--text-muted)]">
              {autoNextHint}
            </p>
          </div>
          <span
            aria-hidden="true"
            className="relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors"
            style={{
              backgroundColor: autoNextEnabled ? accentColor : 'var(--border-glass)',
            }}
          >
            <span
              className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${
                autoNextEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
              }`}
            />
          </span>
        </button>
      </AnchoredPopover>
    </div>
  );
}
