/**
 * Pure mathematical geometry for the DoReMi Hi-Fi Vinyl Turntable, Circular Progress Ring,
 * and Top-Entering Editorial Tonearm (shared between Now Playing and Focus Vinyl).
 *
 * Every coordinate is derived strictly from the vinyl center `(cx, cy)` and stage diameter `S`,
 * guaranteeing that at ALL viewports (2560x1440, 1920x1080, 1440x900, 1366x768, 1024x768):
 * - The vinyl disc remains a true circle (never elliptical).
 * - The tonearm pivot sits at the upper-right above the platter (`r = 546 > ringRadius 482`),
 *   allowing the base/pivot to crop naturally past the top edge when enlarged in Focus Vinyl.
 * - While playing, the stylus tip ALWAYS rests squarely inside the playable vinyl groove band
 *   (strictly outside the center artwork label `146` and strictly inside the outer vinyl rim `418`).
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
  /** Total horizontal stage width including the tonearm swing clearance (px) */
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
  viewBoxWidth: number;
  viewBoxHeight: number;
  cx: number;
  cy: number;
  ringRadius: number;
  deckRadius: number;
  platterRadius: number;
  discRadius: number;
  labelRadius: number;
  grooveInnerRadius: number;
  grooveOuterRadius: number;
  pivotX: number;
  pivotY: number;
  baseNeedleX: number;
  baseNeedleY: number;
  angleDeg: number;
  needleX: number;
  needleY: number;
  needleRadiusFromCenter: number;
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

// Upper-right top-entering pivot above the platter rim (distance from (500,500) = 546.3 > 482)
export const TONEARM_PIVOT_X = 768;
export const TONEARM_PIVOT_Y = 24;

// Base needle landing at outer playable groove (dx = +293, dy = +136 from center => r = 323.0)
// Headshell translate(808, 595) rotate(20) with local tip (0, 44) lands cleanly at (793, 636)!
export const TONEARM_BASE_NEEDLE_X = 793;
export const TONEARM_BASE_NEEDLE_Y = 636;

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
 * Computes exact top-entering tonearm angle & stylus tip coordinates relative to the vinyl center.
 *
 * - Playing (`ratio` in 0..1): tracks monotonically inward across grooves from +1deg (r≈312)
 *   to +12deg (r≈208) — strictly inside `[182, 392]`, never crossing center label `146`.
 * - Paused: rotates outward to `-20deg` (r≈508), resting cleanly outside the progress ring (`482`).
 * - Swapping disc: rotates further outward to `-26deg` (r≈561), clearing the platter.
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
    angleDeg = -26;
  } else if (options.isPlaying || options.forceOnGroove) {
    angleDeg = 1 + safeRatio * 11;
  } else {
    angleDeg = -20;
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
 * Computes responsive Hero Vinyl dimensions across desktop viewports (1024..2560+).
 * In Standard (3-zone Now Playing) mode, sizes the turntable to anchor ~40-44% center column cleanly;
 * in Focus mode returns proportional base metrics used for Focus stage bounds.
 */
export function computeNowPlayingVinylSizing(input: VinylStageSizingInput): VinylStageSizing {
  const sidebarW = input.sidebarWidth ?? (input.viewportWidth >= 1024 ? 76 : 0);
  const mainWidth = Math.max(360, input.viewportWidth - sidebarW);

  const headerH = input.isFocusMode ? 20 : 42;
  const bottomH = input.isFocusMode ? 64 : 68;
  const heroHeight = Math.max(320, input.viewportHeight - headerH - bottomH);

  const targetVerticalMargin = heroHeight >= 740 ? 12 : 10;
  const maxRingDiameterByHeight = Math.max(280, heroHeight - targetVerticalMargin * 2);

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

  const aspectRatio = VINYL_VIEWBOX_WIDTH / VINYL_VIEWBOX_HEIGHT;
  const horizontalPad = input.isFocusMode ? 20 : 24;
  const maxRingDiameterByWidth = Math.floor((heroColumnWidth - horizontalPad) / aspectRatio);

  const absoluteMax = input.isFocusMode ? 940 : 880;
  const ringCanvasSize = Math.max(
    280,
    Math.min(absoluteMax, maxRingDiameterByHeight, maxRingDiameterByWidth),
  );

  const stageHeight = ringCanvasSize;
  const stageWidth = Math.round(ringCanvasSize * aspectRatio);

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
