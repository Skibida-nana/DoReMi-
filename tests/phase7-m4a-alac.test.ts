import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AlacStreamManager,
  detectMp4AudioCodec,
} from '../src/main/services/alac-decoder';
import { resolveTrackMediaResponse } from '../src/main/services/audio-stream-handler';
import { readTrackMetadata } from '../src/main/services/metadata-service';
import type { TrackRecord } from '../src/shared/types/track';
import { classifyTrackAudioCodec } from '../src/shared/utils/audio-codec';
import { formatTrackAudioSpecs } from '../src/renderer/src/utils/formatters';

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildTrackRecord(id: string, filePath: string, meta: Awaited<ReturnType<typeof readTrackMetadata>>): TrackRecord {
  const now = new Date().toISOString();
  return {
    id,
    original_path: filePath,
    normalized_path: filePath.toLowerCase(),
    title: meta.title,
    artist: meta.artist,
    album: meta.album,
    duration_ms: meta.duration_ms,
    codec: meta.codec,
    container: meta.container,
    sample_rate_hz: meta.sample_rate_hz,
    bit_depth: meta.bit_depth,
    bitrate_bps: meta.bitrate_bps,
    file_size_bytes: meta.file_size_bytes,
    modified_at_ms: meta.modified_at_ms,
    status: 'available',
    added_at: now,
    updated_at: now,
  };
}

test('M4A AAC (Lossy) vs ALAC 16-bit/44.1kHz & 24-bit/96kHz (Lossless) real metadata detection, bit-exact offline WAV streaming, 206 seeking & LRU cleanup', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('ffmpeg binary is not available in this environment');
    return;
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-m4a-alac-'));
  const alacManager = new AlacStreamManager({ maxOpenTracks: 2, idleEvictionMs: 60_000 });

  try {
    const aacPath = path.join(tempDir, 'sample-aac.m4a');
    const alac16Path = path.join(tempDir, 'sample-alac-16-44k.m4a');
    const alac24Path = path.join(tempDir, 'sample-alac-24-96k.m4a');
    const alacThirdPath = path.join(tempDir, 'sample-alac-third.m4a');
    const flacPath = path.join(tempDir, 'sample.flac');
    const wavPath = path.join(tempDir, 'sample.wav');
    const mp3Path = path.join(tempDir, 'sample.mp3');

    // Generate real audio fixtures using FFmpeg
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=1.2',
        '-ac',
        '2',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-metadata',
        'title=AAC Test Track',
        aacPath,
      ],
      { stdio: 'ignore' },
    );

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=523.25:sample_rate=44100:duration=1.2',
        '-ac',
        '2',
        '-c:a',
        'alac',
        '-sample_fmt',
        's16p',
        '-metadata',
        'title=ALAC 16-bit Track',
        alac16Path,
      ],
      { stdio: 'ignore' },
    );

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=880:sample_rate=96000:duration=1.0',
        '-ac',
        '2',
        '-c:a',
        'alac',
        '-sample_fmt',
        's32p',
        '-bits_per_raw_sample',
        '24',
        '-metadata',
        'title=ALAC 24-bit 96kHz Track',
        alac24Path,
      ],
      { stdio: 'ignore' },
    );

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:sample_rate=48000:duration=0.6',
        '-ac',
        '2',
        '-c:a',
        'alac',
        '-sample_fmt',
        's16p',
        alacThirdPath,
      ],
      { stdio: 'ignore' },
    );

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=0.5',
        '-ac',
        '2',
        '-c:a',
        'flac',
        flacPath,
      ],
      { stdio: 'ignore' },
    );

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=0.5',
        '-ac',
        '2',
        '-c:a',
        'pcm_s16le',
        wavPath,
      ],
      { stdio: 'ignore' },
    );

    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=44100:duration=0.5',
        '-ac',
        '2',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '192k',
        mp3Path,
      ],
      { stdio: 'ignore' },
    );

    const hashesBefore = {
      aac: await sha256File(aacPath),
      alac16: await sha256File(alac16Path),
      alac24: await sha256File(alac24Path),
    };

    // 1) Verify ISO-BMFF MP4 box detector
    const probeAac = await detectMp4AudioCodec(aacPath);
    assert.equal(probeAac.codec, 'aac');

    const probeAlac16 = await detectMp4AudioCodec(alac16Path);
    assert.equal(probeAlac16.codec, 'alac');
    assert.equal(probeAlac16.sampleRateHz, 44100);
    assert.equal(probeAlac16.bitDepth, 16);
    assert.equal(probeAlac16.channels, 2);

    const probeAlac24 = await detectMp4AudioCodec(alac24Path);
    assert.equal(probeAlac24.codec, 'alac');
    assert.equal(probeAlac24.sampleRateHz, 96000, 'Must read true 32-bit 96kHz sample rate from ALACSpecificConfig');
    assert.equal(probeAlac24.bitDepth, 24);
    assert.equal(probeAlac24.channels, 2);

    // 2) Verify readTrackMetadata + classifyTrackAudioCodec + formatTrackAudioSpecs
    const aacMeta = await readTrackMetadata(aacPath);
    assert.equal(aacMeta.codec, 'AAC');
    assert.equal(aacMeta.container, 'M4A');
    assert.equal(aacMeta.bit_depth, null, 'Lossy AAC must not report a fake PCM bit depth');

    const alac16Meta = await readTrackMetadata(alac16Path);
    assert.equal(alac16Meta.codec, 'ALAC');
    assert.equal(alac16Meta.container, 'M4A');
    assert.equal(alac16Meta.sample_rate_hz, 44100);
    assert.equal(alac16Meta.bit_depth, 16);

    const alac24Meta = await readTrackMetadata(alac24Path);
    assert.equal(alac24Meta.codec, 'ALAC');
    assert.equal(alac24Meta.container, 'M4A');
    assert.equal(alac24Meta.sample_rate_hz, 96000);
    assert.equal(alac24Meta.bit_depth, 24);

    const aacTrack = buildTrackRecord('11111111-1111-4111-8111-111111111111', aacPath, aacMeta);
    const alac16Track = buildTrackRecord('22222222-2222-4222-8222-222222222222', alac16Path, alac16Meta);
    const alac24Track = buildTrackRecord('33333333-3333-4333-8333-333333333333', alac24Path, alac24Meta);
    const alacThirdTrack = buildTrackRecord(
      '44444444-4444-4444-8444-444444444444',
      alacThirdPath,
      await readTrackMetadata(alacThirdPath),
    );
    const flacTrack = buildTrackRecord(
      '55555555-5555-4555-8555-555555555555',
      flacPath,
      await readTrackMetadata(flacPath),
    );
    const wavTrack = buildTrackRecord(
      '66666666-6666-4666-8666-666666666666',
      wavPath,
      await readTrackMetadata(wavPath),
    );
    const mp3Track = buildTrackRecord(
      '77777777-7777-4777-8777-777777777777',
      mp3Path,
      await readTrackMetadata(mp3Path),
    );

    assert.equal(classifyTrackAudioCodec(aacTrack).qualityTier, 'lossy');
    assert.equal(classifyTrackAudioCodec(alac16Track).qualityTier, 'lossless');
    assert.equal(classifyTrackAudioCodec(alac24Track).qualityTier, 'lossless');
    assert.equal(classifyTrackAudioCodec({ container: 'M4A', codec: null, original_path: 'mystery.m4a' }).qualityTier, 'unknown');
    assert.ok(formatTrackAudioSpecs(aacTrack).includes('AAC (Lossy)'));
    assert.ok(formatTrackAudioSpecs(alac16Track).includes('ALAC (Lossless)'));
    assert.ok(formatTrackAudioSpecs(alac24Track).includes('ALAC (Lossless) · 24-bit / 96 kHz'));

    const allTracks = new Map<string, TrackRecord>([
      [aacTrack.id, aacTrack],
      [alac16Track.id, alac16Track],
      [alac24Track.id, alac24Track],
      [alacThirdTrack.id, alacThirdTrack],
      [flacTrack.id, flacTrack],
      [wavTrack.id, wavTrack],
      [mp3Track.id, mp3Track],
    ]);

    const deps = {
      trackRepo: {
        findById: (id: string) => allTracks.get(id) ?? null,
        updateStatus: () => true,
      },
      alacManager,
    };

    // 3) AAC M4A must stay on native audio/mp4 streaming path (never routed through ALAC decoder)
    const aacRes = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${aacTrack.id}`),
      deps,
    );
    assert.equal(aacRes.status, 200);
    assert.equal(aacRes.headers.get('content-type'), 'audio/mp4');
    assert.equal(aacRes.headers.get('x-doremi-decoder'), null);
    assert.equal(alacManager.getActiveTrackCount(), 0);

    // 4) FLAC, WAV, MP3 regression check: unaffected native streaming
    const flacRes = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${flacTrack.id}`, { method: 'HEAD' }),
      deps,
    );
    assert.equal(flacRes.status, 200);
    assert.equal(flacRes.headers.get('content-type'), 'audio/flac');

    const wavRes = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${wavTrack.id}`, { method: 'HEAD' }),
      deps,
    );
    assert.equal(wavRes.status, 200);
    assert.equal(wavRes.headers.get('content-type'), 'audio/wav');

    const mp3Res = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${mp3Track.id}`, { method: 'HEAD' }),
      deps,
    );
    assert.equal(mp3Res.status, 200);
    assert.equal(mp3Res.headers.get('content-type'), 'audio/mpeg');

    // 5) ALAC 16-bit/44.1kHz full WAV stream must be BIT-EXACT against FFmpeg decoded PCM!
    const alac16Res = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${alac16Track.id}`),
      deps,
    );
    assert.equal(alac16Res.status, 200);
    assert.equal(alac16Res.headers.get('content-type'), 'audio/wav');
    assert.equal(alac16Res.headers.get('x-doremi-decoder'), 'alac-wasm-pcm');
    assert.equal(alac16Res.headers.get('accept-ranges'), 'bytes');
    assert.equal(alac16Res.headers.get('access-control-allow-origin'), '*');

    const streamedWav16 = Buffer.from(await alac16Res.arrayBuffer());
    assert.equal(streamedWav16.subarray(0, 4).toString('ascii'), 'RIFF');
    assert.equal(streamedWav16.subarray(8, 12).toString('ascii'), 'WAVE');
    assert.equal(streamedWav16.readUInt16LE(20), 1); // PCM
    assert.equal(streamedWav16.readUInt16LE(22), 2); // Stereo
    assert.equal(streamedWav16.readUInt32LE(24), 44100);
    assert.equal(streamedWav16.readUInt16LE(34), 16);

    const refPcm16 = execFileSync('ffmpeg', ['-i', alac16Path, '-f', 's16le', '-acodec', 'pcm_s16le', '-'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(
      streamedWav16.subarray(44).compare(refPcm16),
      0,
      'Decoded ALAC 16-bit PCM stream must match FFmpeg reference bit-for-bit',
    );

    // 6) ALAC 24-bit/96kHz full stream bit-exactness + non-aligned 206 byte-range seeking!
    const alac24Res = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${alac24Track.id}`),
      deps,
    );
    assert.equal(alac24Res.status, 200);
    const streamedWav24 = Buffer.from(await alac24Res.arrayBuffer());
    assert.equal(streamedWav24.readUInt32LE(24), 96000);
    assert.equal(streamedWav24.readUInt16LE(34), 24);

    const refPcm24 = execFileSync('ffmpeg', ['-i', alac24Path, '-f', 's24le', '-acodec', 'pcm_s24le', '-'], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    assert.equal(
      streamedWav24.subarray(44).compare(refPcm24),
      0,
      'Decoded ALAC 24-bit/96kHz PCM stream must match FFmpeg reference bit-for-bit',
    );

    // Unaligned mid-file seek test (odd byte offset crossing sample & frame boundaries)
    const seekStart = 44 + 77777;
    const seekEnd = seekStart + 19999;
    const seekRes = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${alac24Track.id}`, {
        headers: { Range: `bytes=${seekStart}-${seekEnd}` },
      }),
      deps,
    );
    assert.equal(seekRes.status, 206);
    assert.equal(
      seekRes.headers.get('content-range'),
      `bytes ${seekStart}-${seekEnd}/${streamedWav24.length}`,
    );
    const seekBytes = Buffer.from(await seekRes.arrayBuffer());
    assert.equal(seekBytes.length, seekEnd - seekStart + 1);
    assert.equal(
      seekBytes.compare(streamedWav24.subarray(seekStart, seekEnd + 1)),
      0,
      '206 Partial Content byte range must match full WAV bytes identically',
    );

    // 416 Range Not Satisfiable
    const badRangeRes = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${alac24Track.id}`, {
        headers: { Range: `bytes=${streamedWav24.length + 100}-` },
      }),
      deps,
    );
    assert.equal(badRangeRes.status, 416);

    // 7) Bounded LRU eviction (maxOpenTracks = 2) when switching to a 3rd ALAC track
    assert.equal(alacManager.getActiveTrackCount(), 2);
    const thirdRes = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${alacThirdTrack.id}`, { method: 'HEAD' }),
      deps,
    );
    assert.equal(thirdRes.status, 200);
    assert.equal(alacManager.getActiveTrackCount(), 2, 'LRU cache must evict oldest ALAC handle');

    // 8) Verify source files were NEVER modified (100% read-only)
    assert.equal(await sha256File(aacPath), hashesBefore.aac);
    assert.equal(await sha256File(alac16Path), hashesBefore.alac16);
    assert.equal(await sha256File(alac24Path), hashesBefore.alac24);

    // 9) Dispose releases all open ALAC handles
    alacManager.dispose();
    assert.equal(alacManager.getActiveTrackCount(), 0);
  } finally {
    alacManager.dispose();
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
