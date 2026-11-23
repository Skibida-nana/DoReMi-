import assert from 'node:assert/strict';
import test from 'node:test';
import {
  computeSliderFillWidthCss,
  computeThumbCenterLeftCss,
  getVolumeSliderVisualState,
  volumeToPercent,
} from '../src/renderer/src/utils/volume-slider';

test('volumeToPercent converts standard checkpoints accurately', () => {
  assert.equal(volumeToPercent(0), 0);
  assert.equal(volumeToPercent(0.25), 25);
  assert.equal(volumeToPercent(0.5), 50);
  assert.equal(volumeToPercent(0.75), 75);
  assert.equal(volumeToPercent(1), 100);
  assert.equal(volumeToPercent(-0.4), 0);
  assert.equal(volumeToPercent(1.8), 100);
  assert.equal(volumeToPercent(Number.NaN), 0);
});

test('getVolumeSliderVisualState reflects 0%, 25%, 50%, 75%, 100% and muted states', () => {
  const zero = getVolumeSliderVisualState(0, false);
  assert.equal(zero.percent, 0);
  assert.equal(zero.isMuted, true);
  assert.equal(zero.fillWidthCss, '0%');
  assert.equal(zero.tooltipLabel, '0%');

  const quarter = getVolumeSliderVisualState(0.25, false);
  assert.equal(quarter.percent, 25);
  assert.equal(quarter.isMuted, false);
  assert.equal(quarter.fillWidthCss, 'calc(25% + 3.25px)');
  assert.equal(quarter.tooltipLabel, '25%');

  const half = getVolumeSliderVisualState(0.5, false);
  assert.equal(half.percent, 50);
  assert.equal(half.fillWidthCss, '50%');
  assert.equal(half.thumbCenterLeftCss, '50%');

  const threeQuarters = getVolumeSliderVisualState(0.75, false);
  assert.equal(threeQuarters.percent, 75);
  assert.equal(threeQuarters.fillWidthCss, 'calc(75% - 3.25px)');
  assert.equal(threeQuarters.tooltipLabel, '75%');

  const full = getVolumeSliderVisualState(1, false);
  assert.equal(full.percent, 100);
  assert.equal(full.fillWidthCss, '100%');
  assert.equal(full.tooltipLabel, '100%');

  // Muted while underlying saved volume is 75%
  const muted = getVolumeSliderVisualState(0.75, true);
  assert.equal(muted.effectiveVolume, 0);
  assert.equal(muted.percent, 0);
  assert.equal(muted.isMuted, true);
  assert.equal(muted.fillWidthCss, '0%');
  assert.equal(muted.tooltipLabel, '0%');
});

test('computeSliderFillWidthCss and computeThumbCenterLeftCss stay aligned', () => {
  assert.equal(computeSliderFillWidthCss(0, 12), '0%');
  assert.equal(computeSliderFillWidthCss(1, 12), '100%');
  assert.equal(computeThumbCenterLeftCss(0, 12), 'calc(0% + 6px)');
  assert.equal(computeThumbCenterLeftCss(1, 12), 'calc(100% - 6px)');
});
