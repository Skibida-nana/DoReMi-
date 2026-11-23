import assert from 'node:assert/strict';
import test from 'node:test';
import {
  VINYL_DISC_RADIUS,
  VINYL_GROOVE_INNER_RADIUS,
  VINYL_GROOVE_OUTER_RADIUS,
  VINYL_LABEL_RADIUS,
  VINYL_RING_RADIUS,
  computeNowPlayingVinylSizing,
  computeVinylTonearmGeometry,
} from '../src/renderer/src/utils/vinyl-geometry';

test('Tonearm stylus ALWAYS lands squarely on playable vinyl grooves across 0%..100% playback', () => {
  for (const ratio of [0, 0.15, 0.35, 0.5, 0.75, 1]) {
    const geo = computeVinylTonearmGeometry({
      isPlaying: true,
      isSwappingOff: false,
      progressRatio: ratio,
    });
    assert.equal(geo.isNeedleOnGrooves, true, `ratio=${ratio} r=${geo.needleRadiusFromCenter}`);
    assert.ok(
      geo.needleRadiusFromCenter >= VINYL_GROOVE_INNER_RADIUS &&
        geo.needleRadiusFromCenter <= VINYL_GROOVE_OUTER_RADIUS,
      `Needle radius ${geo.needleRadiusFromCenter} must be strictly within [${VINYL_GROOVE_INNER_RADIUS}, ${VINYL_GROOVE_OUTER_RADIUS}]`,
    );
    assert.ok(
      geo.needleRadiusFromCenter > VINYL_LABEL_RADIUS + 30,
      'Needle must never cross the center artwork label',
    );
    assert.ok(
      geo.needleRadiusFromCenter < VINYL_DISC_RADIUS - 20,
      'Needle must never float outside the vinyl outer rim',
    );
  }
});

test('Tonearm moves monotonically inward from outer groove toward inner groove as track progresses', () => {
  const start = computeVinylTonearmGeometry({
    isPlaying: true,
    isSwappingOff: false,
    progressRatio: 0,
  });
  const end = computeVinylTonearmGeometry({
    isPlaying: true,
    isSwappingOff: false,
    progressRatio: 1,
  });
  assert.ok(
    end.needleRadiusFromCenter < start.needleRadiusFromCenter,
    `Expected end radius (${end.needleRadiusFromCenter}) < start radius (${start.needleRadiusFromCenter})`,
  );
});

test('Tonearm parks cleanly outside the progress ring when paused or swapping discs', () => {
  const paused = computeVinylTonearmGeometry({
    isPlaying: false,
    isSwappingOff: false,
    progressRatio: 0.4,
  });
  assert.equal(paused.isNeedleOnGrooves, false);
  assert.ok(
    paused.needleRadiusFromCenter > VINYL_RING_RADIUS,
    `Paused needle radius (${paused.needleRadiusFromCenter}) should clear ring (${VINYL_RING_RADIUS})`,
  );

  const swapping = computeVinylTonearmGeometry({
    isPlaying: true,
    isSwappingOff: true,
    progressRatio: 0.4,
  });
  assert.equal(swapping.isNeedleOnGrooves, false);
  assert.ok(swapping.needleRadiusFromCenter > paused.needleRadiusFromCenter);
});

test('Now Playing Hero vinyl sizing fills 1366x768 & 1440x900 cleanly with zero column overflow', () => {
  const viewports = [
    { w: 1920, h: 1080 },
    { w: 1440, h: 900 },
    { w: 1366, h: 768 },
    { w: 1024, h: 768 },
  ];

  for (const vp of viewports) {
    const std = computeNowPlayingVinylSizing({
      viewportWidth: vp.w,
      viewportHeight: vp.h,
      isFocusMode: false,
    });
    const focus = computeNowPlayingVinylSizing({
      viewportWidth: vp.w,
      viewportHeight: vp.h,
      isFocusMode: true,
    });

    assert.ok(
      std.stageWidth <= std.heroColumnWidth,
      `Standard stageWidth (${std.stageWidth}) must fit inside heroColumnWidth (${std.heroColumnWidth}) at ${vp.w}x${vp.h}`,
    );
    assert.ok(
      focus.stageWidth <= focus.heroColumnWidth,
      `Focus stageWidth (${focus.stageWidth}) must fit inside heroColumnWidth (${focus.heroColumnWidth}) at ${vp.w}x${vp.h}`,
    );
    assert.ok(
      focus.ringCanvasSize >= std.ringCanvasSize,
      `Focus vinyl (${focus.ringCanvasSize}) should be >= Standard vinyl (${std.ringCanvasSize}) at ${vp.w}x${vp.h}`,
    );
  }

  // Specific check at 1366x768 (user's primary screenshot viewport!)
  const s1366 = computeNowPlayingVinylSizing({
    viewportWidth: 1366,
    viewportHeight: 768,
    isFocusMode: false,
  });
  assert.ok(s1366.ringCanvasSize >= 590, `Expected large vinyl at 1366x768, got ${s1366.ringCanvasSize}`);
  assert.ok(
    s1366.verticalRingMarginPx >= 8 && s1366.verticalRingMarginPx <= 40,
    `Expected tight vertical breathing margin at 1366x768, got ${s1366.verticalRingMarginPx}`,
  );
});
