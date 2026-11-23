import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { openLibraryDatabase } from '../src/main/database/connection';
import { TrackRepository } from '../src/main/database/track-repository';
import {
  parseByteRangeHeader,
  resolveTrackMediaResponse,
} from '../src/main/services/audio-stream-handler';
import {
  buildTrackMediaUrl,
  parseTrackIdFromMediaUrl,
} from '../src/shared/contracts/media-protocol';
import { createWavBuffer, writeFixtureFile } from './helpers/audio-fixtures';

test('parseTrackIdFromMediaUrl rejects path traversal, arbitrary file paths, and non-UUIDs', () => {
  const validId = '550e8400-e29b-41d4-a716-446655440000';
  assert.equal(parseTrackIdFromMediaUrl(buildTrackMediaUrl(validId)), validId);

  assert.equal(parseTrackIdFromMediaUrl('lossless-media://track/../../Windows/win.ini'), null);
  assert.equal(parseTrackIdFromMediaUrl('lossless-media://track/C:/Music/song.flac'), null);
  assert.equal(parseTrackIdFromMediaUrl(`lossless-media://track/${validId}%2f..`), null);
  assert.equal(parseTrackIdFromMediaUrl(`lossless-media://track/${validId}?raw=1`), null);
  assert.equal(parseTrackIdFromMediaUrl(`lossless-media://other/${validId}`), null);
  assert.equal(parseTrackIdFromMediaUrl(`file:///C:/Music/song.flac`), null);
});

test('parseByteRangeHeader parses full, partial, open-ended, and invalid ranges accurately', () => {
  assert.deepEqual(parseByteRangeHeader(null, 1000), {
    ok: true,
    isPartial: false,
    start: 0,
    end: 999,
  });

  assert.deepEqual(parseByteRangeHeader('bytes=100-199', 1000), {
    ok: true,
    isPartial: true,
    start: 100,
    end: 199,
  });

  assert.deepEqual(parseByteRangeHeader('bytes=500-', 1000), {
    ok: true,
    isPartial: true,
    start: 500,
    end: 999,
  });

  assert.deepEqual(parseByteRangeHeader('bytes=1500-2000', 1000), {
    ok: false,
    status: 416,
  });
});

test('resolveTrackMediaResponse streams 206 Partial Content for DB tracks and blocks unauthorized URLs', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'lossless-proto-'));
  const dbPath = path.join(workspace, 'library.db');
  const wavBytes = createWavBuffer({ sampleRate: 8000, bitsPerSample: 16, durationSeconds: 1 });
  const wavPath = writeFixtureFile(path.join(workspace, 'test.wav'), wavBytes);

  const conn = openLibraryDatabase(dbPath);
  try {
    const trackRepo = new TrackRepository(conn.db);
    trackRepo.upsertBatch([
      {
        original_path: wavPath,
        normalized_path: wavPath,
        title: 'Test WAV',
        artist: 'Unknown Artist',
        album: null,
        duration_ms: 1000,
        codec: 'PCM',
        container: 'WAVE',
        sample_rate_hz: 8000,
        bit_depth: 16,
        bitrate_bps: null,
        file_size_bytes: wavBytes.length,
        modified_at_ms: Date.now(),
        status: 'available',
      },
    ]);

    const track = trackRepo.findAll()[0];
    const mediaUrl = buildTrackMediaUrl(track.id);

    // 1. Path traversal attempt -> 403 Forbidden
    const traversalRes = await resolveTrackMediaResponse(
      new Request('lossless-media://track/../../etc/passwd'),
      { trackRepo },
    );
    assert.equal(traversalRes.status, 403);

    // 2. Unregistered valid UUID -> 404 Not Found
    const unknownRes = await resolveTrackMediaResponse(
      new Request('lossless-media://track/11111111-2222-3333-4444-555555555555'),
      { trackRepo },
    );
    assert.equal(unknownRes.status, 404);

    // 3. Valid Range request -> 206 Partial Content with exact bytes
    const rangeRes = await resolveTrackMediaResponse(
      new Request(mediaUrl, { headers: { Range: 'bytes=0-43' } }),
      { trackRepo },
    );
    assert.equal(rangeRes.status, 206);
    assert.equal(rangeRes.headers.get('accept-ranges'), 'bytes');
    assert.equal(rangeRes.headers.get('content-type'), 'audio/wav');
    assert.equal(rangeRes.headers.get('content-range'), `bytes 0-43/${wavBytes.length}`);
    const sliced = Buffer.from(await rangeRes.arrayBuffer());
    assert.equal(sliced.length, 44);
    assert.equal(sliced.subarray(0, 4).toString('ascii'), 'RIFF');

    // 4. Delete source file -> marks track missing and returns 404
    fs.unlinkSync(wavPath);
    let missingCallbackId: string | null = null;
    const missingRes = await resolveTrackMediaResponse(new Request(mediaUrl), {
      trackRepo,
      onTrackMissing: (id) => {
        missingCallbackId = id;
      },
    });
    assert.equal(missingRes.status, 404);
    assert.equal(missingCallbackId, track.id);
    assert.equal(trackRepo.findById(track.id)?.status, 'missing');
  } finally {
    conn.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
