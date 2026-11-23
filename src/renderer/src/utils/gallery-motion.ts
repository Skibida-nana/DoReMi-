import { getNonRepeatingEditorialSlots } from './vietnamese-search';

export type GalleryNavigationDirection = -1 | 0 | 1;

export interface EditorialCardGeometry {
  baseWidth: number;
  baseHeight: number;
  xPx: number;
  yPx: number;
  scale: number;
  rotateDeg: number;
  zIndex: number;
  opacity: number;
  brightness: number;
}

export interface StableEditorialCardPlacement<T extends { id: string }> {
  item: T;
  itemIndex: number;
  slotIndex: number;
  offset: number;
  /** Non-null only when a card wrapped circularly across the outer edge or freshly entered the stage */
  enterFromOffset: number | null;
}

/**
 * Computes consistent circular navigation direction (-1 = previous/rightward flow, +1 = next/leftward flow)
 * between two playlist indices, handling wrap-around (0 <-> N-1) cleanly.
 */
export function computeGalleryDirection(
  prevIndex: number,
  nextIndex: number,
  totalCount: number,
): GalleryNavigationDirection {
  if (totalCount <= 1 || prevIndex === nextIndex) {
    return 0;
  }
  const safePrev = ((prevIndex % totalCount) + totalCount) % totalCount;
  const safeNext = ((nextIndex % totalCount) + totalCount) % totalCount;
  if (safePrev === safeNext) {
    return 0;
  }

  const forwardSteps = (safeNext - safePrev + totalCount) % totalCount;
  const backwardSteps = (safePrev - safeNext + totalCount) % totalCount;
  if (forwardSteps < backwardSteps) {
    return 1;
  }
  if (backwardSteps < forwardSteps) {
    return -1;
  }
  return safeNext > safePrev ? 1 : -1;
}

/**
 * Pure GPU-composited staggered asymmetric editorial card geometry.
 * Every card keeps fixed hero base dimensions (308x424 desktop, 246x339 compact)
 * and transitions strictly via `transform: translate3d(...) scale(...) rotate(...)` + `opacity`
 * so ZERO layout reflows occur during animation on low-end CPUs/iGPUs.
 */
export function getEditorialCardGeometry(offset: number, compact: boolean): EditorialCardGeometry {
  const s = compact ? 0.8 : 1;
  const baseWidth = Math.round(308 * s);
  const baseHeight = Math.round(424 * s);

  switch (offset) {
    case 0:
      return {
        baseWidth,
        baseHeight,
        xPx: 0,
        yPx: 0,
        scale: 1,
        rotateDeg: 0,
        zIndex: 40,
        opacity: 1,
        brightness: 1,
      };
    case -1:
      return {
        baseWidth,
        baseHeight,
        xPx: Math.round(-252 * s),
        yPx: Math.round(24 * s),
        scale: 0.76,
        rotateDeg: -2.2,
        zIndex: 30,
        opacity: 0.94,
        brightness: 0.88,
      };
    case 1:
      return {
        baseWidth,
        baseHeight,
        xPx: Math.round(252 * s),
        yPx: Math.round(-18 * s),
        scale: 0.76,
        rotateDeg: 2.2,
        zIndex: 30,
        opacity: 0.94,
        brightness: 0.88,
      };
    case -2:
      return {
        baseWidth,
        baseHeight,
        xPx: Math.round(-446 * s),
        yPx: Math.round(-16 * s),
        scale: 0.625,
        rotateDeg: -3.5,
        zIndex: 20,
        opacity: 0.8,
        brightness: 0.72,
      };
    case 2:
      return {
        baseWidth,
        baseHeight,
        xPx: Math.round(446 * s),
        yPx: Math.round(28 * s),
        scale: 0.625,
        rotateDeg: 3.5,
        zIndex: 20,
        opacity: 0.8,
        brightness: 0.72,
      };
    case -3:
      return {
        baseWidth,
        baseHeight,
        xPx: Math.round(-618 * s),
        yPx: Math.round(22 * s),
        scale: 0.54,
        rotateDeg: -4.2,
        zIndex: 10,
        opacity: 0.56,
        brightness: 0.58,
      };
    case 3:
      return {
        baseWidth,
        baseHeight,
        xPx: Math.round(618 * s),
        yPx: Math.round(-14 * s),
        scale: 0.54,
        rotateDeg: 4.2,
        zIndex: 10,
        opacity: 0.56,
        brightness: 0.58,
      };
    case -4:
      // Offstage left wing for seamless symmetric edge entry on Previous / wrap-around
      return {
        baseWidth,
        baseHeight,
        xPx: Math.round(-772 * s),
        yPx: Math.round(30 * s),
        scale: 0.46,
        rotateDeg: -5.2,
        zIndex: 5,
        opacity: 0,
        brightness: 0.5,
      };
    default:
      // Offstage right wing (+4) for seamless symmetric edge entry on Next / wrap-around
      return {
        baseWidth,
        baseHeight,
        xPx: Math.round(772 * s),
        yPx: Math.round(-22 * s),
        scale: 0.46,
        rotateDeg: 5.2,
        zIndex: 5,
        opacity: 0,
        brightness: 0.5,
      };
  }
}

export function formatEditorialCardTransform(geo: EditorialCardGeometry): string {
  return `translate3d(${geo.xPx}px, ${geo.yPx}px, 0) scale(${geo.scale}) rotate(${geo.rotateDeg}deg)`;
}

/**
 * Builds the visible editorial card list in STRICTLY STABLE DOM ORDER (sorted by `itemIndex`,
 * NEVER by `slotIndex`).
 *
 * Why this permanently fixes the P0 Previous animation teleport bug:
 * - Previously, sorting React children by `slotIndex` caused the children array to rotate
 *   right on Previous (`[A,B,C,D,E,F,G] -> [G,A,B,C,D,E,F]`). React's `lastPlacedIndex`
 *   reconciliation saw `G` at old index 6 and called `parent.insertBefore()` on ALL 6
 *   other cards (`A..F`), which in Blink/Chromium/Electron detaches their LayoutObject
 *   and cancels every CSS transition in 0ms!
 * - By keeping DOM order fixed by `itemIndex` (and positioning exclusively via `transform`
 *   + explicit `zIndex`), React executes ZERO `insertBefore` calls on visible cards in
 *   BOTH directions (Next, Previous, Click Left, Click Right, Wrap-around, Rapid clicks).
 * - Any card that circularly wraps across the outer edge (`|offset - prevOffset| > 3`,
 *   e.g. `-3 -> +3` on Next or `+3 -> -3` on Prev) is tagged with `enterFromOffset = ±4`
 *   so it stages offstage at opacity 0 for 1 frame and smoothly glides into its new outer
 *   slot without ever flying across behind the center card.
 */
export function buildStableEditorialRenderList<T extends { id: string }>(
  items: readonly T[],
  selectedIndex: number,
  prevOffsetById: ReadonlyMap<string, number>,
  maxVisibleSlots = 7,
): StableEditorialCardPlacement<T>[] {
  if (items.length === 0) {
    return [];
  }

  const rawSlots = getNonRepeatingEditorialSlots(items.length, selectedIndex, maxVisibleSlots);
  const hadPreviousRender = prevOffsetById.size > 0;

  const placements: StableEditorialCardPlacement<T>[] = [];
  for (const slot of rawSlots) {
    const item = items[slot.itemIndex];
    if (!item) {
      continue;
    }

    const prevOffset = prevOffsetById.get(item.id);
    let enterFromOffset: number | null = null;

    if (hadPreviousRender) {
      if (prevOffset === undefined) {
        // Freshly entering card when playlist count > visible slots
        enterFromOffset = slot.offset < 0 ? -4 : slot.offset > 0 ? 4 : null;
      } else if (Math.abs(slot.offset - prevOffset) > 3 && slot.offset !== 0) {
        // Circular wrap-around from far edge (-3 -> +3 on Next, or +3 -> -3 on Previous)
        enterFromOffset = slot.offset > 0 ? 4 : -4;
      }
    }

    placements.push({
      item,
      itemIndex: slot.itemIndex,
      slotIndex: slot.slotIndex,
      offset: slot.offset,
      enterFromOffset,
    });
  }

  // CRITICAL: Sort by stable `itemIndex` so DOM children NEVER permute during circular navigation!
  placements.sort((a, b) => a.itemIndex - b.itemIndex);
  return placements;
}
