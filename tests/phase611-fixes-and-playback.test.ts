import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ArtworkRepository } from '../src/main/database/artwork-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { ArtworkService } from '../src/main/services/artwork-service';
import { ConnectClientService } from '../src/main/services/connect/connect-client';
import { ConnectRepository } from '../src/main/services/connect/connect-repository';
import { ConnectHostService } from '../src/main/services/connect/host-service';
import { ConnectSecretStorage } from '../src/main/services/connect/secret-storage';
import { LyricsService } from '../src/main/services/lyrics-service';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import {
  DEFAULT_PERSONALIZATION_PREFERENCES,
  ProfileService,
} from '../src/main/services/profile-service';
import {
  AudioEngine,
  type AudioElementLike,
  type ExternalTrackResolver,
} from '../src/renderer/src/player/audio-engine';
import {
  PlaybackQueueController,
  shuffleFisherYates,
} from '../src/renderer/src/player/playback-queue';
import {
  resolveSidebarAutoHideMode,
  resolveSidebarRevealedOnTransition,
} from '../src/renderer/src/utils/animation-policy';
import { resolveNowPlayingTitleTypography } from '../src/renderer/src/utils/title-typography';
import type { TrackRecord } from '../src/shared/types/track';
import {
  compareAlbumTracksCanonical,
  parseAlbumOrdinal,
  sortAlbumTracksCanonical,
} from '../src/shared/utils/album-sort';
import { SleepTimerController } from '../src/shared/utils/sleep-timer';
import {
  analyzeShuffleDistribution,
  resolveCanonicalAlbumKey,
  smartShuffleItems,
} from '../src/shared/utils/smart-shuffle';

class FakeAudioElement implements AudioElementLike {
  src = '';
  crossOrigin: string | null = 'anonymous';
  currentTime = 0;
  duration = 180;
  volume = 1;
  muted = false;
  preload = 'metadata';
  paused = true;
  ended = false;
  error: { code: number; message?: string } | null = null;
  private listeners = new Map<string, Set<() => void>>();

  async play(): Promise<void> {
    this.paused = false;
    this.ended = false;
  }

  pause(): void {
    this.paused = true;
  }

  load(): void {}

  addEventListener(type: string, listener: () => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    if (type === 'ended') {
      this.ended = true;
      this.paused = true;
    }
    for (const fn of this.listeners.get(type) ?? []) {
      fn();
    }
  }
}

function makeTrack(
  id: string,
  overrides: Partial<TrackRecord> = {},
): TrackRecord {
  const now = '2026-11-26T00:00:00.000Z';
  return {
    id,
    original_path: `C:\\Music\\${id}.flac`,
    normalized_path: `c:\\music\\${id}.flac`,
    title: id,
    artist: 'Artist',
    album: 'Album',
    album_artist: null,
    genre: null,
    year: 2024,
    track_number: 1,
    track_total: null,
    disc_number: 1,
    disc_total: null,
    composer: null,
    lyricist: null,
    comment: null,
    channels: 2,
    encoder: null,
    file_name: `${id}.flac`,
    duration_ms: 210_000,
    codec: 'FLAC',
    container: 'FLAC',
    sample_rate_hz: 44_100,
    bit_depth: 16,
    bitrate_bps: 900_000,
    file_size_bytes: 20_000_000,
    modified_at_ms: 1_700_000_000_000,
    artwork_url: null,
    artwork_thumb_url: null,
    status: 'available',
    availability_state: 'available',
    availability_reason: null,
    added_at: now,
    updated_at: now,
    ...overrides,
  };
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

test('Phase 6.1.1 BUG-01: Long Vietnamese titles render with safe line-height, 3-line wrap & zero clipping classes', async () => {
  const sampleTitle = 'LẦN CUỐI (đi bên em xót xa người ơi)';
  const stdShort = resolveNowPlayingTitleTypography('Ngắn', 'standard');
  const stdLong = resolveNowPlayingTitleTypography(sampleTitle, 'standard');
  const focusShort = resolveNowPlayingTitleTypography('Ngắn', 'focus');
  const focusLong = resolveNowPlayingTitleTypography(sampleTitle, 'focus');

  assert.ok(stdLong.lineHeight >= 1.24, 'Standard Vietnamese title needs >= 1.24 lineHeight');
  assert.ok(focusLong.lineHeight >= 1.2, 'Focus Vietnamese title needs >= 1.2 lineHeight');
  assert.equal(stdLong.maxLines, 3);
  assert.equal(focusLong.maxLines, 3);
  assert.notEqual(focusLong.fontSize, focusShort.fontSize);
  assert.notEqual(stdLong.fontSize, stdShort.fontSize);

  const npSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/pages/NowPlayingPage.tsx'),
    'utf8',
  );
  assert.match(npSrc, /resolveNowPlayingTitleTypography/);
  assert.match(npSrc, /pt-\[0\.06em\] pb-\[0\.14em\]/);
  assert.doesNotMatch(npSrc, /data-testid="focus-track-title"[\s\S]{0,220}line-clamp-2/);
  assert.doesNotMatch(npSrc, /data-testid="now-playing-hero-title"[\s\S]{0,220}line-clamp-2/);
});

test('Phase 6.1.1 BUG-02: Canonical album track sorting works across disc_number, track_number, tags & fallback', async () => {
  assert.equal(parseAlbumOrdinal(1), 1);
  assert.equal(parseAlbumOrdinal('10'), 10);
  assert.equal(parseAlbumOrdinal('02/12'), 2);
  assert.equal(parseAlbumOrdinal('3 of 14'), 3);
  assert.equal(parseAlbumOrdinal(0), null);
  assert.equal(parseAlbumOrdinal(null), null);
  assert.equal(parseAlbumOrdinal('bonus'), null);

  const unordered = [
    { id: 't10', title: 'Track 10', discNumber: 1, trackNumber: 10, fileName: '10.flac' },
    { id: 't2', title: 'Track 2', discNumber: 1, trackNumber: '02/12', fileName: '02.flac' },
    { id: 'tbonus', title: 'Bonus B', discNumber: 1, trackNumber: null, fileName: 'b-bonus.flac' },
    { id: 't1', title: 'Track 1', discNumber: null, trackNumber: '1/12', fileName: '01.flac' },
    { id: 'd2t1', title: 'Disc 2 Track 1', discNumber: 2, trackNumber: 1, fileName: '201.flac' },
    { id: 'tbonus-a', title: 'Bonus A', discNumber: 1, trackNumber: null, fileName: 'a-bonus.flac' },
  ];

  const sorted = sortAlbumTracksCanonical(unordered);
  assert.deepEqual(
    sorted.map((t) => t.id),
    ['t1', 't2', 't10', 'tbonus-a', 'tbonus', 'd2t1'],
  );
  // Original array must never be mutated
  assert.equal(unordered[0].id, 't10');
  assert.equal(compareAlbumTracksCanonical(sorted[0], sorted[1]) < 0, true);

  // Verify AlbumDetailPage & uiStore reuse canonical sort
  const albumPageSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/pages/AlbumDetailPage.tsx'),
    'utf8',
  );
  assert.match(albumPageSrc, /getAlbumTracksSorted/);

  const uiStoreSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/stores/ui-store.ts'),
    'utf8',
  );
  assert.match(uiStoreSrc, /sortAlbumTracksCanonical/);
  assert.match(uiStoreSrc, /trackNumber:\s*t\.track_number\s*\?\?\s*null/);
});

test('Phase 6.1.1 IMP-03: Album-aware Smart Shuffle eliminates tail clustering, honors boundaries & preserves all entries', () => {
  // Construct 5 albums x 8 tracks = 40 tracks ordered sequentially by album
  const catalog: Array<{
    trackId: string;
    albumKey: string;
    albumTitle: string;
    artist: string;
  }> = [];
  for (let a = 1; a <= 5; a += 1) {
    for (let t = 1; t <= 8; t += 1) {
      catalog.push({
        trackId: `alb${a}-trk${t}`,
        albumKey: `alb-${a}`,
        albumTitle: `Album ${a}`,
        artist: `Artist ${a}`,
      });
    }
  }

  let smartAdjacentSum = 0;
  let fisherAdjacentSum = 0;
  let smartTailAdjacentSum = 0;
  let fisherTailAdjacentSum = 0;

  const anchor = catalog[0];
  for (let run = 0; run < 100; run += 1) {
    const rngA = createMulberry32(1000 + run);
    const rngB = createMulberry32(1000 + run);

    const smart = smartShuffleItems({
      items: catalog,
      getTrackMeta: (item) => item,
      anchorTrack: anchor,
      rng: rngA,
    });
    const naive = shuffleFisherYates(catalog, rngB);

    assert.equal(smart.length, catalog.length);
    assert.deepEqual(
      new Set(smart.map((x) => x.trackId)),
      new Set(catalog.map((x) => x.trackId)),
    );

    const smartReport = analyzeShuffleDistribution(smart, (x) => x, anchor);
    const naiveReport = analyzeShuffleDistribution(naive, (x) => x, anchor);

    assert.equal(smartReport.startsWithAnchorAlbum, false);
    assert.equal(smartReport.startsWithAnchorTrack, false);
    smartAdjacentSum += smartReport.consecutiveSameAlbumPairs;
    fisherAdjacentSum += naiveReport.consecutiveSameAlbumPairs;
    smartTailAdjacentSum += smartReport.tailConsecutiveSameAlbumPairs;
    fisherTailAdjacentSum += naiveReport.tailConsecutiveSameAlbumPairs;
  }

  assert.equal(smartAdjacentSum, 0, 'Balanced 5x8 catalog should achieve zero consecutive same-album pairs across 100 runs');
  assert.ok(fisherAdjacentSum > smartAdjacentSum * 10 + 100);
  assert.equal(smartTailAdjacentSum, 0);
  assert.ok(fisherTailAdjacentSum > 0);

  // Unknown-album fallback must treat different unknown-album tracks independently
  const k1 = resolveCanonicalAlbumKey({ trackId: 'u1', albumTitle: 'Không rõ Album', artist: 'X' });
  const k2 = resolveCanonicalAlbumKey({ trackId: 'u2', albumTitle: '', artist: 'X' });
  assert.notEqual(k1, k2);

  // Single-album, 1-track, duplicates, manual Play Next / Add to Queue & Shuffle OFF restoration
  const controller = new PlaybackQueueController({
    rng: createMulberry32(42),
    getTrackMeta: (id) => ({
      trackId: id,
      albumTitle: id.split(':')[0],
      artist: `Artist-${id.split(':')[0]}`,
    }),
  });
  const orderedIds = [
    'A:1', 'A:2', 'A:3',
    'B:1', 'B:2', 'B:3',
    'C:1', 'C:2', 'C:3',
    'A:2', // intentional duplicate in playlist
  ];
  controller.startContext({
    context: {
      contextId: 'pl-dup',
      label: 'Mixed',
      kind: 'playlist',
      trackIds: orderedIds,
    },
    startTrackId: 'A:1',
    shuffle: true,
  });

  controller.playNext('D:playnext');
  controller.addToQueue('E:manual');

  const shuffledState = controller.getState();
  assert.equal(shuffledState.upcoming[0].trackId, 'D:playnext');
  assert.equal(shuffledState.upcoming[shuffledState.upcoming.length - 1].trackId, 'E:manual');
  assert.equal(shuffledState.upcoming.length, orderedIds.length - 1 + 2);

  // Turning Shuffle OFF restores exact canonical context order while preserving Play Next & Manual Tail
  controller.setShuffle(false);
  const restored = controller.getState();
  assert.equal(restored.upcoming[0].trackId, 'D:playnext');
  assert.equal(restored.upcoming[restored.upcoming.length - 1].trackId, 'E:manual');
  assert.deepEqual(
    restored.upcoming.slice(1, -1).map((e) => e.trackId),
    orderedIds.slice(1),
  );
});

test('Phase 6.1.1 IMP-04 & SleepTimer precedence: Auto Continue plays sequentially or Smart-Shuffled with full safety guards', async () => {
  // 1. Preferences persistence + backward compatibility (legacy record missing autoContinueEnabled -> true)
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p611-pref-'));
  try {
    assert.equal(DEFAULT_PERSONALIZATION_PREFERENCES.autoContinueEnabled, true);
    const conn1 = openLibraryDatabase(path.join(dir, 'library.db'));
    try {
      const svc1 = new ProfileService({ db: conn1.db, userDataDir: dir });
      assert.equal(svc1.getPreferences().autoContinueEnabled, true);
      svc1.updatePreferences({ autoContinueEnabled: false });
      assert.equal(svc1.getPreferences().autoContinueEnabled, false);
    } finally {
      conn1.close();
    }
    const conn2 = openLibraryDatabase(path.join(dir, 'library.db'));
    try {
      const svc2 = new ProfileService({ db: conn2.db, userDataDir: dir });
      assert.equal(svc2.getPreferences().autoContinueEnabled, false);
    } finally {
      conn2.close();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  // 2. AudioEngine end-of-queue Auto Continue matrix
  const T1 = '11111111-1111-4111-8111-000000000001';
  const T2 = '11111111-1111-4111-8111-000000000002';
  const T3 = '11111111-1111-4111-8111-000000000003';
  const T4 = '11111111-1111-4111-8111-000000000004';
  const libTracks = [
    makeTrack(T1, { album: 'Alb1', artist: 'Art1' }),
    makeTrack(T2, { album: 'Alb2', artist: 'Art2' }),
    makeTrack(T3, { album: 'Alb3', artist: 'Art3' }),
    makeTrack(T4, { album: 'Alb4', artist: 'Art4' }),
  ];

  const fakeAudio = new FakeAudioElement();
  const sleepTimer = new SleepTimerController({
    onExpire: () => {
      engine.stop('sleep-timer');
    },
  });

  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    createAudioContext: null,
    autoContinueEnabled: true,
    shouldBlockAutoContinue: () => sleepTimer.handleNaturalTrackEnd(),
    autoContinueResolver: ({ lastTrackId, shuffleEnabled, recentTrackIds }) => {
      const avail = libTracks.filter((t) => t.status === 'available');
      if (avail.length <= 1 && avail[0]?.id === lastTrackId) return null;
      if (shuffleEnabled) {
        const pool = avail.filter((t) => t.id !== lastTrackId && !recentTrackIds.includes(t.id));
        const eff = pool.length > 0 ? pool : avail.filter((t) => t.id !== lastTrackId);
        return eff.length > 0
          ? {
              context: {
                contextId: 'auto-shuf',
                label: 'Phát tiếp',
                kind: 'library',
                trackIds: eff.map((t) => t.id),
              },
              startTrackId: eff[0].id,
            }
          : null;
      }
      const idx = avail.findIndex((t) => t.id === lastTrackId);
      const next = avail[(idx + 1) % avail.length];
      return {
        context: {
          contextId: 'auto-seq',
          label: 'Phát tiếp',
          kind: 'library',
          trackIds: [next.id],
        },
        startTrackId: next.id,
      };
    },
  });

  engine.syncTrackCatalog(libTracks);

  // Case A: Shuffle OFF -> finishes playlist [T1, T2] and continues right to T3!
  await engine.playFromContext(
    { contextId: 'pl-end', label: 'Small Playlist', kind: 'playlist', trackIds: [T1, T2] },
    T2,
    false,
  );
  assert.equal(engine.getPlaybackState().currentTrackId, T2);
  fakeAudio.emit('ended');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.getPlaybackState().currentTrackId, T3);

  // Case B: Auto Continue OFF -> stops cleanly after finishing track!
  engine.setAutoContinueEnabled(false);
  await engine.playFromContext(
    { contextId: 'pl-stop', label: 'Stop Playlist', kind: 'playlist', trackIds: [T3] },
    T3,
    false,
  );
  fakeAudio.emit('ended');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.getPlaybackState().currentTrackId, T3);
  assert.equal(engine.getPlaybackState().status, 'ended');

  // Case C: Auto Next OFF -> Auto Continue MUST NOT trigger even when autoContinueEnabled = true!
  engine.setAutoContinueEnabled(true);
  engine.setAutoNext(false);
  await engine.playFromContext(
    { contextId: 'pl-autonext-off', label: 'NoAutoNext', kind: 'playlist', trackIds: [T3] },
    T3,
    false,
  );
  fakeAudio.emit('ended');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.getPlaybackState().currentTrackId, T3);
  assert.equal(engine.getPlaybackState().status, 'ended');

  // Case D: Sleep Timer end-of-track armed -> Auto Continue MUST NOT fire and timer disarms!
  engine.setAutoNext(true);
  await engine.playFromContext(
    { contextId: 'pl-sleep', label: 'Sleep', kind: 'playlist', trackIds: [T3] },
    T3,
    false,
  );
  sleepTimer.start('end-of-track', { currentTrackId: T3 });
  assert.equal(sleepTimer.getState().preset, 'end-of-track');
  fakeAudio.emit('ended');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.getPlaybackState().currentTrackId, T3);
  assert.equal(engine.getPlaybackState().status, 'ended');
  assert.equal(sleepTimer.getState().preset, 'off');

  // Case E: Repeat All stays inside context instead of crossing to library continuation
  engine.setRepeatMode('all');
  await engine.playFromContext(
    { contextId: 'pl-loop', label: 'Loop', kind: 'playlist', trackIds: [T1, T2] },
    T2,
    false,
  );
  fakeAudio.emit('ended');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.getPlaybackState().currentTrackId, T1);

  // Case F: Remote track MUST NEVER auto-continue into Local Library
  engine.setRepeatMode('off');
  const remoteId = 'remote::11111111-1111-4111-8111-000000000099::11111111-1111-4111-8111-000000000101';
  const remoteResolver: ExternalTrackResolver = {
    ownsTrackId: (id) => id.startsWith('remote::'),
    isTrackPlayable: () => true,
    resolveMediaUrl: (id) => `lossless-media://remote-track/11111111-1111-4111-8111-000000000099/${id.split('::')[2]}`,
    getTrack: (id) => makeTrack(id, { title: 'Remote Song' }),
  };
  engine.setExternalTrackResolver(remoteResolver);
  await engine.playFromContext(
    { contextId: 'remote-tracks-host-1', label: 'Remote', kind: 'custom', trackIds: [remoteId] },
    remoteId,
    false,
  );
  assert.equal(engine.getPlaybackState().currentTrackId, remoteId);
  fakeAudio.emit('ended');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(engine.getPlaybackState().currentTrackId, remoteId);

  // Settings UI contains Auto Continue toggle
  const settingsSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/pages/SettingsPage.tsx'),
    'utf8',
  );
  assert.match(settingsSrc, /settings-auto-continue-toggle/);
  assert.match(settingsSrc, /Tự động phát tiếp khi hết danh sách/);
});

test('Phase 6.1.1 IMP-05 & IMP-06: Instant Sidebar auto-hide contract & Library Play Random action', async () => {
  // IMP-05: Entering both standard & focus hides immediately (ZERO 3s flash)
  assert.equal(resolveSidebarAutoHideMode('now-playing', 'standard'), 'standard-idle');
  assert.equal(resolveSidebarAutoHideMode('now-playing', 'focus'), 'focus-immediate');
  assert.deepEqual(resolveSidebarRevealedOnTransition('none', 'standard-idle', true), {
    revealed: false,
    scheduleHideMs: null,
  });
  assert.deepEqual(resolveSidebarRevealedOnTransition('none', 'focus-immediate', true), {
    revealed: false,
    scheduleHideMs: null,
  });
  assert.deepEqual(resolveSidebarRevealedOnTransition('standard-idle', 'focus-immediate', false), {
    revealed: false,
    scheduleHideMs: null,
  });
  assert.deepEqual(resolveSidebarRevealedOnTransition('focus-immediate', 'none', false), {
    revealed: true,
    scheduleHideMs: null,
  });

  const sidebarSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/components/Sidebar.tsx'),
    'utf8',
  );
  assert.match(sidebarSrc, /suppressInitialEdgeHoverRef/);
  assert.match(sidebarSrc, /w-\[10px\]/);
  assert.match(sidebarSrc, /useState<boolean>\(!isOverlayAutoHide\)/);

  // IMP-06: Play Random button next to Create Playlist
  const libSrc = await fs.readFile(
    path.resolve(process.cwd(), 'src/renderer/src/pages/LibraryPage.tsx'),
    'utf8',
  );
  const randomBtnIdx = libSrc.indexOf('library-toolbar-play-random-btn');
  const createBtnIdx = libSrc.indexOf('library-toolbar-create-playlist-btn');
  assert.ok(randomBtnIdx > 0 && createBtnIdx > randomBtnIdx);
  assert.match(libSrc, /Phát ngẫu nhiên/);
  assert.match(libSrc, /playRandomFromLibrary/);
});

test('Phase 6.1.1 Server Compatibility + BUG-02 Remote Album Track Ordering & Zero Regression', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p611-connect-'));
  const userDataDir = path.join(tmpDir, 'userdata');
  const musicDir = path.join(tmpDir, 'music');
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.mkdir(musicDir, { recursive: true });

  const f1 = path.join(musicDir, '01-first.flac');
  const f2 = path.join(musicDir, '02-second.flac');
  const f10 = path.join(musicDir, '10-tenth.flac');
  await fs.writeFile(f1, Buffer.from('fLaC0001'));
  await fs.writeFile(f2, Buffer.from('fLaC0002'));
  await fs.writeFile(f10, Buffer.from('fLaC0010'));

  const conn = openLibraryDatabase(path.join(userDataDir, 'library.db'));
  let hostService: ConnectHostService | null = null;
  let clientService: ConnectClientService | null = null;

  try {
    const trackRepo = new TrackRepository(conn.db);
    const rootRepo = new LibraryRootRepository(conn.db);
    const artworkRepo = new ArtworkRepository(conn.db);
    const lyricsRepo = new LyricsRepository(conn.db);
    const connectRepo = new ConnectRepository(conn.db);

    const artworkService = new ArtworkService({ trackRepo, artworkRepo, userDataDir });
    const lyricsService = new LyricsService({ trackRepo, lyricsRepo });

    const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));
    // Insert deliberately OUT OF ORDER (10, 2, 1)
    trackRepo.upsertBatch([
      {
        original_path: f10,
        normalized_path: normalizeTrackPath(f10),
        title: 'Tenth Song',
        artist: 'Same Artist',
        album: 'Ordered Album',
        album_artist: 'Same Artist',
        track_number: 10,
        disc_number: 1,
        file_name: '10-tenth.flac',
        duration_ms: 180_000,
        codec: 'FLAC',
        container: 'FLAC',
        sample_rate_hz: 44_100,
        bit_depth: 16,
        bitrate_bps: 900_000,
        file_size_bytes: 8,
        modified_at_ms: 1_700_000_000_000,
        status: 'available',
      },
      {
        original_path: f2,
        normalized_path: normalizeTrackPath(f2),
        title: 'Second Song',
        artist: 'Same Artist',
        album: 'Ordered Album',
        album_artist: 'Same Artist',
        track_number: 2,
        disc_number: 1,
        file_name: '02-second.flac',
        duration_ms: 180_000,
        codec: 'FLAC',
        container: 'FLAC',
        sample_rate_hz: 44_100,
        bit_depth: 16,
        bitrate_bps: 900_000,
        file_size_bytes: 8,
        modified_at_ms: 1_700_000_000_000,
        status: 'available',
      },
      {
        original_path: f1,
        normalized_path: normalizeTrackPath(f1),
        title: 'First Song',
        artist: 'Same Artist',
        album: 'Ordered Album',
        album_artist: 'Same Artist',
        track_number: 1,
        disc_number: 1,
        file_name: '01-first.flac',
        duration_ms: 180_000,
        codec: 'FLAC',
        container: 'FLAC',
        sample_rate_hz: 44_100,
        bit_depth: 16,
        bitrate_bps: 900_000,
        file_size_bytes: 8,
        modified_at_ms: 1_700_000_000_000,
        status: 'available',
      },
    ]);

    connectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, maxActiveClients: 2 });
    hostService = new ConnectHostService({
      appVersion: '1.0.0-rc.3',
      userDataDir,
      connectRepo,
      trackRepo,
      artworkService,
      lyricsService,
      secrets: new ConnectSecretStorage({ userDataDir }),
      enableMdns: false,
    });
    hostService.addSharedSource(root.id);
    const hostSnap = await hostService.start();
    const port = hostSnap.listeningPort!;
    const inv = hostService.createInvitation({ autoApproveSingleUse: true });

    const clientDir = path.join(tmpDir, 'client-data');
    await fs.mkdir(clientDir, { recursive: true });
    const clientConn = openLibraryDatabase(path.join(clientDir, 'client.db'));
    clientService = new ConnectClientService({
      connectRepo: new ConnectRepository(clientConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir }),
    });
    const probe = await clientService.probeHost('127.0.0.1', port);
    const clientSnap = await clientService.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Test-P611-Client',
    });
    assert.equal(clientSnap.status, 'connected');

    const albumsRes = await clientService.listRemoteAlbums();
    assert.equal(albumsRes.items.length, 1);

    const albumTracksRes = await clientService.listRemoteTracks({
      albumKey: albumsRes.items[0].albumKey,
    });
    assert.deepEqual(
      albumTracksRes.items.map((t) => t.trackNumber),
      [1, 2, 10],
      'Remote album tracks endpoint MUST return canonical numeric disc->track order',
    );
    await clientService.disconnect();
    clientConn.close();
  } finally {
    await hostService?.stop();
    conn.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
