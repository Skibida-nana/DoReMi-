import { RotateCcw } from 'lucide-react';
import { GRAPHIC_EQ_FREQUENCIES } from '../../../shared/types/audio-dsp';
import {
  EQ_MAX_GAIN_DB,
  EQ_MIN_GAIN_DB,
  formatDbLabel,
  formatFrequencyLabel,
} from '../../../shared/utils/audio-dsp';

export interface GraphicEqPanelProps {
  gainsDb: number[];
  eqEnabled: boolean;
  accentHex: string;
  accentGlowRgb: string;
  onBandChange: (bandIndex: number, gainDb: number) => void;
  onBandReset: (bandIndex: number) => void;
  onResetAll: () => void;
}

const RAIL_HEIGHT_PX = 164;

export function GraphicEqPanel({
  gainsDb,
  eqEnabled,
  accentHex,
  accentGlowRgb,
  onBandChange,
  onBandReset,
  onResetAll,
}: GraphicEqPanelProps) {
  return (
    <section
      data-testid="graphic-eq-panel"
      aria-label="Graphic Equalizer 10 băng tần"
      className="rounded-[22px] border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-[15px] font-semibold text-[var(--text-primary)]">
            Graphic EQ · 10 Băng Tần Tham Chiếu
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            Dải chỉnh -12 dB đến +12 dB · Nhấp đúp vào thanh trượt bất kỳ để đưa về 0.0 dB
          </p>
        </div>

        <button
          type="button"
          data-testid="graphic-eq-reset-btn"
          onClick={onResetAll}
          className="lp-btn-ghost inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[12px] font-medium text-[var(--text-primary)]"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>Reset 10 Band</span>
        </button>
      </div>

      {/* 10 Vertical Faders with Left Scale */}
      <div className="overflow-x-auto pb-1">
        <div className="grid min-w-[640px] grid-cols-[40px_repeat(10,minmax(56px,1fr))] items-center gap-1.5 sm:gap-2">
          {/* Left dB Reference Scale */}
          <div className="font-mono-tabular flex h-[220px] flex-col justify-between py-[28px] pr-1 text-right text-[10.5px] text-[var(--text-muted)]">
            <span>+12</span>
            <span>+6</span>
            <span className="font-semibold text-[var(--text-secondary)]">0 dB</span>
            <span>-6</span>
            <span>-12</span>
          </div>

          {GRAPHIC_EQ_FREQUENCIES.map((freq, index) => {
            const gain = gainsDb[index] ?? 0;
            const norm = (gain - EQ_MIN_GAIN_DB) / (EQ_MAX_GAIN_DB - EQ_MIN_GAIN_DB); // 0..1
            const thumbBottomPct = norm * 100;
            const isBoost = gain > 0.05;
            const isCut = gain < -0.05;
            const fillHeightPct = Math.abs(norm - 0.5) * 100;
            const fillBottomPct = isBoost ? 50 : thumbBottomPct;

            return (
              <div
                key={freq}
                data-testid={`graphic-eq-band-${index}`}
                className="flex flex-col items-center gap-2 rounded-2xl border border-transparent py-1.5 transition-colors hover:border-[var(--border-subtle)] hover:bg-[var(--surface-hover)]/40"
              >
                {/* Tabular dB Readout */}
                <span
                  data-testid={`graphic-eq-value-${index}`}
                  className="font-mono-tabular text-[11px] font-semibold"
                  style={{
                    color:
                      Math.abs(gain) >= 0.05 && eqEnabled
                        ? accentHex
                        : 'var(--text-secondary)',
                  }}
                >
                  {formatDbLabel(gain, 1).replace(' dB', '')}
                </span>

                {/* Vertical Fader Rail + Accessible Native Range Overlay */}
                <div
                  className="relative flex w-10 items-center justify-center"
                  style={{ height: `${RAIL_HEIGHT_PX}px` }}
                  onDoubleClick={() => onBandReset(index)}
                  title={`${formatFrequencyLabel(freq)}: ${formatDbLabel(gain, 1)} (nhấp đúp để đặt 0 dB)`}
                >
                  {/* Visual Track */}
                  <div className="pointer-events-none relative h-full w-[5px] rounded-full bg-[var(--volume-track-empty)]">
                    {/* Center 0 dB Detent Tick */}
                    <span className="absolute top-1/2 left-1/2 h-[1.5px] w-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-[var(--border-glass)]" />

                    {/* Active Boost/Cut Segment from 0 dB */}
                    {(isBoost || isCut) && (
                      <div
                        className="absolute inset-x-0 rounded-full transition-all duration-75"
                        style={{
                          bottom: `${fillBottomPct}%`,
                          height: `${fillHeightPct}%`,
                          backgroundColor: eqEnabled ? accentHex : 'var(--text-muted)',
                          opacity: eqEnabled ? 1 : 0.45,
                        }}
                      />
                    )}

                    {/* Tactile Fader Cap */}
                    <div
                      className="absolute left-1/2 h-3.5 w-6 -translate-x-1/2 translate-y-1/2 rounded-[5px] border border-[var(--border-glass)] bg-[var(--bg-elevated)] shadow-sm transition-all duration-75"
                      style={{
                        bottom: `${thumbBottomPct}%`,
                        boxShadow:
                          Math.abs(gain) >= 0.05 && eqEnabled
                            ? `0 0 0 1px ${accentHex}, 0 2px 8px rgba(${accentGlowRgb}, 0.28)`
                            : undefined,
                      }}
                    >
                      <span
                        className="absolute top-1/2 right-1.5 left-1.5 h-[1.5px] -translate-y-1/2 rounded-full"
                        style={{
                          backgroundColor: eqEnabled ? accentHex : 'var(--text-muted)',
                        }}
                      />
                    </div>
                  </div>

                  {/* Native Rotated Range Input for Exact Drag, Keyboard, Touch & Automation */}
                  <input
                    type="range"
                    min={EQ_MIN_GAIN_DB}
                    max={EQ_MAX_GAIN_DB}
                    step={0.5}
                    value={gain}
                    data-testid={`graphic-eq-slider-${index}`}
                    aria-label={`Graphic EQ ${formatFrequencyLabel(freq)}`}
                    onChange={(e) => onBandChange(index, Number(e.target.value))}
                    onDoubleClick={() => onBandReset(index)}
                    style={{
                      width: `${RAIL_HEIGHT_PX}px`,
                      height: '36px',
                      transform: 'rotate(-90deg)',
                    }}
                    className="absolute cursor-ns-resize opacity-0"
                  />
                </div>

                {/* Frequency Label */}
                <span className="font-mono-tabular whitespace-nowrap text-[11px] font-medium text-[var(--text-secondary)]">
                  {formatFrequencyLabel(freq)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
