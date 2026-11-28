import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildRemoteTrackId,
} from '../src/shared/contracts/connect-api';
import type {
  ConnectClientSnapshot,
  HostSnapshot,
  RememberedHostRecord,
  RemoteAlbumDto,
  RemoteArtistDto,
  RemoteLibraryPage,
  RemoteTrackDto,
} from '../src/shared/types/connect';
import type { LosslessDesktopApi } from '../src/shared/types/ipc';
import type { PlaybackQueueEntry, PlaybackState } from '../src/shared/types/player';
import { PlaybackQueueController } from '../src/renderer/src/player/playback-queue';
import { ConnectStore } from '../src/renderer/src/stores/connect-store-core';
import {
  matchesNormalizedVietnameseQuery,
  normalizeVietnameseText,
} from '../src/renderer/src/utils/vietnamese-search';

const HOST_A_ID = '11111111-1111-4111-8111-111111111111';
const HOST_B_ID = '22222222-2222-4222-8222-222222222222';

function makeTrackDto(idSuffix: string, title: string, artist: string, album: string): RemoteTrackDto {
  return {
    trackId: `00000000-0000-4000-8000-${idSuffix.padStart(12, '0')}`,
    title,
    artist,
    album,
    albumArtist: artist,
    genre: 'Lossless',
    year: 2024,
    trackNumber: 1,
    trackTotal: 1,
    discNumber: 1,
    discTotal: 1,
    durationMs: 180_000,
    codec: 'FLAC',
    container: 'FLAC',
    sampleRateHz: 44100,
    bitDepth: 16,
    bitrateBps: 1_000_000,
    channels: 2,
    fileSizeBytes: 25_000_000,
    availabilityState: 'available',
    hasArtwork: false,
    artworkHash: null,
    hasLyrics: false,
  };
}

function makeHostRecord(hostId: string, name: string, port: number): RememberedHostRecord {
  return {
    hostId,
    displayName: name,
    lastAddress: '192.168.1.50',
    port,
    pinnedFingerprint: 'sha256:test',
    shortFingerprint: 'TEST-FP',
    deviceId: 'dev-1',
    apiVersion: '1',
    lastConnectedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeClientSnap(
  host: RememberedHostRecord | null,
  status: ConnectClientSnapshot['status'] = host ? 'connected' : 'disconnected',
  updatedAt = '2026-11-27T12:00:00.000Z',
): ConnectClientSnapshot {
  return {
    status,
    activeHost: host,
    summary: host
      ? {
          hostId: host.hostId,
          hostDisplayName: host.displayName,
          totalSharedTracks: 3,
          totalAlbums: 2,
          totalArtists: 2,
          sharedSourceCount: 1,
          updatedAt,
        }
      : null,
    discoveredHosts: [],
    rememberedHosts: host ? [host] : [],
    isDiscovering: false,
    lastError: null,
    lastErrorCode: null,
    reconnectAttempt: 0,
    enrollment: { status: 'idle' },
  };
}

function createHarness() {
  const hostATracks = [
    makeTrackDto('1', 'Có Thể (102112 Version)', 'MCK', '99%'),
    makeTrackDto('2', 'Lần Cuối', 'Ngọt', 'Gieo'),
    makeTrackDto('3', 'Bông Hoa Đẹp Nhất', 'Quân A.P', 'Singles'),
  ];
  const hostBTracks = [
    makeTrackDto('101', 'Midnight Rain', 'HostB Artist', 'HostB Album'),
    makeTrackDto('102', 'Blue Hour', 'HostB Artist', 'HostB Album'),
  ];

  let activeHost: RememberedHostRecord | null = makeHostRecord(HOST_A_ID, 'Host PC Alpha', 48620);
  let clientSnap: ConnectClientSnapshot = makeClientSnap(activeHost, 'connected');
  let clientStateListener: ((s: ConnectClientSnapshot) => void) | null = null;

  const counters = {
    listTracksCalls: 0,
    listAlbumsCalls: 0,
    listArtistsCalls: 0,
    unfilteredFullFetchCount: 0,
  };

  let customListTracksHandler:
    | ((opts: { offset?: number; limit?: number; query?: string; albumKey?: string; artist?: string }) => Promise<RemoteLibraryPage<RemoteTrackDto>>)
    | null = null;

  const playedEntries: PlaybackQueueEntry[] = [];
  let pauseSilentlyCount = 0;
  let playingTrackId: string | null = null;
  const queueController = new PlaybackQueueController();

  const api: Partial<LosslessDesktopApi> = {
    connectGetHostSnapshot: async () =>
      ({
        state: 'STOPPED',
        config: { enabled: false },
      }) as unknown as HostSnapshot,
    connectGetClientSnapshot: async () => clientSnap,
    connectGetClientDiagnostics: async () => ({
      sampledAt: new Date().toISOString(),
      activeHostId: clientSnap.activeHost?.hostId ?? null,
      activeHostName: clientSnap.activeHost?.displayName ?? null,
      activeHostAddress: clientSnap.activeHost?.lastAddress ?? null,
      activeHostPort: clientSnap.activeHost?.port ?? null,
      status: clientSnap.status,
      lastError: clientSnap.lastError,
      lastErrorCode: clientSnap.lastErrorCode,
      lastTrackFailure: null,
      recentTraces: [],
    }),
    onConnectHostStateChanged: () => () => {},
    onConnectClientStateChanged: (cb) => {
      clientStateListener = cb;
      return () => {
        clientStateListener = null;
      };
    },
    connectListRemoteTracks: async (opts = {}) => {
      counters.listTracksCalls += 1;
      if (customListTracksHandler) {
        return customListTracksHandler(opts);
      }
      const source = activeHost?.hostId === HOST_B_ID ? hostBTracks : hostATracks;
      const q = (opts.query ?? '').trim().toLowerCase();
      if (!q && !opts.albumKey && !opts.artist && (opts.offset ?? 0) === 0) {
        counters.unfilteredFullFetchCount += 1;
      }
      const filtered = source.filter((t) => {
        if (q) {
          const hit =
            t.title.toLowerCase().includes(q) ||
            t.artist.toLowerCase().includes(q) ||
            (t.album ?? '').toLowerCase().includes(q);
          if (!hit) return false;
        }
        if (opts.artist && t.artist.toLowerCase() !== opts.artist.toLowerCase()) {
          return false;
        }
        return true;
      });
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? 100;
      const items = filtered.slice(offset, offset + limit);
      return {
        items,
        total: filtered.length,
        offset,
        limit,
        hasMore: offset + items.length < filtered.length,
      };
    },
    connectListRemoteAlbums: async (opts = {}) => {
      counters.listAlbumsCalls += 1;
      const q = (opts.query ?? '').trim().toLowerCase();
      const source = activeHost?.hostId === HOST_B_ID ? hostBTracks : hostATracks;
      const albums: RemoteAlbumDto[] = source
        .filter((t) => !q || (t.album ?? '').toLowerCase().includes(q) || t.artist.toLowerCase().includes(q))
        .map((t, i) => ({
          albumKey: `alb-${i}`,
          title: t.album ?? 'Unknown',
          artist: t.artist,
          year: 2024,
          trackCount: 1,
          totalDurationMs: 180_000,
          coverTrackId: t.trackId,
          coverHash: null,
        }));
      return { items: albums, total: albums.length, offset: 0, limit: 100, hasMore: false };
    },
    connectListRemoteArtists: async (opts = {}) => {
      counters.listArtistsCalls += 1;
      const q = (opts.query ?? '').trim().toLowerCase();
      const source = activeHost?.hostId === HOST_B_ID ? hostBTracks : hostATracks;
      const artists: RemoteArtistDto[] = source
        .filter((t) => !q || t.artist.toLowerCase().includes(q))
        .map((t) => ({ name: t.artist, trackCount: 1, albumCount: 1 }));
      return { items: artists, total: artists.length, offset: 0, limit: 100, hasMore: false };
    },
    connectToRememberedHost: async (hostId) => {
      activeHost =
        hostId === HOST_B_ID
          ? makeHostRecord(HOST_B_ID, 'Host PC Beta', 48621)
          : makeHostRecord(HOST_A_ID, 'Host PC Alpha', 48620);
      clientSnap = makeClientSnap(activeHost, 'connected');
      return clientSnap;
    },
    connectDisconnectClient: async () => {
      activeHost = null;
      clientSnap = makeClientSnap(null, 'disconnected');
      return clientSnap;
    },
  };

  const store = new ConnectStore({
    getApi: () => api as LosslessDesktopApi,
    queueController,
    playbackActions: {
      playQueueEntry: async (entry) => {
        playedEntries.push(entry);
        playingTrackId = entry.trackId;
      },
      getPlaybackState: () =>
        ({
          status: playingTrackId ? 'playing' : 'idle',
          currentTrackId: playingTrackId,
        }) as unknown as PlaybackState,
      pauseSilently: () => {
        pauseSilentlyCount += 1;
        playingTrackId = null;
      },
    },
  });

  return {
    store,
    api,
    counters,
    queueController,
    hostATracks,
    hostBTracks,
    playedEntries,
    getPauseSilentlyCount: () => pauseSilentlyCount,
    getPlayingTrackId: () => playingTrackId,
    setCustomListTracks: (fn: typeof customListTracksHandler) => {
      customListTracksHandler = fn;
    },
    pushHostDisconnectFromMain: () => {
      activeHost = null;
      clientSnap = makeClientSnap(null, 'disconnected');
      clientStateListener?.(clientSnap);
    },
    pushHostSwitchFromMain: (hostId: string) => {
      activeHost =
        hostId === HOST_B_ID
          ? makeHostRecord(HOST_B_ID, 'Host PC Beta', 48621)
          : makeHostRecord(HOST_A_ID, 'Host PC Alpha', 48620);
      clientSnap = makeClientSnap(activeHost, 'connected');
      clientStateListener?.(clientSnap);
    },
  };
}

test('Phase 6.1.3 Cases 1-7, 12-15: Initial load, search, clear, play, unmount/return persistence, rapid changes, playback & queue continuity, zero redundant full-library fetches', async () => {
  const h = createHarness();
  await h.store.initialize();

  // Case 1: Initial unfiltered Remote Library loading
  h.store.setServerPageTab('connect');
  await h.store.loadRemoteLibrary({ query: '' });
  let snap = h.store.getSnapshot();
  assert.equal(snap.remoteTracks.length, 3);
  assert.equal(snap.remoteSearchQuery, '');
  assert.equal(snap.remoteSearchInput, '');
  assert.equal(h.counters.unfilteredFullFetchCount, 1);

  // Case 2: Searching for a track ("có thể")
  await h.store.searchRemoteLibrary('Có Thể');
  snap = h.store.getSnapshot();
  assert.equal(snap.remoteTracks.length, 1);
  assert.equal(snap.remoteTracks[0].title, 'Có Thể (102112 Version)');
  assert.equal(snap.remoteSearchQuery, 'Có Thể');
  assert.equal(snap.remoteSearchInput, 'Có Thể');

  // Case 4: Playing a search result MUST NOT corrupt search or library state
  await h.store.playRemoteTrack(snap.remoteTracks[0]);
  const expectedCompositeId = buildRemoteTrackId(HOST_A_ID, snap.remoteTracks[0].trackId);
  assert.equal(h.getPlayingTrackId(), expectedCompositeId);
  assert.equal(h.store.getSnapshot().remoteTracks.length, 1);
  assert.equal(h.store.getSnapshot().remoteSearchQuery, 'Có Thể');

  // Snapshot playback queue state before further search/clear operations
  const queueBeforeSearchOps = h.queueController.getState();
  assert.equal(queueBeforeSearchOps.currentEntry?.trackId, expectedCompositeId);

  // Case 6 & 12: Navigating to Now Playing & returning to active search-results view preserves tab + synced input/results
  // (Simulating ServerPage remount: reading ConnectStore snapshot directly)
  const remountSnap = h.store.getSnapshot();
  assert.equal(remountSnap.serverPageTab, 'connect');
  assert.equal(remountSnap.remoteSearchInput, 'Có Thể');
  assert.equal(remountSnap.remoteSearchQuery, 'Có Thể');
  assert.equal(remountSnap.remoteTracks.length, 1);

  // Case 3, 5, 13, 14, 15: Clearing search restores unfiltered library from Host-scoped cache
  // with ZERO extra full-library network fetches while keeping playback & Queue uninterrupted!
  const fetchCountBeforeClear = h.counters.unfilteredFullFetchCount;
  h.store.setRemoteSearchInput(''); // User clears input box back to empty -> triggers instant restore!
  // Wait microtask tick for async clear promise
  await Promise.resolve();
  snap = h.store.getSnapshot();
  assert.equal(snap.remoteSearchInput, '');
  assert.equal(snap.remoteSearchQuery, '');
  assert.equal(snap.remoteTracks.length, 3);
  assert.equal(
    h.counters.unfilteredFullFetchCount,
    fetchCountBeforeClear,
    'Restoring unfiltered library after clearing search must reuse Host-scoped cache with 0 redundant fetches',
  );
  // Active playback and Queue remain 100% uninterrupted & unchanged
  assert.equal(h.getPlayingTrackId(), expectedCompositeId);
  assert.equal(h.getPauseSilentlyCount(), 0);
  assert.equal(h.queueController.getState().currentEntry?.trackId, expectedCompositeId);

  // Case 7: Rapid search changes always match latest query
  await h.store.searchRemoteLibrary('Lần');
  await h.store.searchRemoteLibrary('Bông');
  snap = h.store.getSnapshot();
  assert.equal(snap.remoteSearchQuery, 'Bông');
  assert.equal(snap.remoteSearchInput, 'Bông');
  assert.equal(snap.remoteTracks.length, 1);
  assert.equal(snap.remoteTracks[0].title, 'Bông Hoa Đẹp Nhất');

  // Empty search result vs Error state: empty search must set remoteLibraryError=null and tracks=[]
  await h.store.searchRemoteLibrary('Không Tồn Tại XYZ');
  snap = h.store.getSnapshot();
  assert.equal(snap.remoteTracks.length, 0);
  assert.equal(snap.remoteLibraryError, null);

  await h.store.clearRemoteFilters();
  assert.equal(h.store.getSnapshot().remoteTracks.length, 3);

  // Drilldown by artist skips redundant listAlbums/listArtists network calls
  const albumsCallsBeforeArtist = h.counters.listAlbumsCalls;
  await h.store.loadRemoteLibrary({ artist: 'Ngọt', albumKey: null });
  assert.equal(h.store.getSnapshot().remoteTracks.length, 1);
  assert.equal(h.store.getSnapshot().remoteTracks[0].artist, 'Ngọt');
  assert.equal(h.counters.listAlbumsCalls, albumsCallsBeforeArtist);

  h.store.dispose();
});

test('Phase 6.1.3 Cases 8 & 9: Out-of-order search responses cannot overwrite newer results & pagination resets cleanly on filter change', async () => {
  const h = createHarness();
  await h.store.initialize();

  // Case 9: Pagination first loads page 1 (hasMore=true), then appends page 2, then a new search resets offset=0
  const page1Track = makeTrackDto('1', 'Track Alpha', 'Artist 1', 'Alb 1');
  const page2Track = makeTrackDto('2', 'Track Beta', 'Artist 2', 'Alb 2');
  const observedOffsets: number[] = [];

  h.setCustomListTracks(async (opts) => {
    observedOffsets.push(opts.offset ?? 0);
    if (opts.query === 'beta') {
      return { items: [page2Track], total: 1, offset: opts.offset ?? 0, limit: 100, hasMore: false };
    }
    if ((opts.offset ?? 0) === 0) {
      return { items: [page1Track], total: 2, offset: 0, limit: 100, hasMore: true };
    }
    return { items: [page2Track], total: 2, offset: 1, limit: 100, hasMore: false };
  });

  await h.store.loadRemoteLibrary({ query: '' });
  assert.equal(h.store.getSnapshot().remoteTracks.length, 1);
  assert.equal(h.store.getSnapshot().remoteTracksHasMore, true);

  await h.store.loadRemoteLibrary({ append: true });
  assert.equal(h.store.getSnapshot().remoteTracks.length, 2);
  assert.equal(h.store.getSnapshot().remoteTracksHasMore, false);

  // Even if caller mistakenly passes append:true together with a changed query, offset resets to 0!
  await h.store.loadRemoteLibrary({ query: 'beta', append: true });
  assert.equal(observedOffsets.at(-1), 0);
  assert.equal(h.store.getSnapshot().remoteTracks.length, 1);
  assert.equal(h.store.getSnapshot().remoteTracks[0].title, 'Track Beta');

  // Case 8: Out-of-order async resolution — slow "stale-slow" must NEVER overwrite fast "fresh-fast"
  let resolveSlow!: (val: RemoteLibraryPage<RemoteTrackDto>) => void;
  let resolveFast!: (val: RemoteLibraryPage<RemoteTrackDto>) => void;

  h.setCustomListTracks((opts) => {
    if (opts.query === 'stale-slow') {
      return new Promise((res) => {
        resolveSlow = res;
      });
    }
    return new Promise((res) => {
      resolveFast = res;
    });
  });

  const slowPromise = h.store.searchRemoteLibrary('stale-slow');
  const fastPromise = h.store.searchRemoteLibrary('fresh-fast');

  // Fast query resolves first
  resolveFast({
    items: [makeTrackDto('99', 'Fresh Fast Track', 'Artist', 'Album')],
    total: 1,
    offset: 0,
    limit: 100,
    hasMore: false,
  });
  await fastPromise;
  assert.equal(h.store.getSnapshot().remoteTracks[0].title, 'Fresh Fast Track');
  assert.equal(h.store.getSnapshot().remoteSearchQuery, 'fresh-fast');

  // Now older slow query resolves AFTER fast query -> MUST be ignored!
  resolveSlow({
    items: [makeTrackDto('88', 'Stale Old Track', 'Old', 'Old')],
    total: 1,
    offset: 0,
    limit: 100,
    hasMore: false,
  });
  await slowPromise;
  assert.equal(h.store.getSnapshot().remoteSearchQuery, 'fresh-fast');
  assert.equal(h.store.getSnapshot().remoteTracks.length, 1);
  assert.equal(h.store.getSnapshot().remoteTracks[0].title, 'Fresh Fast Track');

  // Also test Host failure vs empty distinction
  h.setCustomListTracks(async () => {
    throw new Error('HOST_UNREACHABLE_TEST');
  });
  await h.store.searchRemoteLibrary('broken');
  assert.equal(h.store.getSnapshot().remoteLibraryError, 'HOST_UNREACHABLE_TEST');

  h.store.dispose();
});

test('Phase 6.1.3 Cases 10, 11 & 16: Switching Hosts resets search/cache cleanly, Disconnect/Reconnect stays isolated & Local Vietnamese search preserved', async () => {
  const h = createHarness();
  await h.store.initialize();

  // Search and populate cache on Host A
  await h.store.loadRemoteLibrary({ query: '' });
  await h.store.searchRemoteLibrary('Có Thể');
  assert.equal(h.store.getSnapshot().remoteTracks[0].title, 'Có Thể (102112 Version)');

  // Case 10: Switch to Host B -> search query, cached unfiltered list, and tracks must switch cleanly without leaking Host A!
  await h.store.connectToRememberedHost(HOST_B_ID);
  let snap = h.store.getSnapshot();
  assert.equal(snap.clientSnapshot?.activeHost?.hostId, HOST_B_ID);
  assert.equal(snap.remoteSearchQuery, '');
  assert.equal(snap.remoteSearchInput, '');
  assert.equal(snap.remoteTracks.length, 2);
  assert.ok(snap.remoteTracks.every((t) => t.artist === 'HostB Artist'));

  // Case 11: Host disconnection and reconnection cleanly clears old search and restores fresh default collection
  await h.store.searchRemoteLibrary('Midnight');
  assert.equal(h.store.getSnapshot().remoteTracks.length, 1);

  h.pushHostDisconnectFromMain();
  snap = h.store.getSnapshot();
  assert.equal(snap.remoteTracks.length, 0);
  assert.equal(snap.remoteSearchQuery, '');
  assert.equal(snap.remoteSearchInput, '');

  // Reconnect back to Host A -> fresh unfiltered Host A library, zero leftover "Midnight" filter!
  await h.store.connectToRememberedHost(HOST_A_ID);
  snap = h.store.getSnapshot();
  assert.equal(snap.remoteSearchQuery, '');
  assert.equal(snap.remoteTracks.length, 3);
  assert.equal(snap.remoteTracks[0].title, 'Có Thể (102112 Version)');

  // Case 16: Existing Local Vietnamese search normalization behavior preserved 100%
  assert.equal(
    matchesNormalizedVietnameseQuery('Có Thể (102112 Version)', normalizeVietnameseText('co the')),
    true,
  );
  assert.equal(
    matchesNormalizedVietnameseQuery('Có Thể (102112 Version)', normalizeVietnameseText('102112 version')),
    true,
  );
  assert.equal(
    matchesNormalizedVietnameseQuery('Đen Vâu - Lối Nhỏ', normalizeVietnameseText('den vau')),
    true,
  );
  assert.equal(
    matchesNormalizedVietnameseQuery('Bông Hoa Đẹp Nhất', normalizeVietnameseText('khong khop')),
    false,
  );

  h.store.dispose();
});

test('Phase 6.1.3 Real Host + Client Loopback: ConnectStore search -> play -> clear restores exact Host shared library', async () => {
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { openLibraryDatabase } = await import('../src/main/database/connection');
  const { ArtworkRepository } = await import('../src/main/database/artwork-repository');
  const { LibraryRootRepository } = await import('../src/main/database/library-root-repository');
  const { LyricsRepository } = await import('../src/main/database/lyrics-repository');
  const { TrackRepository } = await import('../src/main/database/track-repository');
  const { ArtworkService } = await import('../src/main/services/artwork-service');
  const { ConnectClientService } = await import('../src/main/services/connect/connect-client');
  const { ConnectRepository } = await import('../src/main/services/connect/connect-repository');
  const { ConnectHostService } = await import('../src/main/services/connect/host-service');
  const { ConnectSecretStorage } = await import('../src/main/services/connect/secret-storage');
  const { LyricsService } = await import('../src/main/services/lyrics-service');
  const { normalizeTrackPath } = await import('../src/main/services/path-utils');

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p613-real-'));
  const musicDir = path.join(tmpRoot, 'music');
  const hostDir = path.join(tmpRoot, 'host-ud');
  const clientDir = path.join(tmpRoot, 'client-ud');
  await fs.mkdir(musicDir, { recursive: true });
  await fs.mkdir(hostDir, { recursive: true });
  await fs.mkdir(clientDir, { recursive: true });

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
  let host: InstanceType<typeof ConnectHostService> | null = null;
  let client: InstanceType<typeof ConnectClientService> | null = null;

  try {
    const f1 = path.join(musicDir, '01-co-the.flac');
    const f2 = path.join(musicDir, '02-lan-cuoi.flac');
    await fs.writeFile(f1, Buffer.from('fLaC-stub-1'));
    await fs.writeFile(f2, Buffer.from('fLaC-stub-2'));

    const trackRepo = new TrackRepository(hostConn.db);
    const rootRepo = new LibraryRootRepository(hostConn.db);
    const artworkRepo = new ArtworkRepository(hostConn.db);
    const lyricsRepo = new LyricsRepository(hostConn.db);
    const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

    trackRepo.upsertBatch([
      {
        original_path: f1,
        normalized_path: normalizeTrackPath(f1),
        title: 'Có Thể (102112 Version)',
        artist: 'MCK',
        album: '99%',
        duration_ms: 180_000,
        codec: 'ALAC',
        container: 'M4A',
        sample_rate_hz: 48000,
        bit_depth: 24,
        bitrate_bps: 1_500_000,
        file_size_bytes: 11,
        modified_at_ms: Date.now(),
        status: 'available',
      },
      {
        original_path: f2,
        normalized_path: normalizeTrackPath(f2),
        title: 'Lần Cuối',
        artist: 'Ngọt',
        album: 'Gieo',
        duration_ms: 200_000,
        codec: 'FLAC',
        container: 'FLAC',
        sample_rate_hz: 44100,
        bit_depth: 16,
        bitrate_bps: 1_000_000,
        file_size_bytes: 11,
        modified_at_ms: Date.now(),
        status: 'available',
      },
    ]);

    const hostConnectRepo = new ConnectRepository(hostConn.db);
    hostConnectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, maxActiveClients: 3 });
    host = new ConnectHostService({
      appVersion: '1.0.0-rc.5',
      userDataDir: hostDir,
      connectRepo: hostConnectRepo,
      trackRepo,
      artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
      lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
      secrets: new ConnectSecretStorage({ userDataDir: hostDir }),
      enableMdns: false,
    });
    host.addSharedSource(root.id);
    const hostSnap = await host.start();
    const inv = host.createInvitation({ autoApproveSingleUse: true });

    client = new ConnectClientService({
      connectRepo: new ConnectRepository(clientConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir }),
    });
    const probe = await client.probeHost('127.0.0.1', hostSnap.listeningPort!);
    await client.enrollWithHost({
      address: '127.0.0.1',
      port: hostSnap.listeningPort!,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'Phase613LoopbackClient',
    });

    const qc = new PlaybackQueueController();
    const playbackRef: { trackId: string | null } = { trackId: null };
    const realBridgeApi: Partial<LosslessDesktopApi> = {
      connectGetHostSnapshot: async () => host!.getSnapshot(),
      connectGetClientSnapshot: async () => client!.getSnapshot(),
      connectGetClientDiagnostics: async () => client!.getClientDiagnosticsSnapshot(),
      connectListRemoteTracks: (opts) => client!.listRemoteTracks(opts),
      connectListRemoteAlbums: (opts) => client!.listRemoteAlbums(opts),
      connectListRemoteArtists: (opts) => client!.listRemoteArtists(opts),
    };
    const store = new ConnectStore({
      getApi: () => realBridgeApi as LosslessDesktopApi,
      queueController: qc,
      playbackActions: {
        playQueueEntry: async (e) => {
          playbackRef.trackId = e.trackId;
        },
        getPlaybackState: () =>
          ({
            status: playbackRef.trackId ? 'playing' : 'idle',
            currentTrackId: playbackRef.trackId,
          }) as unknown as PlaybackState,
        pauseSilently: () => {
          playbackRef.trackId = null;
        },
      },
    });

    await store.initialize();
    await store.loadRemoteLibrary({ query: '' });
    assert.equal(store.getSnapshot().remoteTracks.length, 2);

    await store.searchRemoteLibrary('Có Thể');
    assert.equal(store.getSnapshot().remoteTracks.length, 1);
    await store.playRemoteTrack(store.getSnapshot().remoteTracks[0]);
    assert.ok(playbackRef.trackId?.startsWith('remote::'));

    // Clear restores unfiltered 2 tracks without interrupting playback
    await store.clearRemoteSearch();
    assert.equal(store.getSnapshot().remoteTracks.length, 2);
    assert.equal(store.getSnapshot().remoteSearchQuery, '');
    assert.ok(playbackRef.trackId?.startsWith('remote::'));

    store.dispose();
  } finally {
    await client?.disconnect().catch(() => {});
    await host?.stop().catch(() => {});
    clientConn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
