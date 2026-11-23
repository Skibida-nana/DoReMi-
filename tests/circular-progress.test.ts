import test from 'node:test';
import assert from 'node:assert/strict';
import {
  clampUnit,
  computeCircularProgressArc,
  isPointerNearProgressRing,
  pointerToCircularRatio,
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

  // 0% -> 12 o'clock (top)
  const at0 = computeCircularProgressArc(0, radius, center);
  assert.ok(Math.abs(at0.handleX - center) < 1e-6);
  assert.ok(Math.abs(at0.handleY - (center - radius)) < 1e-6);
  assert.ok(Math.abs(at0.dashOffset - at0.circumference) < 1e-6);

  // 25% -> 3 o'clock (right)
  const at25 = computeCircularProgressArc(0.25, radius, center);
  assert.ok(Math.abs(at25.handleX - (center + radius)) < 1e-6);
  assert.ok(Math.abs(at25.handleY - center) < 1e-6);
  assert.ok(Math.abs(at25.dashOffset - at25.circumference * 0.75) < 1e-6);

  // 50% -> 6 o'clock (bottom)
  const at50 = computeCircularProgressArc(0.5, radius, center);
  assert.ok(Math.abs(at50.handleX - center) < 1e-6);
  assert.ok(Math.abs(at50.handleY - (center + radius)) < 1e-6);

  // 75% -> 9 o'clock (left)
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

test('isPointerNearProgressRing accepts hits inside radial tolerance and rejects center/far clicks', () => {
  assert.equal(isPointerNearProgressRing(300, 100, 300, 300, 200, 24), true);
  assert.equal(isPointerNearProgressRing(300, 120, 300, 300, 200, 24), true);
  assert.equal(isPointerNearProgressRing(300, 300, 300, 300, 200, 24), false);
  assert.equal(isPointerNearProgressRing(600, 300, 300, 300, 200, 24), false);
});
