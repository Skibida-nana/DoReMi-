import { memo, useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import type { VinylSwapPhase } from '../stores/ui-store';
import {
  clampUnit,
  computeCircularProgressArc,
  pointerToCircularRatio,
} from '../utils/circular-progress';
import { formatDurationSeconds } from '../utils/formatters';
import {
  TONEARM_PIVOT_X,
  TONEARM_PIVOT_Y,
  VINYL_CENTER_X,
  VINYL_DECK_RADIUS,
  VINYL_DISC_RADIUS,
  VINYL_LABEL_RADIUS,
  VINYL_PLATTER_RADIUS,
  VINYL_RING_RADIUS,
  VINYL_VIEWBOX_HEIGHT,
  VINYL_VIEWBOX_WIDTH,
  computeVinylTonearmGeometry,
} from '../utils/vinyl-geometry';
import type { PhysicalVinylPhase } from '../utils/vinyl-swap-controller';

import type { UiQualityPreset } from '../../../shared/types/stage5';

export type StoryboardFrameNumber = 1 | 2 | 3 | 4 | 5 | 6;

interface VinylTurntableProps {
  coverUrl: string;
  albumTitle: string;
  accentColor: string;
  glowRgb: string;
  isPlaying: boolean;
  /** Square diameter of the circular progress ring canvas in px */
  sizePx?: number;
  themeMode?: 'dark' | 'light';
  qualityPreset?: UiQualityPreset;
  swapPhase?: PhysicalVinylPhase | VinylSwapPhase;
  storyboardFrame?: StoryboardFrameNumber;
  vinylAnimationEnabled?: boolean;
  reducedMotion?: boolean;
  /** Concentric interactive thin circular progress ring */
  showProgressRing?: boolean;
  progressPct?: number;
  currentTimeSec?: number;
  durationSec?: number;
  onSeek?: (timeSec: number) => void;
}

function normalizePhase(
  phase: PhysicalVinylPhase | VinylSwapPhase | undefined,
  storyboardFrame?: StoryboardFrameNumber,
): PhysicalVinylPhase {
  if (storyboardFrame) {
    const map: Record<StoryboardFrameNumber, PhysicalVinylPhase> = {
      1: 'idle',
      2: 'tonearm-lift',
      3: 'disc-lift',
      4: 'empty-platter',
      5: 'disc-enter',
      6: 'idle',
    };
    return map[storyboardFrame];
  }
  switch (phase) {
    case 'disc-out':
      return 'disc-exit';
    case 'disc-in':
      return 'disc-enter';
    case 'tonearm-lift':
    case 'disc-lift':
    case 'disc-exit':
    case 'empty-platter':
    case 'disc-enter':
    case 'disc-settle':
    case 'tonearm-drop':
      return phase;
    default:
      return 'idle';
  }
}

/**
 * Hi-Fi Audiophile Vinyl Turntable with Delicate Thin Circular Progress Ring
 * and Mathematically Anchored Right-Side Tonearm:
 * - Single shared normalized coordinate system (1100 × 1000, vinyl center at 500, 500)
 * - Guarantees stylus rests squarely on playable vinyl grooves at every viewport
 * - Pearl-silver audiophile pressing in Light Mode; deep pressed obsidian LP in Dark Mode
 * - Preserves single permanent GPU rotor node (zero angle jump on pause/resume) & 8-step swap
 */
export const VinylTurntable = memo(function VinylTurntable({
  coverUrl,
  albumTitle,
  accentColor,
  glowRgb,
  isPlaying,
  sizePx = 560,
  themeMode = 'dark',
  qualityPreset = 'balanced',
  swapPhase = 'idle',
  storyboardFrame,
  vinylAnimationEnabled = true,
  reducedMotion = false,
  showProgressRing = false,
  progressPct = 0,
  currentTimeSec = 0,
  durationSec = 0,
  onSeek,
}: VinylTurntableProps) {
  const effectivePhase = normalizePhase(swapPhase, storyboardFrame);
  const ringSvgRef = useRef<SVGSVGElement | null>(null);
  const [isDraggingRing, setIsDraggingRing] = useState(false);
  const [dragPreviewRatio, setDragPreviewRatio] = useState<number | null>(null);

  const isLight = themeMode === 'light';
  const isPowerSaver = qualityPreset === 'power-saver';

  const isTonearmSwappingOff =
    effectivePhase === 'tonearm-lift' ||
    effectivePhase === 'disc-lift' ||
    effectivePhase === 'disc-exit' ||
    effectivePhase === 'empty-platter' ||
    effectivePhase === 'disc-enter' ||
    effectivePhase === 'disc-settle';

  const isEmptyPlatter = effectivePhase === 'empty-platter';
  const isDiscLifting = effectivePhase === 'disc-lift';
  const isDiscExiting = effectivePhase === 'disc-exit';
  const isDiscEntering = effectivePhase === 'disc-enter';
  const isDiscSettling = effectivePhase === 'disc-settle';

  // Rotation runs strictly from actual playback status when seated on platter
  const shouldSpin =
    !storyboardFrame &&
    isPlaying &&
    effectivePhase === 'idle' &&
    vinylAnimationEnabled &&
    !reducedMotion;

  // Physical elevation & departure transforms for the 8-step swap sequence
  let discTransform = 'translate3d(0, 0, 0) scale(1)';
  let discOpacity = 1;
  let discShadow = isLight
    ? '0 14px 32px rgba(24, 26, 32, 0.14), 0 3px 10px rgba(24, 26, 32, 0.08)'
    : '0 18px 38px rgba(0, 0, 0, 0.72), 0 4px 12px rgba(0, 0, 0, 0.56)';
  let discTransition =
    'transform 170ms cubic-bezier(0.22, 1, 0.36, 1), opacity 150ms ease, box-shadow 170ms ease';

  if (isDiscLifting) {
    discTransform = 'translate3d(-4px, -18px, 0) scale(1.032)';
    discOpacity = 0.94;
    discShadow = isLight
      ? '0 28px 50px rgba(24, 26, 32, 0.18), 0 8px 18px rgba(24, 26, 32, 0.10)'
      : '0 34px 58px rgba(0, 0, 0, 0.72), 0 12px 24px rgba(0, 0, 0, 0.5)';
  } else if (isDiscExiting) {
    discTransform = 'translate3d(-18px, -52px, 0) scale(1.055)';
    discOpacity = 0;
    discShadow = '0 44px 66px rgba(0, 0, 0, 0.24)';
    discTransition =
      'transform 150ms cubic-bezier(0.4, 0, 1, 1), opacity 140ms ease, box-shadow 150ms ease';
  } else if (isEmptyPlatter) {
    discTransform = 'translate3d(14px, -52px, 0) scale(1.05)';
    discOpacity = 0;
    discShadow = 'none';
    discTransition = 'none';
  } else if (isDiscEntering) {
    discTransform = 'translate3d(4px, -16px, 0) scale(1.028)';
    discOpacity = 0.95;
    discShadow = isLight
      ? '0 26px 46px rgba(24, 26, 32, 0.18), 0 8px 18px rgba(24, 26, 32, 0.10)'
      : '0 32px 54px rgba(0, 0, 0, 0.72), 0 10px 22px rgba(0, 0, 0, 0.48)';
    discTransition =
      'transform 180ms cubic-bezier(0.16, 1, 0.3, 1), opacity 140ms ease, box-shadow 180ms ease';
  } else if (isDiscSettling) {
    discTransform = 'translate3d(0, 0, 0) scale(1)';
    discOpacity = 1;
    discTransition = 'transform 110ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 110ms ease';
  }

  // Exact pixel proportions derived from shared 1100 × 1000 coordinate system
  const unitScale = sizePx / VINYL_VIEWBOX_HEIGHT;
  const ringCanvasSize = sizePx;
  const stageWidth = Math.round(VINYL_VIEWBOX_WIDTH * unitScale);
  const stageHeight = sizePx;
  const deckDiameter = Math.round(VINYL_DECK_RADIUS * 2 * unitScale);
  const platterDiameter = Math.round(VINYL_PLATTER_RADIUS * 2 * unitScale);
  const discDiameter = Math.round(VINYL_DISC_RADIUS * 2 * unitScale);
  const labelDiameter = Math.round(VINYL_LABEL_RADIUS * 2 * unitScale);

  // Circular Progress Ring SVG math (viewBox 0..ringCanvasSize)
  const ringCenter = VINYL_CENTER_X * unitScale;
  const ringRadius = VINYL_RING_RADIUS * unitScale;
  const effectiveRatio =
    dragPreviewRatio !== null ? dragPreviewRatio : clampUnit(progressPct / 100);
  const arc = computeCircularProgressArc(effectiveRatio, ringRadius, ringCenter);

  // Mathematically locked right-side tonearm geometry (stylus guaranteed on grooves when playing)
  const tonearm = computeVinylTonearmGeometry({
    isPlaying,
    isSwappingOff: isTonearmSwappingOff,
    progressRatio: effectiveRatio,
    forceOnGroove: Boolean(storyboardFrame),
  });
  const tonearmLiftScale = isTonearmSwappingOff ? 1.028 : isPlaying || storyboardFrame ? 1 : 1.012;

  const computeRatioFromPointerEvent = useCallback(
    (event: ReactPointerEvent<SVGElement>): number | null => {
      const svg = ringSvgRef.current;
      if (!svg) return null;
      const rect = svg.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      return pointerToCircularRatio(event.clientX, event.clientY, centerX, centerY);
    },
    [],
  );

  const handleRingPointerDown = (event: ReactPointerEvent<SVGCircleElement>) => {
    if (!onSeek || durationSec <= 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const ratio = computeRatioFromPointerEvent(event);
    if (ratio !== null) {
      setIsDraggingRing(true);
      setDragPreviewRatio(ratio);
      onSeek(ratio * durationSec);
    }
  };

  const handleRingPointerMove = (event: ReactPointerEvent<SVGCircleElement>) => {
    if (!isDraggingRing || !onSeek || durationSec <= 0) return;
    const ratio = computeRatioFromPointerEvent(event);
    if (ratio !== null) {
      setDragPreviewRatio(ratio);
      onSeek(ratio * durationSec);
    }
  };

  const handleRingPointerUp = (event: ReactPointerEvent<SVGCircleElement>) => {
    if (!isDraggingRing) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDraggingRing(false);
    setDragPreviewRatio(null);
  };

  const previewTimeSec =
    dragPreviewRatio !== null && durationSec > 0 ? dragPreviewRatio * durationSec : currentTimeSec;

  return (
    <div
      data-testid="vinyl-turntable"
      data-phase={effectivePhase}
      data-playing={shouldSpin ? 'true' : 'false'}
      data-tonearm-angle={tonearm.angleDeg.toFixed(1)}
      data-needle-on-grooves={tonearm.isNeedleOnGrooves ? 'true' : 'false'}
      data-needle-radius={String(Math.round(tonearm.needleRadiusFromCenter))}
      className="relative flex shrink-0 select-none items-center justify-start"
      style={{
        width: `${stageWidth}px`,
        height: `${stageHeight}px`,
        transition: reducedMotion ? 'none' : 'width 360ms cubic-bezier(0.22, 1, 0.36, 1), height 360ms cubic-bezier(0.22, 1, 0.36, 1)',
      }}
      aria-label={`Mâm đĩa than: ${albumTitle}`}
    >
      {/* Subtle restrained studio aura behind platter (skipped in Power Saver for zero overdraw) */}
      {!isPowerSaver && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full transition-colors duration-700"
          style={{
            width: `${Math.round(ringCanvasSize * 1.12)}px`,
            height: `${Math.round(ringCanvasSize * 1.12)}px`,
            left: `${-Math.round(ringCanvasSize * 0.06)}px`,
            top: `${-Math.round(ringCanvasSize * 0.06)}px`,
            opacity: isLight ? 0.36 : 0.52,
            background: isLight
              ? `radial-gradient(circle at 48% 50%, rgba(${glowRgb}, 0.14) 0%, rgba(${glowRgb}, 0.04) 44%, rgba(245,245,243,0) 70%)`
              : `radial-gradient(circle at 48% 50%, rgba(${glowRgb}, 0.22) 0%, rgba(${glowRgb}, 0.06) 44%, rgba(16,17,20,0) 72%)`,
          }}
        />
      )}

      {/* Centered Platter + Delicate Thin Circular Progress Ring Wrapper */}
      <div
        className="relative flex shrink-0 items-center justify-center"
        style={{ width: `${ringCanvasSize}px`, height: `${ringCanvasSize}px` }}
      >
        {/* Layer 0: Delicate Thin Concentric Circular Progress Ring (2.4px stroke, round cap, crisp indicator) */}
        {showProgressRing && (
          <svg
            ref={ringSvgRef}
            data-testid="vinyl-circular-progress"
            viewBox={`0 0 ${ringCanvasSize} ${ringCanvasSize}`}
            width={ringCanvasSize}
            height={ringCanvasSize}
            className="pointer-events-none absolute inset-0 z-15 overflow-visible"
            aria-hidden="false"
            role="slider"
            aria-label="Vòng tiến độ phát nhạc"
            aria-valuemin={0}
            aria-valuemax={Math.round(durationSec)}
            aria-valuenow={Math.round(previewTimeSec)}
          >
            {/* Delicate low-contrast base circular track */}
            <circle
              data-testid="vinyl-circular-progress-track"
              cx={ringCenter}
              cy={ringCenter}
              r={ringRadius}
              fill="none"
              stroke="var(--np-ring-track)"
              strokeWidth="1.8"
            />

            {/* Effective Now Playing Accent Active Progress Arc (12 o'clock clockwise) */}
            <circle
              data-testid="vinyl-circular-progress-arc"
              cx={ringCenter}
              cy={ringCenter}
              r={ringRadius}
              fill="none"
              stroke={accentColor}
              strokeWidth={isDraggingRing ? '3.2' : '2.4'}
              strokeLinecap="round"
              strokeDasharray={arc.circumference}
              strokeDashoffset={arc.dashOffset}
              transform={`rotate(-90 ${ringCenter} ${ringCenter})`}
              style={{
                transition: isDraggingRing ? 'none' : 'stroke-dashoffset 180ms linear',
              }}
            />

            {/* Refined Hi-Fi Hollow Ring Indicator Handle */}
            <circle
              data-testid="vinyl-circular-progress-handle"
              cx={arc.handleX}
              cy={arc.handleY}
              r={isDraggingRing ? 6.8 : 5.2}
              fill={isLight ? '#F5F5F3' : '#101114'}
              stroke={isLight ? '#222326' : accentColor}
              strokeWidth="2.2"
              style={{
                transition: isDraggingRing ? 'none' : 'cx 180ms linear, cy 180ms linear',
              }}
            />

            {/* Generous Invisible Hit Ring for Effortless Click & Drag Seeking */}
            {onSeek && durationSec > 0 && (
              <circle
                data-testid="vinyl-circular-progress-hit"
                cx={ringCenter}
                cy={ringCenter}
                r={ringRadius}
                fill="none"
                stroke="transparent"
                strokeWidth="24"
                className="pointer-events-auto cursor-pointer"
                onPointerDown={handleRingPointerDown}
                onPointerMove={handleRingPointerMove}
                onPointerUp={handleRingPointerUp}
                onPointerCancel={handleRingPointerUp}
              />
            )}
          </svg>
        )}

        {/* Dragging Timestamp Readout Badge */}
        {showProgressRing && isDraggingRing && (
          <div
            data-testid="vinyl-circular-seek-tooltip"
            className="lp-glass-pill font-mono-tabular pointer-events-none absolute top-2 left-1/2 z-30 -translate-x-1/2 rounded-full px-3 py-1 text-[11.5px] font-semibold text-[var(--text-primary)]"
          >
            {formatDurationSeconds(previewTimeSec)} / {formatDurationSeconds(durationSec)}
          </div>
        )}

        {/* Layer 1: Sculpted Deck Rim */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute rounded-full"
          style={{
            width: `${deckDiameter}px`,
            height: `${deckDiameter}px`,
            background: isLight
              ? 'radial-gradient(circle at 32% 28%, #FFFFFF 0%, #EFEFED 66%, #E2E2DE 100%)'
              : 'radial-gradient(circle at 36% 30%, rgba(44, 48, 59, 0.78) 0%, rgba(20, 22, 29, 0.90) 65%, rgba(10, 12, 16, 0.96) 100%)',
            border: isLight
              ? '1px solid rgba(34, 35, 38, 0.08)'
              : '1px solid rgba(255, 255, 255, 0.07)',
            boxShadow: isLight
              ? '0 18px 40px rgba(20, 22, 28, 0.08), inset 0 1px 2px rgba(255, 255, 255, 0.95)'
              : '0 26px 56px rgba(0, 0, 0, 0.56), 0 8px 20px rgba(0, 0, 0, 0.36), inset 0 1px 1px rgba(255, 255, 255, 0.12)',
          }}
        />

        {/* Layer 2: Machined Platter */}
        <div
          data-testid="vinyl-platter"
          className="relative z-10 flex shrink-0 items-center justify-center rounded-full"
          style={{
            width: `${platterDiameter}px`,
            height: `${platterDiameter}px`,
            background: isLight
              ? 'radial-gradient(circle at 32% 28%, #FAFAF8 0%, #ECECE9 54%, #DFDFDB 92%, #EAEAE7 100%)'
              : `radial-gradient(circle at 32% 28%, #474D5B 0%, #292D37 28%, #181B22 62%, #101218 82%, #353A46 96%, #1B1E26 100%)`,
            boxShadow: isLight
              ? 'inset 0 2px 6px rgba(255, 255, 255, 0.9), inset 0 -4px 12px rgba(24, 26, 32, 0.08)'
              : '0 14px 32px rgba(0, 0, 0, 0.68), inset 0 2px 5px rgba(255, 255, 255, 0.2), inset 0 -8px 18px rgba(0, 0, 0, 0.76)',
          }}
        >
          {/* Outer platter chamfer ring */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-[2%] rounded-full"
            style={{
              border: isLight
                ? '1px solid rgba(34, 35, 38, 0.07)'
                : '1px dashed rgba(255, 255, 255, 0.18)',
            }}
          />

          {/* Platter mat (visible during empty-platter disc swap phase) */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-[5.5%] rounded-full"
            style={{
              background: isLight
                ? 'radial-gradient(circle at center, #EAEAE6 0%, #E2E2DE 100%)'
                : 'repeating-radial-gradient(circle at center, rgba(255,255,255,0.04) 0px, rgba(255,255,255,0.04) 1.2px, #13151B 2px, #13151B 9px)',
              border: isLight
                ? '1px solid rgba(34, 35, 38, 0.06)'
                : '1px solid rgba(255, 255, 255, 0.07)',
            }}
          />

          {/* Recessed center platter hub & spindle pin */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute flex h-[28%] w-[28%] items-center justify-center rounded-full"
            style={{
              background: isLight
                ? 'linear-gradient(145deg, #F4F4F1, #DCDCD8)'
                : 'linear-gradient(145deg, #232730, #12141A)',
              border: isLight
                ? '1px solid rgba(34, 35, 38, 0.12)'
                : '1px solid rgba(255, 255, 255, 0.1)',
            }}
          >
            <div className="h-[18%] w-[18%] rounded-full bg-gradient-to-br from-[#F2F5FA] via-[#9BA3B4] to-[#4A505E] shadow" />
          </div>

          {/* Layer 3..6: Physical Vinyl Disc + Grooves + Rotating Circular Label + Center Spindle */}
          <div
            data-testid="vinyl-disc-layer"
            data-phase={effectivePhase}
            className="relative flex items-center justify-center rounded-full"
            style={{
              width: `${discDiameter}px`,
              height: `${discDiameter}px`,
              transform: discTransform,
              opacity: discOpacity,
              boxShadow: discShadow,
              transition: discTransition,
              pointerEvents: isEmptyPlatter ? 'none' : 'auto',
            }}
          >
            {/* Single Permanent GPU Rotor Element: NEVER swapped on Pause/Resume */}
            <div
              data-testid="vinyl-rotor"
              className="lp-vinyl-rotor relative flex h-full w-full items-center justify-center rounded-full"
              style={{
                animationPlayState: shouldSpin ? 'running' : 'paused',
                willChange: shouldSpin ? 'transform' : 'auto',
                background: isLight
                  ? `radial-gradient(circle at center,
                      #EAEAE7 0%,
                      #F5F5F2 34%,
                      #E6E6E2 35.5%,
                      #F8F8F5 36.4%,
                      #EDEDEA 52%,
                      #F6F6F3 53%,
                      #E9E9E6 69%,
                      #F7F7F4 70%,
                      #EBEBE7 87%,
                      #F5F5F2 96.5%,
                      #DFDFDA 100%
                    )`
                  : `radial-gradient(circle at center,
                      #090A0C 0%,
                      #111318 33%,
                      #0A0B0E 35.5%,
                      #151820 36.2%,
                      #0C0E12 52%,
                      #161922 52.8%,
                      #0B0D11 69%,
                      #161922 69.8%,
                      #0D0F14 86%,
                      #1A1E28 96.5%,
                      #08090C 100%
                    )`,
                border: isLight
                  ? '1px solid rgba(34, 35, 38, 0.13)'
                  : '1px solid rgba(255, 255, 255, 0.11)',
              }}
            >
              {/* Layer 4A: Fine pressed LP micro-grooves */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-[2.4%] rounded-full"
                style={{
                  opacity: isLight ? 0.85 : 0.72,
                  background: isLight
                    ? 'repeating-radial-gradient(circle at center, transparent 0px, transparent 1.7px, rgba(30, 34, 42, 0.055) 2.15px, transparent 3px)'
                    : 'repeating-radial-gradient(circle at center, transparent 0px, transparent 1.7px, rgba(255, 255, 255, 0.055) 2.2px, transparent 3px)',
                }}
              />

              {/* Layer 4B: Realistic LP track-band dividers & inner run-out groove */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-[14%] rounded-full"
                style={{
                  border: isLight
                    ? '1px solid rgba(34, 35, 38, 0.06)'
                    : '1px solid rgba(255, 255, 255, 0.06)',
                }}
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-[26%] rounded-full"
                style={{
                  border: isLight
                    ? '1px solid rgba(34, 35, 38, 0.055)'
                    : '1px solid rgba(255, 255, 255, 0.055)',
                }}
              />
              <div
                aria-hidden="true"
                className="pointer-events-none absolute inset-[33.2%] rounded-full"
                style={{
                  border: isLight
                    ? '1px solid rgba(34, 35, 38, 0.09)'
                    : '1px solid rgba(255, 255, 255, 0.09)',
                }}
              />

              {/* Layer 5: Circular Album Artwork Center Label (rotates WITH vinyl) */}
              <div
                data-testid="vinyl-artwork-label"
                className="relative overflow-hidden rounded-full"
                style={{
                  width: `${labelDiameter}px`,
                  height: `${labelDiameter}px`,
                  border: isLight ? '2.5px solid #222326' : '2.5px solid #090A0D',
                  boxShadow: isLight
                    ? '0 0 0 2px rgba(255,255,255,0.75), 0 4px 14px rgba(20,22,28,0.18)'
                    : '0 0 0 2px rgba(255,255,255,0.14), 0 4px 14px rgba(0,0,0,0.75)',
                }}
              >
                <img
                  src={coverUrl}
                  alt={albumTitle}
                  onError={(e) => {
                    const img = e.currentTarget;
                    if (img.dataset.fallbackApplied !== '1') {
                      img.dataset.fallbackApplied = '1';
                      img.src = DEFAULT_DOREMI_ARTWORK_URL;
                    }
                  }}
                  className="h-full w-full scale-[1.08] object-cover"
                />
                {/* Pressed paper label ridge & subtle studio highlight */}
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-[6%] rounded-full border border-white/18"
                />
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0 rounded-full"
                  style={{
                    background:
                      'radial-gradient(circle at 30% 24%, rgba(255,255,255,0.2) 0%, transparent 52%, rgba(0,0,0,0.3) 100%)',
                  }}
                />
                {/* Layer 6: Center Spindle Hole & Machined Pin */}
                <div className="pointer-events-none absolute top-1/2 left-1/2 flex h-[15%] w-[15%] -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full border border-white/45 bg-[#12141A] shadow-[inset_0_1px_3px_rgba(0,0,0,0.85)]">
                  <div className="h-[52%] w-[52%] rounded-full bg-gradient-to-br from-[#F4F6FA] via-[#A4ACBC] to-[#4E5563]" />
                </div>
              </div>
            </div>

            {/* Layer 8B: Stationary Studio Specular Reflection Across Moving Grooves */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 rounded-full"
              style={{
                opacity: isLight ? 0.65 : 0.5,
                mixBlendMode: isLight ? 'normal' : 'screen',
                background: isLight
                  ? `conic-gradient(from 16deg,
                      transparent 0deg,
                      rgba(255, 255, 255, 0.72) 22deg,
                      rgba(255, 255, 255, 0.18) 44deg,
                      transparent 68deg,
                      transparent 185deg,
                      rgba(255, 255, 255, 0.58) 208deg,
                      rgba(20, 22, 28, 0.03) 232deg,
                      transparent 260deg,
                      transparent 360deg
                    )`
                  : `conic-gradient(from 18deg,
                      transparent 0deg,
                      rgba(255, 255, 255, 0.2) 22deg,
                      rgba(${glowRgb}, 0.13) 40deg,
                      transparent 66deg,
                      transparent 185deg,
                      rgba(255, 255, 255, 0.14) 208deg,
                      rgba(${glowRgb}, 0.1) 224deg,
                      transparent 252deg,
                      transparent 360deg
                    )`,
              }}
            />
          </div>
        </div>
      </div>

      {/*
        Layer 7: Mathematically Locked Right-Side Metallic Tonearm Overlay
        Shares the EXACT 1100 × 1000 coordinate system as the vinyl center (500, 500),
        so at ALL viewports the stylus tip lands strictly on the vinyl grooves when playing
        (r = 341..257 inside [182, 392]), parks cleanly outside the ring when paused,
        and never overlaps the center artwork or right Track Title!
      */}
      <svg
        data-testid="vinyl-tonearm"
        aria-hidden="true"
        viewBox={`0 0 ${VINYL_VIEWBOX_WIDTH} ${VINYL_VIEWBOX_HEIGHT}`}
        className="pointer-events-none absolute inset-0 z-25 h-full w-full overflow-visible"
      >
        <defs>
          <linearGradient id="doremiArmShaftDark" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#7C6850" />
            <stop offset="35%" stopColor="#EEDEC9" />
            <stop offset="68%" stopColor="#C1A17C" />
            <stop offset="100%" stopColor="#5D4D3A" />
          </linearGradient>
          <linearGradient id="doremiArmShaftLight" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#6E737D" />
            <stop offset="38%" stopColor="#E6E8EC" />
            <stop offset="70%" stopColor="#9FA5B0" />
            <stop offset="100%" stopColor="#434750" />
          </linearGradient>
          <radialGradient id="doremiPivotBaseDark" cx="35%" cy="30%" r="68%">
            <stop offset="0%" stopColor="#4F5565" />
            <stop offset="52%" stopColor="#232731" />
            <stop offset="100%" stopColor="#0D0F14" />
          </radialGradient>
          <radialGradient id="doremiPivotBaseLight" cx="35%" cy="30%" r="68%">
            <stop offset="0%" stopColor="#FFFFFF" />
            <stop offset="56%" stopColor="#D8DCE2" />
            <stop offset="100%" stopColor="#9AA0AA" />
          </radialGradient>
        </defs>

        {/* Stationary Gimbal Mounting Plate at Upper-Right Pivot (1005, 158) */}
        <g>
          {/* Soft ambient shadow disc beneath mounting plate */}
          <circle
            cx={TONEARM_PIVOT_X + 4}
            cy={TONEARM_PIVOT_Y + 9}
            r="63"
            fill={isLight ? 'rgba(20,22,28,0.12)' : 'rgba(0,0,0,0.48)'}
          />
          <circle
            cx={TONEARM_PIVOT_X}
            cy={TONEARM_PIVOT_Y}
            r="60"
            fill={isLight ? 'url(#doremiPivotBaseLight)' : 'url(#doremiPivotBaseDark)'}
            stroke={isLight ? 'rgba(34,35,38,0.16)' : 'rgba(255,255,255,0.16)'}
            strokeWidth="2.2"
          />
          <circle
            cx={TONEARM_PIVOT_X}
            cy={TONEARM_PIVOT_Y}
            r="42"
            fill={isLight ? '#24272E' : '#151820'}
            stroke={isLight ? 'rgba(255,255,255,0.28)' : 'rgba(193,161,124,0.44)'}
            strokeWidth="2"
          />
          {/* Subtle anti-skate knob */}
          <circle
            cx={TONEARM_PIVOT_X + 46}
            cy={TONEARM_PIVOT_Y - 30}
            r="10"
            fill={isLight ? '#383C45' : '#232732'}
            stroke={isLight ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.2)'}
            strokeWidth="1.6"
          />
        </g>

        {/* Articulated Rotating Arm Assembly Pivoting Strictly Around (1005, 158) */}
        <g
          data-testid="vinyl-tonearm-assembly"
          style={{
            transformOrigin: `${TONEARM_PIVOT_X}px ${TONEARM_PIVOT_Y}px`,
            transform: `rotate(${tonearm.angleDeg}deg) scale(${tonearmLiftScale})`,
            transition: reducedMotion
              ? 'none'
              : 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {/* Rear Counterweight Cylinder above Pivot */}
          <rect
            x={TONEARM_PIVOT_X - 20}
            y={TONEARM_PIVOT_Y - 90}
            width="40"
            height="46"
            rx="9"
            fill={isLight ? '#2D3038' : '#262A34'}
            stroke={isLight ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.2)'}
            strokeWidth="1.8"
          />
          <line
            x1={TONEARM_PIVOT_X - 16}
            y1={TONEARM_PIVOT_Y - 78}
            x2={TONEARM_PIVOT_X + 16}
            y2={TONEARM_PIVOT_Y - 78}
            stroke={isLight ? 'rgba(220,224,232,0.7)' : 'rgba(193,161,124,0.65)'}
            strokeWidth="2.4"
          />

          {/* Gimbal Yoke Bridge */}
          <rect
            x={TONEARM_PIVOT_X - 22}
            y={TONEARM_PIVOT_Y - 22}
            width="44"
            height="44"
            rx="11"
            fill={isLight ? '#323640' : '#2A2F3B'}
            stroke={isLight ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.2)'}
            strokeWidth="1.8"
          />

          {/* Precision S-Curve Metallic Tonearm Shaft reaching directly onto Playable Grooves */}
          <path
            d={`M ${TONEARM_PIVOT_X} ${TONEARM_PIVOT_Y}
                L ${TONEARM_PIVOT_X - 16} ${TONEARM_PIVOT_Y + 230}
                C ${TONEARM_PIVOT_X - 26} ${TONEARM_PIVOT_Y + 320},
                  ${TONEARM_PIVOT_X - 74} ${TONEARM_PIVOT_Y + 382},
                  ${TONEARM_PIVOT_X - 142} ${TONEARM_PIVOT_Y + 438}
                L 838 616`}
            fill="none"
            stroke={isLight ? 'url(#doremiArmShaftLight)' : 'url(#doremiArmShaftDark)'}
            strokeWidth="13.5"
            strokeLinecap="round"
          />
          {/* Crisp Specular Highlight along Arm Tube */}
          <path
            d={`M ${TONEARM_PIVOT_X - 3} ${TONEARM_PIVOT_Y + 14}
                L ${TONEARM_PIVOT_X - 19} ${TONEARM_PIVOT_Y + 230}
                C ${TONEARM_PIVOT_X - 29} ${TONEARM_PIVOT_Y + 316},
                  ${TONEARM_PIVOT_X - 76} ${TONEARM_PIVOT_Y + 378},
                  ${TONEARM_PIVOT_X - 144} ${TONEARM_PIVOT_Y + 434}
                L 836 612`}
            fill="none"
            stroke="rgba(255,255,255,0.42)"
            strokeWidth="2.4"
            strokeLinecap="round"
          />

          {/* Gimbal Pivot Bearing Cap */}
          <circle
            cx={TONEARM_PIVOT_X}
            cy={TONEARM_PIVOT_Y}
            r="16"
            fill={isLight ? 'url(#doremiArmShaftLight)' : 'url(#doremiArmShaftDark)'}
          />
          <circle cx={TONEARM_PIVOT_X} cy={TONEARM_PIVOT_Y} r="6.5" fill="#12141A" />

          {/*
            Angled Headshell, Cartridge & Stylus Tip:
            Group translated to (838, 616) and rotated +39deg so the stylus tip
            at local (0, 44) lands EXACTLY at (810, 650) = TONEARM_BASE_NEEDLE_X/Y!
          */}
          <g transform="translate(838, 616) rotate(39)">
            {/* Locking Collar */}
            <rect
              x="-8"
              y="-14"
              width="16"
              height="14"
              rx="3"
              fill={isLight ? 'url(#doremiArmShaftLight)' : 'url(#doremiArmShaftDark)'}
            />
            {/* Perforated Audiophile Headshell Body */}
            <rect
              x="-16"
              y="-2"
              width="32"
              height="54"
              rx="6"
              fill={isLight ? '#23262E' : '#1E222B'}
              stroke={isLight ? '#8F95A0' : 'url(#doremiArmShaftDark)'}
              strokeWidth="2.4"
            />
            {/* Headshell acoustic slots */}
            <rect x="-9" y="8" width="18" height="5" rx="2" fill="rgba(255,255,255,0.22)" />
            <rect x="-9" y="18" width="18" height="5" rx="2" fill="rgba(255,255,255,0.18)" />
            <rect x="-9" y="28" width="18" height="5" rx="2" fill="rgba(255,255,255,0.14)" />

            {/* Finger Lift Lever */}
            <path
              d="M 16 10 C 30 10, 35 20, 38 30"
              fill="none"
              stroke={isLight ? 'url(#doremiArmShaftLight)' : 'url(#doremiArmShaftDark)'}
              strokeWidth="4"
              strokeLinecap="round"
            />

            {/* Precision Stylus Cartridge Tip at local (0, 44) -> world (810, 650) */}
            <circle
              data-testid="vinyl-stylus-tip"
              cx="0"
              cy="44"
              r="4.2"
              fill={accentColor}
            />
          </g>
        </g>
      </svg>
    </div>
  );
});
