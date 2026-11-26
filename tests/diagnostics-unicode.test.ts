import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { TrackRepository } from '../src/main/database/track-repository';
import { DiagnosticsService } from '../src/main/services/diagnostics-service';
import { normalizeTrackPath } from '../src/main/services/path-utils';
import {
  AudioEngine,
  type AudioElementLike,
  type MediaErrorLike,
} from '../src/renderer/src/player/audio-engine';
import {
  buildPlaybackErrorDetails,
  formatPlaybackDiagnosticReport,
} from '../src/renderer/src/player/playback-error';
import type { DiagnosticRecordInput } from '../src/shared/types/stage6';
import type { TrackRecord } from '../src/shared/types/track';
import { decodeLyricsBuffer } from '../src/shared/utils/lyrics-encoding';

class MockAudioElement implements AudioElementLike {
  src = '';
  currentTime = 0;
  duration = 210;
  volume = 1;
  muted = false;
  preload = 'metadata';
  paused = true;
  ended = false;
  error: MediaErrorLike | null = null;
  playFailure: Error | null = null;
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
    this.currentTime = 0;
    this.ended = false;
  }

  async play(): Promise<void> {
    if (this.playFailure) {
      this.emit('error');
      throw this.playFailure;
    }
    this.paused = false;
    this.emit('loadedmetadata');
    this.emit('playing');
  }

  pause(): void {
    this.paused = true;
    this.emit('pause');
  }
}

function makeTrack(overrides: Partial<TrackRecord> & { id: string; title: string }): TrackRecord {
  const now = new Date().toISOString();
  return {
    original_path: `G:\\Nhạc\\${overrides.title}.flac`,
    normalized_path: `g:\\nhạc\\${overrides.title.toLowerCase()}.flac`,
    artist: 'Test Artist',
    album: 'Test Album',
    duration_ms: 210000,
    codec: 'FLAC',
    container: 'FLAC',
    sample_rate_hz: 96000,
    bit_depth: 16,
    bitrate_bps: 1200000,
    file_size_bytes: 40000000,
    modified_at_ms: 1700000000000,
    status: 'available',
    added_at: now,
    updated_at: now,
    ...overrides,
  };
}

test('buildPlaybackErrorDetails distinguishes missing files, demuxer container errors, ALAC, and decode failures', () => {
  const flacTrack = makeTrack({ id: '11111111-1111-4111-8111-111111111111', title: 'Careless Whisper' });
  const alacTrack = makeTrack({
    id: '22222222-2222-4222-8222-222222222222',
    title: 'Tầng Thượng 102',
    original_path: 'G:\\Nhạc\\01.m4a',
    codec: 'ALAC',
    container: 'M4A',
  });

  const demuxerErr = buildPlaybackErrorDetails({
    attemptId: 'pb-1',
    stage: 'runtime-media',
    track: flacTrack,
    mediaError: {
      code: 4,
      message: 'PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed',
    },
  });
  assert.equal(demuxerErr.code, 'ERR_CONTAINER_CORRUPT_HEADER');
  assert.equal(demuxerErr.isMissingFile, false);
  assert.match(demuxerErr.technicalDetail, /DEMUXER_ERROR_COULD_NOT_OPEN/);

  const missingErr = buildPlaybackErrorDetails({
    attemptId: 'pb-2',
    stage: 'file-verify',
    track: flacTrack,
    isMissingFile: true,
  });
  assert.equal(missingErr.code, 'ERR_FILE_MISSING');
  assert.equal(missingErr.isMissingFile, true);

  const alacErr = buildPlaybackErrorDetails({
    attemptId: 'pb-3',
    stage: 'audio-decode',
    track: alacTrack,
    mediaError: { code: 3, message: 'Audio decode error' },
  });
  assert.equal(alacErr.code, 'ERR_ALAC_DECODE');

  const report = formatPlaybackDiagnosticReport(demuxerErr, [
    {
      timestamp: '2026-11-25T00:00:00.000Z',
      level: 'error',
      scope: 'audio-engine',
      code: demuxerErr.code,
      attemptId: 'pb-1',
      message: demuxerErr.summary,
    },
  ]);
  assert.match(report, /ERR_CONTAINER_CORRUPT_HEADER/);
  assert.match(report, /Careless Whisper/);
});

test('AudioEngine recovers cleanly after playback failure and ignores stale events during async verify switch', async () => {
  const mockAudio = new MockAudioElement();
  const diagnostics: DiagnosticRecordInput[] = [];
  const badTrack = makeTrack({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', title: 'Bad Header FLAC' });
  const goodTrack = makeTrack({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', title: 'Valid Track' });

  let resolveVerifyGood!: (v: { trackId: string; exists: boolean; status: 'available' }) => void;

  const engine = new AudioEngine({
    createAudioElement: () => mockAudio,
    verifyTrack: (id) => {
      if (id === badTrack.id) {
        return Promise.resolve({ trackId: id, exists: true, status: 'available' });
      }
      return new Promise((resolve) => {
        resolveVerifyGood = resolve;
      });
    },
    onDiagnostic: (entry) => diagnostics.push(entry),
  });

  engine.setQueue([badTrack, goodTrack]);

  // 1. Fail on badTrack with Chromium DEMUXER_ERROR
  mockAudio.error = {
    code: 4,
    message: 'PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN: FFmpegDemuxer: open context failed',
  };
  mockAudio.playFailure = Object.assign(new Error('Failed to load because no supported source was found.'), {
    name: 'NotSupportedError',
  });
  await engine.play(badTrack.id);

  const errState = engine.getPlaybackState();
  assert.equal(errState.status, 'error');
  assert.equal(errState.playbackError?.code, 'ERR_CONTAINER_CORRUPT_HEADER');
  assert.equal(diagnostics.length, 1);

  // 2. While switching to goodTrack (before verifyTrack resolves), stale audio events must be ignored
  mockAudio.error = null;
  mockAudio.playFailure = null;
  const goodPlayPromise = engine.play(goodTrack.id);
  mockAudio.emit('ended');
  mockAudio.error = { code: 2 };
  mockAudio.emit('error');
  assert.equal(engine.getPlaybackState().currentTrackId, goodTrack.id);
  assert.equal(engine.getPlaybackState().status, 'loading');

  mockAudio.error = null;
  resolveVerifyGood({ trackId: goodTrack.id, exists: true, status: 'available' });
  await goodPlayPromise;

  const recovered = engine.getPlaybackState();
  assert.equal(recovered.status, 'playing');
  assert.equal(recovered.playbackError, null);
  assert.equal(recovered.errorMessage, null);
  assert.equal(recovered.volume, 0.85);
});

test('DiagnosticsService writes bounded session-linked JSONL logs with rotation', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-diag-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  const diag = new DiagnosticsService({ userDataDir: dir, sessionId: 'sess-test-1' });
  const entry = diag.record({
    level: 'error',
    scope: 'audio-engine',
    code: 'ERR_CONTAINER_CORRUPT_HEADER',
    stage: 'runtime-media',
    attemptId: 'pb-1',
    message: 'Không mở được header FLAC — Hiệu Ứng Trốn Chạy',
    detail: 'DEMUXER_ERROR',
  });
  assert.equal(entry.sessionId, 'sess-test-1');
  assert.equal(diag.getRecentEntries(10).length, 1);

  await diag.flush();
  const content = await fs.readFile(diag.getLogFilePath(), 'utf8');
  assert.match(content, /Hiệu Ứng Trốn Chạy/);
  assert.match(content, /sess-test-1/);
});

test('Unicode / Vietnamese / CJK metadata, paths, lyrics, and SQLite storage preserve exact NFC strings', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-unicode-'));
  const db = openLibraryDatabase(path.join(dir, 'library.db'));
  t.after(async () => {
    db.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const samples = [
    { artist: 'Cá Hồi Hoang', title: 'Hiệu Ứng Trốn Chạy', album: '102112' },
    { artist: 'Vũ.', title: 'Bước Qua Mùa Cô Đơn', album: 'Một Vạn Năm' },
    { artist: 'Sài Gòn', title: 'Sài Gòn Hôm Nay Mưa', album: 'Mưa' },
    { artist: 'Hà Anh Tuấn', title: 'Những Gì Ta Không Nói', album: 'Live' },
    { artist: 'Đen', title: 'Đi Về Nhà', album: 'Đĩa Đơn' },
    { artist: 'Vũ Cát Tường', title: 'Vết Mưa', album: 'Giải Mã' },
    { artist: '8082 Audio', title: '黑神话：悟空', album: 'Black Myth: Wukong Soundtrack Selection' },
  ];

  const repo = new TrackRepository(db.db);

  repo.upsertBatch(
    samples.map((s, idx) => ({
      original_path: `G:\\Nhạc\\${s.artist}\\${idx + 1}. ${s.title}.flac`,
      normalized_path: normalizeTrackPath(`G:\\Nhạc\\${s.artist}\\${idx + 1}. ${s.title.normalize('NFD')}.flac`),
      title: s.title,
      artist: s.artist,
      album: s.album,
      duration_ms: 180000,
      codec: 'FLAC',
      container: 'FLAC',
      sample_rate_hz: 48000,
      bit_depth: 24,
      bitrate_bps: 1500000,
      file_size_bytes: 12345678,
      modified_at_ms: 1700000000000,
      status: 'available',
    })),
  );

  const stored = repo.findAll();
  assert.equal(stored.length, samples.length);
  for (const s of samples) {
    const match = stored.find((row) => row.title === s.title);
    assert.ok(match, `Missing stored track for ${s.title}`);
    assert.equal(match.artist, s.artist);
    assert.equal(match.album, s.album);
    assert.equal(match.title.includes('\uFFFD'), false);
    assert.equal(
      normalizeTrackPath(`G:\\Nhạc\\${s.artist}\\1. ${s.title.normalize('NFD')}.flac`),
      normalizeTrackPath(`G:\\Nhạc\\${s.artist}\\1. ${s.title.normalize('NFC')}.flac`),
    );
  }

  const lrc = '[00:12.00]Hiệu Ứng Trốn Chạy — Cá Hồi Hoang\n[00:18.50]黑神话：悟空';
  const decoded = decodeLyricsBuffer(Buffer.from(`\uFEFF${lrc}`, 'utf8'));
  assert.equal(decoded.detectedEncoding, 'utf-8');
  assert.equal(decoded.hadReplacementChars, false);
  assert.equal(decoded.text, lrc);
});
