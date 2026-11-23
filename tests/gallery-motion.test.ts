import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildStableEditorialRenderList,
  computeGalleryDirection,
  formatEditorialCardTransform,
  getEditorialCardGeometry,
} from '../src/renderer/src/utils/gallery-motion';

const SEVEN_PLAYLISTS = Array.from({ length: 7 }, (_, idx) => ({
  id: `pl-${idx}`,
  name: `Playlist ${idx}`,
}));

const TEN_PLAYLISTS = Array.from({ length: 10 }, (_, idx) => ({
  id: `pl-${idx}`,
  name: `Playlist ${idx}`,
}));

test('computeGalleryDirection resolves normal and circular wrap-around steps accurately', () => {
  assert.equal(computeGalleryDirection(0, 1, 7), 1);
  assert.equal(computeGalleryDirection(1, 0, 7), -1);
  assert.equal(computeGalleryDirection(6, 0, 7), 1); // wrap forward
  assert.equal(computeGalleryDirection(0, 6, 7), -1); // wrap backward
  assert.equal(computeGalleryDirection(2, 5, 7), 1); // +3 right card
  assert.equal(computeGalleryDirection(5, 2, 7), -1); // -3 left card
  assert.equal(computeGalleryDirection(3, 3, 7), 0);
  assert.equal(computeGalleryDirection(0, 0, 1), 0);
});

test('buildStableEditorialRenderList keeps DOM key order 100% invariant across Next, Previous, and Wrap-around', () => {
  const expectedOrder = SEVEN_PLAYLISTS.map((p) => p.id);
  const prevMap = new Map<string, number>();

  // Step through initial -> Next -> Previous -> Wrap-back (0 -> 6) -> Wrap-forward (6 -> 0) -> Jump Left -> Jump Right
  const sequence = [0, 1, 2, 1, 0, 6, 5, 6, 0, 4, 2];

  for (const selectedIndex of sequence) {
    const list = buildStableEditorialRenderList(SEVEN_PLAYLISTS, selectedIndex, prevMap, 7);
    assert.equal(list.length, 7);
    // CRITICAL INVARIANT: DOM order NEVER permutes, so React emits ZERO insertBefore calls!
    assert.deepEqual(
      list.map((entry) => entry.item.id),
      expectedOrder,
    );

    const center = list.find((entry) => entry.offset === 0);
    assert.equal(center?.itemIndex, selectedIndex);

    prevMap.clear();
    for (const entry of list) {
      prevMap.set(entry.item.id, entry.offset);
    }
  }
});

test('buildStableEditorialRenderList flags symmetric offstage entry ONLY for circularly wrapping outer cards', () => {
  // Initial render at index 0: offsets are P4:-3, P5:-2, P6:-1, P0:0, P1:+1, P2:+2, P3:+3
  const prevMap = new Map<string, number>();
  const initial = buildStableEditorialRenderList(SEVEN_PLAYLISTS, 0, prevMap, 7);
  for (const entry of initial) {
    assert.equal(entry.enterFromOffset, null);
    prevMap.set(entry.item.id, entry.offset);
  }

  // NEXT (0 -> 1): P4 wraps from -3 to +3 -> must enter from +4; all other 6 cards animate smoothly (enterFromOffset === null)
  const afterNext = buildStableEditorialRenderList(SEVEN_PLAYLISTS, 1, prevMap, 7);
  const wrappedOnNext = afterNext.filter((e) => e.enterFromOffset !== null);
  assert.equal(wrappedOnNext.length, 1);
  assert.equal(wrappedOnNext[0].item.id, 'pl-4');
  assert.equal(wrappedOnNext[0].offset, 3);
  assert.equal(wrappedOnNext[0].enterFromOffset, 4);

  prevMap.clear();
  for (const e of afterNext) prevMap.set(e.item.id, e.offset);

  // PREVIOUS (1 -> 0): P4 wraps back from +3 to -3 -> must enter from -4; all other 6 cards animate smoothly
  const afterPrev = buildStableEditorialRenderList(SEVEN_PLAYLISTS, 0, prevMap, 7);
  const wrappedOnPrev = afterPrev.filter((e) => e.enterFromOffset !== null);
  assert.equal(wrappedOnPrev.length, 1);
  assert.equal(wrappedOnPrev[0].item.id, 'pl-4');
  assert.equal(wrappedOnPrev[0].offset, -3);
  assert.equal(wrappedOnPrev[0].enterFromOffset, -4);
});

test('buildStableEditorialRenderList handles > 7 playlists with non-repeating slots and symmetric edge entry', () => {
  const prevMap = new Map<string, number>();
  const first = buildStableEditorialRenderList(TEN_PLAYLISTS, 0, prevMap, 7);
  assert.equal(first.length, 7);
  assert.equal(new Set(first.map((e) => e.item.id)).size, 7);
  for (const e of first) prevMap.set(e.item.id, e.offset);

  // Step Previous (0 -> 9): pl-6 freshly enters at -3 with enterFromOffset = -4
  const afterPrev = buildStableEditorialRenderList(TEN_PLAYLISTS, 9, prevMap, 7);
  assert.equal(afterPrev.length, 7);
  assert.equal(new Set(afterPrev.map((e) => e.item.id)).size, 7);
  const entered = afterPrev.find((e) => e.item.id === 'pl-6');
  assert.equal(entered?.offset, -3);
  assert.equal(entered?.enterFromOffset, -4);
});

test('getEditorialCardGeometry uses GPU transform scaling with mirror-symmetric horizontal positions', () => {
  for (const compact of [false, true]) {
    const center = getEditorialCardGeometry(0, compact);
    assert.equal(center.scale, 1);
    assert.equal(center.xPx, 0);
    assert.equal(center.zIndex, 40);

    for (const k of [1, 2, 3, 4]) {
      const left = getEditorialCardGeometry(-k, compact);
      const right = getEditorialCardGeometry(k, compact);
      assert.equal(left.xPx, -right.xPx);
      assert.equal(left.scale, right.scale);
      assert.equal(left.opacity, right.opacity);
      assert.equal(left.zIndex, right.zIndex);
      assert.equal(left.rotateDeg, -right.rotateDeg);
      assert.equal(left.baseWidth, center.baseWidth);
      assert.equal(left.baseHeight, center.baseHeight);
      assert.ok(formatEditorialCardTransform(left).includes('translate3d('));
    }
  }
});
