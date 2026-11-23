export interface CircularProgressArcGeometry {
  ratio: number;
  circumference: number;
  dashOffset: number;
  handleX: number;
  handleY: number;
  angleDeg: number;
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
 * Computes SVG stroke dashoffset and handle coordinates along a circle
 * starting at 12 o'clock (-90deg) and advancing clockwise.
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
 * Converts a pointer coordinate (clientX, clientY) relative to the circular ring center
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
  // atan2(dy, dx): 3 o'clock = 0, 6 o'clock = +PI/2, 12 o'clock = -PI/2
  let angleFromTop = Math.atan2(dy, dx) + Math.PI / 2;
  if (angleFromTop < 0) {
    angleFromTop += 2 * Math.PI;
  }
  return clampUnit(angleFromTop / (2 * Math.PI));
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
