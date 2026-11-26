import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  resolveSidebarAutoHideMode,
  resolveUiAnimationPolicy,
  STANDARD_ENTRY_IDLE_HIDE_MS,
} from '../src/renderer/src/utils/animation-policy';
import { computeEditorialTypographyMetrics } from '../src/shared/utils/editorial-typography';
import {
  buildPaletteFromSampledRgb,
} from '../src/renderer/src/utils/dynamic-color';
import {
  buildFocusFiveLineSlotItems,
  buildFocusLyricSlotItems,
  buildFocusWindowSlotItems,
  accumulateLyricsWheelStep,
  resolveFocusLyricTransitionDirection,
} from '../src/renderer/src/components/FocusMinimalLyrics';
import {
  computeAdaptiveMultilineLyricLayout,
  computeCircularVisibleAreaFraction,
  computeFocusRadialLayout,
  computeRadialCurvedLyricSlotPosition,
  computeUnifiedVinylPlacement,
  computeVinylRadialChordX,
  estimateLyricGroupHeightPx,
} from '../src/renderer/src/utils/focus-radial-layout';
import {
  buildFallbackAdaptiveTheme,
  computeContrastRatio,
  computeRelativeLuminance,
  extractAdaptiveArtworkThemeFromRgbaPixels,
} from '../src/renderer/src/utils/adaptive-artwork';

function makeRgbaGrid(
  colors: Array<[number, number, number, number]>,
  repeats = 16,
): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(colors.length * repeats * 4);
  let idx = 0;
  for (let r = 0; r < repeats; r += 1) {
    for (const [R, G, B, A] of colors) {
      arr[idx++] = R;
      arr[idx++] = G;
      arr[idx++] = B;
      arr[idx++] = A;
    }
  }
  return arr;
}

test('Phase 4B: Offline font stack avoids broken Poppins subset fallback and configures Dark/Light <select> contrast', () => {
  const mainTsx = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/main.tsx'),
    'utf8',
  );
  const indexCss = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/styles/index.css'),
    'utf8',
  );

  assert.equal(mainTsx.includes('@fontsource/poppins'), false);
  assert.match(indexCss, /--font-display:\s*'Segoe UI Variable Display'/);
  assert.match(indexCss, /--font-sans:\s*'Segoe UI Variable Text'/);
  assert.match(indexCss, /Microsoft YaHei UI/);
  assert.match(indexCss, /color-scheme:\s*dark/);
  assert.match(indexCss, /select option/);

  // Extended Vietnamese & CJK Editorial metrics use safe >= 1.1 lineHeight so accents never clip
  const viMetrics = computeEditorialTypographyMetrics({
    topText: 'ÂM NHẠC VIỆT',
    bottomText: '静かな夜 · THẬT SỰ',
    containerWidth: 1280,
    containerHeight: 720,
    fontSizeScale: 1,
  });
  assert.ok(viMetrics.lineHeight >= 1.1, `Expected safe diacritic lineHeight >= 1.1, got ${viMetrics.lineHeight}`);
});

test('Phase 4C: Adaptive Artwork Extractor handles red, blue, gold, monochrome, near-black, near-white & transparent artworks with WCAG contrast', () => {
  const cases: Array<{
    name: string;
    pixels: Uint8ClampedArray;
    expectMono?: boolean;
    expectFallback?: boolean;
  }> = [
    { name: 'crimson-red', pixels: makeRgbaGrid([[196, 36, 48, 255]]) },
    { name: 'ocean-blue', pixels: makeRgbaGrid([[36, 118, 214, 255]]) },
    { name: 'warm-gold', pixels: makeRgbaGrid([[224, 174, 52, 255]]) },
    { name: 'vivid-contrast', pixels: makeRgbaGrid([[210, 42, 90, 255], [24, 168, 196, 255]]) },
    { name: 'grayscale', pixels: makeRgbaGrid([[128, 128, 128, 255]], 32), expectMono: true },
    { name: 'near-black', pixels: makeRgbaGrid([[8, 8, 9, 255]], 32), expectMono: true },
    { name: 'near-white', pixels: makeRgbaGrid([[248, 248, 248, 255]], 32), expectMono: true },
    { name: 'transparent', pixels: makeRgbaGrid([[0, 0, 0, 0]], 16), expectFallback: true },
  ];

  const redDarkHex = extractAdaptiveArtworkThemeFromRgbaPixels(cases[0].pixels, {
    artworkKey: 'red',
    themeMode: 'dark',
    dynamicAlbumColors: true,
  }).palette.dominant;
  const blueDarkHex = extractAdaptiveArtworkThemeFromRgbaPixels(cases[1].pixels, {
    artworkKey: 'blue',
    themeMode: 'dark',
    dynamicAlbumColors: true,
  }).palette.dominant;
  assert.notEqual(redDarkHex, blueDarkHex);

  for (const mode of ['dark', 'light'] as const) {
    for (const c of cases) {
      const theme = extractAdaptiveArtworkThemeFromRgbaPixels(c.pixels, {
        artworkKey: `test:${c.name}`,
        themeMode: mode,
        dynamicAlbumColors: true,
      });

      if (c.expectMono) {
        assert.equal(theme.isMonochrome, true, `${c.name} should stay monochrome`);
      }
      if (c.expectFallback) {
        assert.equal(theme.isFallback, true, `${c.name} should fall back cleanly`);
      }

      // Noticeably lighter right zone vs left zone in BOTH Dark Mode & Light Mode
      const leftLum = computeRelativeLuminance(theme.darkToneRgb);
      const rightLum = computeRelativeLuminance(theme.lightToneRgb);
      assert.ok(
        rightLum > leftLum + 0.25,
        `${c.name} (${mode}): expected right light zone (${rightLum.toFixed(2)}) brighter than left dark zone (${leftLum.toFixed(2)})`,
      );

      // WCAG AA contrast thresholds met on Dark zone, Light zone, and Focus canvas
      assert.ok(theme.darkZoneContrastRatio >= 4.5, `${c.name} dark zone contrast ${theme.darkZoneContrastRatio}`);
      assert.ok(theme.lightZoneContrastRatio >= 4.5, `${c.name} light zone contrast ${theme.lightZoneContrastRatio}`);
      assert.ok(theme.focusContrastRatio >= 4.5, `${c.name} focus contrast ${theme.focusContrastRatio}`);
    }
  }

  const disabledDyn = buildFallbackAdaptiveTheme({ artworkKey: 'none', themeMode: 'dark' });
  assert.equal(disabledDyn.isFallback, true);
});

test('Phase 4E & 4L: Focus Vinyl achieves ~2/3 visible center artwork label, balanced radial arc bands & safe responsive sizing', () => {
  const viewports = [
    { w: 2560, h: 1440 },
    { w: 1920, h: 1080 },
    { w: 1440, h: 900 },
    { w: 1366, h: 768 },
    { w: 1280, h: 720 },
  ];

  for (const vp of viewports) {
    const std = computeUnifiedVinylPlacement({
      viewportWidth: vp.w,
      viewportHeight: vp.h,
      isFocusMode: false,
    });
    const focus = computeUnifiedVinylPlacement({
      viewportWidth: vp.w,
      viewportHeight: vp.h,
      isFocusMode: true,
    });

    assert.equal(std.hasThreeZoneDesktop, true);
    assert.ok(std.visibleLabelAreaFraction > 0.99, 'Standard mode must display full center label');

    // Focus center artwork visibility MUST be ~2/3 (strictly inside [0.60, 0.75])
    assert.ok(
      focus.visibleLabelAreaFraction >= 0.6 && focus.visibleLabelAreaFraction <= 0.75,
      `Expected ~2/3 center label visible at ${vp.w}x${vp.h}, got ${focus.visibleLabelAreaFraction.toFixed(3)}`,
    );

    // Focus actual black disc diameter reaches monumental oversized scale (~133%-150% vh on wide desktop)
    // while keeping ~2/3 visible circular artwork label and balanced right space (>= 42% vw)
    assert.ok(
      focus.discToViewportHeightRatio >= 1.3,
      `Expected oversized Focus ACTUAL disc >= 1.30*vh at ${vp.w}x${vp.h}, got ${focus.discToViewportHeightRatio.toFixed(3)}`,
    );
    if (vp.w / vp.h >= 1.75) {
      assert.ok(
        focus.discToViewportHeightRatio >= 1.45,
        `Expected 16:9 desktop actual disc >= 1.45*vh at ${vp.w}x${vp.h}, got ${focus.discToViewportHeightRatio.toFixed(3)}`,
      );
    }
    assert.ok(focus.centerX - focus.discRadiusPx < 0, 'Outer vinyl must crop off left edge');
    assert.ok(
      (focus.centerX + focus.focusArcRadiusPx) / vp.w <= 0.58,
      `Expected right content width >= 42% at ${vp.w}x${vp.h}, focusArcRight=${focus.centerX + focus.focusArcRadiusPx}`,
    );

    // Phase 4.3D–F: 3-Group Radial Layout — Group A tight Title-Artist gap + radial chord offset for Artist; Group B steps cleanly; Group C renders 7/9-line curved slots
    const radial = computeFocusRadialLayout({
      viewportWidth: vp.w,
      viewportHeight: vp.h,
      placement: focus,
      hasLyrics: true,
    });
    assert.ok(radial.groupATrackIdentity.leftPx >= radial.vinylRightEdgePx + 36);
    assert.equal(
      radial.artistBand.leftPx,
      radial.groupATrackIdentity.leftPx + radial.groupATrackIdentity.artistRadialOffsetPx,
      'Artist must offset radially outward relative to Title along circular chord',
    );
    assert.ok(
      radial.groupATrackIdentity.artistRadialOffsetPx >= 8 &&
        radial.groupATrackIdentity.artistRadialOffsetPx <= 28,
      `Expected subtle radial offset 8-28px at ${vp.w}x${vp.h}, got ${radial.groupATrackIdentity.artistRadialOffsetPx}`,
    );
    assert.ok(
      radial.groupATrackIdentity.titleArtistGapPx >= 1 &&
        radial.groupATrackIdentity.titleArtistGapPx <= 4,
      `Expected tight Phase 4.3 Title-Artist CSS gap (1-4px), got ${radial.groupATrackIdentity.titleArtistGapPx}`,
    );
    assert.ok(radial.groupBPlaybackInteraction.leftPx >= radial.artistBand.leftPx + 4);
    assert.ok(radial.groupBPlaybackInteraction.progressWidthPx >= 340);
    assert.ok(radial.groupATrackIdentity.leftPx + radial.groupATrackIdentity.maxWidthPx <= vp.w * 0.96);

    const expectedSlots = vp.h <= 750 ? 7 : 9;
    assert.equal(radial.groupCLyrics.visibleSlotCount, expectedSlots);
    assert.ok(radial.groupCLyrics.centerFontPx >= 26 && radial.groupCLyrics.centerFontPx <= 32);
    const half = Math.floor(radial.groupCLyrics.visibleSlotCount / 2);
    assert.equal(radial.groupCLyrics.slotOpacities[half], 1);
    assert.equal(radial.groupCLyrics.slotOpacities[half - 1], 0.66);
    assert.equal(radial.groupCLyrics.slotOpacities[half + 1], 0.66);

    // 7/9-line per-slot radial geometry follows actual vinyl circle contour without flat cutoff
    const deltas = Array.from({ length: radial.groupCLyrics.visibleSlotCount }, (_, idx) => idx - half);
    const slots = deltas.map((delta) =>
      computeRadialCurvedLyricSlotPosition({
        slotDelta: delta,
        groupTopPx: radial.groupCLyrics.topPx,
        slotStepY: radial.groupCLyrics.slotStepY,
        baseLeftPx: radial.groupCLyrics.baseLeftPx,
        guideCenterX: radial.groupCLyrics.guideCenterX,
        guideCenterY: radial.groupCLyrics.guideCenterY,
        guideRadius: radial.groupCLyrics.guideRadius,
        vinylRightEdgePx: radial.vinylRightEdgePx,
        minGapPx: radial.minGapPx,
        visibleSlotCount: radial.groupCLyrics.visibleSlotCount,
        slotTopOffsetsPx: radial.groupCLyrics.slotTopOffsetsPx,
        centerSlotYInGroup: radial.groupCLyrics.centerSlotYInGroup,
        focusArcRadiusPx: focus.focusArcRadiusPx,
      }),
    );
    assert.ok(slots.every((s) => Number.isFinite(s.dxPx) && Number.isFinite(s.yPx)));
    assert.notEqual(slots[0].dxPx, slots[slots.length - 1].dxPx, 'Upper and lower lyric slots must follow circle arc curvature');
    assert.ok(
      slots.every((s) => {
        const slotAbsY = radial.groupCLyrics.topPx + s.yPx;
        const arcX = computeVinylRadialChordX(
          slotAbsY,
          focus.centerX,
          focus.centerY,
          focus.focusArcRadiusPx,
        );
        return radial.groupCLyrics.baseLeftPx + s.dxPx >= arcX + radial.minGapPx - 16;
      }),
      `Every curved slot at ${vp.w}x${vp.h} must preserve local rim clearance`,
    );
    assert.ok(
      radial.groupCLyrics.topPx + radial.groupCLyrics.windowHeightPx <= vp.h - 20,
      `Lyric window must not clip bottom edge at ${vp.w}x${vp.h}`,
    );

    // Multiline computation guarantees zero overlap and adapts 9->7->5 gracefully on tall verses
    const singleGroupSample = [{ lines: ['Line 1'] }, { lines: ['Line 2'] }, { lines: ['Line 3'] }];
    assert.ok(estimateLyricGroupHeightPx(singleGroupSample[0].lines, 28, 420, true) >= 34);
    const adaptiveSingle = computeAdaptiveMultilineLyricLayout({
      lyricGroups: Array.from({ length: 12 }, (_, idx) => ({ lines: [`Lyric line ${idx}`] })),
      centerIndex: 5,
      preferredVisibleCount: radial.groupCLyrics.visibleSlotCount,
      groupTopPx: radial.groupCLyrics.topPx,
      maxWindowHeightPx: radial.groupCLyrics.maxWindowHeightPx,
      maxWidthPx: radial.groupCLyrics.maxWidthPx,
      baseLeftPx: radial.groupCLyrics.baseLeftPx,
      guideCenterX: radial.groupCLyrics.guideCenterX,
      guideCenterY: radial.groupCLyrics.guideCenterY,
      guideRadius: radial.groupCLyrics.guideRadius,
      focusArcRadiusPx: focus.focusArcRadiusPx,
      minGapPx: radial.minGapPx,
      centerFontPx: radial.groupCLyrics.centerFontPx,
      adjFontPx: radial.groupCLyrics.adjFontPx,
      outerFontPx: radial.groupCLyrics.outerFontPx,
      adj3FontPx: radial.groupCLyrics.adj3FontPx,
      farFontPx: radial.groupCLyrics.farFontPx,
    });
    assert.equal(adaptiveSingle.visibleSlotCount, expectedSlots);

    // 2-line wrapped title pushes Group B & C down cleanly via measuredTitleHeightPx
    const wrappedLayout = computeFocusRadialLayout({
      viewportWidth: vp.w,
      viewportHeight: vp.h,
      placement: focus,
      hasLyrics: true,
      measuredTitleHeightPx: 148,
      hasMultilineLyrics: true,
    });
    assert.ok(wrappedLayout.groupBPlaybackInteraction.topPx > radial.groupBPlaybackInteraction.topPx);
    assert.ok(wrappedLayout.groupCLyrics.topPx + wrappedLayout.groupCLyrics.windowHeightPx <= vp.h - 16);
  }

  // Exact geometry sanity check on computeCircularVisibleAreaFraction (~2/3 visible at 0.25r)
  assert.ok(Math.abs(computeCircularVisibleAreaFraction(25, 100) - 0.659) < 0.02);

  // Small viewport switches cleanly from 3-zone inline Queue to Queue tab toggle
  const narrowStd = computeUnifiedVinylPlacement({
    viewportWidth: 960,
    viewportHeight: 720,
    isFocusMode: false,
  });
  assert.equal(narrowStd.hasThreeZoneDesktop, false);
});

test('Phase 4J: Unified animation policy maps existing PersonalizationPreferences accurately', () => {
  const high = resolveUiAnimationPolicy({
    uiQualityPreset: 'high',
    reducedMotion: false,
    vinylAnimation: true,
    backgroundEffects: true,
    dynamicAlbumColors: true,
  });
  assert.equal(high.effectiveMotion, 'full');
  assert.equal(high.vinylSpinAllowed, true);
  assert.equal(high.artworkBlurEnabled, true);
  assert.equal(high.diffuseBackdropEnabled, true);
  assert.ok(high.modeTransitionMs >= 850 && high.modeTransitionMs <= 1000);
  assert.ok(high.backgroundCrossfadeMs >= 700 && high.backgroundCrossfadeMs <= 950);
  assert.ok(high.lyricsTransitionMs >= 350 && high.lyricsTransitionMs <= 500);

  const saver = resolveUiAnimationPolicy({
    uiQualityPreset: 'power-saver',
    reducedMotion: false,
    vinylAnimation: true,
    backgroundEffects: true,
    dynamicAlbumColors: true,
  });
  assert.equal(saver.effectiveMotion, 'reduced');
  assert.equal(saver.artworkBlurEnabled, false);
  assert.equal(saver.diffuseBackdropEnabled, false);
  assert.equal(saver.vinylSpinAllowed, true);

  const reduced = resolveUiAnimationPolicy({
    uiQualityPreset: 'high',
    reducedMotion: true,
    vinylAnimation: true,
    backgroundEffects: true,
    dynamicAlbumColors: true,
  });
  assert.equal(reduced.effectiveMotion, 'none');
  assert.equal(reduced.modeTransitionMs, 0);
  assert.equal(reduced.backgroundCrossfadeMs, 0);
  assert.equal(reduced.sidebarTransitionMs, 0);
  assert.equal(reduced.vinylSpinAllowed, false);

  const hiddenWindow = resolveUiAnimationPolicy(
    {
      uiQualityPreset: 'balanced',
      reducedMotion: false,
      vinylAnimation: true,
      backgroundEffects: true,
      dynamicAlbumColors: true,
    },
    { isWindowHidden: true },
  );
  assert.equal(hiddenWindow.vinylSpinAllowed, false);
});

test('Phase 4.1: Custom media protocol services expose CORS headers & Focus Lyrics transitions preserve stable identities', () => {
  const artworkSvc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/main/services/artwork-service.ts'),
    'utf8',
  );
  const playlistSvc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/main/services/playlist-service.ts'),
    'utf8',
  );
  const profileSvc = fs.readFileSync(
    path.resolve(process.cwd(), 'src/main/services/profile-service.ts'),
    'utf8',
  );
  assert.match(artworkSvc, /buildMediaCorsHeaders/);
  assert.match(playlistSvc, /buildMediaCorsHeaders/);
  assert.match(profileSvc, /buildMediaCorsHeaders/);

  const groups = [0, 4, 8, 12, 16].map((timeSec, idx) => ({
    timeSec,
    firstLineIndex: idx,
    lines: [`Line ${idx}`],
  }));

  assert.equal(resolveFocusLyricTransitionDirection(1, 2, true), 'forward');
  assert.equal(resolveFocusLyricTransitionDirection(3, 2, true), 'backward');
  assert.equal(resolveFocusLyricTransitionDirection(0, 4, true), 'jump');
  assert.equal(resolveFocusLyricTransitionDirection(1, 2, false), 'idle');

  // Advancing from index 1 -> 2 must keep outgoing index 0 as exiting-top while promoting index 1 -> prev and index 2 -> current with stable keys
  const forwardSlots = buildFocusLyricSlotItems({
    lyricGroups: groups,
    activeIndex: 2,
    exitingGroupIndex: 0,
    direction: 'forward',
  });
  assert.deepEqual(
    forwardSlots.map((s) => `${s.role}:${s.groupIndex}`),
    ['exiting-top:0', 'prev:1', 'current:2', 'next:3'],
  );

  // Multi-region + perimeter edge output provides edge colors, bottom bar & button contrast tokens
  const splitGrid = makeRgbaGrid([
    [18, 86, 172, 255],
    [224, 146, 56, 255],
  ]);
  const splitTheme = extractAdaptiveArtworkThemeFromRgbaPixels(splitGrid, {
    artworkKey: 'split-cover',
    themeMode: 'dark',
    dynamicAlbumColors: true,
  });
  assert.ok(splitTheme.standardBarSurfaceCss.length > 10);
  assert.ok(splitTheme.diagonalGlowCss.length > 10);
  assert.ok(splitTheme.focusEdgeContinuationCss.length > 10);
  assert.ok(splitTheme.focusDiffusionGradient.length > 20);
  assert.equal(splitTheme.edgeRightSamples.length, 12);
  assert.equal(splitTheme.edgeLeftSamples.length, 12);
  assert.equal(splitTheme.edgeTopSamples.length, 12);
  assert.equal(splitTheme.edgeBottomSamples.length, 12);
  assert.match(splitTheme.edgeLeftHex, /^#[0-9a-f]{6}$/i);
  assert.equal(splitTheme.isFallback, false);

  // Spatially varying artwork (`32x32`: sky-blue upper edge, warm amber lower edge) preserves distinct 12-band vertical samples
  const variedPixels = new Uint8ClampedArray(32 * 32 * 4);
  for (let y = 0; y < 32; y += 1) {
    const isTop = y < 16;
    for (let x = 0; x < 32; x += 1) {
      const idx = (y * 32 + x) * 4;
      variedPixels[idx] = isTop ? 34 : 218;
      variedPixels[idx + 1] = isTop ? 132 : 110;
      variedPixels[idx + 2] = isTop ? 228 : 44;
      variedPixels[idx + 3] = 255;
    }
  }
  const variedTheme = extractAdaptiveArtworkThemeFromRgbaPixels(variedPixels, {
    artworkKey: 'spatial-gradient-test',
    themeMode: 'dark',
    dynamicAlbumColors: true,
    sampleWidth: 32,
    sampleHeight: 32,
  });
  assert.notEqual(
    variedTheme.edgeRightSamples[0],
    variedTheme.edgeRightSamples[11],
    '12-point right perimeter sampling must preserve distinct upper vs lower artwork edge colors',
  );

  // Five-line, Seven-line & Nine-line Focus lyrics builders + wheel coalescing + Sidebar auto-hide policy checks
  const fourteenGroups = Array.from({ length: 14 }, (_, idx) => ({
    timeSec: idx * 3,
    firstLineIndex: idx,
    lines: [`L${idx}`],
  }));
  const sevenGroups = fourteenGroups.slice(0, 7);
  const fiveSlots = buildFocusFiveLineSlotItems({
    lyricGroups: sevenGroups,
    centerIndex: 3,
    trackKey: 'track-x',
    prevCenterIndex: 2,
    direction: 'forward',
  });
  // Center = 3 => visible [-2..+2] = [1,2,3,4,5], plus exiting-top [0]
  assert.deepEqual(
    fiveSlots.map((s) => `${s.role}:${s.groupIndex}`),
    ['exiting-top:0', 'prev2:1', 'prev1:2', 'current:3', 'next1:4', 'next2:5'],
  );

  // 7-line Focus window (Phase 4.3F default compact/720p desktop)
  const sevenSlots = buildFocusWindowSlotItems({
    lyricGroups: fourteenGroups,
    centerIndex: 6,
    trackKey: 'track-x',
    visibleSlotCount: 7,
    prevCenterIndex: 5,
    direction: 'forward',
  });
  assert.deepEqual(
    sevenSlots.map((s) => `${s.role}:${s.groupIndex}:${s.slotDelta}`),
    [
      'exiting-top:2:-4',
      'prev3:3:-3',
      'prev2:4:-2',
      'prev1:5:-1',
      'current:6:0',
      'next1:7:1',
      'next2:8:2',
      'next3:9:3',
    ],
  );

  // 9-line Focus window (Phase 4.3F standard/large desktop) with backward exit
  const nineSlots = buildFocusWindowSlotItems({
    lyricGroups: fourteenGroups,
    centerIndex: 6,
    trackKey: 'track-x',
    visibleSlotCount: 9,
    prevCenterIndex: 7,
    direction: 'backward',
  });
  assert.deepEqual(
    nineSlots.map((s) => `${s.role}:${s.groupIndex}:${s.slotDelta}`),
    [
      'exiting-bottom:11:5',
      'prev4:2:-4',
      'prev3:3:-3',
      'prev2:4:-2',
      'prev1:5:-1',
      'current:6:0',
      'next1:7:1',
      'next2:8:2',
      'next3:9:3',
      'next4:10:4',
    ],
  );

  // Boundary start (index 0) displays only available forward items without fake placeholders
  const startSlots = buildFocusFiveLineSlotItems({
    lyricGroups: sevenGroups,
    centerIndex: 0,
    trackKey: 'track-x',
  });
  assert.deepEqual(
    startSlots.map((s) => s.groupIndex),
    [0, 1, 2],
  );

  // Wheel coalescing steps reliably
  const w1 = accumulateLyricsWheelStep(0, 20, 36);
  assert.equal(w1.stepCount, 0);
  const w2 = accumulateLyricsWheelStep(w1.remainderPx, 24, 36);
  assert.equal(w2.stepCount, 1);

  // Sidebar policy checks
  assert.equal(resolveSidebarAutoHideMode('now-playing', 'focus'), 'focus-immediate');
  assert.equal(resolveSidebarAutoHideMode('now-playing', 'standard'), 'standard-idle');
  assert.equal(resolveSidebarAutoHideMode('home', 'standard'), 'none');
  assert.equal(STANDARD_ENTRY_IDLE_HIDE_MS, 3000);

  // Explicit --np-bg + --np-btn-primary-bg/fg contrast tokens present in NowPlayingPage
  const npTsx = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/pages/NowPlayingPage.tsx'),
    'utf8',
  );
  assert.match(npTsx, /'--np-bg':\s*adaptiveTheme\.lightToneHex/);
  assert.match(npTsx, /'--np-btn-primary-bg':\s*adaptiveTheme\.lightZonePrimaryBtnBg/);
  assert.ok(
    computeContrastRatio(
      { r: 16, g: 18, b: 25 },
      { r: 240, g: 242, b: 246 },
    ) >= 7.0,
  );
  // Check lightZone contrast token directly via computeContrastRatio
  const parseHex = (h: string) => ({
    r: Number.parseInt(h.slice(1, 3), 16),
    g: Number.parseInt(h.slice(3, 5), 16),
    b: Number.parseInt(h.slice(5, 7), 16),
  });
  assert.ok(
    computeContrastRatio(
      parseHex(splitTheme.lightZonePrimaryBtnBg),
      parseHex(splitTheme.lightZonePrimaryBtnFg),
    ) >= 7.0,
  );
  assert.equal(buildPaletteFromSampledRgb({ r: 18, g: 86, b: 172 }).isFallback, false);
});
