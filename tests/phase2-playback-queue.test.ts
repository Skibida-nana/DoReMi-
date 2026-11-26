import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { ProfileService } from '../src/main/services/profile-service';
import {
  AudioEngine,
  type AudioElementLike,
  type MediaErrorLike,
} from '../src/renderer/src/player/audio-engine';
import {
  PlaybackQueueController,
  shuffleFisherYates,
} from '../src/renderer/src/player/playback-queue';
import type { PlaybackContextDescriptor } from '../src/shared/types/player';
import type { TrackRecord } from '../src/shared/types/track';
import { DEFAULT_PLAYBACK_CONTROLS, normalizePlaybackControls } from '../src/shared/utils/playback-controls';

class QueueFakeAudioElement implements AudioElementLike {
  src = '';
  currentTime = 0;
  duration = 180;
  volume = 1;
  muted = false;
  preload = 'metadata';
  paused = true;
  ended = false;
  error: MediaErrorLike | null = null;
  playCalls = 0;
  loadCalls = 0;
  failTrackIds = new Set<string>();
  private listeners = new Map<string, Set<() => void>>();

  addEventListener(type: string, listener: () => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, listener: () => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener();
    }
  }

  load(): void {
    this.loadCalls += 1;
    this.currentTime = 0;
    this.ended = false;
    this.error = null;
  }

  async play(): Promise<void> {
    this.playCalls += 1;
    for (const badId of this.failTrackIds) {
      if (this.src.includes(badId)) {
        this.error = { code: 4, message: 'DEMUXER_ERROR_COULD_NOT_OPEN' };
        this.emit('error');
        throw new Error('Failed to decode source');
      }
    }
    this.paused = false;
    this.ended = false;
    this.emit('loadedmetadata');
    this.emit('playing');
  }

  pause(): void {
    this.paused = true;
    this.emit('pause');
  }
}

function makeUuidTrack(index: number, status: TrackRecord['status'] = 'available'): TrackRecord {
  const hex = index.toString(16).padStart(12, '0');
  const id = `00000000-0000-4000-8000-${hex}`;
  const now = new Date().toISOString();
  return {
    id,
    original_path: `G:\\Music\\Track_${index}.flac`,
    normalized_path: `g:\\music\\track_${index}.flac`,
    title: `Track ${index}`,
    artist: 'Test Artist',
    album: 'Test Album',
    duration_ms: 180_000,
    codec: 'FLAC',
    container: 'FLAC',
    sample_rate_hz: 48_000,
    bit_depth: 24,
    bitrate_bps: 1_500_000,
    file_size_bytes: 25_000_000,
    modified_at_ms: 1700000000000,
    status,
    added_at: now,
    updated_at: now,
  };
}

function makeTracks(count: number): TrackRecord[] {
  return Array.from({ length: count }, (_, idx) => makeUuidTrack(idx + 1));
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 15));
}

test('Shuffle ON/OFF preserves current track, history, Play Next priority, Add to Queue tail, and exact source context order', () => {
  const controller = new PlaybackQueueController({
    // Deterministic rng returning decreasing values so Fisher-Yates permutes non-trivially
    rng: () => 0.25,
  });

  // Deliberately non-ABC context order
  const context: PlaybackContextDescriptor = {
    contextId: 'pl-custom',
    label: 'Custom Order',
    kind: 'playlist',
    trackIds: ['t-z', 't-a', 't-m', 't-b', 't-k', 't-c'],
  };

  controller.startContext({ context, startTrackId: 't-z' });
  controller.markCurrentPlaybackStarted();

  // Move forward once so t-z goes into History and t-a becomes Current
  const next1 = controller.advanceManualNext();
  assert.equal(next1.entry?.trackId, 't-a');
  controller.markCurrentPlaybackStarted();

  // Add Play Next + Add to Queue manual entries
  const pn = controller.playNext('t-priority');
  const aq = controller.addToQueue('t-tail');
  assert.deepEqual(
    controller.getState().upcoming.map((e) => e.trackId),
    ['t-priority', 't-m', 't-b', 't-k', 't-c', 't-tail'],
  );

  // Enable Shuffle -> current (t-a), history ([t-z]), Play Next (t-priority), Manual tail (t-tail) preserved
  controller.setShuffle(true);
  const shuffledState = controller.getState();
  assert.equal(shuffledState.currentEntry?.trackId, 't-a');
  assert.deepEqual(
    shuffledState.history.map((e) => e.trackId),
    ['t-z'],
  );
  assert.equal(shuffledState.upcoming[0].queueEntryId, pn.queueEntryId);
  assert.equal(shuffledState.upcoming[shuffledState.upcoming.length - 1].queueEntryId, aq.queueEntryId);
  // Shuffled middle must match exact same remaining context items, not t-z or t-a
  const middleIds = shuffledState.upcoming.slice(1, -1).map((e) => e.trackId);
  assert.deepEqual([...middleIds].sort(), ['t-b', 't-c', 't-k', 't-m']);

  // Reading state repeatedly MUST NOT re-shuffle
  assert.deepEqual(
    controller.getState().upcoming.map((e) => e.queueEntryId),
    shuffledState.upcoming.map((e) => e.queueEntryId),
  );

  // Manual Next MUST play exact first item in Upcoming (t-priority)
  const next2 = controller.advanceManualNext();
  assert.equal(next2.entry?.queueEntryId, pn.queueEntryId);

  // Disable Shuffle -> remaining context items restore exact non-ABC order (t-m, t-b, t-k, t-c) without resurrecting t-z/t-a!
  controller.setShuffle(false);
  assert.deepEqual(
    controller.getState().upcoming.map((e) => e.trackId),
    ['t-m', 't-b', 't-k', 't-c', 't-tail'],
  );
});

test('Queue distinguishes Track ID vs Queue Entry ID, supports duplicates, drag-reorder, remove, clearUpcoming, and history timeline', () => {
  const controller = new PlaybackQueueController();
  controller.startContext({
    context: {
      contextId: 'alb-1',
      label: 'Album 1',
      kind: 'album',
      trackIds: ['t1', 't2', 't3', 't4'],
    },
    startTrackId: 't1',
  });
  controller.markCurrentPlaybackStarted();

  // Intentionally add t2 twice via Play Next and Add to Queue
  const dupHead = controller.playNext('t2');
  const dupTail = controller.addToQueue('t2');
  assert.equal(
    controller.getState().upcoming.filter((e) => e.trackId === 't2').length,
    3,
  );

  // Removing specific dupHead keeps original t2 and dupTail intact
  assert.equal(controller.removeUpcomingEntry(dupHead.queueEntryId), true);
  assert.equal(
    controller.getState().upcoming.filter((e) => e.trackId === 't2').length,
    2,
  );

  // Reorder upcoming (drag t4 to index 0)
  const upcomingBefore = controller.getState().upcoming;
  const t4Idx = upcomingBefore.findIndex((e) => e.trackId === 't4');
  assert.equal(controller.reorderUpcoming(t4Idx, 0), true);
  assert.equal(controller.getState().upcoming[0].trackId, 't4');

  // Step forward: t1 -> t4 -> t2 -> t3
  assert.equal(controller.advanceManualNext().entry?.trackId, 't4');
  controller.markCurrentPlaybackStarted();
  assert.equal(controller.advanceManualNext().entry?.trackId, 't2');
  controller.markCurrentPlaybackStarted();

  // Previous steps back along timeline without duplicating: t2 -> t4 -> t1
  const prev1 = controller.advanceManualPrevious();
  assert.equal(prev1?.trackId, 't4');
  assert.equal(controller.getState().upcoming[0].trackId, 't2');
  const prev2 = controller.advanceManualPrevious();
  assert.equal(prev2?.trackId, 't1');
  assert.equal(controller.getState().upcoming[0].trackId, 't4');

  // Next returns along exact timeline: t1 -> t4 -> t2
  assert.equal(controller.advanceManualNext().entry?.trackId, 't4');
  controller.markCurrentPlaybackStarted();
  assert.equal(controller.advanceManualNext().entry?.trackId, 't2');
  controller.markCurrentPlaybackStarted();

  // Remove dupTail then Clear Upcoming under Repeat ALL -> cleared tracks MUST NOT resurrect!
  controller.setRepeatMode('all');
  controller.removeUpcomingEntry(dupTail.queueEntryId);
  controller.clearUpcoming();
  assert.deepEqual(controller.getState().upcoming, []);
  assert.equal(controller.getState().currentEntry?.trackId, 't2');
  assert.ok(controller.getState().history.length >= 2);
  const res = controller.resolveNaturalTrackEnd();
  // Only current surviving entry remains in repeat scope (never brings back t1/t3/t4!)
  assert.equal(res.action, 'play-entry');
  if (res.action === 'play-entry') {
    assert.equal(res.entry.trackId, 't2');
  }
});

test('AudioEngine enforces full 6-cell Auto Next x Repeat policy table and generation-guarded ended events', async () => {
  const tracks = makeTracks(3);
  const fakeAudio = new QueueFakeAudioElement();
  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    verifyTrack: async (id) => ({ trackId: id, exists: true, status: 'available' }),
  });
  engine.setVolume(0.7);
  engine.setQueue(tracks);

  // 1. Auto Next ON + Repeat OFF -> advances 1->2->3 then stops
  engine.setAutoNext(true);
  engine.setRepeatMode('off');
  await engine.play(tracks[0].id);
  const gen1 = engine.getPlaybackState().playbackGeneration;

  // Duplicate ended events in SAME generation must advance ONLY ONCE (1 -> 2, NEVER 1 -> 3!)
  fakeAudio.ended = true;
  fakeAudio.emit('ended');
  fakeAudio.emit('ended');
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[1].id);
  assert.ok(engine.getPlaybackState().playbackGeneration > gen1);

  // Advance 2 -> 3
  fakeAudio.emit('ended');
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[2].id);

  // End of track 3 with Repeat OFF -> stops at ended
  fakeAudio.emit('ended');
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().status, 'ended');
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[2].id);

  // 2. Auto Next OFF + Repeat OFF -> stays stopped, preserves Upcoming & Context
  await engine.play(tracks[0].id);
  engine.setAutoNext(false);
  engine.setRepeatMode('off');
  fakeAudio.emit('ended');
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().status, 'ended');
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[0].id);
  assert.equal(engine.getQueueState().upcoming.length, 2);

  // Turning Auto Next back ON after ended MUST NOT unexpectedly start playback
  engine.setAutoNext(true);
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().status, 'ended');

  // 3. Auto Next OFF + Repeat ALL -> stops after current track, keeps Repeat ALL & Upcoming intact
  await engine.play(tracks[0].id);
  engine.setAutoNext(false);
  engine.setRepeatMode('all');
  fakeAudio.emit('ended');
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().status, 'ended');
  assert.equal(engine.getPlaybackState().repeatMode, 'all');
  assert.equal(engine.getQueueState().upcoming.length, 2);

  // 4. Auto Next OFF + Repeat ONE -> REPLAYS current track cleanly without duplicating queue/history
  await engine.play(tracks[1].id);
  const historyBeforeOne = engine.getQueueState().history.length;
  const playCallsBeforeOne = fakeAudio.playCalls;
  engine.setAutoNext(false);
  engine.setRepeatMode('one');
  for (let loop = 0; loop < 4; loop += 1) {
    fakeAudio.emit('ended');
    await flushMicrotasks();
    assert.equal(engine.getPlaybackState().currentTrackId, tracks[1].id);
    assert.equal(engine.getPlaybackState().status, 'playing');
    assert.equal(engine.getPlaybackState().volume, 0.7);
  }
  assert.equal(fakeAudio.playCalls >= playCallsBeforeOne + 4, true);
  assert.equal(engine.getQueueState().history.length, historyBeforeOne);
  // Manual Next STILL advances out of Repeat ONE!
  await engine.next();
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[2].id);

  // 5. Auto Next ON + Repeat ALL -> loops around end of queue cleanly
  engine.setAutoNext(true);
  engine.setRepeatMode('all');
  fakeAudio.emit('ended');
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[0].id);
  assert.equal(engine.getPlaybackState().status, 'playing');
});

test('AudioEngine skips failing tracks safely under Auto Next ON, stops when all fail, and never loops infinitely in Repeat ONE', async () => {
  const tracks = makeTracks(3);
  const fakeAudio = new QueueFakeAudioElement();
  fakeAudio.failTrackIds.add(tracks[1].id);

  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    verifyTrack: async (id) => ({ trackId: id, exists: true, status: 'available' }),
  });
  engine.setQueue(tracks);
  engine.setAutoNext(true);
  engine.setRepeatMode('off');

  await engine.play(tracks[0].id);
  fakeAudio.emit('ended');
  await flushMicrotasks();

  // Skipped failing track[1] and landed on playable track[2]
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[2].id);
  assert.equal(engine.getPlaybackState().status, 'playing');

  // Track[1] was marked 'error' in history, NEVER 'completed'
  const errHist = engine.getQueueState().history.find((h) => h.trackId === tracks[1].id);
  assert.equal(errHist?.historyStatus, 'error');

  // Repeat ONE on failing track MUST stop in error state (no infinite retry)
  fakeAudio.failTrackIds.add(tracks[2].id);
  engine.setRepeatMode('one');
  const callsBefore = fakeAudio.playCalls;
  await engine.play(tracks[2].id);
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().status, 'error');
  assert.equal(fakeAudio.playCalls, callsBefore + 1);

  // Repeat ALL when ALL tracks fail MUST terminate boundedly in error state
  fakeAudio.failTrackIds.add(tracks[0].id);
  engine.setRepeatMode('all');
  engine.setAutoNext(true);
  await engine.play(tracks[0].id);
  // Simulate ended -> auto advance tries track[1], track[2], track[0] and halts cleanly
  fakeAudio.emit('ended');
  await flushMicrotasks();
  assert.equal(engine.getPlaybackState().status, 'error');
});

test('Shuffle performance scales linearly (100 / 1,000 / 10,000 tracks) without blocking or duplication', () => {
  for (const count of [100, 1_000, 10_000]) {
    const ids = Array.from({ length: count }, (_, i) => `track-${i}`);
    const t0 = performance.now();
    const shuffled = shuffleFisherYates(ids);
    const elapsedMs = performance.now() - t0;

    assert.equal(shuffled.length, count);
    assert.equal(new Set(shuffled).size, count);
    assert.ok(elapsedMs < 200, `Shuffle of ${count} items took too long: ${elapsedMs.toFixed(2)}ms`);

    const controller = new PlaybackQueueController();
    const cStart = performance.now();
    controller.startContext({
      context: { contextId: `ctx-${count}`, label: 'Bench', kind: 'library', trackIds: ids },
      startTrackId: 'track-0',
      shuffle: true,
    });
    controller.setShuffle(false);
    const cElapsed = performance.now() - cStart;
    assert.equal(controller.getState().upcoming.length, count - 1);
    assert.ok(cElapsed < 250, `Controller start+unshuffle for ${count} items took ${cElapsed.toFixed(2)}ms`);
  }
});

test('ProfileService persists playbackControls (shuffle, repeat, autoNext) across SQLite restarts with safe fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-p2-prefs-'));
  const dbPath = path.join(dir, 'library.db');

  try {
    const conn1 = openLibraryDatabase(dbPath);
    try {
      const svc1 = new ProfileService({ db: conn1.db, userDataDir: dir });
      const initial = svc1.getPreferences();
      assert.deepEqual(initial.playbackControls, DEFAULT_PLAYBACK_CONTROLS);

      svc1.updatePreferences({
        playbackControls: {
          shuffleEnabled: true,
          repeatMode: 'one',
          autoNextEnabled: false,
        },
      });
    } finally {
      conn1.close();
    }

    const conn2 = openLibraryDatabase(dbPath);
    try {
      const svc2 = new ProfileService({ db: conn2.db, userDataDir: dir });
      const restored = svc2.getPreferences();
      assert.deepEqual(restored.playbackControls, {
        shuffleEnabled: true,
        repeatMode: 'one',
        autoNextEnabled: false,
      });
    } finally {
      conn2.close();
    }

    // Invalid value normalization check
    const sanitized = normalizePlaybackControls({
      shuffleEnabled: 'yes' as unknown as boolean,
      repeatMode: 'invalid-mode' as unknown as 'off',
      autoNextEnabled: undefined,
    });
    assert.deepEqual(sanitized, DEFAULT_PLAYBACK_CONTROLS);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Edge cases: seek near end does not skip track, audible scrubbing preserves volume, multiple Play Next stacks LIFO, jumpToHistoryEntry preserves future queue, history capped at 500', async () => {
  const tracks = makeTracks(4);
  const fakeAudio = new QueueFakeAudioElement();
  let resolveVerify2!: (v: { trackId: string; exists: boolean; status: 'available' }) => void;

  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    verifyTrack: (id) => {
      if (id === tracks[1].id) {
        return new Promise((resolve) => {
          resolveVerify2 = resolve;
        });
      }
      return Promise.resolve({ trackId: id, exists: true, status: 'available' });
    },
  });
  engine.setQueue(tracks);
  engine.setVolume(0.8);
  await engine.play(tracks[0].id);

  // Seek near end of track must NOT prematurely mute or advance queue
  engine.seek(179.5);
  assert.equal(fakeAudio.currentTime, 179.5);
  assert.equal(fakeAudio.muted, false);
  assert.equal(fakeAudio.volume, 0.8);
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[0].id);

  // Concurrent rapid switch: start track[1] (slow verify) then immediately switch to track[2]
  const slowPlay = engine.play(tracks[1].id);
  const fastPlay = engine.play(tracks[2].id);
  resolveVerify2({ trackId: tracks[1].id, exists: true, status: 'available' });
  await Promise.all([slowPlay, fastPlay]);
  assert.equal(engine.getPlaybackState().currentTrackId, tracks[2].id);
  assert.equal(engine.getPlaybackState().status, 'playing');

  // Multiple Play Next & jumpToHistoryEntry fidelity
  const q = new PlaybackQueueController();
  q.startContext({
    context: { contextId: 'c1', label: 'C1', kind: 'playlist', trackIds: ['A', 'B', 'C', 'D'] },
    startTrackId: 'A',
  });
  q.markCurrentPlaybackStarted();
  q.advanceManualNext(); // B
  q.markCurrentPlaybackStarted();
  q.advanceManualNext(); // C
  q.markCurrentPlaybackStarted();

  q.playNext('X');
  q.playNext('Y');
  assert.deepEqual(q.getState().upcoming.slice(0, 3).map((e) => e.trackId), ['Y', 'X', 'D']);

  const firstHistId = q.getState().history[0].queueEntryId; // A
  q.jumpToHistoryEntry(firstHistId);
  assert.equal(q.getState().currentEntry?.trackId, 'A');
  assert.deepEqual(
    q.getState().upcoming.map((e) => e.trackId),
    ['B', 'C', 'Y', 'X', 'D'],
  );

  // History bounded at 500 entries
  const largeIds = Array.from({ length: 620 }, (_, i) => `h-${i}`);
  q.startContext({
    context: { contextId: 'huge', label: 'Huge', kind: 'library', trackIds: largeIds },
    startTrackId: 'h-0',
    preserveHistory: false,
  });
  q.markCurrentPlaybackStarted();
  for (let i = 0; i < 610; i += 1) {
    q.advanceManualNext();
    q.markCurrentPlaybackStarted();
  }
  assert.equal(q.getState().history.length <= 500, true);
});

test('Phase 3K: Repeat modes once/twice 10-cell matrix, remainingReplays invariant across pause/seek, manual Next reset, SQLite persistence & deleted-while-playing', async () => {
  // 1. Repeat ONCE (+1 replay = 2 total plays), Auto Next ON -> replays Track 1 once, then moves to Track 2 with fresh remainingReplays=1
  const q1 = new PlaybackQueueController({
    initialControls: { shuffleEnabled: false, repeatMode: 'once', autoNextEnabled: true },
  });
  q1.startContext({
    context: { contextId: 'p3k', label: 'P3K', kind: 'playlist', trackIds: ['T1', 'T2', 'T3'] },
    startTrackId: 'T1',
  });
  assert.equal(q1.getState().repeatRuntime.remainingReplays, 1);
  q1.markCurrentPlaybackStarted();

  const end1 = q1.resolveNaturalTrackEnd();
  assert.equal(end1.action, 'replay');
  if (end1.action === 'replay') assert.equal(end1.entry.trackId, 'T1');
  assert.equal(q1.getState().repeatRuntime.remainingReplays, 0);
  q1.markCurrentPlaybackStarted();

  const end2 = q1.resolveNaturalTrackEnd();
  assert.equal(end2.action, 'play-entry');
  if (end2.action === 'play-entry') assert.equal(end2.entry.trackId, 'T2');
  // Track T2 starts with fresh remainingReplays = 1 under 'once' mode
  assert.equal(q1.getState().repeatRuntime.remainingReplays, 1);

  // 2. Repeat ONCE + Auto Next OFF -> replays Track 1 once (2 total plays), then STOPS
  const q2 = new PlaybackQueueController({
    initialControls: { shuffleEnabled: false, repeatMode: 'once', autoNextEnabled: false },
  });
  q2.startContext({
    context: { contextId: 'p3k2', label: 'P3K2', kind: 'playlist', trackIds: ['T1', 'T2'] },
    startTrackId: 'T1',
  });
  assert.equal(q2.resolveNaturalTrackEnd().action, 'replay');
  assert.equal(q2.resolveNaturalTrackEnd().action, 'stop');
  assert.equal(q2.getState().currentEntry?.trackId, 'T1');

  // 3. Repeat TWICE (+2 replays = 3 total plays), Auto Next ON vs OFF
  const q3 = new PlaybackQueueController({
    initialControls: { shuffleEnabled: false, repeatMode: 'twice', autoNextEnabled: false },
  });
  q3.startContext({
    context: { contextId: 'p3k3', label: 'P3K3', kind: 'playlist', trackIds: ['T1', 'T2'] },
    startTrackId: 'T1',
  });
  assert.equal(q3.getState().repeatRuntime.remainingReplays, 2);
  assert.equal(q3.resolveNaturalTrackEnd().action, 'replay');
  assert.equal(q3.getState().repeatRuntime.remainingReplays, 1);
  assert.equal(q3.resolveNaturalTrackEnd().action, 'replay');
  assert.equal(q3.getState().repeatRuntime.remainingReplays, 0);
  assert.equal(q3.resolveNaturalTrackEnd().action, 'stop');

  // Repeat TWICE + Auto Next ON advances after 3rd play
  q3.setAutoNext(true);
  const afterTwiceEnd = q3.resolveNaturalTrackEnd();
  assert.equal(afterTwiceEnd.action, 'play-entry');
  if (afterTwiceEnd.action === 'play-entry') assert.equal(afterTwiceEnd.entry.trackId, 'T2');

  // 4. Repeat ALL + Auto Next OFF -> MUST stop after current track finishes
  const q4 = new PlaybackQueueController({
    initialControls: { shuffleEnabled: false, repeatMode: 'all', autoNextEnabled: false },
  });
  q4.startContext({
    context: { contextId: 'p3k4', label: 'P3K4', kind: 'playlist', trackIds: ['T1', 'T2'] },
    startTrackId: 'T1',
  });
  assert.equal(q4.resolveNaturalTrackEnd().action, 'stop');

  // 5. Mid-song repeat mode switch + Manual Next reset
  q4.setRepeatMode('twice');
  assert.equal(q4.getState().repeatRuntime.remainingReplays, 2);
  assert.equal(q4.resolveNaturalTrackEnd().action, 'replay'); // remaining -> 1
  assert.equal(q4.getState().repeatRuntime.remainingReplays, 1);
  const manualNextRes = q4.advanceManualNext();
  assert.equal(manualNextRes.status, 'ok');
  // Advancing manually resets remainingReplays to 2 for T2!
  assert.equal(q4.getState().repeatRuntime.remainingReplays, 2);

  // 6. Pause & Seek preserve remainingReplays in full AudioEngine
  const engineTracks = makeTracks(2);
  const fakeAudio = new QueueFakeAudioElement();
  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    verifyTrack: (id) => Promise.resolve({ trackId: id, exists: true, status: 'available' }),
  });
  engine.setQueue(engineTracks);
  engine.setRepeatMode('twice');
  await engine.play(engineTracks[0].id);
  assert.equal(engine.getPlaybackState().remainingReplays, 2);
  fakeAudio.emit('ended');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(engine.getPlaybackState().remainingReplays, 1);
  engine.pause();
  await engine.resume();
  engine.seek(0);
  // Pause/Resume/Seek to 0 MUST NOT reset remainingReplays!
  assert.equal(engine.getPlaybackState().remainingReplays, 1);

  // 7. Track removed from library while actively playing under repeat 'one' or 'twice':
  // keeps current playback alive until natural end, prevents further replay, cleans upcoming!
  engine.setRepeatMode('one');
  assert.equal(engine.getPlaybackState().remainingReplays, null);
  engine.syncTrackCatalog([engineTracks[1]]); // track 0 removed from library!
  assert.equal(engine.getPlaybackState().currentTrackId, engineTracks[0].id);
  assert.equal(engine.getPlaybackState().remainingReplays, 0);
  fakeAudio.emit('ended');
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(engine.getPlaybackState().currentTrackId, engineTracks[1].id);

  // 8. SQLite persistence supports 'once' and 'twice'
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-p3k-prefs-'));
  const dbPath = path.join(dir, 'library.db');
  try {
    const conn1 = openLibraryDatabase(dbPath);
    try {
      const svc1 = new ProfileService({ db: conn1.db, userDataDir: dir });
      svc1.updatePreferences({
        playbackControls: { shuffleEnabled: true, repeatMode: 'twice', autoNextEnabled: true },
      });
    } finally {
      conn1.close();
    }
    const conn2 = openLibraryDatabase(dbPath);
    try {
      const svc2 = new ProfileService({ db: conn2.db, userDataDir: dir });
      assert.equal(svc2.getPreferences().playbackControls?.repeatMode, 'twice');
    } finally {
      conn2.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
