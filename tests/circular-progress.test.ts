import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  beginCircularDrag,
  clampUnit,
  computeAdaptiveFocusArcGeometry,
  computeAdaptiveHitStrokeWidth,
  computeCircularProgressArc,
  isPointerNearProgressRing,
  pointerToCircularRatio,
  pointerToSvgAdaptiveArcRatio,
  pointerToSvgCircularRatio,
  stepCircularDrag,
} from '../src/renderer/src/utils/circular-progress';

test('clampUnit handles NaN, Infinity, negative, and >1 values safely', () => {
  assert.equal(clampUnit(Number.NaN), 0);
  assert.equal(clampUnit(Number.POSITIVE_INFINITY), 0);
  assert.equal(clampUnit(-0.4), 0);
  assert.equal(clampUnit(1.8), 1);
  assert.equal(clampUnit(0.42), 0.42);
});

test('computeCircularProgressArc places handle accurately at 12, 3, 6, and 9 o-clock', () => {
  const radius = 200;
  const center = 250;

  const at0 = computeCircularProgressArc(0, radius, center);
  assert.ok(Math.abs(at0.handleX - center) < 1e-6);
  assert.ok(Math.abs(at0.handleY - (center - radius)) < 1e-6);
  assert.ok(Math.abs(at0.dashOffset - at0.circumference) < 1e-6);

  const at25 = computeCircularProgressArc(0.25, radius, center);
  assert.ok(Math.abs(at25.handleX - (center + radius)) < 1e-6);
  assert.ok(Math.abs(at25.handleY - center) < 1e-6);
  assert.ok(Math.abs(at25.dashOffset - at25.circumference * 0.75) < 1e-6);

  const at50 = computeCircularProgressArc(0.5, radius, center);
  assert.ok(Math.abs(at50.handleX - center) < 1e-6);
  assert.ok(Math.abs(at50.handleY - (center + radius)) < 1e-6);

  const at75 = computeCircularProgressArc(0.75, radius, center);
  assert.ok(Math.abs(at75.handleX - (center - radius)) < 1e-6);
  assert.ok(Math.abs(at75.handleY - center) < 1e-6);
});

test('pointerToCircularRatio maps clockwise quadrants starting at 12 o-clock', () => {
  const cx = 300;
  const cy = 300;

  assert.ok(Math.abs(pointerToCircularRatio(cx, cy - 100, cx, cy) - 0) < 1e-6);
  assert.ok(Math.abs(pointerToCircularRatio(cx + 100, cy, cx, cy) - 0.25) < 1e-6);
  assert.ok(Math.abs(pointerToCircularRatio(cx, cy + 100, cx, cy) - 0.5) < 1e-6);
  assert.ok(Math.abs(pointerToCircularRatio(cx - 100, cy, cx, cy) - 0.75) < 1e-6);
  assert.equal(pointerToCircularRatio(cx, cy, cx, cy), 0);
});

test('pointerToSvgCircularRatio uses inverse screen CTM accurately on CSS-scaled & cropped Focus Vinyl SVGs', () => {
  // Simulate a Focus Vinyl wrapper translated (-340, -180) and scaled 1.6x, DPI zoomed cleanly
  const scale = 1.6;
  const offsetX = -340;
  const offsetY = -180;
  const svgCenter = 280;
  const mockSvg = {
    getScreenCTM: () => ({
      inverse: () => ({
        a: 1 / scale,
        b: 0,
        c: 0,
        d: 1 / scale,
        e: -offsetX / scale,
        f: -offsetY / scale,
      }),
    }),
  };

  // Screen position of center is (offsetX + svgCenter * scale, offsetY + svgCenter * scale) = (108, 268)
  const screenCenterX = offsetX + svgCenter * scale;
  const screenCenterY = offsetY + svgCenter * scale;

  // Clicking 3 o'clock visually (far right of clipped Focus Vinyl disc) maps cleanly to 0.25
  const rightRatio = pointerToSvgCircularRatio(
    mockSvg,
    screenCenterX + 320,
    screenCenterY,
    svgCenter,
    svgCenter,
  );
  assert.ok(rightRatio !== null && Math.abs(rightRatio - 0.25) < 1e-6);

  // Clicking 2 o'clock (+30 deg above horizon => 60 deg from 12 o'clock => ratio = 1/6)
  const r = 300;
  const x2 = screenCenterX + r * Math.sin(Math.PI / 3);
  const y2 = screenCenterY - r * Math.cos(Math.PI / 3);
  const twoOClockRatio = pointerToSvgCircularRatio(mockSvg, x2, y2, svgCenter, svgCenter);
  assert.ok(twoOClockRatio !== null && Math.abs(twoOClockRatio - 1 / 6) < 1e-6);

  // Fallback when getScreenCTM returns null (e.g., headless DOM without layout)
  const rectFallbackSvg = {
    getScreenCTM: () => null,
    getBoundingClientRect: () => ({ left: 100, top: 200, width: 400, height: 400 }),
  };
  const bottomRatio = pointerToSvgCircularRatio(rectFallbackSvg, 300, 560, 200, 200);
  assert.ok(bottomRatio !== null && Math.abs(bottomRatio - 0.5) < 1e-6);
});

test('stepCircularDrag prevents 12 o-clock seam wrapping glitch and unwinds smoothly', () => {
  // Dragging clockwise across 96% -> 2% must saturate at 100%, NEVER snap to 2%
  let drag = beginCircularDrag(0.96);
  drag = stepCircularDrag(drag, 0.99);
  assert.ok(Math.abs(drag.clampedRatio - 0.99) < 1e-6);
  drag = stepCircularDrag(drag, 0.03);
  assert.equal(drag.clampedRatio, 1);

  // Unwinding counter-clockwise from overrun back to 97% decrements cleanly
  drag = stepCircularDrag(drag, 0.97);
  assert.ok(Math.abs(drag.clampedRatio - 0.97) < 1e-6);

  // Dragging counter-clockwise across 3% -> 97% must saturate at 0%, NEVER wrap to 97%
  let startZero = beginCircularDrag(0.03);
  startZero = stepCircularDrag(startZero, 0.97);
  assert.equal(startZero.clampedRatio, 0);
});

test('computeAdaptiveHitStrokeWidth & NowPlayingPage stacking keep circular progress unobstructed in BOTH modes', () => {
  assert.ok(computeAdaptiveHitStrokeWidth(1) >= 24);
  assert.ok(computeAdaptiveHitStrokeWidth(1.65) * 1.65 >= 28);

  const nowPlayingTsx = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/pages/NowPlayingPage.tsx'),
    'utf8',
  );
  // Standard layout outer container must NEVER swallow center vinyl clicks
  assert.match(
    nowPlayingTsx,
    /data-testid="now-playing-standard-layout"[\s\S]{0,220}pointer-events-none/,
  );
  // Focus showcase outer fixed-inset-0 wrapper must stay strictly pointer-events-none (inner content uses pointerEvents)
  assert.doesNotMatch(
    nowPlayingTsx,
    /data-testid="now-playing-focus-showcase"[\s\S]{0,260}pointerEvents:\s*isFocusMode\s*\?\s*'auto'/,
  );
  const vinylTsx = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/VinylTurntable.tsx'),
    'utf8',
  );
  assert.match(vinylTsx, /onLostPointerCapture=\{clearRingDrag\}/);
  assert.match(vinylTsx, /pointerEvents:\s*isArcPresentation\s*\?\s*'none'\s*:\s*'stroke'/);
  assert.match(vinylTsx, /pointerEvents:\s*isArcPresentation\s*\?\s*'stroke'\s*:\s*'none'/);
});

test('isPointerNearProgressRing accepts hits inside radial tolerance and rejects center/far clicks', () => {
  assert.equal(isPointerNearProgressRing(300, 100, 300, 300, 200, 24), true);
  assert.equal(isPointerNearProgressRing(300, 120, 300, 300, 200, 24), true);
  assert.equal(isPointerNearProgressRing(300, 300, 300, 300, 200, 24), false);
  assert.equal(isPointerNearProgressRing(600, 300, 300, 300, 200, 24), false);
});

test('Phase 4.2C: computeAdaptiveFocusArcGeometry maps full 0..100% duration onto visible right arc without clipping', () => {
  const vh = 1080;
  const centerViewportX = 70;
  const centerViewportY = 545;
  const arcRadiusPx = 820;
  const centerSvg = 340;
  const radiusSvg = 430;
  const scale = arcRadiusPx / radiusSvg;

  const arc0 = computeAdaptiveFocusArcGeometry({
    centerXSvg: centerSvg,
    centerYSvg: centerSvg,
    radiusSvg,
    centerViewportX,
    centerViewportY,
    arcRadiusPx,
    viewportHeight: vh,
    progressRatio: 0,
  });
  assert.ok(arc0.startAngleDeg < -18 && arc0.endAngleDeg > 18);
  assert.ok(arc0.sweepAngleDeg >= 50 && arc0.sweepAngleDeg <= 150);
  // 0% endpoint sits strictly inside top safe margin
  const yStartScreen = centerViewportY + arcRadiusPx * Math.sin((arc0.startAngleDeg * Math.PI) / 180);
  const yEndScreen = centerViewportY + arcRadiusPx * Math.sin((arc0.endAngleDeg * Math.PI) / 180);
  assert.ok(yStartScreen >= 58, `Top endpoint clipped: ${yStartScreen}`);
  assert.ok(yEndScreen <= vh - 30, `Bottom endpoint clipped: ${yEndScreen}`);

  // 50% maps cleanly to midpoint of arc angular sweep
  const arc50 = computeAdaptiveFocusArcGeometry({
    centerXSvg: centerSvg,
    centerYSvg: centerSvg,
    radiusSvg,
    centerViewportX,
    centerViewportY,
    arcRadiusPx,
    viewportHeight: vh,
    progressRatio: 0.5,
  });
  assert.ok(Math.abs(arc50.activeAngleDeg - (arc50.startAngleDeg + arc50.endAngleDeg) * 0.5) < 1e-6);

  // Inverse CTM pointer mapping hits 0%, 50%, 100% cleanly and clamps outside endpoints with zero wrap
  const mockSvg = {
    getScreenCTM: () => ({
      inverse: () => ({
        a: 1 / scale,
        b: 0,
        c: 0,
        d: 1 / scale,
        e: -centerViewportX / scale + centerSvg,
        f: -centerViewportY / scale + centerSvg,
      }),
    }),
  };
  const screenAtAngle = (deg: number) => ({
    x: centerViewportX + arcRadiusPx * Math.cos((deg * Math.PI) / 180),
    y: centerViewportY + arcRadiusPx * Math.sin((deg * Math.PI) / 180),
  });

  const p0 = screenAtAngle(arc0.startAngleDeg);
  const p50 = screenAtAngle((arc0.startAngleDeg + arc0.endAngleDeg) * 0.5);
  const p100 = screenAtAngle(arc0.endAngleDeg);
  const pAboveStart = screenAtAngle(arc0.startAngleDeg - 28);
  const pBelowEnd = screenAtAngle(arc0.endAngleDeg + 28);

  const r0 = pointerToSvgAdaptiveArcRatio(
    mockSvg,
    p0.x,
    p0.y,
    centerSvg,
    centerSvg,
    arc0.startAngleDeg,
    arc0.endAngleDeg,
  );
  const r50 = pointerToSvgAdaptiveArcRatio(
    mockSvg,
    p50.x,
    p50.y,
    centerSvg,
    centerSvg,
    arc0.startAngleDeg,
    arc0.endAngleDeg,
  );
  const r100 = pointerToSvgAdaptiveArcRatio(
    mockSvg,
    p100.x,
    p100.y,
    centerSvg,
    centerSvg,
    arc0.startAngleDeg,
    arc0.endAngleDeg,
  );
  const rClampedZero = pointerToSvgAdaptiveArcRatio(
    mockSvg,
    pAboveStart.x,
    pAboveStart.y,
    centerSvg,
    centerSvg,
    arc0.startAngleDeg,
    arc0.endAngleDeg,
  );
  const rClampedOne = pointerToSvgAdaptiveArcRatio(
    mockSvg,
    pBelowEnd.x,
    pBelowEnd.y,
    centerSvg,
    centerSvg,
    arc0.startAngleDeg,
    arc0.endAngleDeg,
  );

  assert.ok(r0 !== null && Math.abs(r0 - 0) < 1e-4);
  assert.ok(r50 !== null && Math.abs(r50 - 0.5) < 1e-4);
  assert.ok(r100 !== null && Math.abs(r100 - 1) < 1e-4);
  assert.equal(rClampedZero, 0);
  assert.equal(rClampedOne, 1);

  const vinylTsx = fs.readFileSync(
    path.resolve(process.cwd(), 'src/renderer/src/components/VinylTurntable.tsx'),
    'utf8',
  );
  assert.match(vinylTsx, /data-testid="vinyl-adaptive-progress-hit"/);
});
