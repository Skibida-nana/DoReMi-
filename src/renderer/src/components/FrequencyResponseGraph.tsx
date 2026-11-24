import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';
import {
  GRAPHIC_EQ_FREQUENCIES,
  type EqSlotConfig,
  type HeadroomAnalysis,
  type ParametricBandConfig,
} from '../../../shared/types/audio-dsp';
import {
  clampFinite,
  computeCompositeFrequencyResponse,
  EQ_MAX_GAIN_DB,
  EQ_MIN_GAIN_DB,
  formatDbLabel,
  formatFrequencyLabel,
  getFilterTypeCapabilities,
  PARAMETRIC_MAX_Q,
  PARAMETRIC_MIN_FREQ_HZ,
  PARAMETRIC_MIN_Q,
  roundTo,
} from '../../../shared/utils/audio-dsp';
import { playerActions } from '../stores/player-store';

export interface FrequencyResponseGraphProps {
  slot: EqSlotConfig;
  eqEnabled: boolean;
  sampleRate: number;
  spectrumEnabled: boolean;
  spectrumActive: boolean;
  reducedMotion: boolean;
  accentHex: string;
  accentGlowRgb: string;
  selectedParametricIndex: number | null;
  onSelectParametricIndex: (index: number | null) => void;
  onGraphicBandChange: (bandIndex: number, gainDb: number) => void;
  onGraphicBandReset: (bandIndex: number) => void;
  onParametricBandChange: (bandIndex: number, patch: Partial<ParametricBandConfig>) => void;
  onParametricBandReset: (bandIndex: number) => void;
  onHeadroomComputed?: (headroom: HeadroomAnalysis) => void;
}

const VIEW_W = 860;
const VIEW_H = 264;
const PAD_L = 48;
const PAD_R = 20;
const PAD_T = 20;
const PAD_B = 34;
const PLOT_W = VIEW_W - PAD_L - PAD_R;
const PLOT_H = VIEW_H - PAD_T - PAD_B;

const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_DB = -18;
const MAX_DB = 18;

const LOG_MIN = Math.log10(MIN_FREQ);
const LOG_MAX = Math.log10(MAX_FREQ);

const FREQ_TICKS = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000] as const;
const DB_TICKS = [12, 6, 0, -6, -12] as const;

function freqToX(freqHz: number): number {
  const clamped = clampFinite(freqHz, MIN_FREQ, MAX_FREQ, 1000);
  const norm = (Math.log10(clamped) - LOG_MIN) / (LOG_MAX - LOG_MIN);
  return PAD_L + norm * PLOT_W;
}

function xToFreq(x: number): number {
  const norm = clampFinite((x - PAD_L) / PLOT_W, 0, 1, 0.5);
  return Math.pow(10, LOG_MIN + norm * (LOG_MAX - LOG_MIN));
}

function dbToY(db: number): number {
  const clamped = clampFinite(db, MIN_DB, MAX_DB, 0);
  const norm = (MAX_DB - clamped) / (MAX_DB - MIN_DB);
  return PAD_T + norm * PLOT_H;
}

function yToDb(y: number): number {
  const norm = clampFinite((y - PAD_T) / PLOT_H, 0, 1, 0.5);
  return MAX_DB - norm * (MAX_DB - MIN_DB);
}

export function FrequencyResponseGraph({
  slot,
  eqEnabled,
  sampleRate,
  spectrumEnabled,
  spectrumActive,
  reducedMotion,
  accentHex,
  accentGlowRgb,
  selectedParametricIndex,
  onSelectParametricIndex,
  onGraphicBandChange,
  onGraphicBandReset,
  onParametricBandChange,
  onParametricBandReset,
}: FrequencyResponseGraphProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<{
    mode: 'graphic' | 'parametric';
    index: number;
  } | null>(null);
  const [hoverCoord, setHoverCoord] = useState<{
    x: number;
    y: number;
    freqHz: number;
    db: number;
  } | null>(null);

  // Compute the configured curve (always computed for preview/ghosting when bypassed)
  const activeResponse = useMemo(
    () => computeCompositeFrequencyResponse(slot, true, sampleRate, 180),
    [slot, sampleRate],
  );

  const zeroY = dbToY(0);

  const { eqPath, totalPath, fillPath } = useMemo(() => {
    const pts = activeResponse.points;
    if (pts.length === 0) {
      return { eqPath: '', totalPath: '', fillPath: '' };
    }
    const eqCoords = pts.map((p) => `${freqToX(p.frequencyHz).toFixed(2)},${dbToY(p.eqDb).toFixed(2)}`);
    const totalCoords = pts.map(
      (p) => `${freqToX(p.frequencyHz).toFixed(2)},${dbToY(p.totalDb).toFixed(2)}`,
    );
    const firstX = freqToX(pts[0].frequencyHz).toFixed(2);
    const lastX = freqToX(pts[pts.length - 1].frequencyHz).toFixed(2);
    const lineTotal = `M ${totalCoords.join(' L ')}`;
    return {
      eqPath: `M ${eqCoords.join(' L ')}`,
      totalPath: lineTotal,
      fillPath: `${lineTotal} L ${lastX},${zeroY.toFixed(2)} L ${firstX},${zeroY.toFixed(2)} Z`,
    };
  }, [activeResponse.points, zeroY]);

  const hasPreampOffset = Math.abs(activeResponse.headroom.effectivePreampDb) >= 0.05;

  // Live FFT Spectrum Canvas Overlay (strictly guarded: desktop DSP active + visible + !reducedMotion)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      return;
    }

    const clearCanvas = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };

    if (!spectrumEnabled || !spectrumActive || reducedMotion) {
      clearCanvas();
      return;
    }

    const binCount = playerActions.getAnalyserBinCount();
    if (binCount <= 0) {
      clearCanvas();
      return;
    }

    const freqData = new Uint8Array(binCount);
    const nyquist = Math.max(8000, sampleRate / 2);
    let rafId = 0;
    let lastDrawMs = 0;
    const barCount = 56;

    const draw = (nowMs: number) => {
      rafId = window.requestAnimationFrame(draw);
      if (document.hidden || nowMs - lastDrawMs < 33) {
        return;
      }
      lastDrawMs = nowMs;

      const ok = playerActions.readSpectrumData(freqData);
      clearCanvas();
      if (!ok) {
        return;
      }

      const scaleX = canvas.width / VIEW_W;
      const scaleY = canvas.height / VIEW_H;
      const plotLeft = PAD_L * scaleX;
      const plotTop = PAD_T * scaleY;
      const plotWidth = PLOT_W * scaleX;
      const plotHeight = PLOT_H * scaleY;
      const barWidth = Math.max(2, plotWidth / barCount - 2);

      ctx.fillStyle = `rgba(${accentGlowRgb}, 0.19)`;

      for (let i = 0; i < barCount; i += 1) {
        const t0 = i / barCount;
        const t1 = (i + 1) / barCount;
        const f0 = Math.pow(10, LOG_MIN + t0 * (LOG_MAX - LOG_MIN));
        const f1 = Math.pow(10, LOG_MIN + t1 * (LOG_MAX - LOG_MIN));
        const b0 = Math.max(0, Math.min(binCount - 1, Math.floor((f0 / nyquist) * binCount)));
        const b1 = Math.max(b0, Math.min(binCount - 1, Math.ceil((f1 / nyquist) * binCount)));

        let peak = 0;
        for (let b = b0; b <= b1; b += 1) {
          if (freqData[b] > peak) {
            peak = freqData[b];
          }
        }
        const norm = peak / 255;
        if (norm <= 0.01) {
          continue;
        }
        const barH = norm * plotHeight * 0.84;
        const x = plotLeft + t0 * plotWidth + 1;
        const y = plotTop + plotHeight - barH;
        ctx.fillRect(x, y, barWidth, barH);
      }
    };

    rafId = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(rafId);
      clearCanvas();
    };
  }, [spectrumEnabled, spectrumActive, reducedMotion, sampleRate, accentGlowRgb]);

  const clientToSvgCoords = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) {
      return null;
    }
    const rect = svg.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) {
      return null;
    }
    const x = ((clientX - rect.left) / rect.width) * VIEW_W;
    const y = ((clientY - rect.top) / rect.height) * VIEW_H;
    return { x, y };
  }, []);

  const handleSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const pt = clientToSvgCoords(e.clientX, e.clientY);
    if (!pt) {
      return;
    }

    const clampedX = clampFinite(pt.x, PAD_L, PAD_L + PLOT_W, PAD_L);
    const clampedY = clampFinite(pt.y, PAD_T, PAD_T + PLOT_H, zeroY);
    const freqHz = xToFreq(clampedX);
    const db = yToDb(clampedY);

    setHoverCoord({ x: clampedX, y: clampedY, freqHz, db });

    if (!draggingHandle) {
      return;
    }

    if (draggingHandle.mode === 'graphic') {
      const snappedDb = roundTo(clampFinite(db, EQ_MIN_GAIN_DB, EQ_MAX_GAIN_DB, 0), 1);
      onGraphicBandChange(draggingHandle.index, snappedDb);
    } else {
      const band = slot.parametricBands[draggingHandle.index];
      if (!band) {
        return;
      }
      const caps = getFilterTypeCapabilities(band.type);
      const safeMax = Math.min(MAX_FREQ, Math.floor(sampleRate * 0.48));
      const nextFreq = roundTo(clampFinite(freqHz, PARAMETRIC_MIN_FREQ_HZ, safeMax, 1000), 1);
      const patch: Partial<ParametricBandConfig> = {
        frequencyHz: nextFreq,
        enabled: true,
      };
      if (caps.hasGain) {
        patch.gainDb = roundTo(clampFinite(db, EQ_MIN_GAIN_DB, EQ_MAX_GAIN_DB, 0), 1);
      }
      onParametricBandChange(draggingHandle.index, patch);
    }
  };

  const handleSvgPointerUp = () => {
    setDraggingHandle(null);
  };

  const handleParametricWheel = (bandIndex: number, e: ReactWheelEvent<SVGGElement>) => {
    const band = slot.parametricBands[bandIndex];
    if (!band) {
      return;
    }
    const caps = getFilterTypeCapabilities(band.type);
    if (!caps.hasQ) {
      return;
    }
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.12 : 0.89;
    const nextQ = roundTo(clampFinite(band.q * factor, PARAMETRIC_MIN_Q, PARAMETRIC_MAX_Q, 1.2), 2);
    onParametricBandChange(bandIndex, { q: nextQ });
  };

  return (
    <div
      data-testid="audio-lab-frequency-graph"
      className="relative overflow-hidden rounded-[22px] border border-[var(--border-glass)] bg-[var(--surface-glass-light)] p-3.5 sm:p-4"
    >
      {/* Top Instrument Telemetry Bar */}
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-[11.5px]">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[var(--text-secondary)]">
          <span className="font-semibold text-[var(--text-primary)]">
            {slot.mode === 'graphic'
              ? 'Đáp tuyến Graphic EQ 10-Band'
              : 'Đáp tuyến Parametric EQ 8-Band'}
          </span>
          <span aria-hidden="true" className="text-[var(--text-muted)]">
            ·
          </span>
          <span className="font-mono-tabular text-[var(--text-muted)]">
            20 Hz – 20 kHz · ±18 dB
          </span>
          {!eqEnabled && (
            <>
              <span aria-hidden="true" className="text-[var(--text-muted)]">
                ·
              </span>
              <span className="font-medium text-amber-600 dark:text-amber-300">
                Đang Bypass (0.0 dB phẳng)
              </span>
            </>
          )}
        </div>

        <div className="font-mono-tabular flex items-center gap-3 text-[11.5px] text-[var(--text-secondary)]">
          {hoverCoord ? (
            <span data-testid="graph-cursor-readout">
              {formatFrequencyLabel(hoverCoord.freqHz)} · {formatDbLabel(hoverCoord.db, 1)}
            </span>
          ) : (
            <span className="text-[var(--text-muted)]">
              {slot.mode === 'parametric'
                ? 'Kéo điểm để chỉnh Hz/dB · Cuộn chuột chỉnh Q · Nhấp đúp reset'
                : 'Kéo điểm trên biểu đồ hoặc thanh trượt bên dưới · Nhấp đúp reset'}
            </span>
          )}
        </div>
      </div>

      {/* Layered Spectrum Canvas + Interactive SVG Bode Plot */}
      <div className="relative aspect-[860/264] w-full select-none">
        <canvas
          ref={canvasRef}
          width={VIEW_W}
          height={VIEW_H}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 h-full w-full"
        />

        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          role="img"
          aria-label="Biểu đồ đáp tuyến tần số Equalizer từ 20 Hz đến 20 kHz"
          onPointerMove={handleSvgPointerMove}
          onPointerUp={handleSvgPointerUp}
          onPointerCancel={handleSvgPointerUp}
          onPointerLeave={() => {
            setHoverCoord(null);
            setDraggingHandle(null);
          }}
          className="relative z-10 h-full w-full touch-none overflow-visible"
        >
          <defs>
            <linearGradient id="doremi-eq-area-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={accentHex} stopOpacity={eqEnabled ? 0.28 : 0.08} />
              <stop offset="50%" stopColor={accentHex} stopOpacity={eqEnabled ? 0.07 : 0.02} />
              <stop offset="100%" stopColor={accentHex} stopOpacity={eqEnabled ? 0.22 : 0.06} />
            </linearGradient>
            <clipPath id="doremi-eq-plot-clip">
              <rect x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H} rx={6} />
            </clipPath>
          </defs>

          {/* Plot Frame */}
          <rect
            x={PAD_L}
            y={PAD_T}
            width={PLOT_W}
            height={PLOT_H}
            rx={6}
            fill="transparent"
            stroke="var(--border-subtle)"
            strokeWidth={1}
          />

          {/* Horizontal dB Gridlines */}
          {DB_TICKS.map((db) => {
            const y = dbToY(db);
            const isZero = db === 0;
            return (
              <g key={db}>
                <line
                  x1={PAD_L}
                  y1={y}
                  x2={PAD_L + PLOT_W}
                  y2={y}
                  stroke={isZero ? 'var(--border-glass)' : 'var(--border-subtle)'}
                  strokeWidth={isZero ? 1.25 : 0.75}
                  strokeDasharray={isZero ? undefined : '2 4'}
                />
                <text
                  x={PAD_L - 8}
                  y={y + 3.5}
                  textAnchor="end"
                  fill="var(--text-muted)"
                  fontSize="10.5"
                  className="font-mono-tabular"
                >
                  {db > 0 ? `+${db}` : `${db}`}
                </text>
              </g>
            );
          })}

          {/* Vertical Logarithmic Frequency Gridlines */}
          {FREQ_TICKS.map((freq) => {
            const x = freqToX(freq);
            return (
              <g key={freq}>
                <line
                  x1={x}
                  y1={PAD_T}
                  x2={x}
                  y2={PAD_T + PLOT_H}
                  stroke="var(--border-subtle)"
                  strokeWidth={0.75}
                  strokeDasharray="2 4"
                />
                <text
                  x={x}
                  y={VIEW_H - 12}
                  textAnchor="middle"
                  fill="var(--text-muted)"
                  fontSize="10.5"
                  className="font-mono-tabular"
                >
                  {freq >= 1000 ? `${freq / 1000}k` : `${freq}`}
                </text>
              </g>
            );
          })}

          {/* Hover Crosshair */}
          {hoverCoord && (
            <g className="pointer-events-none">
              <line
                x1={hoverCoord.x}
                y1={PAD_T}
                x2={hoverCoord.x}
                y2={PAD_T + PLOT_H}
                stroke="var(--border-glass)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
              <line
                x1={PAD_L}
                y1={hoverCoord.y}
                x2={PAD_L + PLOT_W}
                y2={hoverCoord.y}
                stroke="var(--border-glass)"
                strokeWidth={1}
                strokeDasharray="3 3"
              />
            </g>
          )}

          {/* Clipped Response Curves */}
          <g clipPath="url(#doremi-eq-plot-clip)">
            {/* Subtle Pure-EQ Dashed Reference when Preamp / Auto Headroom shifts total curve */}
            {hasPreampOffset && (
              <path
                d={eqPath}
                fill="none"
                stroke="var(--text-muted)"
                strokeWidth={1.25}
                strokeDasharray="4 4"
                opacity={eqEnabled ? 0.65 : 0.25}
              />
            )}

            {/* Area Fill */}
            <path d={fillPath} fill="url(#doremi-eq-area-fill)" />

            {/* Main Composite Frequency Response Curve */}
            <path
              d={totalPath}
              data-testid="frequency-response-curve"
              fill="none"
              stroke={accentHex}
              strokeWidth={eqEnabled ? 2.4 : 1.5}
              strokeDasharray={eqEnabled ? undefined : '6 4'}
              strokeLinecap="round"
              strokeLinejoin="round"
              opacity={eqEnabled ? 1 : 0.4}
            />

            {/* Flat Unity Reference Line when Bypassed */}
            {!eqEnabled && (
              <line
                x1={PAD_L}
                y1={zeroY}
                x2={PAD_L + PLOT_W}
                y2={zeroY}
                stroke="var(--text-primary)"
                strokeWidth={1.8}
                opacity={0.75}
              />
            )}
          </g>

          {/* Interactive Band Control Points */}
          {slot.mode === 'graphic'
            ? GRAPHIC_EQ_FREQUENCIES.map((freq, idx) => {
                const gain = slot.graphicGainsDb[idx] ?? 0;
                const cx = freqToX(freq);
                const cy = dbToY(gain);
                const isDragging =
                  draggingHandle?.mode === 'graphic' && draggingHandle.index === idx;
                return (
                  <g
                    key={freq}
                    data-testid={`graph-graphic-node-${idx}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                      setDraggingHandle({ mode: 'graphic', index: idx });
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onGraphicBandReset(idx);
                    }}
                    className="cursor-ns-resize"
                  >
                    <circle cx={cx} cy={cy} r={13} fill="transparent" />
                    <circle
                      cx={cx}
                      cy={cy}
                      r={isDragging ? 6.5 : 5}
                      fill={eqEnabled ? accentHex : 'var(--bg-elevated)'}
                      stroke="var(--bg-deep)"
                      strokeWidth={2}
                      opacity={eqEnabled ? 1 : 0.55}
                    />
                  </g>
                );
              })
            : slot.parametricBands.map((band, idx) => {
                const caps = getFilterTypeCapabilities(band.type);
                const cx = freqToX(band.frequencyHz);
                const cy = dbToY(caps.hasGain ? band.gainDb : 0);
                const isSelected = selectedParametricIndex === idx;
                const isDragging =
                  draggingHandle?.mode === 'parametric' && draggingHandle.index === idx;
                return (
                  <g
                    key={band.id}
                    data-testid={`graph-parametric-node-${idx}`}
                    onPointerDown={(e) => {
                      e.stopPropagation();
                      e.currentTarget.setPointerCapture?.(e.pointerId);
                      onSelectParametricIndex(idx);
                      setDraggingHandle({ mode: 'parametric', index: idx });
                    }}
                    onDoubleClick={(e) => {
                      e.stopPropagation();
                      onParametricBandReset(idx);
                    }}
                    onWheel={(e) => handleParametricWheel(idx, e)}
                    className="cursor-grab active:cursor-grabbing"
                  >
                    <circle cx={cx} cy={cy} r={16} fill="transparent" />
                    <circle
                      cx={cx}
                      cy={cy}
                      r={isDragging || isSelected ? 11 : 9}
                      fill={
                        band.enabled && eqEnabled
                          ? accentHex
                          : 'var(--bg-elevated)'
                      }
                      stroke={isSelected ? 'var(--text-primary)' : 'var(--bg-deep)'}
                      strokeWidth={isSelected ? 2 : 1.75}
                      opacity={band.enabled ? (eqEnabled ? 1 : 0.55) : 0.45}
                    />
                    <text
                      x={cx}
                      y={cy + 3.5}
                      textAnchor="middle"
                      fontSize="9.5"
                      fontWeight="700"
                      fill={
                        band.enabled && eqEnabled
                          ? 'var(--user-accent-on)'
                          : 'var(--text-muted)'
                      }
                      className="font-mono-tabular pointer-events-none select-none"
                    >
                      {idx + 1}
                    </text>
                  </g>
                );
              })}
        </svg>
      </div>
    </div>
  );
}
