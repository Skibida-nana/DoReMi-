export const BACK_TO_TOP_MIN_THRESHOLD_PX = 420;
export const BACK_TO_TOP_MAX_THRESHOLD_PX = 600;

export function findScrollParent(el: HTMLElement | null): HTMLElement | null {
  let curr = el?.parentElement ?? null;
  while (curr) {
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(curr) : null;
    if (style && (style.overflowY === 'auto' || style.overflowY === 'scroll')) {
      return curr;
    }
    curr = curr.parentElement;
  }
  return null;
}

export function computeBackToTopThresholdPx(viewportHeight: number): number {
  const safeVh = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 768;
  return Math.max(
    BACK_TO_TOP_MIN_THRESHOLD_PX,
    Math.min(BACK_TO_TOP_MAX_THRESHOLD_PX, Math.round(safeVh * 0.72)),
  );
}

/**
 * Determines whether the Back-to-Top button should be visible:
 * - Content must actually overflow the scroll container meaningfully.
 * - Scroll offset must pass the adaptive 420..600px threshold.
 */
export function shouldShowBackToTop(input: {
  scrollTop: number;
  viewportHeight: number;
  scrollHeight: number;
}): boolean {
  const { scrollTop, viewportHeight, scrollHeight } = input;
  if (
    !Number.isFinite(scrollTop) ||
    !Number.isFinite(viewportHeight) ||
    !Number.isFinite(scrollHeight)
  ) {
    return false;
  }
  const threshold = computeBackToTopThresholdPx(viewportHeight);
  if (scrollHeight <= viewportHeight + Math.round(threshold * 0.35)) {
    return false;
  }
  return scrollTop >= threshold;
}

export function resolveScrollBehavior(reducedMotion: boolean): ScrollBehavior {
  return reducedMotion ? 'auto' : 'smooth';
}

export function scrollContainerToTop(
  scrollParent: HTMLElement | null,
  reducedMotion: boolean,
): void {
  const behavior = resolveScrollBehavior(reducedMotion);
  if (scrollParent && typeof scrollParent.scrollTo === 'function') {
    scrollParent.scrollTo({ top: 0, behavior });
    return;
  }
  if (scrollParent) {
    scrollParent.scrollTop = 0;
    return;
  }
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo({ top: 0, behavior });
  }
}
