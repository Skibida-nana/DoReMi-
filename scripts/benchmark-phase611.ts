import os from 'node:os';
import { sortAlbumTracksCanonical } from '../src/shared/utils/album-sort';
import { shuffleFisherYates } from '../src/renderer/src/player/playback-queue';
import {
  analyzeShuffleDistribution,
  smartShuffleItems,
} from '../src/shared/utils/smart-shuffle';

interface BenchTrack {
  trackId: string;
  albumKey: string;
  albumTitle: string;
  artist: string;
  discNumber: number;
  trackNumber: number;
  title: string;
}

function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateCatalog(trackCount: number, albumCount: number): BenchTrack[] {
  const out: BenchTrack[] = new Array(trackCount);
  for (let i = 0; i < trackCount; i += 1) {
    const albIdx = (i % albumCount) + 1;
    const trackNum = Math.floor(i / albumCount) + 1;
    out[i] = {
      trackId: `trk-${i}`,
      albumKey: `alb-${albIdx}`,
      albumTitle: `Album ${albIdx}`,
      artist: `Artist ${((albIdx - 1) % Math.max(1, Math.floor(albumCount / 2))) + 1}`,
      discNumber: trackNum > 15 ? 2 : 1,
      trackNumber: trackNum,
      title: `Track ${trackNum} from Album ${albIdx}`,
    };
  }
  return out;
}

function measure<T>(label: string, fn: () => T): {
  label: string;
  elapsedMs: number;
  cpuPctLogical: number;
  heapDeltaMb: number;
  result: T;
} {
  const heapBefore = process.memoryUsage().heapUsed;
  const cpuBefore = process.cpuUsage();
  const t0 = performance.now();
  const result = fn();
  const elapsedMs = Math.max(0.1, performance.now() - t0);
  const cpuDelta = process.cpuUsage(cpuBefore);
  const heapAfter = process.memoryUsage().heapUsed;
  const cpus = Math.max(1, os.cpus().length || 1);
  const cpuPctLogical = ((cpuDelta.user + cpuDelta.system) / (elapsedMs * 1000 * cpus)) * 100;
  return {
    label,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    cpuPctLogical: Number(cpuPctLogical.toFixed(2)),
    heapDeltaMb: Number(((heapAfter - heapBefore) / (1024 * 1024)).toFixed(2)),
    result,
  };
}

function main(): void {
  const catalog500 = generateCatalog(500, 25);
  let oldAdjTotal = 0;
  let oldMaxRunTotal = 0;
  let oldTailAdjTotal = 0;
  let oldTailDistinctSum = 0;

  let smartAdjTotal = 0;
  let smartMaxRunTotal = 0;
  let smartTailAdjTotal = 0;
  let smartTailDistinctSum = 0;

  const anchor = catalog500[0];
  const compRunStart = performance.now();
  for (let r = 0; r < 100; r += 1) {
    const naive = shuffleFisherYates(catalog500, createMulberry32(7000 + r));
    const nr = analyzeShuffleDistribution(naive, (x) => x, anchor);
    oldAdjTotal += nr.consecutiveSameAlbumPairs;
    oldMaxRunTotal += nr.maxConsecutiveSameAlbumRun;
    oldTailAdjTotal += nr.tailConsecutiveSameAlbumPairs;
    oldTailDistinctSum += nr.tailDistinctAlbumRatio;

    const smart = smartShuffleItems({
      items: catalog500,
      getTrackMeta: (x) => x,
      anchorTrack: anchor,
      rng: createMulberry32(7000 + r),
    });
    const sr = analyzeShuffleDistribution(smart, (x) => x, anchor);
    smartAdjTotal += sr.consecutiveSameAlbumPairs;
    smartMaxRunTotal += sr.maxConsecutiveSameAlbumRun;
    smartTailAdjTotal += sr.tailConsecutiveSameAlbumPairs;
    smartTailDistinctSum += sr.tailDistinctAlbumRatio;
  }
  const compElapsedMs = Number((performance.now() - compRunStart).toFixed(2));

  const bench5k = measure('smartShuffle-5000-tracks', () =>
    smartShuffleItems({
      items: generateCatalog(5000, 250),
      getTrackMeta: (x) => x,
      rng: createMulberry32(99),
    }),
  );

  const cat50k = generateCatalog(50_000, 2500);
  const bench50k = measure('smartShuffle-50000-tracks', () =>
    smartShuffleItems({
      items: cat50k,
      getTrackMeta: (x) => x,
      rng: createMulberry32(101),
    }),
  );

  const albumTracks10k = generateCatalog(10_000, 1).reverse();
  const sort10k = measure('canonicalAlbumSort-10000-tracks', () =>
    sortAlbumTracksCanonical(albumTracks10k),
  );

  const summary = {
    environment: {
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      logicalCpus: os.cpus().length,
      totalRamGb: Number((os.totalmem() / (1024 ** 3)).toFixed(2)),
    },
    shuffle100RunComparison_500tracks_25albums: {
      elapsedMs: compElapsedMs,
      naiveFisherYatesAvg: {
        consecutiveSameAlbumPairs: Number((oldAdjTotal / 100).toFixed(2)),
        maxSameAlbumRun: Number((oldMaxRunTotal / 100).toFixed(2)),
        tailConsecutiveSameAlbumPairs: Number((oldTailAdjTotal / 100).toFixed(2)),
        tailDistinctAlbumRatio: Number((oldTailDistinctSum / 100).toFixed(3)),
      },
      smartShuffleAvg: {
        consecutiveSameAlbumPairs: Number((smartAdjTotal / 100).toFixed(2)),
        maxSameAlbumRun: Number((smartMaxRunTotal / 100).toFixed(2)),
        tailConsecutiveSameAlbumPairs: Number((smartTailAdjTotal / 100).toFixed(2)),
        tailDistinctAlbumRatio: Number((smartTailDistinctSum / 100).toFixed(3)),
      },
    },
    scaleBenchmarks: [
      {
        label: bench5k.label,
        items: bench5k.result.length,
        elapsedMs: bench5k.elapsedMs,
        cpuPctLogical: bench5k.cpuPctLogical,
        heapDeltaMb: bench5k.heapDeltaMb,
      },
      {
        label: bench50k.label,
        items: bench50k.result.length,
        elapsedMs: bench50k.elapsedMs,
        cpuPctLogical: bench50k.cpuPctLogical,
        heapDeltaMb: bench50k.heapDeltaMb,
      },
      {
        label: sort10k.label,
        items: sort10k.result.length,
        elapsedMs: sort10k.elapsedMs,
        cpuPctLogical: sort10k.cpuPctLogical,
        heapDeltaMb: sort10k.heapDeltaMb,
      },
    ],
  };

  console.log(JSON.stringify(summary, null, 2));
}

main();
