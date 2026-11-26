import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { DEFAULT_DOREMI_ARTWORK_URL } from '../assets/default-artwork';
import type { VinylSwapPhase } from '../stores/ui-store';
import {
  beginCircularDrag,
  clampUnit,
  computeAdaptiveFocusArcGeometry,
  computeAdaptiveHitStrokeWidth,
  computeCircularProgressArc,
  pointerToSvgAdaptiveArcRatio,
  pointerToSvgCircularRatio,
  stepCircularDrag,
  type CircularDragState,
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
  /** Concentric interactive progress presentation ('circle' in Now Playing, 'arc' in Focus Vinyl) */
  showProgressRing?: boolean;
  progressPresentation?: 'circle' | 'arc';
  progressPct?: number;
  currentTimeSec?: number;
  durationSec?: number;
  /** Applied stage transform scale (allows uniform screen-space hit-band & hairline stroke width) */
  stageScale?: number;
  /** Focus Adaptive Arc screen radius (px) & viewport vinyl center (px) for clipping math */
  focusArcRadiusPx?: number;
  focusArcViewportCenter?: { x: number; y: number };
  viewportHeight?: number;
  progressTransitionMs?: number;
  /** Phase 4.3C: True during the single paint frame immediately following foreground resume */
  suppressResumeTransitions?: boolean;
  /** Resets active circular drag safely when active track or display mode switches */
  seekResetKey?: string;
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
  progressPresentation = 'circle',
  progressPct = 0,
  currentTimeSec = 0,
  durationSec = 0,
  stageScale = 1,
  focusArcRadiusPx,
  focusArcViewportCenter,
  viewportHeight = 768,
  progressTransitionMs = 500,
  suppressResumeTransitions = false,
  seekResetKey = '',
  onSeek,
}: VinylTurntableProps) {
  const effectivePhase = normalizePhase(swapPhase, storyboardFrame);
  const ringSvgRef = useRef<SVGSVGElement | null>(null);
  const arcSvgRef = useRef<SVGSVGElement | null>(null);
  const dragStateRef = useRef<CircularDragState | null>(null);
  const arcDraggingRef = useRef(false);
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

  const safeStageScale = Number.isFinite(stageScale) && stageScale > 0.25 ? stageScale : 1;
  const isArcPresentation = progressPresentation === 'arc';
  const focusArcRadiusSvg = focusArcRadiusPx
    ? focusArcRadiusPx / safeStageScale
    : ringRadius;
  const adaptiveArc = computeAdaptiveFocusArcGeometry({
    centerXSvg: ringCenter,
    centerYSvg: ringCenter,
    radiusSvg: focusArcRadiusSvg,
    centerViewportX: focusArcViewportCenter?.x ?? 70,
    centerViewportY: focusArcViewportCenter?.y ?? viewportHeight * 0.5,
    arcRadiusPx: focusArcRadiusPx ?? ringRadius * safeStageScale,
    viewportHeight,
    progressRatio: effectiveRatio,
  });

  const adaptiveHitStrokeWidth = computeAdaptiveHitStrokeWidth(safeStageScale);
  const adaptiveTrackStrokeWidth = Math.max(1.3, 2 / Math.sqrt(safeStageScale));
  const adaptiveActiveStrokeWidth = isDraggingRing
    ? Math.max(2.2, 3.2 / Math.sqrt(safeStageScale))
    : Math.max(1.7, 2.6 / Math.sqrt(safeStageScale));
  const adaptiveHandleRadius = isDraggingRing
    ? Math.max(4.4, 6.8 / Math.sqrt(safeStageScale))
    : Math.max(3.6, 5.2 / Math.sqrt(safeStageScale));

  const clearRingDrag = useCallback(() => {
    dragStateRef.current = null;
    arcDraggingRef.current = false;
    setIsDraggingRing(false);
    setDragPreviewRatio(null);
  }, []);

  // Safely cancel dragging when switching tracks, switching Standard<->Focus, or losing focus
  useEffect(() => {
    clearRingDrag();
  }, [seekResetKey, durationSec, clearRingDrag]);

  useEffect(() => {
    if (!isDraggingRing) return;
    const onBlur = () => clearRingDrag();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        clearRingDrag();
      }
    };
    window.addEventListener('blur', onBlur);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isDraggingRing, clearRingDrag]);

  const computeRatioFromPointerEvent = useCallback(
    (event: ReactPointerEvent<SVGElement>): number | null => {
      return pointerToSvgCircularRatio(
        ringSvgRef.current,
        event.clientX,
        event.clientY,
        ringCenter,
        ringCenter,
      );
    },
    [ringCenter],
  );

  const computeArcRatioFromPointerEvent = useCallback(
    (event: ReactPointerEvent<SVGElement>): number | null => {
      return pointerToSvgAdaptiveArcRatio(
        arcSvgRef.current,
        event.clientX,
        event.clientY,
        ringCenter,
        ringCenter,
        adaptiveArc.startAngleDeg,
        adaptiveArc.endAngleDeg,
      );
    },
    [ringCenter, adaptiveArc.startAngleDeg, adaptiveArc.endAngleDeg],
  );

  const handleRingPointerDown = (event: ReactPointerEvent<SVGCircleElement>) => {
    if (isArcPresentation) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (!onSeek || durationSec <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic pointer events in test environments may not register real pointer IDs
    }
    const rawRatio = computeRatioFromPointerEvent(event);
    if (rawRatio !== null) {
      const nextDrag = beginCircularDrag(rawRatio);
      dragStateRef.current = nextDrag;
      setIsDraggingRing(true);
      setDragPreviewRatio(nextDrag.clampedRatio);
      onSeek(nextDrag.clampedRatio * durationSec);
    }
  };

  const handleRingPointerMove = (event: ReactPointerEvent<SVGCircleElement>) => {
    if (isArcPresentation || !dragStateRef.current || !onSeek || durationSec <= 0) return;
    const rawRatio = computeRatioFromPointerEvent(event);
    if (rawRatio !== null) {
      const nextDrag = stepCircularDrag(dragStateRef.current, rawRatio);
      dragStateRef.current = nextDrag;
      setDragPreviewRatio(nextDrag.clampedRatio);
      onSeek(nextDrag.clampedRatio * durationSec);
    }
  };

  const handleRingPointerUp = (event: ReactPointerEvent<SVGCircleElement>) => {
    if (!dragStateRef.current) return;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore synthetic cleanup error
    }
    clearRingDrag();
  };

  const handleArcPointerDown = (event: ReactPointerEvent<SVGPathElement>) => {
    if (!isArcPresentation) return;
    if (event.button !== 0 && event.pointerType === 'mouse') return;
    if (!onSeek || durationSec <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // Ignore synthetic capture error
    }
    const ratio = computeArcRatioFromPointerEvent(event);
    if (ratio !== null) {
      arcDraggingRef.current = true;
      setIsDraggingRing(true);
      setDragPreviewRatio(ratio);
      onSeek(ratio * durationSec);
    }
  };

  const handleArcPointerMove = (event: ReactPointerEvent<SVGPathElement>) => {
    if (!isArcPresentation || !arcDraggingRef.current || !onSeek || durationSec <= 0) return;
    const ratio = computeArcRatioFromPointerEvent(event);
    if (ratio !== null) {
      setDragPreviewRatio(ratio);
      onSeek(ratio * durationSec);
    }
  };

  const handleArcPointerUp = (event: ReactPointerEvent<SVGPathElement>) => {
    if (!arcDraggingRef.current) return;
    try {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    } catch {
      // Ignore synthetic cleanup error
    }
    clearRingDrag();
  };

  const previewTimeSec =
    dragPreviewRatio !== null && durationSec > 0 ? dragPreviewRatio * durationSec : currentTimeSec;
  const activeHandleX = isArcPresentation ? adaptiveArc.handleXSvg : arc.handleX;
  const activeHandleY = isArcPresentation ? adaptiveArc.handleYSvg : arc.handleY;
  const focusTooltipX = Math.max(
    ringCenter + (isArcPresentation ? focusArcRadiusSvg * 0.16 : ringRadius * 0.14),
    Math.min(ringCanvasSize - 72, activeHandleX + (isArcPresentation ? 24 / safeStageScale : 0)),
  );
  const focusTooltipY = Math.max(56, Math.min(ringCanvasSize - 42, activeHandleY - 22 / safeStageScale));
  const progressFadeCss =
    !suppressResumeTransitions && !reducedMotion && progressTransitionMs > 0
      ? `opacity ${Math.round(progressTransitionMs * 0.65)}ms cubic-bezier(0.22, 1, 0.36, 1)`
      : 'none';
  const progressGeometryTransition = (cssProp: string) =>
    suppressResumeTransitions || isDraggingRing ? 'none' : cssProp;

  return (
    <div
      data-testid="vinyl-turntable"
      data-phase={effectivePhase}
      data-playing={shouldSpin ? 'true' : 'false'}
      data-progress-presentation={progressPresentation}
      data-actual-disc-diameter={String(Math.round(discDiameter * safeStageScale))}
      data-tonearm-angle={tonearm.angleDeg.toFixed(1)}
      data-needle-on-grooves={tonearm.isNeedleOnGrooves ? 'true' : 'false'}
      data-needle-radius={String(Math.round(tonearm.needleRadiusFromCenter))}
      className="lp-resume-snap-target relative flex shrink-0 select-none items-center justify-start"
      style={{
        width: `${stageWidth}px`,
        height: `${stageHeight}px`,
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
        {/* Layer 0A: Standard Now Playing 360-deg Concentric Circular Progress Ring */}
        {showProgressRing && (
          <svg
            ref={ringSvgRef}
            data-testid="vinyl-circular-progress"
            viewBox={`0 0 ${ringCanvasSize} ${ringCanvasSize}`}
            width={ringCanvasSize}
            height={ringCanvasSize}
            className="pointer-events-none absolute inset-0 overflow-visible"
            style={{
              zIndex: 24,
              opacity: isArcPresentation ? 0 : 1,
              transition: progressFadeCss,
            }}
            aria-hidden={isArcPresentation}
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
              strokeWidth={adaptiveTrackStrokeWidth}
            />

            {/* Effective Now Playing Accent Active Progress Arc (12 o'clock clockwise) */}
            <circle
              data-testid="vinyl-circular-progress-arc"
              cx={ringCenter}
              cy={ringCenter}
              r={ringRadius}
              fill="none"
              stroke={accentColor}
              strokeWidth={adaptiveActiveStrokeWidth}
              strokeLinecap="round"
              strokeDasharray={arc.circumference}
              strokeDashoffset={arc.dashOffset}
              transform={`rotate(-90 ${ringCenter} ${ringCenter})`}
              style={{
                transition: progressGeometryTransition('stroke-dashoffset 180ms linear'),
              }}
            />

            {/* Refined Hi-Fi Hollow Ring Indicator Handle */}
            <circle
              data-testid="vinyl-circular-progress-handle"
              cx={arc.handleX}
              cy={arc.handleY}
              r={adaptiveHandleRadius}
              fill={isLight ? '#F5F5F3' : '#101114'}
              stroke={isLight ? '#222326' : accentColor}
              strokeWidth={Math.max(1.5, 2.2 / Math.sqrt(safeStageScale))}
              style={{
                transition: progressGeometryTransition('cx 180ms linear, cy 180ms linear'),
              }}
            />

            {/* Generous Uniform Screen-Space Invisible Hit Ring (enabled strictly in Standard mode) */}
            {onSeek && durationSec > 0 && (
              <circle
                data-testid="vinyl-circular-progress-hit"
                cx={ringCenter}
                cy={ringCenter}
                r={ringRadius}
                fill="none"
                stroke="rgba(255,255,255,0.001)"
                strokeWidth={adaptiveHitStrokeWidth}
                style={{
                  pointerEvents: isArcPresentation ? 'none' : 'stroke',
                  cursor: isDraggingRing ? 'grabbing' : 'pointer',
                }}
                onPointerDown={handleRingPointerDown}
                onPointerMove={handleRingPointerMove}
                onPointerUp={handleRingPointerUp}
                onPointerCancel={handleRingPointerUp}
                onLostPointerCapture={clearRingDrag}
              />
            )}
          </svg>
        )}

        {/* Layer 0B: Focus Vinyl Adaptive Progress Arc (maps full 0..100% duration strictly along visible right curve) */}
        {showProgressRing && (
          <svg
            ref={arcSvgRef}
            data-testid="vinyl-adaptive-progress"
            data-arc-start-deg={adaptiveArc.startAngleDeg.toFixed(1)}
            data-arc-end-deg={adaptiveArc.endAngleDeg.toFixed(1)}
            data-arc-sweep-deg={adaptiveArc.sweepAngleDeg.toFixed(1)}
            viewBox={`0 0 ${ringCanvasSize} ${ringCanvasSize}`}
            width={ringCanvasSize}
            height={ringCanvasSize}
            className="pointer-events-none absolute inset-0 overflow-visible"
            style={{
              zIndex: 31,
              opacity: isArcPresentation ? 1 : 0,
              transition: progressFadeCss,
            }}
            aria-hidden={!isArcPresentation}
            role="slider"
            aria-label="Cung tiến độ Focus Vinyl (0% đến 100%)"
            aria-valuemin={0}
            aria-valuemax={Math.round(durationSec)}
            aria-valuenow={Math.round(previewTimeSec)}
          >
            <path
              data-testid="vinyl-adaptive-progress-track"
              d={adaptiveArc.trackPathD}
              fill="none"
              stroke="var(--np-ring-track)"
              strokeWidth={adaptiveTrackStrokeWidth}
              strokeLinecap="round"
            />

            <path
              data-testid="vinyl-adaptive-progress-arc"
              d={adaptiveArc.trackPathD}
              fill="none"
              stroke={accentColor}
              strokeWidth={adaptiveActiveStrokeWidth}
              strokeLinecap="round"
              strokeDasharray={adaptiveArc.arcLengthSvg}
              strokeDashoffset={adaptiveArc.dashOffsetSvg}
              style={{
                transition: progressGeometryTransition('stroke-dashoffset 180ms linear'),
              }}
            />

            <circle
              data-testid="vinyl-adaptive-progress-handle"
              cx={adaptiveArc.handleXSvg}
              cy={adaptiveArc.handleYSvg}
              r={adaptiveHandleRadius}
              fill={isLight ? '#F5F5F3' : '#101114'}
              stroke={isLight ? '#222326' : accentColor}
              strokeWidth={Math.max(1.5, 2.2 / Math.sqrt(safeStageScale))}
              style={{
                transition: progressGeometryTransition('cx 180ms linear, cy 180ms linear'),
              }}
            />

            {onSeek && durationSec > 0 && (
              <path
                data-testid="vinyl-adaptive-progress-hit"
                d={adaptiveArc.trackPathD}
                fill="none"
                stroke="rgba(255,255,255,0.001)"
                strokeWidth={adaptiveHitStrokeWidth}
                strokeLinecap="round"
                style={{
                  pointerEvents: isArcPresentation ? 'stroke' : 'none',
                  cursor: isDraggingRing ? 'grabbing' : 'pointer',
                }}
                onPointerDown={handleArcPointerDown}
                onPointerMove={handleArcPointerMove}
                onPointerUp={handleArcPointerUp}
                onPointerCancel={handleArcPointerUp}
                onLostPointerCapture={clearRingDrag}
              />
            )}
          </svg>
        )}

        {/* Dragging Timestamp Readout Badge (stays safely visible in both Standard & Focus modes) */}
        {showProgressRing && isDraggingRing && (
          <div
            data-testid="vinyl-circular-seek-tooltip"
            className="lp-glass-pill font-mono-tabular pointer-events-none absolute z-35 -translate-x-1/2 rounded-full px-3 py-1 text-[11.5px] font-semibold text-[var(--text-primary)]"
            style={
              safeStageScale > 1.15 || isArcPresentation
                ? {
                    left: `${Math.round(focusTooltipX)}px`,
                    top: `${Math.round(focusTooltipY)}px`,
                    transform: `translate3d(-50%, -50%, 0) scale(${(1 / safeStageScale).toFixed(3)})`,
                  }
                : {
                    left: '50%',
                    top: '8px',
                  }
            }
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
                // Keep compositor promotion stable across pause/hidden toggles so Chromium
                // never drops & re-uploads the high-res rotor GPU layer right on foreground resume
                willChange: vinylAnimationEnabled && !reducedMotion ? 'transform' : 'auto',
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
        className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
        style={{ zIndex: 28 }}
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

        {/* Stationary Gimbal Mounting Plate at Top-Entering Pivot (768, 24) */}
        <g>
          {/* Soft ambient shadow disc beneath mounting plate */}
          <circle
            cx={TONEARM_PIVOT_X + 3}
            cy={TONEARM_PIVOT_Y + 8}
            r="56"
            fill={isLight ? 'rgba(20,22,28,0.12)' : 'rgba(0,0,0,0.48)'}
          />
          <circle
            cx={TONEARM_PIVOT_X}
            cy={TONEARM_PIVOT_Y}
            r="54"
            fill={isLight ? 'url(#doremiPivotBaseLight)' : 'url(#doremiPivotBaseDark)'}
            stroke={isLight ? 'rgba(34,35,38,0.16)' : 'rgba(255,255,255,0.16)'}
            strokeWidth="2.2"
          />
          <circle
            cx={TONEARM_PIVOT_X}
            cy={TONEARM_PIVOT_Y}
            r="38"
            fill={isLight ? '#24272E' : '#151820'}
            stroke={isLight ? 'rgba(255,255,255,0.28)' : 'rgba(193,161,124,0.44)'}
            strokeWidth="2"
          />
          {/* Subtle anti-skate knob */}
          <circle
            cx={TONEARM_PIVOT_X + 42}
            cy={TONEARM_PIVOT_Y - 26}
            r="9"
            fill={isLight ? '#383C45' : '#232732'}
            stroke={isLight ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.2)'}
            strokeWidth="1.6"
          />
        </g>

        {/* Articulated Rotating Arm Assembly Pivoting Strictly Around (768, 24) */}
        <g
          data-testid="vinyl-tonearm-assembly"
          style={{
            transformOrigin: `${TONEARM_PIVOT_X}px ${TONEARM_PIVOT_Y}px`,
            transform: `rotate(${tonearm.angleDeg}deg) scale(${tonearmLiftScale})`,
            transition:
              suppressResumeTransitions || reducedMotion
                ? 'none'
                : 'transform 280ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
        >
          {/* Rear Counterweight Cylinder above Pivot */}
          <rect
            x={TONEARM_PIVOT_X - 18}
            y={TONEARM_PIVOT_Y - 82}
            width="36"
            height="42"
            rx="9"
            fill={isLight ? '#2D3038' : '#262A34'}
            stroke={isLight ? 'rgba(255,255,255,0.25)' : 'rgba(255,255,255,0.2)'}
            strokeWidth="1.8"
          />
          <line
            x1={TONEARM_PIVOT_X - 14}
            y1={TONEARM_PIVOT_Y - 70}
            x2={TONEARM_PIVOT_X + 14}
            y2={TONEARM_PIVOT_Y - 70}
            stroke={isLight ? 'rgba(220,224,232,0.7)' : 'rgba(193,161,124,0.65)'}
            strokeWidth="2.4"
          />

          {/* Gimbal Yoke Bridge */}
          <rect
            x={TONEARM_PIVOT_X - 20}
            y={TONEARM_PIVOT_Y - 20}
            width="40"
            height="40"
            rx="10"
            fill={isLight ? '#323640' : '#2A2F3B'}
            stroke={isLight ? 'rgba(255,255,255,0.26)' : 'rgba(255,255,255,0.2)'}
            strokeWidth="1.8"
          />

          {/* Soft Platter Cast Shadow under Tonearm Shaft & Headshell */}
          <path
            d={`M ${TONEARM_PIVOT_X + 12} ${TONEARM_PIVOT_Y + 18}
                C ${TONEARM_PIVOT_X + 24} ${TONEARM_PIVOT_Y + 215},
                  ${TONEARM_PIVOT_X + 94} ${TONEARM_PIVOT_Y + 388},
                  ${TONEARM_PIVOT_X + 68} ${TONEARM_PIVOT_Y + 536}
                L 820 618`}
            fill="none"
            stroke={isLight ? 'rgba(20,22,28,0.14)' : 'rgba(0,0,0,0.46)'}
            strokeWidth="22"
            strokeLinecap="round"
          />

          {/* Top-Entering Precision S-Curve Metallic Tonearm Shaft reaching directly onto Playable Grooves */}
          <path
            d={`M ${TONEARM_PIVOT_X} ${TONEARM_PIVOT_Y}
                C ${TONEARM_PIVOT_X + 12} ${TONEARM_PIVOT_Y + 195},
                  ${TONEARM_PIVOT_X + 82} ${TONEARM_PIVOT_Y + 368},
                  ${TONEARM_PIVOT_X + 56} ${TONEARM_PIVOT_Y + 516}
                L 808 595`}
            fill="none"
            stroke={isLight ? 'url(#doremiArmShaftLight)' : 'url(#doremiArmShaftDark)'}
            strokeWidth="16"
            strokeLinecap="round"
          />
          {/* Crisp Specular Highlight along Arm Tube */}
          <path
            d={`M ${TONEARM_PIVOT_X - 3.5} ${TONEARM_PIVOT_Y + 14}
                C ${TONEARM_PIVOT_X + 9} ${TONEARM_PIVOT_Y + 195},
                  ${TONEARM_PIVOT_X + 79} ${TONEARM_PIVOT_Y + 366},
                  ${TONEARM_PIVOT_X + 53} ${TONEARM_PIVOT_Y + 512}
                L 805.5 591`}
            fill="none"
            stroke="rgba(255,255,255,0.48)"
            strokeWidth="3.2"
            strokeLinecap="round"
          />

          {/* Gimbal Pivot Bearing Cap */}
          <circle
            cx={TONEARM_PIVOT_X}
            cy={TONEARM_PIVOT_Y}
            r="15"
            fill={isLight ? 'url(#doremiArmShaftLight)' : 'url(#doremiArmShaftDark)'}
          />
          <circle cx={TONEARM_PIVOT_X} cy={TONEARM_PIVOT_Y} r="6" fill="#12141A" />

          {/*
            Angled Headshell, Cartridge & Stylus Tip:
            Group translated to (808, 595) and rotated +20deg so the stylus tip
            at local (0, 44) lands EXACTLY at (793, 636) = TONEARM_BASE_NEEDLE_X/Y!
          */}
          <g transform="translate(808, 595) rotate(20)">
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
