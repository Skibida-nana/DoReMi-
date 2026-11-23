import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AudioEngine,
  type AudioElementLike,
  type MediaErrorLike,
} from '../src/renderer/src/player/audio-engine';
import type { TrackRecord } from '../src/shared/types/track';

class FakeAudioElement implements AudioElementLike {
  src = '';
  currentTime = 0;
  duration = 180;
  volume = 1;
  muted = false;
  preload = 'metadata';
  paused = true;
  ended = false;
  error: MediaErrorLike | null = null;
  loadCalls = 0;

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

function makeTrack(id: string, title: string, status: TrackRecord['status'] = 'available'): TrackRecord {
  const now = new Date().toISOString();
  return {
    id,
    original_path: `D:\\Music\\${title}.flac`,
    normalized_path: `d:\\music\\${title.toLowerCase()}.flac`,
    title,
    artist: 'Test Artist',
    album: 'Test Album',
    duration_ms: 180000,
    codec: 'FLAC',
    container: 'FLAC',
    sample_rate_hz: 44100,
    bit_depth: 16,
    bitrate_bps: 900000,
    file_size_bytes: 20000000,
    modified_at_ms: 1700000000000,
    status,
    added_at: now,
    updated_at: now,
  };
}

test('AudioEngine manages play, pause, resume, seek without reloading src, volume, and next/prev', async () => {
  const fakeAudio = new FakeAudioElement();
  const track1 = makeTrack('11111111-1111-4111-8111-111111111111', 'Track One');
  const trackMissing = makeTrack('22222222-2222-4222-8222-222222222222', 'Missing Track', 'missing');
  const track3 = makeTrack('33333333-3333-4333-8333-333333333333', 'Track Three');

  const engine = new AudioEngine({
    createAudioElement: () => fakeAudio,
    verifyTrack: async (id) => ({
      trackId: id,
      exists: id !== trackMissing.id,
      status: id === trackMissing.id ? 'missing' : 'available',
    }),
  });

  engine.setQueue([track1, trackMissing, track3]);
  assert.equal(engine.getPlaybackState().status, 'idle');

  // Play track 1
  await engine.play(track1.id);
  assert.equal(engine.getPlaybackState().status, 'playing');
  assert.equal(engine.getPlaybackState().currentTrackId, track1.id);
  assert.equal(fakeAudio.loadCalls, 1);

  // Seek without reloading src
  engine.seek(65);
  assert.equal(fakeAudio.currentTime, 65);
  assert.equal(engine.getPlaybackState().currentTimeSeconds, 65);
  assert.equal(fakeAudio.loadCalls, 1, 'Seeking must not reload audio src');

  // Pause & Resume
  engine.pause();
  assert.equal(engine.getPlaybackState().status, 'paused');
  await engine.resume();
  assert.equal(engine.getPlaybackState().status, 'playing');

  // Volume clamping
  engine.setVolume(0.4);
  assert.equal(engine.getPlaybackState().volume, 0.4);
  engine.setVolume(1.5);
  assert.equal(engine.getPlaybackState().volume, 1);

  // Next skips missing track2 and plays track3
  await engine.next();
  assert.equal(engine.getPlaybackState().currentTrackId, track3.id);
  assert.equal(engine.getPlaybackState().status, 'playing');

  // Ended event updates playback status accurately
  fakeAudio.ended = true;
  fakeAudio.emit('ended');
  assert.equal(engine.getPlaybackState().status, 'ended');

  // Media error transitions cleanly to error state with message
  fakeAudio.error = { code: 4 };
  fakeAudio.emit('error');
  assert.equal(engine.getPlaybackState().status, 'error');
  assert.ok(engine.getPlaybackState().errorMessage);
});
