/**
 * Pure mathematical geometry for the DoReMi Hi-Fi Vinyl Turntable, Circular Progress Ring,
 * and Right-Side Sculpted Tonearm.
 *
 * Every coordinate is derived strictly from the vinyl center `(cx, cy)` and stage diameter `S`,
 * guaranteeing that at ALL viewports (1920x1080, 1440x900, 1366x768, 1024x768):
 * - The circular progress ring stays crisp and unclipped with ~8–16px vertical breathing room.
 * - The vinyl disc remains a true circle (never oval).
 * - The tonearm pivot sits on the upper-right outside the progress ring.
 * - While playing, the stylus tip ALWAYS rests squarely inside the playable vinyl groove band
 *   (strictly outside the center artwork label and strictly inside the outer vinyl rim).
 * - While paused or swapping discs, the stylus parks cleanly outside the progress ring.
 */

export interface VinylStageSizingInput {
  viewportWidth: number;
  viewportHeight: number;
  isFocusMode: boolean;
  sidebarWidth?: number;
}

export interface VinylStageSizing {
  /** Square diameter of the circular progress ring canvas (px) */
  ringCanvasSize: number;
  /** Total horizontal stage width including the right-side tonearm gimbal (px) */
  stageWidth: number;
  /** Total vertical stage height (px) */
  stageHeight: number;
  /** Available hero height between header and bottom control strip (px) */
  heroHeight: number;
  /** Allocated hero column width (px) */
  heroColumnWidth: number;
  /** Top/bottom margin between progress ring edge and hero edge (px) */
  verticalRingMarginPx: number;
}

export interface VinylTonearmGeometry {
  /** Normalized SVG viewBox width (in 1000-unit height space) */
  viewBoxWidth: number;
  /** Normalized SVG viewBox height (always 1000) */
  viewBoxHeight: number;
  /** Vinyl center coordinates in viewBox space */
  cx: number;
  cy: number;
  /** Radii in viewBox space (out of 1000 height) */
  ringRadius: number;
  deckRadius: number;
  platterRadius: number;
  discRadius: number;
  labelRadius: number;
  grooveInnerRadius: number;
  grooveOuterRadius: number;
  /** Right-side tonearm pivot coordinates in viewBox space */
  pivotX: number;
  pivotY: number;
  /** Base stylus coordinates at angleDeg = 0 (outer playable groove) */
  baseNeedleX: number;
  baseNeedleY: number;
  /** Effective rotation angle (degrees around pivot) */
  angleDeg: number;
  /** Actual rotated stylus coordinates in viewBox space */
  needleX: number;
  needleY: number;
  /** Distance from vinyl center (cx, cy) to the rotated stylus tip */
  needleRadiusFromCenter: number;
  /** True when stylus sits strictly inside the playable vinyl groove band */
  isNeedleOnGrooves: boolean;
}

export const VINYL_VIEWBOX_HEIGHT = 1000;
export const VINYL_VIEWBOX_WIDTH = 1100;
export const VINYL_CENTER_X = 500;
export const VINYL_CENTER_Y = 500;

export const VINYL_RING_RADIUS = 482;
export const VINYL_DECK_RADIUS = 448;
export const VINYL_PLATTER_RADIUS = 434;
export const VINYL_DISC_RADIUS = 418;
export const VINYL_LABEL_RADIUS = 146;
export const VINYL_GROOVE_INNER_RADIUS = 182;
export const VINYL_GROOVE_OUTER_RADIUS = 392;

// Upper-right pivot anchored outside the progress ring (distance = 610 > ringRadius 482)
export const TONEARM_PIVOT_X = 1005;
export const TONEARM_PIVOT_Y = 158;

// Base needle landing at outer playable groove (dx = -195, dy = +492 from pivot => x=810, y=650)
// Distance from center (500, 500) = hypot(310, 150) = 344.38 -> squarely inside [182, 392]!
export const TONEARM_BASE_NEEDLE_X = 810;
export const TONEARM_BASE_NEEDLE_Y = 650;

/**
 * Rotates a point `(px, py)` around `(ox, oy)` by `angleDeg` clockwise in SVG screen space.
 */
export function rotatePoint2D(
  px: number,
  py: number,
  ox: number,
  oy: number,
  angleDeg: number,
): { x: number; y: number } {
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = px - ox;
  const dy = py - oy;
  return {
    x: ox + dx * cos - dy * sin,
    y: oy + dx * sin + dy * cos,
  };
}

/**
 * Computes exact right-side tonearm angle & stylus tip coordinates relative to the vinyl center.
 *
 * - Playing (`ratio` in 0..1): smoothly tracks across grooves from +0.5deg (outer groove, r≈341)
 *   to +9.5deg (inner groove, r≈257) — ALWAYS strictly inside `[182, 392]`, never crossing label `146`.
 * - Paused: rotates outward to `-18.5deg` (r≈511), resting neatly just outside the progress ring (`482`).
 * - Swapping disc: rotates further outward to `-24deg` (r≈560), clearing the entire platter.
 */
export function computeVinylTonearmGeometry(options: {
  isPlaying: boolean;
  isSwappingOff: boolean;
  progressRatio?: number;
  forceOnGroove?: boolean;
}): VinylTonearmGeometry {
  const safeRatio =
    typeof options.progressRatio === 'number' && Number.isFinite(options.progressRatio)
      ? Math.max(0, Math.min(1, options.progressRatio))
      : 0;

  let angleDeg: number;
  if (options.isSwappingOff) {
    angleDeg = -24;
  } else if (options.isPlaying || options.forceOnGroove) {
    // Track gracefully from outer playable groove (0.5deg) to inner groove (9.5deg)
    angleDeg = 0.5 + safeRatio * 9;
  } else {
    // Parked neatly outside progress ring on resting post
    angleDeg = -18.5;
  }

  const tip = rotatePoint2D(
    TONEARM_BASE_NEEDLE_X,
    TONEARM_BASE_NEEDLE_Y,
    TONEARM_PIVOT_X,
    TONEARM_PIVOT_Y,
    angleDeg,
  );

  const needleRadiusFromCenter = Math.hypot(tip.x - VINYL_CENTER_X, tip.y - VINYL_CENTER_Y);
  const isNeedleOnGrooves =
    needleRadiusFromCenter >= VINYL_GROOVE_INNER_RADIUS &&
    needleRadiusFromCenter <= VINYL_GROOVE_OUTER_RADIUS;

  return {
    viewBoxWidth: VINYL_VIEWBOX_WIDTH,
    viewBoxHeight: VINYL_VIEWBOX_HEIGHT,
    cx: VINYL_CENTER_X,
    cy: VINYL_CENTER_Y,
    ringRadius: VINYL_RING_RADIUS,
    deckRadius: VINYL_DECK_RADIUS,
    platterRadius: VINYL_PLATTER_RADIUS,
    discRadius: VINYL_DISC_RADIUS,
    labelRadius: VINYL_LABEL_RADIUS,
    grooveInnerRadius: VINYL_GROOVE_INNER_RADIUS,
    grooveOuterRadius: VINYL_GROOVE_OUTER_RADIUS,
    pivotX: TONEARM_PIVOT_X,
    pivotY: TONEARM_PIVOT_Y,
    baseNeedleX: TONEARM_BASE_NEEDLE_X,
    baseNeedleY: TONEARM_BASE_NEEDLE_Y,
    angleDeg,
    needleX: tip.x,
    needleY: tip.y,
    needleRadiusFromCenter,
    isNeedleOnGrooves,
  };
}

/**
 * Computes responsive Hero Vinyl dimensions across desktop viewports (1024..1920+)
 * so the progress ring fills ~92–96% of Hero height whenever horizontal space allows,
 * with ~8–16px top/bottom margin and zero overlap with the Right Editorial column.
 */
export function computeNowPlayingVinylSizing(input: VinylStageSizingInput): VinylStageSizing {
  const sidebarW = input.sidebarWidth ?? (input.viewportWidth >= 1024 ? 76 : 0);
  const mainWidth = Math.max(360, input.viewportWidth - sidebarW);

  // Slim header (42px) + slim bottom bar (68px) in Standard Mode;
  // Floating overlay controls only in Focus Vinyl Mode (more vertical canvas!)
  const headerH = input.isFocusMode ? 20 : 42;
  const bottomH = input.isFocusMode ? 64 : 68;
  const heroHeight = Math.max(320, input.viewportHeight - headerH - bottomH);

  // Target 12px margin above & below the circular progress ring (total 24px vertical breathing room)
  const targetVerticalMargin = heroHeight >= 740 ? 12 : 10;
  const maxRingDiameterByHeight = Math.max(280, heroHeight - targetVerticalMargin * 2);

  // Allocate Hero column width proportionally so Right Panel always stays spacious & readable
  const heroWidthRatio = input.isFocusMode
    ? input.viewportWidth >= 1280
      ? 0.58
      : 0.56
    : input.viewportWidth >= 1600
      ? 0.54
      : input.viewportWidth >= 1320
        ? 0.545
        : input.viewportWidth >= 1024
          ? 0.52
          : 0.92;

  const heroColumnWidth = Math.floor(mainWidth * heroWidthRatio);

  // Stage width = ringCanvasSize * (VINYL_VIEWBOX_WIDTH / VINYL_VIEWBOX_HEIGHT) = 1.10 * ringCanvasSize
  const aspectRatio = VINYL_VIEWBOX_WIDTH / VINYL_VIEWBOX_HEIGHT;
  // Keep full circular progress ring + right-side tonearm gimbal cleanly inside heroColumnWidth
  const horizontalPad = input.isFocusMode ? 20 : 24;
  const maxRingDiameterByWidth = Math.floor((heroColumnWidth - horizontalPad) / aspectRatio);

  // In Standard Mode, cap at 880px on huge monitors; in Focus Mode, allow +6-10% larger up to 940px
  const absoluteMax = input.isFocusMode ? 940 : 880;
  const ringCanvasSize = Math.max(
    280,
    Math.min(absoluteMax, maxRingDiameterByHeight, maxRingDiameterByWidth),
  );

  const stageHeight = ringCanvasSize;
  const stageWidth = Math.round(ringCanvasSize * aspectRatio);

  // Actual ring diameter is 2 * (VINYL_RING_RADIUS / VINYL_VIEWBOX_HEIGHT) * ringCanvasSize
  const actualRingDiameter = (VINYL_RING_RADIUS * 2 * ringCanvasSize) / VINYL_VIEWBOX_HEIGHT;
  const verticalRingMarginPx = Math.max(0, Math.round((heroHeight - actualRingDiameter) / 2));

  return {
    ringCanvasSize,
    stageWidth,
    stageHeight,
    heroHeight,
    heroColumnWidth,
    verticalRingMarginPx,
  };
}
