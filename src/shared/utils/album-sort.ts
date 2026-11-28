import { extractFileNameFromPath, naturalCompare } from './natural-sort';

export interface CanonicalAlbumTrackSortable {
  id?: string;
  trackId?: string;
  title?: string | null;
  trackNumber?: number | string | null;
  track_number?: number | string | null;
  discNumber?: number | string | null;
  disc_number?: number | string | null;
  fileName?: string | null;
  file_name?: string | null;
  original_path?: string | null;
  filePathDisplay?: string | null;
}

const ORDINAL_TAG_PATTERN = /^\s*0*(\d+)(?:\s*(?:\/|of)\s*\d+)?\s*$/i;

/**
 * Parses numeric track/disc ordinals cleanly from numbers or tag strings such as `"1/12"`, `"02/10"`, `"03"`.
 * Returns a positive finite integer (>= 1) or `null` when missing/invalid.
 */
export function parseAlbumOrdinal(value: unknown): number | null {
  if (typeof value === 'number') {
    if (Number.isFinite(value) && value >= 1) {
      return Math.trunc(value);
    }
    return null;
  }
  if (typeof value === 'string') {
    const match = ORDINAL_TAG_PATTERN.exec(value);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isFinite(parsed) && parsed >= 1 ? parsed : null;
  }
  return null;
}

function getEffectiveTrackFileName(track: CanonicalAlbumTrackSortable): string {
  const explicit = (track.fileName ?? track.file_name ?? '').trim();
  if (explicit) {
    return explicit;
  }
  const pathStr = (track.original_path ?? track.filePathDisplay ?? '').trim();
  if (pathStr) {
    const extracted = extractFileNameFromPath(pathStr);
    if (extracted) {
      return extracted;
    }
  }
  return (track.title ?? '').trim();
}

function getEffectiveStableId(track: CanonicalAlbumTrackSortable): string {
  return track.id ?? track.trackId ?? '';
}

/**
 * Canonical Album track comparator:
 * 1. Disc number numeric ascending (missing defaults to Disc 1 so Disc 1 precedes Disc 2+)
 * 2. Track number numeric ascending (`1 < 2 < 10`; missing tracks placed deterministically after numbered tracks)
 * 3. Deterministic fallback by natural filename -> natural title -> track ID
 */
export function compareAlbumTracksCanonical(
  a: CanonicalAlbumTrackSortable,
  b: CanonicalAlbumTrackSortable,
): number {
  const discA = parseAlbumOrdinal(a.discNumber ?? a.disc_number) ?? 1;
  const discB = parseAlbumOrdinal(b.discNumber ?? b.disc_number) ?? 1;
  if (discA !== discB) {
    return discA - discB;
  }

  const trackA = parseAlbumOrdinal(a.trackNumber ?? a.track_number);
  const trackB = parseAlbumOrdinal(b.trackNumber ?? b.track_number);
  const effectiveA = trackA ?? Number.MAX_SAFE_INTEGER;
  const effectiveB = trackB ?? Number.MAX_SAFE_INTEGER;
  if (effectiveA !== effectiveB) {
    return effectiveA - effectiveB;
  }

  const fileCmp = naturalCompare(getEffectiveTrackFileName(a), getEffectiveTrackFileName(b));
  if (fileCmp !== 0) {
    return fileCmp;
  }

  const titleCmp = naturalCompare(a.title ?? '', b.title ?? '');
  if (titleCmp !== 0) {
    return titleCmp;
  }

  return getEffectiveStableId(a).localeCompare(getEffectiveStableId(b));
}

/**
 * Returns a new canonically ordered array without mutating the source list.
 */
export function sortAlbumTracksCanonical<T extends CanonicalAlbumTrackSortable>(
  tracks: readonly T[],
): T[] {
  return [...tracks].sort(compareAlbumTracksCanonical);
}
