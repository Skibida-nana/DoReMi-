import { useEffect, useRef, useState } from 'react';
import { AudioWaveform, Check } from 'lucide-react';
import type { FadeDurationSec } from '../../../shared/types/stage5';
import { uiStore, useUiState } from '../stores/ui-store';
import { SettingToggleRow } from './ToggleSwitch';

const FADE_OPTIONS: FadeDurationSec[] = [0.5, 1, 2, 3];

interface PlaybackTransitionControlProps {
  accentHex: string;
  accentGlowRgb: string;
}

/**
 * Compact "Chuyển bài mượt" (Fade In/Out) trigger button & popover placed directly
 * in the Now Playing bottom control bar, synchronized two-way with Settings > Phát nhạc.
 */
export function PlaybackTransitionControl({
  accentHex,
  accentGlowRgb,
}: PlaybackTransitionControlProps) {
  const ui = useUiState();
  const { enabled, durationSec } = ui.preferences.transition;
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }
    const handlePointerDown = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    window.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const statusText = enabled
    ? `Đang bật · ${durationSec}s`
    : 'Đang tắt';

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label="Chuyển bài mượt (Fade In/Out)"
        aria-expanded={open}
        aria-haspopup="dialog"
        title={`Chuyển bài mượt — ${statusText}`}
        data-testid="now-playing-fade-trigger"
        style={
          enabled
            ? {
                color: accentHex,
                backgroundColor: `rgba(${accentGlowRgb}, 0.16)`,
                borderColor: `rgba(${accentGlowRgb}, 0.42)`,
              }
            : undefined
        }
        className={`flex h-9 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition focus-visible:outline-2 focus-visible:outline-offset-2 ${
          enabled
            ? 'shadow-sm'
            : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
        }`}
      >
        <AudioWaveform className="h-4 w-4 shrink-0" />
        <span className="hidden xl:inline">{enabled ? `${durationSec}s` : 'Fade'}</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Cài đặt Chuyển bài mượt"
          data-testid="now-playing-fade-popover"
          className="lp-glass-pill absolute bottom-12 right-0 z-50 w-[268px] rounded-2xl p-4"
        >
          <SettingToggleRow
            variant="compact"
            label="Chuyển bài mượt"
            description="Fade In/Out khi chuyển track"
            checked={enabled}
            onChange={(next) => uiStore.updateTransitionSettings({ enabled: next })}
            accentHex={accentHex}
            testId="fade-popover-toggle"
          />

          <div className="mt-3.5">
            <p className="mb-2 text-[11px] font-medium text-[var(--text-secondary)]">
              Thời lượng chuyển mượt
            </p>
            <div className="grid grid-cols-4 gap-1.5">
              {FADE_OPTIONS.map((sec) => {
                const selected = durationSec === sec;
                return (
                  <button
                    key={sec}
                    type="button"
                    data-testid={`fade-duration-${sec}`}
                    onClick={() =>
                      uiStore.updateTransitionSettings({
                        enabled: true,
                        durationSec: sec,
                      })
                    }
                    style={
                      selected
                        ? {
                            backgroundColor: `rgba(${accentGlowRgb}, 0.22)`,
                            borderColor: `rgba(${accentGlowRgb}, 0.55)`,
                            color: accentHex,
                          }
                        : undefined
                    }
                    className={`flex items-center justify-center gap-0.5 rounded-xl border py-1.5 text-[12px] font-semibold transition ${
                      selected
                        ? ''
                        : 'border-[var(--border-subtle)] bg-[var(--surface-glass-light)] text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    {selected && <Check className="h-3 w-3" />}
                    {sec}s
                  </button>
                );
              })}
            </div>
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-[var(--border-subtle)] pt-2.5 text-[11px]">
            <span className="text-[var(--text-muted)]">Trạng thái</span>
            <span
              className="font-medium"
              style={{ color: enabled ? accentHex : 'var(--text-secondary)' }}
            >
              {statusText}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
