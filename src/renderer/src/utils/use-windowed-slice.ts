import { useEffect, useState, type RefObject } from 'react';
import {
  computeQueueWindowSlice,
  QUEUE_VIRTUALIZE_THRESHOLD,
  type QueueWindowSlice,
} from './queue-virtualization';

function findScrollParent(el: HTMLElement | null): HTMLElement | null {
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

/**
 * Reusable rAF-throttled windowed slice hook for large track/search tables (`> 80` rows).
 * Measures scroll offset relative to the nearest scrollable container (`<main>` or `window`)
 * without changing layout styling or visual scrollbar behavior.
 */
export function useWindowedListSlice(input: {
  containerRef: RefObject<HTMLElement | null>;
  totalItems: number;
  itemHeightPx: number;
  overscanCount?: number;
  threshold?: number;
}): QueueWindowSlice {
  const {
    containerRef,
    totalItems,
    itemHeightPx,
    overscanCount = 12,
    threshold = QUEUE_VIRTUALIZE_THRESHOLD,
  } = input;

  const [metrics, setMetrics] = useState({ scrollOffsetPx: 0, viewportHeightPx: 720 });

  useEffect(() => {
    if (totalItems <= threshold || typeof window === 'undefined') {
      return;
    }

    const listEl = containerRef.current;
    const scrollParent = findScrollParent(listEl);
    let rafId: number | null = null;

    const measure = () => {
      rafId = null;
      const targetEl = containerRef.current;
      if (!targetEl) {
        return;
      }
      if (scrollParent) {
        const listRect = targetEl.getBoundingClientRect();
        const parentRect = scrollParent.getBoundingClientRect();
        const scrollOffsetPx = Math.max(0, parentRect.top - listRect.top);
        const viewportHeightPx = scrollParent.clientHeight || 720;
        setMetrics((prev) =>
          Math.abs(prev.scrollOffsetPx - scrollOffsetPx) < 4 &&
          Math.abs(prev.viewportHeightPx - viewportHeightPx) < 4
            ? prev
            : { scrollOffsetPx, viewportHeightPx },
        );
      } else {
        const listRect = targetEl.getBoundingClientRect();
        const scrollOffsetPx = Math.max(0, -listRect.top);
        const viewportHeightPx = window.innerHeight || 720;
        setMetrics((prev) =>
          Math.abs(prev.scrollOffsetPx - scrollOffsetPx) < 4 &&
          Math.abs(prev.viewportHeightPx - viewportHeightPx) < 4
            ? prev
            : { scrollOffsetPx, viewportHeightPx },
        );
      }
    };

    const scheduleMeasure = () => {
      if (rafId !== null) {
        return;
      }
      rafId = window.requestAnimationFrame(measure);
    };

    measure();
    const scrollTarget: EventTarget = scrollParent ?? window;
    scrollTarget.addEventListener('scroll', scheduleMeasure, { passive: true });
    window.addEventListener('resize', scheduleMeasure, { passive: true });

    return () => {
      if (rafId !== null) {
        window.cancelAnimationFrame(rafId);
      }
      scrollTarget.removeEventListener('scroll', scheduleMeasure);
      window.removeEventListener('resize', scheduleMeasure);
    };
  }, [containerRef, totalItems, threshold]);

  return computeQueueWindowSlice({
    totalItems,
    itemHeightPx,
    scrollOffsetPx: metrics.scrollOffsetPx,
    viewportHeightPx: metrics.viewportHeightPx,
    overscanCount,
    threshold,
  });
}
