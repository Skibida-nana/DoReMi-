export interface SmartShuffleTrackMeta {
  trackId: string;
  albumKey?: string | null;
  albumTitle?: string | null;
  albumArtist?: string | null;
  artist?: string | null;
}

export interface SmartShuffleOptions<T> {
  items: readonly T[];
  getTrackMeta: (item: T) => SmartShuffleTrackMeta;
  anchorTrack?: SmartShuffleTrackMeta | null;
  recentTrackIds?: ReadonlyArray<string>;
  recentAlbumKeys?: ReadonlyArray<string>;
  rng?: () => number;
}

export interface ShuffleDistributionReport {
  totalItems: number;
  distinctAlbums: number;
  consecutiveSameAlbumPairs: number;
  consecutiveSameArtistPairs: number;
  maxConsecutiveSameAlbumRun: number;
  startsWithAnchorTrack: boolean;
  startsWithAnchorAlbum: boolean;
  tailWindowStartRatio: number;
  tailConsecutiveSameAlbumPairs: number;
  tailDistinctAlbumRatio: number;
}

const UNKNOWN_ALBUM_LABELS = new Set([
  '',
  'không rõ album',
  'unknown album',
  'unknown',
  '(unknown)',
]);

const UNKNOWN_ARTIST_LABELS = new Set([
  '',
  'unknown artist',
  'không rõ nghệ sĩ',
  'unknown',
  '(unknown)',
]);

function normalizeTextKey(raw: string | null | undefined): string {
  return (raw ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US');
}

/**
 * Resolves a canonical album bucket key.
 * When album metadata is missing/unknown, falls back cleanly to track-level identity so
 * unrelated single tracks without album tags never falsely cluster together.
 */
export function resolveCanonicalAlbumKey(meta: SmartShuffleTrackMeta): string {
  const titleNorm = normalizeTextKey(meta.albumTitle);
  const keyNorm = normalizeTextKey(meta.albumKey);
  if (keyNorm && !UNKNOWN_ALBUM_LABELS.has(keyNorm) && titleNorm && !UNKNOWN_ALBUM_LABELS.has(titleNorm)) {
    return keyNorm;
  }
  if (titleNorm && !UNKNOWN_ALBUM_LABELS.has(titleNorm)) {
    const ownerNorm = normalizeTextKey(meta.albumArtist || meta.artist);
    return `album::${titleNorm}::${ownerNorm}`;
  }
  if (keyNorm && !UNKNOWN_ALBUM_LABELS.has(keyNorm) && !keyNorm.startsWith('không rõ album')) {
    return keyNorm;
  }
  return `unknown-track-album::${meta.trackId}`;
}

export function resolveCanonicalArtistKey(meta: SmartShuffleTrackMeta): string {
  const artistNorm = normalizeTextKey(meta.artist || meta.albumArtist);
  if (artistNorm && !UNKNOWN_ARTIST_LABELS.has(artistNorm)) {
    return `artist::${artistNorm}`;
  }
  return `unknown-artist::${meta.trackId}`;
}

function fisherYatesInPlace<T>(arr: T[], rng: () => number): T[] {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const raw = rng();
    const bounded = Number.isFinite(raw) ? Math.min(0.999999999, Math.max(0, raw)) : 0;
    const j = Math.floor(bounded * (i + 1));
    const tmp = arr[i];
    arr[i] = arr[j];
    arr[j] = tmp;
  }
  return arr;
}

interface TaggedNode<T> {
  item: T;
  trackId: string;
  albumKey: string;
  artistKey: string;
  sortKey: number;
}

/**
 * Album-aware Smart Shuffle:
 * - Preserves every input item occurrence (never mutates input or drops duplicates).
 * - Distributes tracks from each album proportionally across the full timeline (eliminating tail clustering).
 * - Minimizes consecutive same-album adjacency (and secondary artist repetition) cleanly even at 50k tracks.
 * - Falls back gracefully for single-album, 1-2 track, or mathematically imbalanced collections.
 */
export function smartShuffleItems<T>(options: SmartShuffleOptions<T>): T[] {
  const { items, getTrackMeta, anchorTrack, recentTrackIds, recentAlbumKeys } = options;
  const rng = options.rng ?? Math.random;
  const total = items.length;
  if (total <= 1) {
    return [...items];
  }

  const buckets = new Map<string, TaggedNode<T>[]>();
  const distinctTrackIds = new Set<string>();

  for (let i = 0; i < total; i += 1) {
    const item = items[i];
    const meta = getTrackMeta(item);
    distinctTrackIds.add(meta.trackId);
    const albumKey = resolveCanonicalAlbumKey(meta);
    const artistKey = resolveCanonicalArtistKey(meta);
    const node: TaggedNode<T> = {
      item,
      trackId: meta.trackId,
      albumKey,
      artistKey,
      sortKey: 0,
    };
    let list = buckets.get(albumKey);
    if (!list) {
      list = [];
      buckets.set(albumKey, list);
    }
    list.push(node);
  }

  const recentTrackSet = new Set(recentTrackIds ?? []);
  const recentAlbumSet = new Set(recentAlbumKeys ?? []);
  const anchorAlbumKey = anchorTrack ? resolveCanonicalAlbumKey(anchorTrack) : null;
  const anchorTrackId = anchorTrack?.trackId ?? null;

  const albumCount = buckets.size;
  const flattened: TaggedNode<T>[] = new Array(total);

  if (albumCount <= 1) {
    // Single-album or single-bucket fallback: pure Fisher-Yates, avoiding starting directly on anchorTrack
    const onlyBucket = Array.from(buckets.values())[0]!;
    fisherYatesInPlace(onlyBucket, rng);
    for (let i = 0; i < onlyBucket.length; i += 1) {
      flattened[i] = onlyBucket[i];
    }
    if (anchorTrackId && distinctTrackIds.size > 1 && flattened[0].trackId === anchorTrackId) {
      const swapIdx = flattened.findIndex((n) => n.trackId !== anchorTrackId);
      if (swapIdx > 0) {
        const tmp = flattened[0];
        flattened[0] = flattened[swapIdx];
        flattened[swapIdx] = tmp;
      }
    }
    return flattened.map((n) => n.item);
  }

  // Spread every album evenly across [0, 1) with randomized within-slot jitter and random album phase
  let writeIdx = 0;
  for (const bucket of buckets.values()) {
    fisherYatesInPlace(bucket, rng);
    const m = bucket.length;
    const albumPhase = (rng() - 0.5) * (0.36 / Math.max(m, 3));
    for (let j = 0; j < m; j += 1) {
      const jitter = 0.14 + 0.72 * rng();
      bucket[j].sortKey = (j + jitter) / m + albumPhase + rng() * 1e-6;
      flattened[writeIdx] = bucket[j];
      writeIdx += 1;
    }
  }

  flattened.sort((a, b) => a.sortKey - b.sortKey);

  // Boundary rule for position 0: avoid starting on anchor album/track or recent track/album if avoidable
  const scoreStart = (node: TaggedNode<T>): number => {
    let penalty = 0;
    if (anchorTrackId && node.trackId === anchorTrackId) penalty += 1000;
    if (anchorAlbumKey && node.albumKey === anchorAlbumKey) penalty += 200;
    if (recentTrackSet.has(node.trackId)) penalty += 50;
    if (recentAlbumSet.has(node.albumKey)) penalty += 15;
    return penalty;
  };

  let bestStartIdx = 0;
  let bestStartPenalty = scoreStart(flattened[0]);
  if (bestStartPenalty > 0) {
    const startSearchLimit = Math.min(total, 64);
    for (let i = 1; i < startSearchLimit; i += 1) {
      const candidatePenalty = scoreStart(flattened[i]);
      if (candidatePenalty < bestStartPenalty) {
        bestStartPenalty = candidatePenalty;
        bestStartIdx = i;
        if (candidatePenalty === 0) break;
      }
    }
    if (bestStartIdx > 0) {
      const tmp = flattened[0];
      flattened[0] = flattened[bestStartIdx];
      flattened[bestStartIdx] = tmp;
    }
  }

  // Bounded O(n) constrained repair pass to eliminate remaining avoidable album/artist adjacency
  const LOOKAHEAD_LIMIT = 40;
  const LOOKBACK_LIMIT = 24;

  const canSwapWithoutBreakingNeighborhood = (leftIdx: number, rightIdx: number): boolean => {
    const leftNode = flattened[leftIdx];
    const rightNode = flattened[rightIdx];
    if (rightIdx > 0 && flattened[rightIdx - 1].albumKey === leftNode.albumKey && rightIdx - 1 !== leftIdx) {
      return false;
    }
    if (
      rightIdx + 1 < total &&
      flattened[rightIdx + 1].albumKey === leftNode.albumKey &&
      rightIdx + 1 !== leftIdx
    ) {
      return false;
    }
    if (leftIdx > 0 && flattened[leftIdx - 1].albumKey === rightNode.albumKey && leftIdx - 1 !== rightIdx) {
      return false;
    }
    if (
      leftIdx + 1 < total &&
      flattened[leftIdx + 1].albumKey === rightNode.albumKey &&
      leftIdx + 1 !== rightIdx
    ) {
      return false;
    }
    if (leftIdx === 0 && anchorAlbumKey && rightNode.albumKey === anchorAlbumKey) {
      return false;
    }
    return true;
  };

  for (let i = 1; i < total; i += 1) {
    const prev = flattened[i - 1];
    const curr = flattened[i];
    const sameAlbum = curr.albumKey === prev.albumKey;
    const sameArtist = !sameAlbum && curr.artistKey === prev.artistKey;
    if (!sameAlbum && !sameArtist) {
      continue;
    }

    let swapTarget = -1;
    const maxForward = Math.min(total - 1, i + LOOKAHEAD_LIMIT);
    for (let j = i + 1; j <= maxForward; j += 1) {
      const cand = flattened[j];
      if (cand.albumKey === prev.albumKey) continue;
      if (sameAlbum && cand.artistKey !== prev.artistKey && canSwapWithoutBreakingNeighborhood(i, j)) {
        swapTarget = j;
        break;
      }
      if (cand.artistKey !== prev.artistKey && canSwapWithoutBreakingNeighborhood(i, j)) {
        swapTarget = j;
        if (!sameAlbum) break;
      }
      if (swapTarget < 0 && canSwapWithoutBreakingNeighborhood(i, j)) {
        swapTarget = j;
      }
    }

    // If still sameAlbum at tail and no safe forward candidate exists, try bounded safe earlier slot
    if (swapTarget < 0 && sameAlbum) {
      const minBack = Math.max(1, i - LOOKBACK_LIMIT);
      for (let j = minBack; j < i - 1; j += 1) {
        const cand = flattened[j];
        if (cand.albumKey === prev.albumKey) continue;
        if (canSwapWithoutBreakingNeighborhood(i, j)) {
          swapTarget = j;
          break;
        }
      }
    }

    if (swapTarget >= 0) {
      const tmp = flattened[i];
      flattened[i] = flattened[swapTarget];
      flattened[swapTarget] = tmp;
    }
  }

  return flattened.map((n) => n.item);
}

/**
 * Quantitative inspection utility for unit tests and performance benchmarks.
 */
export function analyzeShuffleDistribution<T>(
  sequence: readonly T[],
  getTrackMeta: (item: T) => SmartShuffleTrackMeta,
  anchorTrack?: SmartShuffleTrackMeta | null,
): ShuffleDistributionReport {
  const n = sequence.length;
  if (n === 0) {
    return {
      totalItems: 0,
      distinctAlbums: 0,
      consecutiveSameAlbumPairs: 0,
      consecutiveSameArtistPairs: 0,
      maxConsecutiveSameAlbumRun: 0,
      startsWithAnchorTrack: false,
      startsWithAnchorAlbum: false,
      tailWindowStartRatio: 0.8,
      tailConsecutiveSameAlbumPairs: 0,
      tailDistinctAlbumRatio: 0,
    };
  }

  const tailStart = Math.floor(n * 0.8);
  const allAlbums = new Set<string>();
  const tailAlbums = new Set<string>();
  let sameAlbumPairs = 0;
  let tailSameAlbumPairs = 0;
  let sameArtistPairs = 0;
  let currentRun = 1;
  let maxRun = 1;

  let prevAlbum = '';
  let prevArtist = '';

  const firstMeta = getTrackMeta(sequence[0]);
  const firstAlbum = resolveCanonicalAlbumKey(firstMeta);
  const anchorAlbum = anchorTrack ? resolveCanonicalAlbumKey(anchorTrack) : null;

  for (let i = 0; i < n; i += 1) {
    const meta = getTrackMeta(sequence[i]);
    const alb = resolveCanonicalAlbumKey(meta);
    const art = resolveCanonicalArtistKey(meta);
    allAlbums.add(alb);
    if (i >= tailStart) {
      tailAlbums.add(alb);
    }
    if (i > 0) {
      if (alb === prevAlbum) {
        sameAlbumPairs += 1;
        currentRun += 1;
        if (currentRun > maxRun) {
          maxRun = currentRun;
        }
        if (i > tailStart) {
          tailSameAlbumPairs += 1;
        }
      } else {
        currentRun = 1;
      }
      if (art === prevArtist) {
        sameArtistPairs += 1;
      }
    }
    prevAlbum = alb;
    prevArtist = art;
  }

  const tailCount = Math.max(1, n - tailStart);
  const maxPossibleTailAlbums = Math.min(allAlbums.size, tailCount);

  return {
    totalItems: n,
    distinctAlbums: allAlbums.size,
    consecutiveSameAlbumPairs: sameAlbumPairs,
    consecutiveSameArtistPairs: sameArtistPairs,
    maxConsecutiveSameAlbumRun: maxRun,
    startsWithAnchorTrack: Boolean(anchorTrack && firstMeta.trackId === anchorTrack.trackId),
    startsWithAnchorAlbum: Boolean(anchorAlbum && firstAlbum === anchorAlbum),
    tailWindowStartRatio: 0.8,
    tailConsecutiveSameAlbumPairs: tailSameAlbumPairs,
    tailDistinctAlbumRatio: maxPossibleTailAlbums > 0 ? tailAlbums.size / maxPossibleTailAlbums : 1,
  };
}
