import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FALLBACK_DOREMI_PALETTE,
  extractPaletteFromRgbaPixels,
} from '../src/renderer/src/utils/dynamic-color';

function buildSolidRgba(r: number, g: number, b: number, pixelCount = 64): Uint8ClampedArray {
  const arr = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i += 1) {
    arr[i * 4] = r;
    arr[i * 4 + 1] = g;
    arr[i * 4 + 2] = b;
    arr[i * 4 + 3] = 255;
  }
  return arr;
}

test('M3.5 Dynamic color extractor derives distinct, contrast-safe palettes from artwork pixels', () => {
  const warmPalette = extractPaletteFromRgbaPixels(buildSolidRgba(235, 118, 42));
  const coolPalette = extractPaletteFromRgbaPixels(buildSolidRgba(45, 130, 230));

  assert.equal(warmPalette.isFallback, false);
  assert.equal(coolPalette.isFallback, false);
  assert.notEqual(warmPalette.dominant, coolPalette.dominant);
  assert.notEqual(warmPalette.glowRgb, coolPalette.glowRgb);
  assert.match(warmPalette.dominant, /^#[0-9a-f]{6}$/i);
  assert.match(coolPalette.dominant, /^#[0-9a-f]{6}$/i);
});

test('M3.5 Dynamic color extractor cleanly returns DoReMi fallback for transparent or dark-only pixels', () => {
  const empty = extractPaletteFromRgbaPixels(new Uint8ClampedArray(0));
  assert.deepEqual(empty, FALLBACK_DOREMI_PALETTE);

  const pitchBlack = extractPaletteFromRgbaPixels(buildSolidRgba(4, 4, 5));
  assert.equal(pitchBlack.isFallback, true);
  assert.equal(pitchBlack.dominant, FALLBACK_DOREMI_PALETTE.dominant);
});
