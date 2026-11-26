export const QUEUE_VIRTUALIZE_THRESHOLD = 80;

export interface QueueWindowSlice {
  startIndex: number;
  endIndex: number;
  topSpacerPx: number;
  bottomSpacerPx: number;
  virtualized: boolean;
}

/**
 * Pure windowed virtualization math for large Queue / Preceding Source sections (`Phase 4.4G`).
 * Below `80` rows renders directly without virtual spacers; for hundreds/thousands of tracks
 * keeps DOM size bounded (~35-45 rows) while maintaining full native scrollbar height.
 */
export function computeQueueWindowSlice(input: {
  totalItems: number;
  itemHeightPx: number;
  scrollOffsetPx: number;
  viewportHeightPx: number;
  overscanCount?: number;
  threshold?: number;
}): QueueWindowSlice {
  const {
    totalItems,
    itemHeightPx,
    scrollOffsetPx,
    viewportHeightPx,
    overscanCount = 14,
    threshold = QUEUE_VIRTUALIZE_THRESHOLD,
  } = input;

  if (totalItems <= 0) {
    return {
      startIndex: 0,
      endIndex: 0,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      virtualized: false,
    };
  }

  if (totalItems <= threshold) {
    return {
      startIndex: 0,
      endIndex: totalItems,
      topSpacerPx: 0,
      bottomSpacerPx: 0,
      virtualized: false,
    };
  }

  const rowH = Math.max(24, itemHeightPx);
  const viewH = Math.max(120, viewportHeightPx);
  const maxScrollPx = Math.max(0, totalItems * rowH - viewH);
  const clampedScroll = Math.min(maxScrollPx, Math.max(0, scrollOffsetPx));
  const visibleStart = Math.floor(clampedScroll / rowH);
  const visibleCount = Math.ceil(viewH / rowH);

  const endIndex = Math.min(totalItems, visibleStart + visibleCount + overscanCount);
  const startIndex = Math.min(endIndex, Math.max(0, visibleStart - overscanCount));

  return {
    startIndex,
    endIndex,
    topSpacerPx: startIndex * rowH,
    bottomSpacerPx: Math.max(0, (totalItems - endIndex) * rowH),
    virtualized: true,
  };
}
