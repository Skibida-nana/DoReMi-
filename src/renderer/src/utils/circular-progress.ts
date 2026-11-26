export interface CircularProgressArcGeometry {
  ratio: number;
  circumference: number;
  dashOffset: number;
  handleX: number;
  handleY: number;
  angleDeg: number;
}

export interface CircularDragState {
  prevRawRatio: number;
  unwrappedRatio: number;
  clampedRatio: number;
}

export interface AdaptiveFocusArcGeometry {
  centerXSvg: number;
  centerYSvg: number;
  radiusSvg: number;
  /** Start angle in degrees relative to +X (3 o'clock = 0deg; upper right < 0) */
  startAngleDeg: number;
  /** End angle in degrees relative to +X (lower right > 0) */
  endAngleDeg: number;
  /** Positive clockwise angular sweep in degrees */
  sweepAngleDeg: number;
  /** Total geometric arc length along the circumference in SVG units */
  arcLengthSvg: number;
  ratio: number;
  dashOffsetSvg: number;
  startXSvg: number;
  startYSvg: number;
  endXSvg: number;
  endYSvg: number;
  handleXSvg: number;
  handleYSvg: number;
  activeAngleDeg: number;
  /** Full background track SVG path (start -> end clockwise) */
  trackPathD: string;
}

/**
 * Clamps an arbitrary numeric value into [0, 1], returning 0 for non-finite inputs.
 */
export function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

/**
 * Computes SVG stroke dashoffset and handle coordinates along a full 360-degree circle
 * starting at 12 o'clock (-90deg) and advancing clockwise. (Used by Standard Now Playing)
 */
export function computeCircularProgressArc(
  progressRatio: number,
  radius: number,
  center: number,
): CircularProgressArcGeometry {
  const ratio = clampUnit(progressRatio);
  const safeRadius = Math.max(1, radius);
  const circumference = 2 * Math.PI * safeRadius;
  const dashOffset = circumference * (1 - ratio);
  const angleRad = -Math.PI / 2 + ratio * 2 * Math.PI;
  const handleX = center + safeRadius * Math.cos(angleRad);
  const handleY = center + safeRadius * Math.sin(angleRad);
  return {
    ratio,
    circumference,
    dashOffset,
    handleX,
    handleY,
    angleDeg: ratio * 360,
  };
}

/**
 * Computes an Adaptive Progress Arc strictly spanning the visible, unobstructed right rim
 * of the oversized Focus Vinyl disc, mapping 0..100% of track duration onto the live
 * visible arc `[startAngleDeg, endAngleDeg]` so every timestamp 0%..100% stays accessible.
 */
export function computeAdaptiveFocusArcGeometry(input: {
  centerXSvg: number;
  centerYSvg: number;
  radiusSvg: number;
  centerViewportX: number;
  centerViewportY: number;
  arcRadiusPx: number;
  viewportHeight: number;
  safeTopPx?: number;
  safeBottomPx?: number;
  handlePadPx?: number;
  progressRatio: number;
}): AdaptiveFocusArcGeometry {
  const ratio = clampUnit(input.progressRatio);
  const rSvg = Math.max(1, input.radiusSvg);
  const rScreen = Math.max(40, input.arcRadiusPx);
  const vh = Math.max(360, input.viewportHeight || 768);
  const safeTop = Math.max(40, input.safeTopPx ?? 58);
  const safeBottom = Math.min(vh - 18, input.safeBottomPx ?? vh - 32);
  const handlePad = Math.max(8, input.handlePadPx ?? 14);

  const minScreenY = safeTop + handlePad;
  const maxScreenY = Math.max(minScreenY + 48, safeBottom - handlePad);

  const rawTopSin = (minScreenY - input.centerViewportY) / rScreen;
  const rawBotSin = (maxScreenY - input.centerViewportY) / rScreen;

  // Clamp sin within clean right-hemisphere angular limits so upper/lower ends never collide or invert
  const startAngleDeg = (Math.asin(Math.max(-0.92, Math.min(-0.18, rawTopSin))) * 180) / Math.PI;
  const endAngleDeg = (Math.asin(Math.min(0.92, Math.max(0.18, rawBotSin))) * 180) / Math.PI;
  const sweepAngleDeg = Math.max(20, endAngleDeg - startAngleDeg);

  const startRad = (startAngleDeg * Math.PI) / 180;
  const endRad = (endAngleDeg * Math.PI) / 180;
  const activeAngleDeg = startAngleDeg + ratio * sweepAngleDeg;
  const activeRad = (activeAngleDeg * Math.PI) / 180;

  const startXSvg = input.centerXSvg + rSvg * Math.cos(startRad);
  const startYSvg = input.centerYSvg + rSvg * Math.sin(startRad);
  const endXSvg = input.centerXSvg + rSvg * Math.cos(endRad);
  const endYSvg = input.centerYSvg + rSvg * Math.sin(endRad);
  const handleXSvg = input.centerXSvg + rSvg * Math.cos(activeRad);
  const handleYSvg = input.centerYSvg + rSvg * Math.sin(activeRad);

  const arcLengthSvg = rSvg * ((sweepAngleDeg * Math.PI) / 180);
  const dashOffsetSvg = arcLengthSvg * (1 - ratio);
  const largeArcFlag = sweepAngleDeg > 180 ? 1 : 0;
  const trackPathD = `M ${startXSvg.toFixed(2)} ${startYSvg.toFixed(2)} A ${rSvg.toFixed(2)} ${rSvg.toFixed(2)} 0 ${largeArcFlag} 1 ${endXSvg.toFixed(2)} ${endYSvg.toFixed(2)}`;

  return {
    centerXSvg: input.centerXSvg,
    centerYSvg: input.centerYSvg,
    radiusSvg: rSvg,
    startAngleDeg,
    endAngleDeg,
    sweepAngleDeg,
    arcLengthSvg,
    ratio,
    dashOffsetSvg,
    startXSvg,
    startYSvg,
    endXSvg,
    endYSvg,
    handleXSvg,
    handleYSvg,
    activeAngleDeg,
    trackPathD,
  };
}

/**
 * Converts a local SVG pointer angle `(dx, dy)` relative to disc center into `[0, 1]`
 * linearly mapped along Focus Vinyl's bounded `[startAngleDeg, endAngleDeg]` arc.
 * Clamps smoothly at both endpoints without wrapping to the opposite side.
 */
export function localCoordsToAdaptiveArcRatio(
  localX: number,
  localY: number,
  centerXSvg: number,
  centerYSvg: number,
  startAngleDeg: number,
  endAngleDeg: number,
): number {
  const dx = localX - centerXSvg;
  const dy = localY - centerYSvg;
  if (dx === 0 && dy === 0) {
    return 0;
  }
  const pointerRad = Math.atan2(dy, dx);
  const midDeg = (startAngleDeg + endAngleDeg) * 0.5;
  const midRad = (midDeg * Math.PI) / 180;
  // Shortest signed angular offset from arc midpoint (-180..+180)
  const deltaRad = Math.atan2(
    Math.sin(pointerRad - midRad),
    Math.cos(pointerRad - midRad),
  );
  const normalizedDeg = midDeg + (deltaRad * 180) / Math.PI;
  const sweepDeg = Math.max(1, endAngleDeg - startAngleDeg);
  return clampUnit((normalizedDeg - startAngleDeg) / sweepDeg);
}

/**
 * Converts a coordinate (clientX, clientY) relative to the circular ring center
 * into a clockwise progress ratio in [0, 1] starting from 12 o'clock.
 */
export function pointerToCircularRatio(
  clientX: number,
  clientY: number,
  centerX: number,
  centerY: number,
): number {
  const dx = clientX - centerX;
  const dy = clientY - centerY;
  if (dx === 0 && dy === 0) {
    return 0;
  }
  let angleFromTop = Math.atan2(dy, dx) + Math.PI / 2;
  if (angleFromTop < 0) {
    angleFromTop += 2 * Math.PI;
  }
  return clampUnit(angleFromTop / (2 * Math.PI));
}

export interface SvgCtmLike {
  getScreenCTM?: () => {
    inverse: () => { a: number; b: number; c: number; d: number; e: number; f: number };
  } | null;
  getBoundingClientRect?: () => { left: number; top: number; width: number; height: number };
}

/**
 * Transforms browser client pointer coordinates into SVG local user-space coordinates via
 * `svg.getScreenCTM().inverse()` when available, handling scale, translation, crop & DPI zoom.
 */
export function clientPointToSvgLocal(
  svg: SvgCtmLike | null,
  clientX: number,
  clientY: number,
  centerXSvg: number,
  centerYSvg: number,
): { x: number; y: number } | null {
  if (!svg || !Number.isFinite(clientX) || !Number.isFinite(clientY)) {
    return null;
  }

  if (typeof svg.getScreenCTM === 'function') {
    try {
      const ctm = svg.getScreenCTM();
      if (ctm && typeof ctm.inverse === 'function') {
        const inv = ctm.inverse();
        const localX = inv.a * clientX + inv.c * clientY + inv.e;
        const localY = inv.b * clientX + inv.d * clientY + inv.f;
        if (Number.isFinite(localX) && Number.isFinite(localY)) {
          return { x: localX, y: localY };
        }
      }
    } catch {
      // Fall back cleanly below
    }
  }

  if (typeof svg.getBoundingClientRect === 'function') {
    const rect = svg.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      // Translate client point into centered fallback coords
      return {
        x: centerXSvg + (clientX - (rect.left + rect.width * 0.5)),
        y: centerYSvg + (clientY - (rect.top + rect.height * 0.5)),
      };
    }
  }

  return null;
}

/**
 * Maps browser pointer `(clientX, clientY)` onto `[0, 1]` along full 360° circle starting at 12 o'clock.
 */
export function pointerToSvgCircularRatio(
  svg: SvgCtmLike | null,
  clientX: number,
  clientY: number,
  centerXSvg: number,
  centerYSvg: number,
): number | null {
  const local = clientPointToSvgLocal(svg, clientX, clientY, centerXSvg, centerYSvg);
  if (!local) return null;
  return pointerToCircularRatio(local.x, local.y, centerXSvg, centerYSvg);
}

/**
 * Maps browser pointer `(clientX, clientY)` onto `[0, 1]` along Focus Vinyl Adaptive Progress Arc.
 */
export function pointerToSvgAdaptiveArcRatio(
  svg: SvgCtmLike | null,
  clientX: number,
  clientY: number,
  centerXSvg: number,
  centerYSvg: number,
  startAngleDeg: number,
  endAngleDeg: number,
): number | null {
  const local = clientPointToSvgLocal(svg, clientX, clientY, centerXSvg, centerYSvg);
  if (!local) return null;
  return localCoordsToAdaptiveArcRatio(
    local.x,
    local.y,
    centerXSvg,
    centerYSvg,
    startAngleDeg,
    endAngleDeg,
  );
}

/**
 * Initializes seam-safe continuous dragging from an initial clicked ratio.
 */
export function beginCircularDrag(initialRawRatio: number): CircularDragState {
  const safe = clampUnit(initialRawRatio);
  return {
    prevRawRatio: safe,
    unwrappedRatio: safe,
    clampedRatio: safe,
  };
}

/**
 * Advances full-circle drag across frames while guarding the 12 o'clock seam (0 <-> 1).
 */
export function stepCircularDrag(
  prevState: CircularDragState,
  nextRawRatio: number,
): CircularDragState {
  const safeNext = clampUnit(nextRawRatio);
  let delta = safeNext - prevState.prevRawRatio;
  if (delta > 0.5) {
    delta -= 1;
  } else if (delta < -0.5) {
    delta += 1;
  }

  const nextUnwrapped = Math.max(-0.2, Math.min(1.2, prevState.unwrappedRatio + delta));
  return {
    prevRawRatio: safeNext,
    unwrappedRatio: nextUnwrapped,
    clampedRatio: clampUnit(nextUnwrapped),
  };
}

/**
 * Keeps the interactive hit ring comfortably clickable (~26-36 CSS screen pixels wide)
 * even when the parent SVG stage scales cleanly between Standard and oversized Focus Vinyl.
 */
export function computeAdaptiveHitStrokeWidth(effectiveScale: number): number {
  const safeScale = Number.isFinite(effectiveScale) && effectiveScale > 0.25 ? effectiveScale : 1;
  return Math.round(Math.max(18, Math.min(48, 32 / safeScale)));
}

/**
 * Checks whether a pointer coordinate lies within a radial hit-band around the progress ring.
 */
export function isPointerNearProgressRing(
  clientX: number,
  clientY: number,
  centerX: number,
  centerY: number,
  radius: number,
  tolerancePx = 24,
): boolean {
  const dist = Math.hypot(clientX - centerX, clientY - centerY);
  return Math.abs(dist - radius) <= tolerancePx;
}
