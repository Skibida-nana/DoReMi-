export interface VolumeSliderVisualState {
  effectiveVolume: number;
  percent: number;
  isMuted: boolean;
  fillWidthCss: string;
  thumbCenterLeftCss: string;
  tooltipLabel: string;
}

export const VOLUME_THUMB_DIAMETER_PX = 13;

export function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function volumeToPercent(volume: number): number {
  return Math.round(clampVolume(volume) * 100);
}

/**
 * Computes exact CSS width for the filled rail so it aligns cleanly with the
 * center of a native <input type="range"> thumb of diameter `thumbDiameterPx`.
 */
export function computeSliderFillWidthCss(
  volume: number,
  thumbDiameterPx: number = VOLUME_THUMB_DIAMETER_PX,
): string {
  const clamped = clampVolume(volume);
  if (clamped <= 0) {
    return '0%';
  }
  if (clamped >= 1) {
    return '100%';
  }
  const pct = clamped * 100;
  const offsetPx = Number(((0.5 - clamped) * thumbDiameterPx).toFixed(2));
  if (offsetPx === 0) {
    return `${pct}%`;
  }
  return offsetPx > 0
    ? `calc(${pct}% + ${offsetPx}px)`
    : `calc(${pct}% - ${Math.abs(offsetPx)}px)`;
}

/**
 * Computes the horizontal center position of the native range thumb for
 * anchoring the hover/drag percentage tooltip directly above the thumb.
 */
export function computeThumbCenterLeftCss(
  volume: number,
  thumbDiameterPx: number = VOLUME_THUMB_DIAMETER_PX,
): string {
  const clamped = clampVolume(volume);
  const pct = clamped * 100;
  const offsetPx = Number(((0.5 - clamped) * thumbDiameterPx).toFixed(2));
  if (offsetPx === 0) {
    return `${pct}%`;
  }
  return offsetPx > 0
    ? `calc(${pct}% + ${offsetPx}px)`
    : `calc(${pct}% - ${Math.abs(offsetPx)}px)`;
}

export function getVolumeSliderVisualState(
  rawVolume: number,
  muted: boolean,
  thumbDiameterPx: number = VOLUME_THUMB_DIAMETER_PX,
): VolumeSliderVisualState {
  const effectiveVolume = muted ? 0 : clampVolume(rawVolume);
  const percent = volumeToPercent(effectiveVolume);
  const isMuted = muted || effectiveVolume <= 0;
  const fillWidthCss = computeSliderFillWidthCss(effectiveVolume, thumbDiameterPx);
  const thumbCenterLeftCss = computeThumbCenterLeftCss(effectiveVolume, thumbDiameterPx);
  const tooltipLabel = isMuted ? '0%' : `${percent}%`;

  return {
    effectiveVolume,
    percent,
    isMuted,
    fillWidthCss,
    thumbCenterLeftCss,
    tooltipLabel,
  };
}
