import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, Check, SlidersHorizontal } from 'lucide-react';
import {
  getActiveSlotConfig,
  getAllPresets,
} from '../../../shared/utils/audio-dsp';
import { uiStore, useUiState } from '../stores/ui-store';
import { ToggleSwitch } from './ToggleSwitch';

export interface QuickEqPopoverProps {
  accentHex: string;
  accentGlowRgb: string;
}

export function QuickEqPopover({ accentHex, accentGlowRgb }: QuickEqPopoverProps) {
  useUiState();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  const audioLab = uiStore.getAudioLabSettings();
  const activeSlot = getActiveSlotConfig(audioLab);
  const presets = useMemo(() => getAllPresets(audioLab), [audioLab]);
  const activePreset = useMemo(
    () => presets.find((p) => p.id === activeSlot.activePresetId) ?? null,
    [presets, activeSlot.activePresetId],
  );

  useEffect(() => {
    if (!open) {
      return;
    }
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        data-testid="now-playing-quick-eq-btn"
        aria-label="Mở nhanh Equalizer (Audio Lab)"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((prev) => !prev)}
        style={
          audioLab.enabled
            ? {
                borderColor: `rgba(${accentGlowRgb}, 0.55)`,
                backgroundColor: `rgba(${accentGlowRgb}, 0.16)`,
                color: accentHex,
              }
            : undefined
        }
        className={`inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-[11.5px] font-semibold transition ${
          audioLab.enabled
            ? ''
            : 'border-[var(--np-divider)] bg-transparent text-[var(--np-text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--np-text-primary)]'
        }`}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
        <span>EQ</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Điều khiển nhanh Equalizer"
          data-testid="now-playing-quick-eq-popover"
          className="lp-glass-pill absolute right-0 bottom-11 z-40 w-[292px] rounded-2xl p-3.5 text-[var(--text-primary)] shadow-2xl"
        >
          {/* Header: EQ On/Off + Active Preset */}
          <div className="flex items-center justify-between gap-3 border-b border-[var(--border-subtle)] pb-3">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-[var(--text-primary)]">
                Quick EQ
              </p>
              <p
                data-testid="quick-eq-active-preset"
                className="truncate text-[11.5px] text-[var(--text-muted)]"
              >
                {audioLab.enabled
                  ? `${activePreset ? activePreset.name : 'Tùy chỉnh'} · Slot ${audioLab.activeSlot}`
                  : 'Đang tắt (Bypass)'}
              </p>
            </div>
            <ToggleSwitch
              checked={audioLab.enabled}
              onChange={(next) => uiStore.setAudioLabEnabled(next)}
              ariaLabel="Bật hoặc tắt Equalizer nhanh"
              accentHex={accentHex}
              testId="quick-eq-toggle"
            />
          </div>

          {/* Slot A / B Quick Switch */}
          <div className="mt-2.5 flex items-center justify-between gap-2">
            <span className="text-[11px] font-medium text-[var(--text-muted)]">
              So sánh cấu hình
            </span>
            <div className="inline-flex rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-elevated)]/70 p-0.5">
              {(['A', 'B'] as const).map((slotId) => {
                const active = audioLab.activeSlot === slotId;
                return (
                  <button
                    key={slotId}
                    type="button"
                    data-testid={`quick-eq-slot-${slotId}`}
                    onClick={() => uiStore.setActiveEqSlot(slotId)}
                    style={
                      active
                        ? {
                            backgroundColor: `rgba(${accentGlowRgb}, 0.22)`,
                            color: accentHex,
                          }
                        : undefined
                    }
                    className={`rounded-md px-2.5 py-0.5 text-[11px] font-semibold transition ${
                      active ? '' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                    }`}
                  >
                    Slot {slotId}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Quick Preset List */}
          <div className="mt-2.5 max-h-[208px] space-y-1 overflow-y-auto pr-0.5">
            {presets.map((preset) => {
              const selected = activeSlot.activePresetId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  data-testid={`quick-eq-preset-${preset.id}`}
                  onClick={() => uiStore.applyEqPreset(preset.id)}
                  style={
                    selected
                      ? {
                          backgroundColor: `rgba(${accentGlowRgb}, 0.16)`,
                          color: accentHex,
                        }
                      : undefined
                  }
                  className={`flex w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left text-[12px] transition ${
                    selected
                      ? 'font-semibold'
                      : 'text-[var(--text-secondary)] hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  <span className="truncate">{preset.name}</span>
                  {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                </button>
              );
            })}
          </div>

          {/* Open Full Audio Lab */}
          <button
            type="button"
            data-testid="quick-eq-open-audio-lab-btn"
            onClick={() => {
              setOpen(false);
              uiStore.navigate('audio-lab');
            }}
            style={{
              backgroundColor: `rgba(${accentGlowRgb}, 0.14)`,
              borderColor: `rgba(${accentGlowRgb}, 0.35)`,
            }}
            className="mt-3 flex w-full items-center justify-between rounded-xl border px-3 py-2 text-[12px] font-semibold text-[var(--text-primary)] transition hover:brightness-110"
          >
            <span>Mở Audio Lab</span>
            <ArrowUpRight className="h-3.5 w-3.5" style={{ color: accentHex }} />
          </button>
        </div>
      )}
    </div>
  );
}
