import { RotateCcw } from 'lucide-react';
import type {
  ParametricBandConfig,
  ParametricFilterType,
} from '../../../shared/types/audio-dsp';
import {
  clampFinite,
  EQ_MAX_GAIN_DB,
  EQ_MIN_GAIN_DB,
  getFilterTypeCapabilities,
  getSafeMaxFrequencyHz,
  PARAMETRIC_MAX_Q,
  PARAMETRIC_MIN_FREQ_HZ,
  PARAMETRIC_MIN_Q,
  roundTo,
} from '../../../shared/utils/audio-dsp';
import { ToggleSwitch } from './ToggleSwitch';

export interface ParametricEqPanelProps {
  bands: ParametricBandConfig[];
  sampleRate: number;
  eqEnabled: boolean;
  accentHex: string;
  accentGlowRgb: string;
  selectedIndex: number | null;
  onSelectIndex: (index: number) => void;
  onBandChange: (bandIndex: number, patch: Partial<ParametricBandConfig>) => void;
  onBandReset: (bandIndex: number) => void;
  onResetAll: () => void;
}

const FILTER_TYPES: ParametricFilterType[] = [
  'peaking',
  'lowshelf',
  'highshelf',
  'lowpass',
  'highpass',
  'notch',
];

const LOG_MIN_FREQ = Math.log10(PARAMETRIC_MIN_FREQ_HZ);
const LOG_MIN_Q = Math.log10(PARAMETRIC_MIN_Q);
const LOG_MAX_Q = Math.log10(PARAMETRIC_MAX_Q);

function freqToSliderNorm(freqHz: number, maxFreq: number): number {
  const logMax = Math.log10(Math.max(PARAMETRIC_MIN_FREQ_HZ + 10, maxFreq));
  return clampFinite(
    (Math.log10(clampFinite(freqHz, PARAMETRIC_MIN_FREQ_HZ, maxFreq, 1000)) - LOG_MIN_FREQ) /
      (logMax - LOG_MIN_FREQ),
    0,
    1,
    0.5,
  );
}

function sliderNormToFreq(norm: number, maxFreq: number): number {
  const logMax = Math.log10(Math.max(PARAMETRIC_MIN_FREQ_HZ + 10, maxFreq));
  const raw = Math.pow(10, LOG_MIN_FREQ + clampFinite(norm, 0, 1, 0.5) * (logMax - LOG_MIN_FREQ));
  return raw >= 1000 ? Math.round(raw) : roundTo(raw, 1);
}

function qToSliderNorm(q: number): number {
  return clampFinite(
    (Math.log10(clampFinite(q, PARAMETRIC_MIN_Q, PARAMETRIC_MAX_Q, 1.2)) - LOG_MIN_Q) /
      (LOG_MAX_Q - LOG_MIN_Q),
    0,
    1,
    0.5,
  );
}

function sliderNormToQ(norm: number): number {
  const raw = Math.pow(10, LOG_MIN_Q + clampFinite(norm, 0, 1, 0.5) * (LOG_MAX_Q - LOG_MIN_Q));
  return roundTo(clampFinite(raw, PARAMETRIC_MIN_Q, PARAMETRIC_MAX_Q, 1.2), 2);
}

export function ParametricEqPanel({
  bands,
  sampleRate,
  eqEnabled,
  accentHex,
  accentGlowRgb,
  selectedIndex,
  onSelectIndex,
  onBandChange,
  onBandReset,
  onResetAll,
}: ParametricEqPanelProps) {
  const maxFreqHz = getSafeMaxFrequencyHz(sampleRate);

  return (
    <section
      data-testid="parametric-eq-panel"
      aria-label="Parametric Equalizer 8 băng tần"
      className="rounded-[22px] border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-4 sm:p-5"
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-[15px] font-semibold text-[var(--text-primary)]">
            Parametric EQ · 8 Bộ Lọc Biquad Tùy Biến
          </h2>
          <p className="mt-0.5 text-[12px] text-[var(--text-muted)]">
            Chỉnh trực tiếp loại lọc, tần số (20 Hz – {Math.round(maxFreqHz / 1000)} kHz), Gain và hệ số Q · Đồng bộ tức thì với biểu đồ
          </p>
        </div>

        <button
          type="button"
          data-testid="parametric-eq-reset-btn"
          onClick={onResetAll}
          className="lp-btn-ghost inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-xl px-3 text-[12px] font-medium text-[var(--text-primary)]"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          <span>Reset 8 Band</span>
        </button>
      </div>

      <div className="space-y-2">
        {bands.map((band, idx) => {
          const caps = getFilterTypeCapabilities(band.type);
          const isSelected = selectedIndex === idx;
          const isBandActive = band.enabled && eqEnabled;

          return (
            <div
              key={band.id}
              data-testid={`peq-band-row-${idx}`}
              onClick={() => onSelectIndex(idx)}
              style={
                isSelected
                  ? {
                      borderColor: `rgba(${accentGlowRgb}, 0.55)`,
                      backgroundColor: `rgba(${accentGlowRgb}, 0.08)`,
                    }
                  : undefined
              }
              className={`grid grid-cols-1 items-center gap-3 rounded-2xl border px-3.5 py-2.5 transition-colors lg:grid-cols-[96px_138px_1fr_1fr_1fr_36px] ${
                isSelected
                  ? ''
                  : 'border-[var(--border-subtle)] bg-[var(--bg-elevated)]/45 hover:border-[var(--border-glass)]'
              } ${!band.enabled ? 'opacity-65' : ''}`}
            >
              {/* Band ID + Enable Toggle */}
              <div className="flex items-center gap-2.5">
                <span
                  className="font-mono-tabular flex h-6 w-7 shrink-0 items-center justify-center rounded-lg text-[11px] font-bold"
                  style={{
                    backgroundColor: isBandActive
                      ? `rgba(${accentGlowRgb}, 0.2)`
                      : 'var(--surface-hover)',
                    color: isBandActive ? accentHex : 'var(--text-muted)',
                  }}
                >
                  B{idx + 1}
                </span>
                <div onClick={(e) => e.stopPropagation()}>
                  <ToggleSwitch
                    checked={band.enabled}
                    onChange={(next) => onBandChange(idx, { enabled: next })}
                    ariaLabel={`Bật hoặc tắt Band ${idx + 1}`}
                    accentHex={accentHex}
                    testId={`peq-band-${idx}-toggle`}
                  />
                </div>
              </div>

              {/* Filter Type Selector */}
              <select
                data-testid={`peq-band-${idx}-type`}
                aria-label={`Loại lọc Band ${idx + 1}`}
                value={band.type}
                onChange={(e) =>
                  onBandChange(idx, { type: e.target.value as ParametricFilterType })
                }
                className="lp-surface-input h-8 w-full rounded-xl px-2.5 text-[12px] font-medium focus:outline-none"
              >
                {FILTER_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {getFilterTypeCapabilities(type).label}
                  </option>
                ))}
              </select>

              {/* Frequency Control (Log Slider + Exact Hz Input) */}
              <div className="flex items-center gap-2">
                <span className="w-7 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">
                  Hz
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.002}
                  value={freqToSliderNorm(band.frequencyHz, maxFreqHz)}
                  data-testid={`peq-band-${idx}-freq-slider`}
                  aria-label={`Tần số Band ${idx + 1}`}
                  onChange={(e) =>
                    onBandChange(idx, {
                      frequencyHz: sliderNormToFreq(Number(e.target.value), maxFreqHz),
                    })
                  }
                  className="lp-slider h-4 min-w-0 flex-1 accent-[var(--user-accent)]"
                />
                <input
                  type="number"
                  min={PARAMETRIC_MIN_FREQ_HZ}
                  max={maxFreqHz}
                  step={1}
                  value={Math.round(band.frequencyHz)}
                  data-testid={`peq-band-${idx}-freq-input`}
                  aria-label={`Nhập tần số Hz Band ${idx + 1}`}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) {
                      onBandChange(idx, { frequencyHz: v });
                    }
                  }}
                  className="lp-surface-input font-mono-tabular h-8 w-[74px] shrink-0 rounded-lg px-2 text-right text-[11.5px] focus:outline-none"
                />
              </div>

              {/* Gain Control (disabled cleanly for LPF / HPF / Notch) */}
              <div className="flex items-center gap-2">
                <span className="w-7 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">
                  dB
                </span>
                {caps.hasGain ? (
                  <>
                    <input
                      type="range"
                      min={EQ_MIN_GAIN_DB}
                      max={EQ_MAX_GAIN_DB}
                      step={0.5}
                      value={band.gainDb}
                      data-testid={`peq-band-${idx}-gain-slider`}
                      aria-label={`Gain dB Band ${idx + 1}`}
                      onChange={(e) =>
                        onBandChange(idx, { gainDb: Number(e.target.value) })
                      }
                      className="lp-slider h-4 min-w-0 flex-1 accent-[var(--user-accent)]"
                    />
                    <input
                      type="number"
                      min={EQ_MIN_GAIN_DB}
                      max={EQ_MAX_GAIN_DB}
                      step={0.5}
                      value={band.gainDb}
                      data-testid={`peq-band-${idx}-gain-input`}
                      aria-label={`Nhập Gain dB Band ${idx + 1}`}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) {
                          onBandChange(idx, { gainDb: v });
                        }
                      }}
                      className="lp-surface-input font-mono-tabular h-8 w-[64px] shrink-0 rounded-lg px-2 text-right text-[11.5px] focus:outline-none"
                    />
                  </>
                ) : (
                  <span className="font-mono-tabular flex-1 text-[11.5px] text-[var(--text-muted)]">
                    Không áp dụng cho {caps.shortLabel}
                  </span>
                )}
              </div>

              {/* Q Control (disabled cleanly for Low Shelf / High Shelf) */}
              <div className="flex items-center gap-2">
                <span className="w-4 shrink-0 text-[11px] font-medium text-[var(--text-muted)]">
                  Q
                </span>
                {caps.hasQ ? (
                  <>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.005}
                      value={qToSliderNorm(band.q)}
                      data-testid={`peq-band-${idx}-q-slider`}
                      aria-label={`Hệ số Q Band ${idx + 1}`}
                      onChange={(e) =>
                        onBandChange(idx, { q: sliderNormToQ(Number(e.target.value)) })
                      }
                      className="lp-slider h-4 min-w-0 flex-1 accent-[var(--user-accent)]"
                    />
                    <input
                      type="number"
                      min={PARAMETRIC_MIN_Q}
                      max={PARAMETRIC_MAX_Q}
                      step={0.1}
                      value={band.q}
                      data-testid={`peq-band-${idx}-q-input`}
                      aria-label={`Nhập hệ số Q Band ${idx + 1}`}
                      onChange={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v)) {
                          onBandChange(idx, { q: v });
                        }
                      }}
                      className="lp-surface-input font-mono-tabular h-8 w-[60px] shrink-0 rounded-lg px-2 text-right text-[11.5px] focus:outline-none"
                    />
                  </>
                ) : (
                  <span className="font-mono-tabular flex-1 text-[11.5px] text-[var(--text-muted)]">
                    Độ dốc chuẩn S=1
                  </span>
                )}
              </div>

              {/* Single-Band Reset */}
              <button
                type="button"
                data-testid={`peq-band-${idx}-reset`}
                title={`Đặt lại Band ${idx + 1}`}
                aria-label={`Đặt lại Band ${idx + 1}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onBandReset(idx);
                }}
                className="flex h-8 w-8 items-center justify-center rounded-lg text-[var(--text-muted)] transition hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
