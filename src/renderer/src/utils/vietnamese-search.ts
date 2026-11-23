/**
 * Pure utilities for Vietnamese accent-insensitive + CJK/Unicode-safe search,
 * locale-aware Unicode sorting, synced lyrics lookup, and editorial gallery positioning.
 */

const LATIN_SEGMENT_REGEX = /[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]+/g;

/**
 * Normalizes text ONLY for search matching (never mutates stored original strings):
 * - Vietnamese / Latin segments have accents folded (đ -> d, á -> a) and lowercased.
 * - CJK (Han/Kanji, Hiragana, Katakana, Hangul) and other Unicode scripts stay intact in NFC!
 */
export function normalizeVietnameseText(input: string): string {
  if (!input) {
    return '';
  }
  const nfc = input.normalize('NFC');
  const folded = nfc.replace(LATIN_SEGMENT_REGEX, (segment) =>
    segment
      .replace(/đ/g, 'd')
      .replace(/Đ/g, 'D')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase(),
  );
  return folded.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function matchesVietnameseQuery(target: string | null | undefined, query: string): boolean {
  const normalizedQuery = normalizeVietnameseText(query);
  if (!normalizedQuery) {
    return true;
  }
  if (!target) {
    return false;
  }
  return normalizeVietnameseText(target).includes(normalizedQuery);
}

const unicodeCollator = new Intl.Collator(undefined, {
  sensitivity: 'base',
  numeric: true,
});

/**
 * Locale-aware Unicode comparator suitable for mixed Vietnamese, English,
 * Chinese, Japanese, and Korean metadata titles/artists/albums.
 */
export function compareUnicodeText(a: string, b: string): number {
  return unicodeCollator.compare(a.normalize('NFC'), b.normalize('NFC'));
}

export interface TimedLyricLine {
  timeSec: number;
  text: string;
}

/**
 * Returns the index of the active lyric line at currentTimeSec, or -1 if before the first timestamp.
 */
export function getActiveLyricIndex(lines: readonly TimedLyricLine[], currentTimeSec: number): number {
  if (lines.length === 0 || !Number.isFinite(currentTimeSec)) {
    return -1;
  }
  let active = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].timeSec <= currentTimeSec + 0.05) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}

/**
 * Maps a circular list of `totalCount` items into 7 visual gallery slots (0..6),
 * where slot 3 is always `centerIndex`.
 */
export function getCircularGallerySlots(totalCount: number, centerIndex: number): number[] {
  if (totalCount <= 0) {
    return [];
  }
  const safeCenter = ((centerIndex % totalCount) + totalCount) % totalCount;
  const offsets = [-3, -2, -1, 0, 1, 2, 3];
  return offsets.map((offset) => ((safeCenter + offset) % totalCount + totalCount) % totalCount);
}

export interface EditorialSlotPlacement {
  itemIndex: number;
  slotIndex: number; // 0..6 where 3 is always center
  offset: number; // -3..3 where 0 is always center
}

/**
 * Computes non-repeating gallery placements for any playlist count:
 * - 0 items -> []
 * - 1 item  -> [{ itemIndex: 0, slotIndex: 3, offset: 0 }]
 * - 2..6 items -> balanced non-repeating slots centered on slot 3 (NEVER duplicates items!)
 * - 7+ items -> full 7-card layered circular stage (slots 0..6)
 */
export function getNonRepeatingEditorialSlots(
  totalCount: number,
  centerIndex: number,
  maxVisibleSlots = 7,
): EditorialSlotPlacement[] {
  if (totalCount <= 0) {
    return [];
  }

  const safeCenter = ((centerIndex % totalCount) + totalCount) % totalCount;
  const effectiveMax = Math.max(1, Math.min(7, maxVisibleSlots));
  const countToShow = Math.min(totalCount, effectiveMax);

  // Ordered offsets radiating outwards from center (0) so odd/even counts stay balanced
  const offsetOrder = [0, -1, 1, -2, 2, -3, 3];
  const placements: EditorialSlotPlacement[] = [];
  const usedItems = new Set<number>();

  for (let i = 0; i < offsetOrder.length && placements.length < countToShow; i += 1) {
    const offset = offsetOrder[i];
    const itemIndex = ((safeCenter + offset) % totalCount + totalCount) % totalCount;
    if (usedItems.has(itemIndex)) {
      continue;
    }
    usedItems.add(itemIndex);
    placements.push({
      itemIndex,
      slotIndex: 3 + offset,
      offset,
    });
  }

  return placements.sort((a, b) => a.slotIndex - b.slotIndex);
}
