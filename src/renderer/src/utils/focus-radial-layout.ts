import {
  VINYL_DISC_RADIUS,
  VINYL_LABEL_RADIUS,
  VINYL_RING_RADIUS,
  VINYL_VIEWBOX_HEIGHT,
  computeNowPlayingVinylSizing,
} from './vinyl-geometry';

export interface UnifiedVinylPlacement {
  /** Base component diameter used by the single mounted VinylTurntable node (px) */
  baseSizePx: number;
  /** CSS scale multiplier applied via GPU transform on the shared wrapper */
  scale: number;
  /** Computed stage size in px (baseSizePx * scale) */
  targetSizePx: number;
  /** Actual pressed black vinyl disc diameter in screen px (`2 * discRadiusPx`) */
  actualDiscDiameterPx: number;
  /** Ratio `actualDiscDiameterPx / viewportHeight` (`~1.45-1.56` in Focus desktop) */
  discToViewportHeightRatio: number;
  /** Wrapper top-left X coordinate inside NowPlayingPage root (px) */
  translateX: number;
  /** Wrapper top-left Y coordinate inside NowPlayingPage root (px) */
  translateY: number;
  /** Visual center X in screen viewport coordinates (px) */
  centerX: number;
  /** Visual center Y in screen viewport coordinates (px) */
  centerY: number;
  /** Scaled full circular progress ring radius in Standard mode (px) */
  ringRadiusPx: number;
  /** Effective Focus Adaptive Progress Arc radius closely hugging the black vinyl rim (px) */
  focusArcRadiusPx: number;
  /** Scaled black/pressed vinyl disc radius (px) */
  discRadiusPx: number;
  /** Scaled circular center artwork label radius (px) */
  labelRadiusPx: number;
  /** Fraction (0..1) of the circular center artwork label remaining inside viewport x >= 0 */
  visibleLabelAreaFraction: number;
  /** True when Standard Now Playing shows inline 3-zone desktop layout */
  hasThreeZoneDesktop: boolean;
  /** Desktop 3-zone column bounds in Standard mode (px across full stable viewport) */
  standardZones: {
    stageWidth: number;
    stageHeight: number;
    leftQueueWidth: number;
    centerVinylWidth: number;
    rightInfoWidth: number;
    diagonalTopPct: number;
    diagonalBottomPct: number;
  };
}

export interface RadialArcBand {
  leftPx: number;
  maxWidthPx: number;
  topPx: number;
}

export interface FocusRadialLayout {
  isCompactFallback: boolean;
  /** Safe content zone bounds relative to viewport */
  contentRightLimitPx: number;
  /** Rightmost visible screen X edge of Focus Adaptive Progress Arc */
  vinylRightEdgePx: number;
  minGapPx: number;
  /** Group A: Track Identity (Title + Artist aligned along the continuous radial arc) */
  groupATrackIdentity: {
    leftPx: number;
    topPx: number;
    maxWidthPx: number;
    titleArtistGapPx: number;
    /** Phase 4.3D: Computed arc chord differential (+ optical leading alignment) for Artist relative to Title (px). */
    artistRadialOffsetPx: number;
    /** Rendered/estimated title height (px) used for stacked positioning */
    approxTitleHeightPx: number;
  };
  /** Group B: Playback Interaction (5 compact controls + horizontal progress share unified anchor) */
  groupBPlaybackInteraction: {
    leftPx: number;
    topPx: number;
    maxWidthPx: number;
    progressWidthPx: number;
    controlsToProgressGapPx: number;
  };
  /** Group C: Radial curved lyrics parameters — slot count adapts (5 | 7 | 9) by available height */
  groupCLyrics: {
    baseLeftPx: number;
    topPx: number;
    maxWidthPx: number;
    slotStepY: number;
    centerSlotYInGroup: number;
    guideCenterX: number;
    guideCenterY: number;
    guideRadius: number;
    centerFontPx: number;
    adjFontPx: number;
    outerFontPx: number;
    adj3FontPx: number;
    farFontPx: number;
    /** Phase 4.3F: Visible slot window size (5 | 7 | 9). Active lyric always sits at center slot. */
    visibleSlotCount: 5 | 7 | 9;
    /** Phase 4.3F: Per-slot top Y offsets relative to Group C top, indexed 0..visibleSlotCount-1 */
    slotTopOffsetsPx: number[];
    /** Total stage height of the visible lyric window (px) */
    windowHeightPx: number;
    /** Phase 4.4C: Maximum usable vertical height downward inside safe bottom margin (px) */
    maxWindowHeightPx: number;
    /** Phase 4.3F: Per-slot opacity values indexed from top (0) to bottom (visibleSlotCount-1) */
    slotOpacities: number[];
    /** Phase 4.3F: Per-slot font size values indexed from top (0) to bottom (visibleSlotCount-1) */
    slotFontSizes: number[];
  };
  /** Legacy / compatibility band aliases mapped cleanly from the 3 groups */
  titleBand: RadialArcBand;
  artistBand: RadialArcBand;
  controlsBand: RadialArcBand;
  lyricsBand: RadialArcBand;
}

/**
 * Exact circular segment visibility helper:
 * Given a circle of radius `r` centered at `centerX` relative to left crop line `x = 0`,
 * computes the fraction of area lying inside `x >= 0`.
 * At `centerX = 0.25 * r`, visible fraction ≈ 0.659 (~2/3).
 */
export function computeCircularVisibleAreaFraction(centerX: number, radius: number): number {
  if (radius <= 0) return 0;
  if (centerX >= radius) return 1;
  if (centerX <= -radius) return 0;

  if (centerX >= 0) {
    const h = radius - centerX;
    const theta = 2 * Math.acos(Math.max(-1, Math.min(1, (radius - h) / radius)));
    const cutArea = 0.5 * radius * radius * (theta - Math.sin(theta));
    const total = Math.PI * radius * radius;
    return Math.max(0, Math.min(1, 1 - cutArea / total));
  }

  const hVisible = radius + centerX;
  const theta = 2 * Math.acos(Math.max(-1, Math.min(1, (radius - hVisible) / radius)));
  const visibleArea = 0.5 * radius * radius * (theta - Math.sin(theta));
  const total = Math.PI * radius * radius;
  return Math.max(0, Math.min(1, visibleArea / total));
}

/**
 * Computes pure radial arc X coordinate on the right chord of `(cx, cy, R)` at vertical position `y`,
 * with smooth tangent continuation outside `|y - cy| >= 0.88 * R` so NaN or sudden collapse never happens.
 */
export function computeVinylRadialChordX(
  yPos: number,
  centerX: number,
  centerY: number,
  guideRadius: number,
): number {
  const dy = yPos - centerY;
  const safeLimit = guideRadius * 0.88;
  if (Math.abs(dy) <= safeLimit) {
    return centerX + Math.sqrt(Math.max(0, guideRadius * guideRadius - dy * dy));
  }
  const edgeX = centerX + Math.sqrt(Math.max(0, guideRadius * guideRadius - safeLimit * safeLimit));
  const slopeMagnitude = safeLimit / Math.max(1, edgeX - centerX);
  const overshoot = Math.abs(dy) - safeLimit;
  return Math.max(centerX + guideRadius * 0.35, edgeX - overshoot * Math.min(1.15, slopeMagnitude));
}

/**
 * Computes unified placement coordinates for the SINGLE persistent VinylTurntable wrapper
 * across BOTH Standard Now Playing (sidebar overlays cleanly with zero stage jump!) and
 * Focus Vinyl (Phase 4.2B: ACTUAL pressed disc diameter reaches ~145–158% of desktop height
 * with ~2/3 visible circular center label artwork and tight Adaptive Progress Arc hugging disc rim).
 */
export function computeUnifiedVinylPlacement(input: {
  viewportWidth: number;
  viewportHeight: number;
  isFocusMode: boolean;
}): UnifiedVinylPlacement {
  const vw = Math.max(480, input.viewportWidth || 1366);
  const vh = Math.max(420, input.viewportHeight || 768);

  // Sidebar in Now Playing & Focus is an overlay drawer (`fixed inset-y-0 left-0`),
  // so `stdStageW === vw` stays invariant whether Sidebar is visible or hidden (`0px` shift).
  const stdStageW = vw;
  const headerH = 44;
  const bottomH = 68;
  const stdStageH = Math.max(320, vh - headerH - bottomH);

  const hasThreeZoneDesktop = vw >= 1120;
  const leftQueueWidth = hasThreeZoneDesktop
    ? Math.max(296, Math.min(388, Math.round(stdStageW * 0.265)))
    : 0;
  const rightInfoWidth = hasThreeZoneDesktop
    ? Math.max(352, Math.min(548, Math.round(stdStageW * 0.34)))
    : Math.max(300, Math.round(stdStageW * 0.48));
  const centerVinylWidth = Math.max(280, stdStageW - leftQueueWidth - rightInfoWidth);

  const stdSizing = computeNowPlayingVinylSizing({
    viewportWidth: vw,
    viewportHeight: vh,
    isFocusMode: false,
    sidebarWidth: 0,
  });

  const stdByCenterCol = Math.floor((centerVinylWidth + (hasThreeZoneDesktop ? 64 : 16)) / 1.1);
  const stdSizePx = Math.max(
    260,
    Math.min(stdSizing.ringCanvasSize, stdByCenterCol, stdStageH - 20),
  );

  // Phase 4.2B Focus Actual Black Disc Sizing (`2 * VINYL_DISC_RADIUS / VINYL_VIEWBOX_HEIGHT = 0.836`):
  // Target actual black record diameter ~148%-154% of vh on desktop wide screens (vs 120% in 4.1),
  // reserving comfortable minimum right-side content width (>= 430px on desktop).
  const discDiameterPerStage = (VINYL_DISC_RADIUS * 2) / VINYL_VIEWBOX_HEIGHT; // 0.836
  const focusDesiredDiscDiam = vh * (vw >= 1280 ? 1.5 : 1.28);
  const arcOffsetPx = Math.round(Math.max(14, Math.min(24, vh * 0.02)));
  const minRightContentWidth = vw >= 1280 ? Math.max(460, Math.round(vw * 0.44)) : Math.round(vw * 0.46);
  const safeGapFocus = vw >= 1440 ? 66 : vw >= 1120 ? 54 : 34;

  // centerX = 0.25 * (labelRatio * stageSize) = 0.25 * (146/418) * discRadius = 0.08732 * discRadius
  // So discRightEdge = centerX + discRadius = 1.08732 * discRadius, arcRightEdge = discRightEdge + arcOffsetPx
  const maxArcRightEdge = Math.round(vw * 0.945 - minRightContentWidth - safeGapFocus);
  const maxDiscDiameterByWidth = Math.floor(
    ((maxArcRightEdge - arcOffsetPx) * 2) / (1 + 0.25 * (VINYL_LABEL_RADIUS / VINYL_DISC_RADIUS)),
  );
  const maxDiscDiameterSafe = Math.max(Math.round(vh * 1.15), Math.round(vw * 0.9));
  const focusDiscDiameterPx = Math.round(
    Math.max(
      stdSizePx * discDiameterPerStage * 1.22,
      Math.min(maxDiscDiameterSafe, focusDesiredDiscDiam, maxDiscDiameterByWidth),
    ),
  );

  const focusSizePx = Math.round(focusDiscDiameterPx / discDiameterPerStage);
  const baseSizePx = stdSizePx;

  const stdCenterX = leftQueueWidth + centerVinylWidth * 0.49;
  const stdCenterY = headerH + stdStageH * 0.5;

  const focusLabelRadiusPx = focusSizePx * (VINYL_LABEL_RADIUS / VINYL_VIEWBOX_HEIGHT);
  // 0.25 * labelRadius => ~65.9% visible circular label area (strictly inside [0.60, 0.75])
  const focusCenterX = Math.round(focusLabelRadiusPx * 0.25);
  const focusCenterY = Math.round(vh * 0.505);

  const targetSize = input.isFocusMode ? focusSizePx : stdSizePx;
  const targetCenterX = input.isFocusMode ? focusCenterX : stdCenterX;
  const targetCenterY = input.isFocusMode ? focusCenterY : stdCenterY;
  const scale = targetSize / baseSizePx;

  const translateX = Math.round(targetCenterX - 0.5 * targetSize);
  const translateY = Math.round(targetCenterY - 0.5 * targetSize);

  const ringRadiusPx = targetSize * (VINYL_RING_RADIUS / VINYL_VIEWBOX_HEIGHT);
  const discRadiusPx = targetSize * (VINYL_DISC_RADIUS / VINYL_VIEWBOX_HEIGHT);
  const focusArcRadiusPx = discRadiusPx + arcOffsetPx;
  const labelRadiusPx = targetSize * (VINYL_LABEL_RADIUS / VINYL_VIEWBOX_HEIGHT);
  const actualDiscDiameterPx = Math.round(discRadiusPx * 2);

  const diagonalCenterPct = (stdCenterX / stdStageW) * 100;
  const diagonalTopPct = Math.round((diagonalCenterPct + 6.5) * 10) / 10;
  const diagonalBottomPct = Math.round((diagonalCenterPct - 6.5) * 10) / 10;

  return {
    baseSizePx,
    scale,
    targetSizePx: targetSize,
    actualDiscDiameterPx,
    discToViewportHeightRatio: actualDiscDiameterPx / vh,
    translateX,
    translateY,
    centerX: targetCenterX,
    centerY: targetCenterY,
    ringRadiusPx,
    focusArcRadiusPx,
    discRadiusPx,
    labelRadiusPx,
    visibleLabelAreaFraction: computeCircularVisibleAreaFraction(targetCenterX, labelRadiusPx),
    hasThreeZoneDesktop,
    standardZones: {
      stageWidth: stdStageW,
      stageHeight: stdStageH,
      leftQueueWidth,
      centerVinylWidth,
      rightInfoWidth,
      diagonalTopPct,
      diagonalBottomPct,
    },
  };
}

/**
 * Builds non-uniform per-slot top offsets (`0..windowHeightPx`) for `visibleSlotCount` (`5 | 7 | 9`)
 * so active center lyric (`slotDelta === 0`) enjoys clean visual breathing space while outer context
 * lines pack more compactly and keep Active Lyric close to Playback Controls (`Phase 4.3E–F §50–51`).
 */
export function buildRadialLyricSlotOffsets(
  visibleSlotCount: 5 | 7 | 9,
  scaleFactor = 1,
  extraLineGapPx = 0,
): { slotTopOffsetsPx: number[]; centerSlotYInGroup: number; windowHeightPx: number; avgStepY: number } {
  const half = Math.floor(visibleSlotCount / 2); // 2, 3, or 4
  const distGap = (distFromCenter: number): number => {
    const base =
      distFromCenter === 1
        ? 39
        : distFromCenter === 2
          ? 31
          : distFromCenter === 3
            ? 27
            : 25;
    return Math.round(base * scaleFactor + (distFromCenter <= 1 ? extraLineGapPx : extraLineGapPx * 0.5));
  };

  // Accumulate relative offsets upward & downward symmetrically around center slot
  const relFromCenter: number[] = new Array(visibleSlotCount).fill(0);
  let accUp = 0;
  for (let d = 1; d <= half; d += 1) {
    accUp += distGap(d);
    relFromCenter[half - d] = -accUp;
  }
  let accDown = 0;
  for (let d = 1; d <= half; d += 1) {
    accDown += distGap(d);
    relFromCenter[half + d] = accDown;
  }

  const topShift = -relFromCenter[0];
  const slotTopOffsetsPx = relFromCenter.map((v) => Math.round(v + topShift));
  const centerSlotYInGroup = slotTopOffsetsPx[half];
  const bottomPad = Math.round(28 * scaleFactor + extraLineGapPx * 0.5);
  const windowHeightPx = slotTopOffsetsPx[visibleSlotCount - 1] + bottomPad;
  const avgStepY = Math.round(
    (slotTopOffsetsPx[visibleSlotCount - 1] - slotTopOffsetsPx[0]) / Math.max(1, visibleSlotCount - 1),
  );
  return { slotTopOffsetsPx, centerSlotYInGroup, windowHeightPx, avgStepY };
}

/**
 * Computes unified 3-Group Focus Vinyl layout + per-slot Curved Lyrics math (`Phase 4.2D–E`, `Phase 4.3D–F`):
 * - **Group A (Track Identity)**: Title + Artist form one compact semantic group with `3–6px` visual gap;
 *   Artist follows exact arc curvature relative to Title row's center (`artistRadialOffsetPx`).
 * - **Group B (Playback Interaction)**: 5 compact Sample 2 buttons + Horizontal Progress aligned near equator.
 * - **Group C (Interactive 7/9/5-Line Lyrics)**: Centered at vertical lyric window with true radial
 *   per-slot arc curvature along actual Focus disc & Adaptive Arc clearance.
 */
export function computeFocusRadialLayout(input: {
  viewportWidth: number;
  viewportHeight: number;
  placement: UnifiedVinylPlacement;
  hasLyrics: boolean;
  measuredTitleHeightPx?: number;
  hasMultilineLyrics?: boolean;
}): FocusRadialLayout {
  const vw = Math.max(480, input.viewportWidth || 1366);
  const vh = Math.max(420, input.viewportHeight || 768);
  const { centerX, centerY, focusArcRadiusPx } = input.placement;

  const isCompactFallback = vw < 980;
  const minGapPx = vw >= 1440 ? 70 : vw >= 1120 ? 56 : 34;
  const vinylRightEdgePx = Math.round(centerX + focusArcRadiusPx);
  const contentRightLimitPx = Math.round(vw * 0.948);
  const guideRadius = focusArcRadiusPx + minGapPx;

  // Responsive Track Identity metrics (`clamp(52px, 4.4vw, 84px)` & `clamp(21px, 1.55vw, 28px)`)
  const titleFontPx = Math.round(Math.max(52, Math.min(84, vw * 0.044)));
  const singleLineTitleHeightPx = Math.round(titleFontPx * 1.06);
  const approxTitleHeightPx =
    input.measuredTitleHeightPx && input.measuredTitleHeightPx > 32
      ? Math.round(input.measuredTitleHeightPx)
      : singleLineTitleHeightPx;
  const artistFontPx = Math.round(Math.max(21, Math.min(28, vw * 0.0155)));
  const approxArtistHeightPx = Math.round(artistFontPx * 1.28);

  // Tight vertical CSS margin so actual visible gap (accounting for 52-84px font half-leading) is ~3-6px
  // while keeping Vietnamese diacritics & descenders 100% intact.
  const titleToArtistGapPx = vh >= 900 ? 1 : 2;
  const approxGroupAHeight = approxTitleHeightPx + titleToArtistGapPx + approxArtistHeightPx;
  const groupAToBGap = vw >= 1440 && vh >= 880 ? 26 : 22;
  const controlsToProgressGapPx = vh >= 900 ? 13 : 11;
  const approxGroupBHeight = 36 + controlsToProgressGapPx + 16; // h-9 buttons + gap + h-4 progress
  const groupBToCGap = vh >= 900 ? 15 : 12;

  // Expanded Phase 4.3F/4.4C Lyric Typography (`27-32 / 20-24 / 18-20 / 16-18 / 14-16 px` on desktop)
  const centerFontPx = Math.round(Math.max(27, Math.min(32, vw * 0.017)));
  const adjFontPx = Math.round(Math.max(20, Math.min(24, vw * 0.0124)));
  const outerFontPx = Math.round(Math.max(18, Math.min(20, vw * 0.0102)));
  const adj3FontPx = Math.round(Math.max(16, Math.min(18, vw * 0.0091)));
  const farFontPx = Math.round(Math.max(14, Math.min(16, vw * 0.008)));

  const lyricScale = vh >= 980 ? 1.06 : vh >= 800 ? 1.0 : 0.94;
  const extraLineGapPx = input.hasMultilineLyrics ? 10 : 0;

  if (isCompactFallback) {
    const safeLeft = Math.min(contentRightLimitPx - 280, Math.max(24, vinylRightEdgePx + 24));
    const safeWidth = Math.max(240, contentRightLimitPx - safeLeft);
    const titleTop = Math.round(vh * 0.10);
    const controlsTop = Math.round(titleTop + approxGroupAHeight + 20);
    const lyricsTop = Math.round(controlsTop + approxGroupBHeight + 14);
    const compactGeom = buildRadialLyricSlotOffsets(5, 0.92, extraLineGapPx);
    const compactSlotOpacities = [0.42, 0.66, 1.0, 0.66, 0.42];
    const compactSlotFonts = [16, 20, 25, 20, 16];
    return {
      isCompactFallback: true,
      contentRightLimitPx,
      vinylRightEdgePx,
      minGapPx,
      groupATrackIdentity: {
        leftPx: safeLeft,
        topPx: titleTop,
        maxWidthPx: safeWidth,
        titleArtistGapPx: titleToArtistGapPx,
        artistRadialOffsetPx: 0,
        approxTitleHeightPx,
      },
      groupBPlaybackInteraction: {
        leftPx: safeLeft,
        topPx: controlsTop,
        maxWidthPx: safeWidth,
        progressWidthPx: Math.min(safeWidth, 380),
        controlsToProgressGapPx,
      },
      groupCLyrics: {
        baseLeftPx: safeLeft,
        topPx: lyricsTop,
        maxWidthPx: safeWidth,
        slotStepY: compactGeom.avgStepY,
        centerSlotYInGroup: compactGeom.centerSlotYInGroup,
        guideCenterX: centerX,
        guideCenterY: centerY,
        guideRadius,
        centerFontPx: 25,
        adjFontPx: 20,
        outerFontPx: 16,
        adj3FontPx: 14,
        farFontPx: 14,
        visibleSlotCount: 5,
        slotTopOffsetsPx: compactGeom.slotTopOffsetsPx,
        windowHeightPx: compactGeom.windowHeightPx,
        maxWindowHeightPx: Math.max(180, vh - 20 - lyricsTop),
        slotOpacities: compactSlotOpacities,
        slotFontSizes: compactSlotFonts,
      },
      titleBand: { leftPx: safeLeft, maxWidthPx: safeWidth, topPx: titleTop },
      artistBand: { leftPx: safeLeft, maxWidthPx: safeWidth, topPx: titleTop + approxTitleHeightPx + titleToArtistGapPx },
      controlsBand: { leftPx: safeLeft, maxWidthPx: safeWidth, topPx: controlsTop },
      lyricsBand: { leftPx: safeLeft, maxWidthPx: safeWidth, topPx: lyricsTop },
    };
  }

  // Phase 4.4C: Expand vertical lyrics zone cleanly downward while preserving Group A–B cohesion
  const topSafeMin = Math.round(Math.max(48, vh * 0.068));
  const bottomSafeMargin = 24;
  const maxRemainingForLyrics =
    vh - topSafeMin - bottomSafeMargin - approxGroupAHeight - groupAToBGap - approxGroupBHeight - groupBToCGap;

  const geom9 = buildRadialLyricSlotOffsets(9, lyricScale, extraLineGapPx);
  const geom7 = buildRadialLyricSlotOffsets(7, lyricScale, extraLineGapPx);
  const geom5 = buildRadialLyricSlotOffsets(5, lyricScale, extraLineGapPx);

  let visibleSlotCount: 5 | 7 | 9 = 7;
  let chosenGeom = geom7;
  if (vw >= 1360 && maxRemainingForLyrics >= geom9.windowHeightPx + 52) {
    visibleSlotCount = 9;
    chosenGeom = geom9;
  } else if (maxRemainingForLyrics < geom7.windowHeightPx + 14 || vh < 610) {
    visibleSlotCount = 5;
    chosenGeom = geom5;
  }

  const halfSlots = Math.floor(visibleSlotCount / 2);
  const slotOpacities: number[] = [];
  const slotFontSizes: number[] = [];
  for (let i = 0; i < visibleSlotCount; i += 1) {
    const dist = Math.abs(i - halfSlots);
    if (dist === 0) {
      slotOpacities.push(1.0);
      slotFontSizes.push(centerFontPx);
    } else if (dist === 1) {
      slotOpacities.push(0.66);
      slotFontSizes.push(adjFontPx);
    } else if (dist === 2) {
      slotOpacities.push(0.44);
      slotFontSizes.push(outerFontPx);
    } else if (dist === 3) {
      slotOpacities.push(0.29);
      slotFontSizes.push(adj3FontPx);
    } else {
      slotOpacities.push(0.20);
      slotFontSizes.push(farFontPx);
    }
  }

  // Cohesive vertical stack framing: keeps Group A, Group B & Group C connected seamlessly
  // near balanced viewport center while freeing downward `maxWindowHeightPx` for multiline lyrics
  const totalStackHeight = input.hasLyrics
    ? approxGroupAHeight + groupAToBGap + approxGroupBHeight + groupBToCGap + chosenGeom.windowHeightPx
    : approxGroupAHeight + groupAToBGap + approxGroupBHeight;

  const targetCenterYBias = input.hasLyrics ? vh * 0.48 : vh * 0.46;
  const rawYGroupA = Math.round(targetCenterYBias - totalStackHeight * 0.5);
  const maxYGroupA = input.hasLyrics
    ? Math.max(topSafeMin, vh - bottomSafeMargin - totalStackHeight)
    : Math.max(topSafeMin, Math.round(vh * 0.38));
  const yGroupA = Math.max(topSafeMin, Math.min(maxYGroupA, rawYGroupA));
  const yGroupB = yGroupA + approxGroupAHeight + groupAToBGap;
  const yGroupC = yGroupB + approxGroupBHeight + groupBToCGap;
  const maxWindowHeightPx = Math.max(180, vh - 20 - yGroupC);

  // Continuous local safety boundary along ACTUAL arc at height `y`:
  // Never clamp all groups against equatorial max X when curvature naturally bends inward!
  const localArcSafeX = (yCoord: number): number =>
    Math.round(computeVinylRadialChordX(yCoord, centerX, centerY, focusArcRadiusPx) + minGapPx);
  const guideXAtY = (yCoord: number): number =>
    computeVinylRadialChordX(yCoord, centerX, centerY, guideRadius);

  // Group A horizontal anchor follows chord near Title optical midpoint + modest clearance margin
  const titleMidY = yGroupA + Math.round(approxTitleHeightPx * 0.52);
  const artistTopY = yGroupA + approxTitleHeightPx + titleToArtistGapPx;
  const artistMidY = artistTopY + Math.round(approxArtistHeightPx * 0.48);
  const groupABottomSafeX = Math.max(
    localArcSafeX(yGroupA + 8),
    localArcSafeX(artistTopY + approxArtistHeightPx),
  );
  const rawGroupALeft = Math.round(guideXAtY(titleMidY) + 12);
  const groupALeft = Math.round(
    Math.min(contentRightLimitPx - 440, Math.max(groupABottomSafeX, rawGroupALeft)),
  );

  // Artist Radial Offset (§35-37): derived directly from chord differential between artistMidY and titleMidY
  // plus mild side-bearing alignment (~4.5% of big display title font size) so Artist aligns visually along arc!
  const rawChordDelta = guideXAtY(artistMidY) - guideXAtY(titleMidY);
  const opticalSideBearingPx = Math.round(Math.min(6, titleFontPx * 0.055));
  const rawArtistOffset = Math.round(rawChordDelta + opticalSideBearingPx);
  const minSafeArtistOffset = Math.max(-18, localArcSafeX(artistTopY + approxArtistHeightPx) - groupALeft);
  const artistRadialOffsetPx = Math.round(
    Math.max(minSafeArtistOffset, Math.min(24, rawArtistOffset)),
  );

  // Group B pushes cleanly along convex equatorial zone (~22-36px right of Group A depending on curvature)
  const groupBMidY = yGroupB + Math.round(approxGroupBHeight * 0.5);
  const groupBSafeMin = Math.max(localArcSafeX(yGroupB), localArcSafeX(yGroupB + approxGroupBHeight));
  const rawGroupBLeft = Math.round(guideXAtY(groupBMidY) + 18);
  const groupBLeft = Math.round(
    Math.min(
      contentRightLimitPx - 400,
      Math.max(groupBSafeMin + 14, groupALeft + 22, rawGroupBLeft),
    ),
  );

  // Group C center slot anchors directly to the guide circle at its real center lyric vertical Y
  const centerLyricMidY = yGroupC + chosenGeom.centerSlotYInGroup + Math.round(centerFontPx * 0.55);
  const centerLyricSafeMin = Math.max(
    localArcSafeX(centerLyricMidY - 14),
    localArcSafeX(centerLyricMidY + 14),
  );
  const lyricsBaseLeft = Math.round(
    Math.min(
      contentRightLimitPx - 360,
      Math.max(centerLyricSafeMin + 12, Math.round(guideXAtY(centerLyricMidY) + 14)),
    ),
  );

  const groupAMaxWidth = Math.max(320, contentRightLimitPx - groupALeft);
  const groupBMaxWidth = Math.max(320, contentRightLimitPx - groupBLeft);
  const progressWidthPx = Math.round(Math.max(340, Math.min(540, groupBMaxWidth * 0.86)));
  const groupCMaxWidth = Math.max(300, Math.min(640, contentRightLimitPx - lyricsBaseLeft));

  return {
    isCompactFallback: false,
    contentRightLimitPx,
    vinylRightEdgePx,
    minGapPx,
    groupATrackIdentity: {
      leftPx: groupALeft,
      topPx: yGroupA,
      maxWidthPx: groupAMaxWidth,
      titleArtistGapPx: titleToArtistGapPx,
      artistRadialOffsetPx,
      approxTitleHeightPx,
    },
    groupBPlaybackInteraction: {
      leftPx: groupBLeft,
      topPx: yGroupB,
      maxWidthPx: groupBMaxWidth,
      progressWidthPx,
      controlsToProgressGapPx,
    },
    groupCLyrics: {
      baseLeftPx: lyricsBaseLeft,
      topPx: yGroupC,
      maxWidthPx: groupCMaxWidth,
      slotStepY: chosenGeom.avgStepY,
      centerSlotYInGroup: chosenGeom.centerSlotYInGroup,
      guideCenterX: centerX,
      guideCenterY: centerY,
      guideRadius,
      centerFontPx,
      adjFontPx,
      outerFontPx,
      adj3FontPx,
      farFontPx,
      visibleSlotCount,
      slotTopOffsetsPx: chosenGeom.slotTopOffsetsPx,
      windowHeightPx: chosenGeom.windowHeightPx,
      maxWindowHeightPx,
      slotOpacities,
      slotFontSizes,
    },
    titleBand: { leftPx: groupALeft, maxWidthPx: groupAMaxWidth, topPx: yGroupA },
    artistBand: {
      leftPx: groupALeft + artistRadialOffsetPx,
      maxWidthPx: Math.max(240, groupAMaxWidth - Math.max(0, artistRadialOffsetPx)),
      topPx: artistTopY,
    },
    controlsBand: { leftPx: groupBLeft, maxWidthPx: groupBMaxWidth, topPx: yGroupB },
    lyricsBand: { leftPx: lyricsBaseLeft, maxWidthPx: groupCMaxWidth, topPx: yGroupC },
  };
}

/**
 * Computes individual curved horizontal offset `(dx, dy)` for any Focus lyric slot
 * across `5 | 7 | 9`-slot windows (`slotDelta` in `-4..+4`, including transient exiting slots).
 * Follows ACTUAL vinyl arc curvature around `(guideCenterX, guideCenterY, guideRadius)` while
 * enforcing local clearance against the Adaptive Progress Arc at that exact vertical height (`§44, §52-53`).
 */
export function computeRadialCurvedLyricSlotPosition(input: {
  slotDelta: number;
  groupTopPx: number;
  slotStepY: number;
  baseLeftPx: number;
  guideCenterX: number;
  guideCenterY: number;
  guideRadius: number;
  vinylRightEdgePx: number;
  minGapPx: number;
  visibleSlotCount?: 5 | 7 | 9;
  slotTopOffsetsPx?: readonly number[];
  centerSlotYInGroup?: number;
  focusArcRadiusPx?: number;
}): { dxPx: number; yPx: number } {
  const count: 5 | 7 | 9 = input.visibleSlotCount ?? 5;
  const half = Math.floor(count / 2);
  const slotIndexFromTop = input.slotDelta + half;

  let yPx: number;
  if (
    input.slotTopOffsetsPx &&
    input.slotTopOffsetsPx.length === count &&
    slotIndexFromTop >= 0 &&
    slotIndexFromTop < count
  ) {
    yPx = input.slotTopOffsetsPx[slotIndexFromTop];
  } else if (input.slotTopOffsetsPx && input.slotTopOffsetsPx.length === count) {
    // Transient exiting slots cleanly mirror step just beyond top (index < 0) or bottom (index >= count)
    if (slotIndexFromTop < 0) {
      yPx = input.slotTopOffsetsPx[0] + slotIndexFromTop * input.slotStepY;
    } else {
      yPx =
        input.slotTopOffsetsPx[count - 1] + (slotIndexFromTop - (count - 1)) * input.slotStepY;
    }
  } else {
    yPx = Math.round(slotIndexFromTop * input.slotStepY);
  }

  const centerOffsetY =
    input.centerSlotYInGroup ??
    (input.slotTopOffsetsPx && input.slotTopOffsetsPx.length === count
      ? input.slotTopOffsetsPx[half]
      : half * input.slotStepY);

  const centerAbsY = input.groupTopPx + centerOffsetY + input.slotStepY * 0.5;
  const slotAbsY = input.groupTopPx + yPx + input.slotStepY * 0.45;

  const centerChordX = computeVinylRadialChordX(
    centerAbsY,
    input.guideCenterX,
    input.guideCenterY,
    input.guideRadius,
  );
  const slotChordX = computeVinylRadialChordX(
    slotAbsY,
    input.guideCenterX,
    input.guideCenterY,
    input.guideRadius,
  );

  // Real geometric chord differential relative to center lyric slot
  const rawDx = slotChordX - centerChordX;

  // Enforce local radial clearance at BOTH slot top & bottom against true Adaptive Progress Arc contour
  const inferredArcRadius =
    input.focusArcRadiusPx ?? Math.max(120, input.guideRadius - input.minGapPx);
  const rimAtSlot = Math.max(
    computeVinylRadialChordX(input.groupTopPx + yPx, input.guideCenterX, input.guideCenterY, inferredArcRadius),
    computeVinylRadialChordX(input.groupTopPx + yPx + input.slotStepY, input.guideCenterX, input.guideCenterY, inferredArcRadius),
  );
  const minSafeDx = Math.round(rimAtSlot + Math.max(24, input.minGapPx - 14) - input.baseLeftPx);
  const dxPx = Math.round(Math.max(minSafeDx, Math.max(-42, Math.min(34, rawDx))));
  return { dxPx, yPx };
}

/**
 * Estimates rendered height of a multiline / wrapped lyric group accurately before DOM paint
 * (handles wide CJK characters vs Latin/Vietnamese text + multi-line bilingual entries).
 */
export function estimateLyricGroupHeightPx(
  lines: readonly string[],
  mainFontPx: number,
  maxWidthPx: number,
  isCenter: boolean,
): number {
  const safeWidth = Math.max(180, maxWidthPx * 0.9);
  const estimateWrappedLineCount = (text: string, fontPx: number, maxLines: number): number => {
    const trimmed = text.trim();
    if (!trimmed) return 1;
    let widthUnits = 0;
    for (let i = 0; i < trimmed.length; i += 1) {
      const code = trimmed.charCodeAt(i);
      const isWideCjk =
        (code >= 0x3000 && code <= 0x9fff) ||
        (code >= 0xac00 && code <= 0xd7af) ||
        (code >= 0xff00 && code <= 0xffef);
      widthUnits += isWideCjk ? 1.0 : 0.52;
    }
    const textWidthPx = widthUnits * fontPx;
    const rawLines = Math.max(1, Math.ceil(textWidthPx / safeWidth));
    return Math.min(maxLines, rawLines);
  };

  const mainLines = estimateWrappedLineCount(lines[0] ?? '', mainFontPx, isCenter ? 3 : 2);
  let totalHeight = Math.ceil(mainLines * mainFontPx * 1.28);

  if (lines.length > 1) {
    const subFontPx = Math.max(12, mainFontPx - 5);
    for (let s = 1; s < Math.min(lines.length, 3); s += 1) {
      const subWrap = estimateWrappedLineCount(lines[s] ?? '', subFontPx, 2);
      totalHeight += 2 + Math.ceil(subWrap * subFontPx * 1.24);
    }
  }
  return Math.max(Math.ceil(mainFontPx * 1.28), totalHeight);
}

export interface AdaptiveMultilineLyricSlotPosition {
  groupIndex: number;
  slotDelta: number;
  heightPx: number;
  yPx: number;
  dxPx: number;
  widthPx: number;
  fontSizePx: number;
  opacity: number;
}

export interface AdaptiveMultilineLyricLayoutResult {
  visibleSlotCount: 3 | 5 | 7 | 9;
  positionsByDelta: Map<number, AdaptiveMultilineLyricSlotPosition>;
  stageHeightPx: number;
  centerSlotYInGroup: number;
  avgSlotStepY: number;
}

/**
 * Pure non-overlapping multiline radial lyrics positioner (`Phase 4.4C`):
 * - Allocates actual height per lyric group (`measuredHeights` with deterministic estimate fallback),
 *   guaranteeing ZERO text overlap even across consecutive 2–3 line groups.
 * - Adapts visible slot window (`9 -> 7 -> 5 -> 3`) cleanly when multiline height exceeds
 *   available space or pushes active line too far below Playback Controls.
 * - Evaluates radial chord curve `dxPx` at each slot's REAL vertical center `y + H * 0.45`,
 *   clamped locally against the Focus Adaptive Progress Arc perimeter.
 */
export function computeAdaptiveMultilineLyricLayout(input: {
  lyricGroups: readonly { lines: readonly string[] }[];
  centerIndex: number;
  preferredVisibleCount: 5 | 7 | 9;
  groupTopPx: number;
  maxWindowHeightPx: number;
  maxWidthPx: number;
  baseLeftPx: number;
  guideCenterX: number;
  guideCenterY: number;
  guideRadius: number;
  focusArcRadiusPx: number;
  minGapPx: number;
  centerFontPx: number;
  adjFontPx: number;
  outerFontPx: number;
  adj3FontPx: number;
  farFontPx: number;
  getMeasuredHeight?: (groupIndex: number, fontSizePx: number, widthPx: number) => number | undefined;
}): AdaptiveMultilineLyricLayoutResult {
  const {
    lyricGroups,
    centerIndex,
    preferredVisibleCount,
    groupTopPx,
    maxWindowHeightPx,
    maxWidthPx,
    baseLeftPx,
    guideCenterX,
    guideCenterY,
    guideRadius,
    focusArcRadiusPx,
    minGapPx,
    centerFontPx,
    adjFontPx,
    outerFontPx,
    adj3FontPx,
    farFontPx,
    getMeasuredHeight,
  } = input;

  if (lyricGroups.length === 0) {
    return {
      visibleSlotCount: 5,
      positionsByDelta: new Map(),
      stageHeightPx: 120,
      centerSlotYInGroup: 0,
      avgSlotStepY: 36,
    };
  }

  const fontForDist = (dist: number): number => {
    if (dist === 0) return centerFontPx;
    if (dist === 1) return adjFontPx;
    if (dist === 2) return outerFontPx;
    if (dist === 3) return adj3FontPx;
    return farFontPx;
  };

  const opacityForDist = (dist: number): number => {
    if (dist === 0) return 1.0;
    if (dist === 1) return 0.66;
    if (dist === 2) return 0.44;
    if (dist === 3) return 0.29;
    return 0.2;
  };

  const pairGapForAdjacent = (deltaA: number, deltaB: number): number => {
    const minDist = Math.min(Math.abs(deltaA), Math.abs(deltaB));
    if (minDist === 0) return 18;
    if (minDist === 1) return 13;
    return 10;
  };

  const measureSlot = (idx: number, delta: number, approxDxWidth: number): { height: number; fontSizePx: number } => {
    const dist = Math.abs(delta);
    const fontPx = fontForDist(dist);
    const availW = Math.max(240, maxWidthPx - Math.max(0, approxDxWidth));
    const measured = getMeasuredHeight?.(idx, fontPx, availW);
    const height =
      typeof measured === 'number' && Number.isFinite(measured) && measured > 8
        ? Math.ceil(measured)
        : estimateLyricGroupHeightPx(lyricGroups[idx].lines, fontPx, availW, dist === 0);
    return { height, fontSizePx: fontPx };
  };

  const candidates = ([9, 7, 5, 3] as const).filter(
    (c) => c <= preferredVisibleCount || c === 3 || c === 5,
  );
  let chosenCount: 3 | 5 | 7 | 9 = candidates[candidates.length - 1] ?? 5;
  let chosenYMap = new Map<number, { yPx: number; height: number; fontSizePx: number }>();
  let chosenStageHeight = 140;

  for (const count of candidates) {
    const half = Math.floor(count / 2);
    const slotMetrics = new Map<number, { height: number; fontSizePx: number; idx: number }>();

    for (let d = -half; d <= half; d += 1) {
      const idx = centerIndex + d;
      if (idx < 0 || idx >= lyricGroups.length) continue;
      // Mild width safety (~10px upper arc shift)
      const { height, fontSizePx } = measureSlot(idx, d, d < 0 ? 6 : 0);
      slotMetrics.set(d, { height, fontSizePx, idx });
    }

    const centerMetric = slotMetrics.get(0);
    if (!centerMetric) continue;

    // Accumulate upward above center so ZERO overlap happens
    let aboveHeight = 0;
    const negDeltas = Array.from(slotMetrics.keys())
      .filter((d) => d < 0)
      .sort((a, b) => b - a); // -1, -2, -3...
    for (let i = 0; i < negDeltas.length; i += 1) {
      const d = negDeltas[i];
      const upperDeltaNextCloser = i === 0 ? 0 : negDeltas[i - 1];
      aboveHeight += pairGapForAdjacent(d, upperDeltaNextCloser) + slotMetrics.get(d)!.height;
    }

    let belowHeight = centerMetric.height;
    const posDeltas = Array.from(slotMetrics.keys())
      .filter((d) => d > 0)
      .sort((a, b) => a - b); // +1, +2, +3...
    for (let i = 0; i < posDeltas.length; i += 1) {
      const d = posDeltas[i];
      const prevCloser = i === 0 ? 0 : posDeltas[i - 1];
      belowHeight += pairGapForAdjacent(prevCloser, d) + slotMetrics.get(d)!.height;
    }

    const totalNeeded = aboveHeight + belowHeight;
    // Keep Active Line cleanly positioned near Controls when lyrics above are unusually multi-line tall
    const maxAboveBudget = Math.max(175, Math.round(maxWindowHeightPx * 0.48));
    const fitsWindow = totalNeeded <= maxWindowHeightPx;
    const keepsCenterNearControls = count <= 5 || aboveHeight <= maxAboveBudget;

    if ((fitsWindow && keepsCenterNearControls) || count === 3) {
      const yMap = new Map<number, { yPx: number; height: number; fontSizePx: number }>();
      const centerTop = aboveHeight;
      yMap.set(0, {
        yPx: centerTop,
        height: centerMetric.height,
        fontSizePx: centerMetric.fontSizePx,
      });

      let cursorTop = centerTop;
      for (let i = 0; i < negDeltas.length; i += 1) {
        const d = negDeltas[i];
        const prevCloser = i === 0 ? 0 : negDeltas[i - 1];
        const m = slotMetrics.get(d)!;
        cursorTop -= pairGapForAdjacent(d, prevCloser) + m.height;
        yMap.set(d, { yPx: Math.max(0, cursorTop), height: m.height, fontSizePx: m.fontSizePx });
      }

      let cursorBottom = centerTop + centerMetric.height;
      for (let i = 0; i < posDeltas.length; i += 1) {
        const d = posDeltas[i];
        const prevCloser = i === 0 ? 0 : posDeltas[i - 1];
        const m = slotMetrics.get(d)!;
        cursorBottom += pairGapForAdjacent(prevCloser, d);
        yMap.set(d, { yPx: cursorBottom, height: m.height, fontSizePx: m.fontSizePx });
        cursorBottom += m.height;
      }

      chosenCount = count;
      chosenYMap = yMap;
      chosenStageHeight = Math.max(totalNeeded, centerMetric.height + 16);
      break;
    }
  }

  const centerInfo = chosenYMap.get(0) ?? { yPx: 0, height: 36, fontSizePx: centerFontPx };
  const centerAbsY = groupTopPx + centerInfo.yPx + centerInfo.height * 0.5;
  const centerChordX = computeVinylRadialChordX(centerAbsY, guideCenterX, guideCenterY, guideRadius);

  const positionsByDelta = new Map<number, AdaptiveMultilineLyricSlotPosition>();
  const minRimMargin = Math.max(24, minGapPx - 14);

  const sortedDeltas = Array.from(chosenYMap.keys()).sort((a, b) => a - b);
  for (const d of sortedDeltas) {
    const idx = centerIndex + d;
    const item = chosenYMap.get(d)!;
    const slotMidY = groupTopPx + item.yPx + item.height * 0.45;
    const slotChordX = computeVinylRadialChordX(slotMidY, guideCenterX, guideCenterY, guideRadius);
    const rawDx = slotChordX - centerChordX;

    const rimAtTop = computeVinylRadialChordX(
      groupTopPx + item.yPx,
      guideCenterX,
      guideCenterY,
      focusArcRadiusPx,
    );
    const rimAtBot = computeVinylRadialChordX(
      groupTopPx + item.yPx + item.height,
      guideCenterX,
      guideCenterY,
      focusArcRadiusPx,
    );
    const minSafeDx = Math.round(Math.max(rimAtTop, rimAtBot) + minRimMargin - baseLeftPx);
    const dxPx = d === 0 ? Math.round(Math.max(minSafeDx, 0)) : Math.round(Math.max(minSafeDx, Math.max(-44, Math.min(34, rawDx))));
    const widthPx = Math.max(240, maxWidthPx - Math.max(0, dxPx));

    positionsByDelta.set(d, {
      groupIndex: idx,
      slotDelta: d,
      heightPx: item.height,
      yPx: Math.round(item.yPx),
      dxPx,
      widthPx,
      fontSizePx: item.fontSizePx,
      opacity: opacityForDist(Math.abs(d)),
    });
  }

  const firstPos = positionsByDelta.get(sortedDeltas[0]);
  const lastPos = positionsByDelta.get(sortedDeltas[sortedDeltas.length - 1]);
  const avgSlotStepY =
    sortedDeltas.length > 1 && firstPos && lastPos
      ? Math.max(28, Math.round((lastPos.yPx - firstPos.yPx) / (sortedDeltas.length - 1)))
      : 38;

  return {
    visibleSlotCount: chosenCount,
    positionsByDelta,
    stageHeightPx: Math.round(chosenStageHeight),
    centerSlotYInGroup: Math.round(centerInfo.yPx),
    avgSlotStepY,
  };
}
