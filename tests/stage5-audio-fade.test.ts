import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioEngine,
  type AudioElementLike,
  type MediaErrorLike,
} from '../src/renderer/src/player/audio-engine';
import type { ListeningSessionInput } from '../src/shared/types/stage5';
import type { TrackRecord } from '../src/shared/types/track';

class FadeFakeAudioElement implements AudioElementLike {
  src = '';
  currentTime = 0;
  duration = 200;
  volume = 1;
  muted = false;
  preload = 'metadata';
  paused = true;
  ended = false;
  error: MediaErrorLike | null = null;
  volumeHistory: number[] = [];

  private listeners = new Map<string, Set<() => void>>();

  setVolumeObserved(v: number): void {
    this.volume = v;
    this.volumeHistory.push(Number(v.toFixed(3)));
  }

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
    this.currentTime = 0;
    this.ended = false;
    this.error = null;
  }

  async play(): Promise<void> {
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

function makeTrack(id: string, title: string): TrackRecord {
  const now = new Date().toISOString();
  return {
    id,
    original_path: `D:\\Lossless\\${title}.flac`,
    normalized_path: `d:\\lossless\\${title.toLowerCase()}.flac`,
    title,
    artist: 'Audiophile Artist',
    album: 'Studio Master',
    duration_ms: 200_000,
    codec: 'FLAC',
    container: 'FLAC',
    sample_rate_hz: 96_000,
    bit_depth: 24,
    bitrate_bps: 3_100_000,
    file_size_bytes: 55_000_000,
    modified_at_ms: 1700000000000,
    status: 'available',
    added_at: now,
    updated_at: now,
  };
}

test('AudioEngine performs real Fade Out/In transitions without altering saved user volume', async () => {
  const fakeAudio = new FadeFakeAudioElement();
  const trackA = makeTrack('aaaa1111-1111-4111-8111-111111111111', 'Alpha');
  const trackB = makeTrack('bbbb2222-2222-4222-8222-222222222222', 'Beta');

  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    verifyTrack: async (id) => ({ trackId: id, exists: true, status: 'available' }),
    fadeStepMs: 10,
  });

  engine.setQueue([trackA, trackB]);
  engine.setVolume(0.75);
  engine.setTransitionConfig({ enabled: true, durationSec: 0.5 });

  await engine.play(trackA.id);
  assert.equal(engine.getPlaybackState().volume, 0.75);

  // Switch track while playing -> triggers Fade Out then Fade In
  const nextPromise = engine.next();
  await nextPromise;

  // Wait for fade-in ramp (0.5s) to finish
  await new Promise((r) => setTimeout(r, 620));

  assert.equal(engine.getPlaybackState().currentTrackId, trackB.id);
  assert.equal(engine.getPlaybackState().volume, 0.75);
  assert.ok(Math.abs(fakeAudio.volume - 0.75) < 0.02, `Expected final audio.volume ~0.75, got ${fakeAudio.volume}`);
});

test('AudioEngine cancels stale fade on rapid Next and restores volume on pause', async () => {
  const fakeAudio = new FadeFakeAudioElement();
  const t1 = makeTrack('1111aaaa-1111-4111-8111-111111111111', 'One');
  const t2 = makeTrack('2222bbbb-2222-4222-8222-222222222222', 'Two');
  const t3 = makeTrack('3333cccc-3333-4333-8333-333333333333', 'Three');

  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    verifyTrack: async (id) => ({ trackId: id, exists: true, status: 'available' }),
    fadeStepMs: 10,
  });

  engine.setQueue([t1, t2, t3]);
  engine.setVolume(0.6);
  engine.setTransitionConfig({ enabled: true, durationSec: 0.5 });

  await engine.play(t1.id);
  const p1 = engine.play(t2.id);
  const p2 = engine.play(t3.id);
  await Promise.all([p1, p2]);

  // Pause mid-fade -> must immediately restore hardware volume so next resume is never stuck at 0
  engine.pause();
  assert.equal(engine.getPlaybackState().volume, 0.6);
  assert.equal(fakeAudio.volume, 0.6);
});

test('AudioEngine checkpoints true active listening time excluding paused time', async () => {
  const fakeAudio = new FadeFakeAudioElement();
  const track = makeTrack('9999aaaa-1111-4111-8111-111111111111', 'Session Track');
  let clockMs = 1_700_000_000_000;
  const checkpoints: ListeningSessionInput[] = [];

  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    verifyTrack: async (id) => ({ trackId: id, exists: true, status: 'available' }),
    nowMs: () => clockMs,
    onSessionCheckpoint: (session) => checkpoints.push(session),
  });

  engine.setQueue([track]);
  await engine.play(track.id);

  // Listen actively for 40s
  clockMs += 40_000;
  engine.pause();

  // Remain paused for 10 minutes (must NOT count toward listenedMs)
  clockMs += 600_000;
  await engine.resume();

  // Listen another 15s and stop
  clockMs += 15_000;
  engine.pause();

  assert.ok(checkpoints.length >= 2);
  const last = checkpoints[checkpoints.length - 1];
  assert.equal(last.trackId, track.id);
  assert.equal(last.listenedMs, 55_000);
});
