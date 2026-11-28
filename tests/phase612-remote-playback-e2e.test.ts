import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AlacStreamManager } from '../src/main/services/alac-decoder';
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
import { buildPlaybackErrorDetails } from '../src/renderer/src/player/playback-error';
import {
  buildRemoteArtworkMediaUrl,
  buildRemoteTrackMediaUrl,
} from '../src/shared/contracts/media-protocol';
import {
  buildRemoteTrackId,
  mapRemoteTrackDtoToTrackRecord,
} from '../src/shared/contracts/connect-api';

function findFfmpegPath(): string | null {
  const candidates = [
    process.env.DOREMI_REAL_FFMPEG_DIR
      ? path.join(process.env.DOREMI_REAL_FFMPEG_DIR, 'ffmpeg.exe')
      : null,
    'D:/Dowload/FFmpeg/ffmpeg-2026-11-23-git-05c674c913-full_build/bin/ffmpeg.exe',
  ].filter((p): p is string => Boolean(p));

  for (const candidate of candidates) {
    if (fsSync.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function createToneWavBuffer(durationSec: number, sampleRate: number, bits: 16 | 24): Buffer {
  const channels = 2;
  const bytesPerSample = bits / 8;
  const frameCount = Math.round(sampleRate * durationSec);
  const dataSize = frameCount * channels * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  buf.writeUInt16LE(channels * bytesPerSample, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataSize, 40);

  let off = 44;
  for (let i = 0; i < frameCount; i += 1) {
    const val = Math.round(Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 12000);
    for (let ch = 0; ch < channels; ch += 1) {
      if (bits === 16) {
        buf.writeInt16LE(val, off);
      } else {
        const s24 = val << 8;
        buf[off] = s24 & 0xff;
        buf[off + 1] = (s24 >> 8) & 0xff;
        buf[off + 2] = (s24 >> 16) & 0xff;
      }
      off += bytesPerSample;
    }
  }
  return buf;
}

function sha256(buf: Uint8Array): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function buildFlacWithInvalidPicture(validFlac: Buffer): Buffer {
  // Insert malformed METADATA_BLOCK_PICTURE (type 6, mimeLength = 0) right after STREAMINFO
  assert.equal(validFlac.subarray(0, 4).toString('ascii'), 'fLaC');
  const siHdr = validFlac.subarray(4, 8);
  const siBodyLen = (siHdr[1] << 16) | (siHdr[2] << 8) | siHdr[3];
  const restOffset = 8 + siBodyLen;
  const newSiHdr = Buffer.from(siHdr);
  newSiHdr[0] = newSiHdr[0] & 0x7f; // not last

  // Bad picture block (isLast = true if rest starts with audio frame, wait we keep original blocks after and mark non-last)
  const badPicBody = Buffer.alloc(40, 0); // mimeLength = 0!
  badPicBody.writeUInt32BE(3, 0); // Cover (front)
  const badPicHdr = Buffer.from([
    (siHdr[0] & 0x80) !== 0 ? 0x86 : 0x06,
    0x00,
    0x00,
    badPicBody.length,
  ]);
  return Buffer.concat([
    validFlac.subarray(0, 4),
    newSiHdr,
    validFlac.subarray(8, restOffset),
    badPicHdr,
    badPicBody,
    validFlac.subarray(restOffset),
  ]);
}

async function enrollLocalHostClient(
  host: ConnectHostService,
  port: number,
  clientDir: string,
  deviceName: string,
): Promise<{ client: ConnectClientService; closeDb: () => void }> {
  const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
  const client = new ConnectClientService({
    connectRepo: new ConnectRepository(clientConn.db),
    secrets: new ConnectSecretStorage({ userDataDir: clientDir }),
  });
  const probe = await client.probeHost('127.0.0.1', port);
  const inv = host.createInvitation({ autoApproveSingleUse: true });
  await client.enrollWithHost({
    address: '127.0.0.1',
    port,
    expectedFingerprintSha256: probe.observedFingerprintSha256!,
    inviteCode: inv.inviteCode,
    deviceName,
  });
  return { client, closeDb: () => clientConn.close() };
}

test('Phase 6.1.2: DB upgrade concurrency floor, ALAC bit-exact SHA-256 parity (16/44.1, 24/48, 24/96, moov-EOF), FLAC ID3/PICTURE compat & Host/Client limits', async () => {
  const ffmpeg = findFfmpegPath();
  assert.ok(ffmpeg, 'Real ffmpeg.exe is required for Phase 6.1.2 tests.');

  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-p612-core-'));
  const musicDir = path.join(tmpRoot, 'music');
  const hostDir = path.join(tmpRoot, 'host-ud');
  await fs.mkdir(musicDir, { recursive: true });
  await fs.mkdir(hostDir, { recursive: true });

  const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
  const closeClients: Array<() => void> = [];
  let host: ConnectHostService | null = null;

  try {
    // 1. Verify ConnectRepository upgrades legacy v9 max_requests_per_device=4 / max_global_requests=12 cleanly
    const hostConnectRepo = new ConnectRepository(hostConn.db);
    hostConnectRepo.getHostConfig();
    hostConn.db
      .prepare('UPDATE connect_host_config SET max_requests_per_device = 4, max_global_requests = 12 WHERE id = 1')
      .run();
    const floored = hostConnectRepo.getHostConfig();
    assert.ok(floored.resourceLimits.maxRequestsPerDevice >= 16);
    assert.ok(floored.resourceLimits.maxGlobalRequests >= 48);
    assert.equal(floored.resourceLimits.maxActiveClients, 3);

    // 2. Synthesize real audio formats
    const wav16Path = path.join(musicDir, 'src-16-441.wav');
    const wav2448Path = path.join(musicDir, 'src-24-48.wav');
    const wav2496Path = path.join(musicDir, 'src-24-96.wav');
    await fs.writeFile(wav16Path, createToneWavBuffer(6.0, 44100, 16));
    await fs.writeFile(wav2448Path, createToneWavBuffer(6.0, 48000, 24));
    await fs.writeFile(wav2496Path, createToneWavBuffer(5.0, 96000, 24));

    const alac16Path = path.join(musicDir, 'track-alac-16-441.m4a');
    const alac2448Path = path.join(musicDir, 'track-alac-24-48.m4a');
    const alac2496Path = path.join(musicDir, 'track-alac-24-96.m4a');
    const alacEofPath = path.join(musicDir, 'track-alac-eof.m4a');
    const aacEofPath = path.join(musicDir, 'track-aac-eof.m4a');
    const flacCleanPath = path.join(musicDir, 'track-clean.flac');
    const flacId3Path = path.join(musicDir, 'track-id3.flac');
    const flacBadPicPath = path.join(musicDir, 'track-badpic.flac');

    execFileSync(ffmpeg, ['-y', '-i', wav16Path, '-c:a', 'alac', '-movflags', '+faststart', alac16Path], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-i', wav2448Path, '-c:a', 'alac', '-sample_fmt', 's32p', '-movflags', '+faststart', alac2448Path], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-i', wav2496Path, '-c:a', 'alac', '-sample_fmt', 's32p', '-movflags', '+faststart', alac2496Path], { stdio: 'ignore' });
    // Explicit non-faststart so moov resides AFTER mdat!
    execFileSync(ffmpeg, ['-y', '-i', wav2448Path, '-c:a', 'alac', '-sample_fmt', 's32p', alacEofPath], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-i', wav16Path, '-c:a', 'aac', '-b:a', '192k', aacEofPath], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-i', wav16Path, '-c:a', 'flac', flacCleanPath], { stdio: 'ignore' });

    const cleanFlacBytes = await fs.readFile(flacCleanPath);
    const id3Tag = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x0a, ...new Array(10).fill(0)]);
    await fs.writeFile(flacId3Path, Buffer.concat([id3Tag, cleanFlacBytes]));
    await fs.writeFile(flacBadPicPath, buildFlacWithInvalidPicture(cleanFlacBytes));

    // Confirm alac-eof actually has mdat before moov
    const eofHead = await fs.readFile(alacEofPath);
    assert.ok(eofHead.indexOf('mdat') < eofHead.indexOf('moov'), 'Expected mdat before moov in EOF M4A');

    // Also store a tiny png artwork file referenced as folder artwork
    await fs.writeFile(
      path.join(musicDir, 'cover.png'),
      Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415408d763f8ffff3f0005fe02fea7d655b30000000049454e44ae426082', 'hex'),
    );

    const trackRepo = new TrackRepository(hostConn.db);
    const rootRepo = new LibraryRootRepository(hostConn.db);
    const artworkRepo = new ArtworkRepository(hostConn.db);
    const lyricsRepo = new LyricsRepository(hostConn.db);
    const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

    const defs = [
      { p: wav16Path, title: 'WAV_16', codec: 'PCM', container: 'WAV', sr: 44100, bits: 16 },
      { p: alac16Path, title: 'ALAC_16_441', codec: 'ALAC', container: 'M4A', sr: 44100, bits: 16 },
      { p: alac2448Path, title: 'ALAC_24_48', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24 },
      { p: alac2496Path, title: 'ALAC_24_96', codec: 'ALAC', container: 'M4A', sr: 96000, bits: 24 },
      { p: alacEofPath, title: 'ALAC_EOF', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24 },
      { p: aacEofPath, title: 'AAC_EOF', codec: 'AAC', container: 'M4A', sr: 44100, bits: null },
      { p: flacCleanPath, title: 'FLAC_CLEAN', codec: 'FLAC', container: 'FLAC', sr: 44100, bits: 16 },
      { p: flacId3Path, title: 'FLAC_ID3', codec: 'FLAC', container: 'FLAC', sr: 44100, bits: 16 },
      { p: flacBadPicPath, title: 'FLAC_BADPIC', codec: 'FLAC', container: 'FLAC', sr: 44100, bits: 16 },
    ];
    const recordsToInsert = [];
    for (const d of defs) {
      const st = await fs.stat(d.p);
      recordsToInsert.push({
        original_path: d.p,
        normalized_path: normalizeTrackPath(d.p),
        title: d.title,
        artist: 'Phase612Artist',
        album: 'Phase612Album',
        duration_ms: 6000,
        codec: d.codec,
        container: d.container,
        sample_rate_hz: d.sr,
        bit_depth: d.bits,
        bitrate_bps: 1_500_000,
        file_size_bytes: st.size,
        modified_at_ms: Math.round(st.mtimeMs),
        status: 'available' as const,
      });
    }
    trackRepo.upsertBatch(recordsToInsert);
    const dbTracks = trackRepo.findAll();

    hostConnectRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, maxActiveClients: 3 });
    host = new ConnectHostService({
      appVersion: '1.0.0-rc.4',
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
    const port = hostSnap.listeningPort!;
    const hostId = hostSnap.identity!.hostId;

    const c1Dir = path.join(tmpRoot, 'client-1');
    await fs.mkdir(c1Dir, { recursive: true });
    const c1 = await enrollLocalHostClient(host, port, c1Dir, 'Client-1');
    closeClients.push(c1.closeDb);

    // Populate metadata cache as App UI does
    const listed = await c1.client.listRemoteTracks({ limit: 50 });
    assert.equal(listed.items.length, dbTracks.length);

    // 3. Bit-exact SHA-256 verification of Remote ALAC vs Local AlacStreamManager
    const localAlac = new AlacStreamManager({ maxOpenTracks: 2 });
    const alacCases = ['ALAC_16_441', 'ALAC_24_48', 'ALAC_24_96', 'ALAC_EOF'] as const;

    for (const label of alacCases) {
      const t = dbTracks.find((row) => row.title === label)!;
      const localResp = await localAlac.resolveAlacWavResponse(
        new Request(`lossless-media://track/${t.id}`),
        t.original_path,
        {},
      );
      assert.ok(localResp && localResp.status === 200, `${label}: local ALAC must resolve`);
      const localWavBuf = Buffer.from(await localResp.arrayBuffer());

      const remoteResp = await c1.client.resolveRemoteTrackMediaResponse(
        new Request(buildRemoteTrackMediaUrl(hostId, t.id)),
      );
      assert.equal(remoteResp.status, 200, `${label}: remote ALAC must resolve as 200 WAV`);
      assert.equal(remoteResp.headers.get('content-type'), 'audio/wav');
      assert.equal(remoteResp.headers.get('x-doremi-transfer-mode'), 'remote-alac-range-wasm');
      const remoteWavBuf = Buffer.from(await remoteResp.arrayBuffer());

      assert.equal(
        remoteWavBuf.length,
        localWavBuf.length,
        `${label}: remote decoded WAV byte length (${remoteWavBuf.length}) must equal local (${localWavBuf.length})`,
      );
      assert.equal(
        sha256(remoteWavBuf),
        sha256(localWavBuf),
        `${label}: remote ALAC WAV SHA-256 must be 100% bit-exact with local WASM decoder`,
      );

      // Verify mid-file seek Range request matches exact slice of local WAV
      const seekStart = 44 + 48000;
      const seekEnd = seekStart + 16383;
      const seekResp = await c1.client.resolveRemoteTrackMediaResponse(
        new Request(buildRemoteTrackMediaUrl(hostId, t.id), {
          headers: { Range: `bytes=${seekStart}-${seekEnd}` },
        }),
      );
      assert.equal(seekResp.status, 206);
      assert.equal(seekResp.headers.get('content-range'), `bytes ${seekStart}-${seekEnd}/${localWavBuf.length}`);
      const seekBuf = Buffer.from(await seekResp.arrayBuffer());
      assert.equal(sha256(seekBuf), sha256(localWavBuf.subarray(seekStart, seekEnd + 1)));
    }
    localAlac.dispose();

    // 4. Verify AAC passes through untouched (not intercepted as ALAC)
    const aacTrack = dbTracks.find((r) => r.title === 'AAC_EOF')!;
    const aacResp = await c1.client.resolveRemoteTrackMediaResponse(
      new Request(buildRemoteTrackMediaUrl(hostId, aacTrack.id)),
    );
    assert.equal(aacResp.status, 200);
    assert.equal(aacResp.headers.get('content-type'), 'audio/mp4');
    const aacBuf = Buffer.from(await aacResp.arrayBuffer());
    assert.equal(sha256(aacBuf), sha256(await fs.readFile(aacEofPath)));

    // 5. Verify FLAC clean, ID3-prepended FLAC & Bad-PICTURE FLAC
    for (const flacLabel of ['FLAC_ID3', 'FLAC_BADPIC'] as const) {
      const fTrack = dbTracks.find((r) => r.title === flacLabel)!;
      const onDiskBefore = sha256(await fs.readFile(fTrack.original_path));
      const fResp = await c1.client.resolveRemoteTrackMediaResponse(
        new Request(buildRemoteTrackMediaUrl(hostId, fTrack.id)),
      );
      assert.equal(fResp.status, 200);
      assert.equal(fResp.headers.get('x-doremi-transfer-mode'), 'remote-flac-normalized');
      const streamedFlac = Buffer.from(await fResp.arrayBuffer());
      assert.equal(streamedFlac.subarray(0, 4).toString('ascii'), 'fLaC', `${flacLabel}: virtual stream must begin with fLaC`);
      assert.equal(sha256(await fs.readFile(fTrack.original_path)), onDiskBefore, 'Host file on disk must never be modified');
    }

    // 6. Blast 24 concurrent artwork requests + concurrent FLAC Range stream (no 429 failures)
    const flacTrack = dbTracks.find((r) => r.title === 'FLAC_CLEAN')!;
    const artworkPromises = Array.from({ length: 24 }, (_, idx) =>
      c1.client.resolveRemoteArtworkMediaResponse(
        new Request(buildRemoteArtworkMediaUrl(hostId, dbTracks[idx % dbTracks.length].id, 'thumb')),
      ),
    );
    const streamRangePromise = c1.client.resolveRemoteTrackMediaResponse(
      new Request(buildRemoteTrackMediaUrl(hostId, flacTrack.id), {
        headers: { Range: 'bytes=0-32767' },
      }),
    );
    const [streamRangeResp, ...artResponses] = await Promise.all([
      streamRangePromise,
      ...artworkPromises,
    ]);
    assert.equal(streamRangeResp.status, 206);
    assert.equal(streamRangeResp.headers.get('content-type'), 'audio/flac');
    const rangeBytes = await streamRangeResp.arrayBuffer();
    assert.equal(rangeBytes.byteLength, 32768);
    assert.equal(
      artResponses.some((r) => r.status === 429),
      false,
      'Artwork flood must never trigger HTTP 429 errors',
    );

    // 7. Verify 404 / Non-audio rejection never returns garbage JSON with status 200 & Error Taxonomy maps accurately
    const missingId = '00000000-0000-4000-8000-000000000999';
    const missingResp = await c1.client.resolveRemoteTrackMediaResponse(
      new Request(buildRemoteTrackMediaUrl(hostId, missingId)),
    );
    assert.equal(missingResp.status, 404);
    const diagAfter404 = c1.client.getClientDiagnosticsSnapshot();
    assert.equal(diagAfter404.lastTrackFailure?.errorCode, 'ERR_REMOTE_TRACK_NOT_FOUND');

    const fakeRemoteTrack = {
      ...mapRemoteTrackDtoToTrackRecord(hostId, listed.items[0]),
      id: buildRemoteTrackId(hostId, missingId),
      title: 'Missing',
    };

    const classified404 = buildPlaybackErrorDetails({
      attemptId: 'pb-test-404',
      stage: 'runtime-media',
      track: fakeRemoteTrack,
      mediaError: { code: 4, message: 'PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN' },
      remoteFailureHint: { errorCode: 'ERR_REMOTE_TRACK_NOT_FOUND', statusCode: 404, detail: 'TRACK_NOT_FOUND' },
    });
    assert.equal(classified404.code, 'ERR_REMOTE_TRACK_NOT_FOUND');

    const classified429 = buildPlaybackErrorDetails({
      attemptId: 'pb-test-429',
      stage: 'runtime-media',
      track: fakeRemoteTrack,
      mediaError: { code: 4, message: 'PipelineStatus::DEMUXER_ERROR_COULD_NOT_OPEN' },
      remoteFailureHint: { errorCode: 'ERR_REMOTE_RESOURCE_LIMIT', statusCode: 429, detail: 'CLIENT_LIMIT_REACHED' },
    });
    assert.equal(classified429.code, 'ERR_REMOTE_RESOURCE_LIMIT');

    // 8. Verify maxActiveClients=3 still rejects 4th simultaneous playback device cleanly with 429 CLIENT_LIMIT_REACHED
    // Create a large 12MB WAV so 3 paused unread streams hold backpressure (never finishing inside socket buffer)
    const bigWavPath = path.join(musicDir, 'big-backpressure.wav');
    const bigWavBuf = createToneWavBuffer(70.0, 44100, 16); // ~12.3 MB
    await fs.writeFile(bigWavPath, bigWavBuf);
    const bigStat = await fs.stat(bigWavPath);
    trackRepo.upsertBatch([
      {
        original_path: bigWavPath,
        normalized_path: normalizeTrackPath(bigWavPath),
        title: 'BIG_BACKPRESSURE_WAV',
        artist: 'Phase612Artist',
        album: 'Phase612Album',
        duration_ms: 70000,
        codec: 'PCM',
        container: 'WAV',
        sample_rate_hz: 44100,
        bit_depth: 16,
        bitrate_bps: 1_411_200,
        file_size_bytes: bigStat.size,
        modified_at_ms: Math.round(bigStat.mtimeMs),
        status: 'available' as const,
      },
    ]);
    const bigTrack = trackRepo.findAll().find((r) => r.title === 'BIG_BACKPRESSURE_WAV')!;

    const extraClients: ConnectClientService[] = [];
    for (let i = 2; i <= 4; i += 1) {
      const dir = path.join(tmpRoot, `client-${i}`);
      await fs.mkdir(dir, { recursive: true });
      const enrolled = await enrollLocalHostClient(host, port, dir, `Client-${i}`);
      closeClients.push(enrolled.closeDb);
      extraClients.push(enrolled.client);
    }

    // Hold 3 active streams open concurrently (C1, C2, C3) without draining their streams
    const openAborts = [new AbortController(), new AbortController(), new AbortController()];
    const activeStreamResponses = await Promise.all(
      [c1.client, extraClients[0], extraClients[1]].map((cli, idx) =>
        cli.resolveRemoteTrackMediaResponse(
          new Request(buildRemoteTrackMediaUrl(hostId, bigTrack.id), {
            signal: openAborts[idx].signal,
          }),
        ),
      ),
    );
    assert.ok(activeStreamResponses.every((r) => r.status === 200));

    // 4th distinct client attempting playback stream MUST get 429 CLIENT_LIMIT_REACHED
    const fourthResp = await extraClients[2].resolveRemoteTrackMediaResponse(
      new Request(buildRemoteTrackMediaUrl(hostId, bigTrack.id)),
    );
    assert.equal(fourthResp.status, 429);
    const fourthJson = (await fourthResp.json()) as { code?: string };
    assert.equal(fourthJson.code, 'CLIENT_LIMIT_REACHED');
    assert.equal(
      extraClients[2].getClientDiagnosticsSnapshot().lastTrackFailure?.errorCode,
      'ERR_REMOTE_RESOURCE_LIMIT',
    );

    // Cleanly abort the 3 open streams and verify streams finalize
    for (const ac of openAborts) ac.abort();
    for (const r of activeStreamResponses) {
      await r.body?.cancel().catch(() => {});
    }
    await Promise.all([c1.client.disconnect(), ...extraClients.map((e) => e.disconnect())]);
  } finally {
    await host?.stop().catch(() => {});
    for (const fn of closeClients) fn();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('Phase 6.1.2 E2E: Real Electron Chromium <audio> + Web Audio AudioContext playback, seeking, pause>10s, track switching & mid-stream revocation', async () => {
  const ffmpeg = findFfmpegPath();
  assert.ok(ffmpeg, 'Real ffmpeg.exe is required for Phase 6.1.2 Chromium E2E test.');

  // Launch Electron GUI child process using bundled runner so BrowserWindow + Chromium FFmpeg + Web Audio execute for real
  const runnerTs = path.join(os.tmpdir(), `doremi-p612-chromium-${Date.now()}.ts`);
  const runnerCjs = path.join(os.tmpdir(), `doremi-p612-chromium-${Date.now()}.cjs`);
  const outJson = path.join(os.tmpdir(), `doremi-p612-chromium-${Date.now()}.json`);
  const repoRoot = process.cwd().replace(/\\/g, '/');

  const runnerSource = `
import { execFileSync } from 'node:child_process';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, BrowserWindow, session } from 'electron';
import { openLibraryDatabase } from '${repoRoot}/src/main/database/connection';
import { ArtworkRepository } from '${repoRoot}/src/main/database/artwork-repository';
import { LibraryRootRepository } from '${repoRoot}/src/main/database/library-root-repository';
import { LyricsRepository } from '${repoRoot}/src/main/database/lyrics-repository';
import { TrackRepository } from '${repoRoot}/src/main/database/track-repository';
import { ArtworkService } from '${repoRoot}/src/main/services/artwork-service';
import { registerAudioProtocolHandler, registerPrivilegedAudioScheme } from '${repoRoot}/src/main/services/audio-protocol';
import { ConnectClientService } from '${repoRoot}/src/main/services/connect/connect-client';
import { ConnectRepository } from '${repoRoot}/src/main/services/connect/connect-repository';
import { ConnectHostService } from '${repoRoot}/src/main/services/connect/host-service';
import { ConnectSecretStorage } from '${repoRoot}/src/main/services/connect/secret-storage';
import { LyricsService } from '${repoRoot}/src/main/services/lyrics-service';
import { normalizeTrackPath } from '${repoRoot}/src/main/services/path-utils';
import { buildRemoteArtworkMediaUrl, buildRemoteTrackMediaUrl } from '${repoRoot}/src/shared/contracts/media-protocol';

const tmpRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'doremi-e2e-win-'));
app.setPath('userData', path.join(tmpRoot, 'ud'));
registerPrivilegedAudioScheme();

function wavBuf(durationSec: number, sr: number, bits: 16 | 24): Buffer {
  const ch = 2;
  const bps = bits / 8;
  const frames = Math.round(sr * durationSec);
  const data = frames * ch * bps;
  const buf = Buffer.alloc(44 + data);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(ch, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * ch * bps, 28);
  buf.writeUInt16LE(ch * bps, 32);
  buf.writeUInt16LE(bits, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data, 40);
  let off = 44;
  for (let i = 0; i < frames; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 12000);
    for (let c = 0; c < ch; c += 1) {
      if (bits === 16) buf.writeInt16LE(v, off);
      else {
        const s24 = v << 8;
        buf[off] = s24 & 0xff;
        buf[off + 1] = (s24 >> 8) & 0xff;
        buf[off + 2] = (s24 >> 16) & 0xff;
      }
      off += bps;
    }
  }
  return buf;
}

async function run() {
  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    await app.whenReady();
    const ffmpeg = ${JSON.stringify(ffmpeg)};
    const musicDir = path.join(tmpRoot, 'music');
    const hostDir = path.join(tmpRoot, 'host-ud');
    const clientDir = path.join(tmpRoot, 'client-ud');
    await fs.mkdir(musicDir, { recursive: true });
    await fs.mkdir(hostDir, { recursive: true });
    await fs.mkdir(clientDir, { recursive: true });

    const w16 = path.join(musicDir, 'e2e.wav');
    const w24 = path.join(musicDir, 'e2e24.wav');
    const flac = path.join(musicDir, 'e2e.flac');
    const flacId3 = path.join(musicDir, 'e2e-id3.flac');
    const aacEof = path.join(musicDir, 'e2e-aac.m4a');
    const alac16 = path.join(musicDir, 'e2e-alac16.m4a');
    const alac24 = path.join(musicDir, 'e2e-alac24.m4a');
    const alacEof = path.join(musicDir, 'e2e-alac-eof.m4a');

    await fs.writeFile(w16, wavBuf(8, 44100, 16));
    await fs.writeFile(w24, wavBuf(8, 48000, 24));
    execFileSync(ffmpeg, ['-y', '-i', w16, '-c:a', 'flac', flac], { stdio: 'ignore' });
    const rawFlac = await fs.readFile(flac);
    await fs.writeFile(flacId3, Buffer.concat([Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 10, ...new Array(10).fill(0)]), rawFlac]));
    execFileSync(ffmpeg, ['-y', '-i', w16, '-c:a', 'aac', '-b:a', '192k', aacEof], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-i', w16, '-c:a', 'alac', '-movflags', '+faststart', alac16], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-i', w24, '-c:a', 'alac', '-sample_fmt', 's32p', '-movflags', '+faststart', alac24], { stdio: 'ignore' });
    execFileSync(ffmpeg, ['-y', '-i', w24, '-c:a', 'alac', '-sample_fmt', 's32p', alacEof], { stdio: 'ignore' });

    const hostConn = openLibraryDatabase(path.join(hostDir, 'library.db'));
    const trackRepo = new TrackRepository(hostConn.db);
    const rootRepo = new LibraryRootRepository(hostConn.db);
    const artworkRepo = new ArtworkRepository(hostConn.db);
    const lyricsRepo = new LyricsRepository(hostConn.db);
    const root = rootRepo.upsertRoot(musicDir, normalizeTrackPath(musicDir));

    const defs = [
      { p: w16, title: 'WAV', codec: 'PCM', container: 'WAV', sr: 44100, bits: 16 },
      { p: flac, title: 'FLAC', codec: 'FLAC', container: 'FLAC', sr: 44100, bits: 16 },
      { p: flacId3, title: 'FLAC_ID3', codec: 'FLAC', container: 'FLAC', sr: 44100, bits: 16 },
      { p: aacEof, title: 'AAC_EOF', codec: 'AAC', container: 'M4A', sr: 44100, bits: null },
      { p: alac16, title: 'ALAC_16_441', codec: 'ALAC', container: 'M4A', sr: 44100, bits: 16 },
      { p: alac24, title: 'ALAC_24_48', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24 },
      { p: alacEof, title: 'ALAC_EOF', codec: 'ALAC', container: 'M4A', sr: 48000, bits: 24 },
    ];
    const rows = [];
    for (const d of defs) {
      const st = await fs.stat(d.p);
      rows.push({
        original_path: d.p,
        normalized_path: normalizeTrackPath(d.p),
        title: d.title,
        artist: 'E2E',
        album: 'E2EAlbum',
        duration_ms: 8000,
        codec: d.codec,
        container: d.container,
        sample_rate_hz: d.sr,
        bit_depth: d.bits,
        bitrate_bps: 1_200_000,
        file_size_bytes: st.size,
        modified_at_ms: Math.round(st.mtimeMs),
        status: 'available' as const,
      });
    }
    trackRepo.upsertBatch(rows);
    const tracks = trackRepo.findAll();

    const hostRepo = new ConnectRepository(hostConn.db);
    hostRepo.updateHostConfig({ bindAddress: '127.0.0.1', port: 0, maxActiveClients: 3 });
    const host = new ConnectHostService({
      appVersion: '1.0.0-rc.4',
      userDataDir: hostDir,
      connectRepo: hostRepo,
      trackRepo,
      artworkService: new ArtworkService({ trackRepo, artworkRepo, userDataDir: hostDir }),
      lyricsService: new LyricsService({ trackRepo, lyricsRepo }),
      secrets: new ConnectSecretStorage({ userDataDir: hostDir }),
      enableMdns: false,
    });
    host.addSharedSource(root.id);
    const hostSnap = await host.start();
    const port = hostSnap.listeningPort!;
    const hostId = hostSnap.identity!.hostId;

    const clientConn = openLibraryDatabase(path.join(clientDir, 'library.db'));
    const client = new ConnectClientService({
      connectRepo: new ConnectRepository(clientConn.db),
      secrets: new ConnectSecretStorage({ userDataDir: clientDir }),
    });
    const probe = await client.probeHost('127.0.0.1', port);
    const inv = host.createInvitation({ autoApproveSingleUse: true });
    await client.enrollWithHost({
      address: '127.0.0.1',
      port,
      expectedFingerprintSha256: probe.observedFingerprintSha256!,
      inviteCode: inv.inviteCode,
      deviceName: 'E2EChromiumClient',
    });
    await client.listRemoteTracks({ limit: 50 });

    registerAudioProtocolHandler({ trackRepo, connectClientService: client });
    session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      if (details.resourceType === 'mainFrame') {
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            'Content-Security-Policy': ["default-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; media-src 'self' lossless-media:; img-src 'self' data: blob: lossless-media:;"],
          },
        });
        return;
      }
      callback({ responseHeaders: details.responseHeaders });
    });

    const win = new BrowserWindow({
      show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const htmlPath = path.join(tmpRoot, 'e2e.html');
    await fs.writeFile(htmlPath, '<!doctype html><html><body></body></html>', 'utf8');
    await win.loadFile(htmlPath);
    await win.webContents.executeJavaScript(\`
      window.__a = new Audio();
      window.__a.crossOrigin = 'anonymous';
      window.__a.preload = 'metadata';
      window.__ctx = new AudioContext();
      window.__src = window.__ctx.createMediaElementSource(window.__a);
      window.__src.connect(window.__ctx.destination);
      true;
    \`);

    async function verifyFormat(title: string, withArtworkFlood: boolean) {
      const t = tracks.find((x) => x.title === title)!;
      const url = buildRemoteTrackMediaUrl(hostId, t.id);
      const artUrls = withArtworkFlood
        ? Array.from({ length: 20 }, (_, i) => buildRemoteArtworkMediaUrl(hostId, tracks[i % tracks.length].id, 'thumb', String(i)))
        : [];
      const outcome = await win.webContents.executeJavaScript(\`
        new Promise((resolve) => {
          const a = window.__a;
          const ctx = window.__ctx;
          for (const au of \${JSON.stringify(artUrls)}) {
            const img = new Image();
            img.src = au;
          }
          const done = (ok, detail) => {
            clearTimeout(timer);
            a.oncanplay = null;
            a.onerror = null;
            resolve({ ok, detail: detail + (a.error ? ' code=' + a.error.code + ' ' + a.error.message : '') });
          };
          const timer = setTimeout(() => done(false, 'TIMEOUT'), 8000);
          a.onerror = () => done(false, 'MEDIA_ERROR');
          let ran = false;
          a.oncanplay = async () => {
            if (ran) return;
            ran = true;
            try {
              if (ctx.state === 'suspended') await ctx.resume();
              await a.play();
              setTimeout(() => {
                // Forward seek, then backward seek, then verify currentTime moved
                a.currentTime = 5.5;
                setTimeout(() => {
                  a.currentTime = 2.0;
                  setTimeout(() => {
                    const pausedOk = !a.paused && a.currentTime >= 1.8 && a.duration > 7.5;
                    done(pausedOk, pausedOk ? 'PLAY_SEEK_FWD_BACK_OK t=' + a.currentTime.toFixed(2) : 'BAD_TIME t=' + a.currentTime);
                  }, 250);
                }, 200);
              }, 200);
            } catch (e) {
              done(false, 'EXC:' + String(e));
            }
          };
          a.src = \${JSON.stringify(url)};
          a.load();
        })
      \`);
      results.push({ name: title + (withArtworkFlood ? '+ART20' : ''), ok: outcome.ok, detail: outcome.detail });
    }

    for (const name of ['WAV', 'FLAC', 'FLAC_ID3', 'AAC_EOF', 'ALAC_16_441', 'ALAC_24_48', 'ALAC_EOF']) {
      await verifyFormat(name, name === 'FLAC');
    }

    // Pause > 10.5 seconds test to confirm timeout was disarmed after response headers!
    const wavUrl = buildRemoteTrackMediaUrl(hostId, tracks.find((x) => x.title === 'WAV')!.id);
    const pauseResume = await win.webContents.executeJavaScript(\`
      new Promise((resolve) => {
        const a = window.__a;
        a.oncanplay = async () => {
          a.oncanplay = null;
          await a.play();
          a.pause();
          setTimeout(async () => {
            try {
              await a.play();
              setTimeout(() => resolve({ ok: !a.paused && !a.error, detail: 'PAUSED_10.5S_RESUMED t=' + a.currentTime.toFixed(2) }), 250);
            } catch (e) {
              resolve({ ok: false, detail: 'RESUME_ERR:' + String(e) });
            }
          }, 10500);
        };
        a.onerror = () => resolve({ ok: false, detail: 'PAUSE_ERR:' + a.error?.message });
        a.src = \${JSON.stringify(wavUrl)};
        a.load();
      })
    \`);
    results.push({ name: 'PAUSE_OVER_10S_RESUME', ok: pauseResume.ok, detail: pauseResume.detail });

    // Snapshot BEFORE testing device revocation so we verify normal playback+seek+pause left ZERO false track failures
    const diagBeforeRevoke = client.getClientDiagnosticsSnapshot();

    // Revoke client device cleanly
    const enrolledDevices = host.getSnapshot().authorizedDevices;
    host.revokeDevice(enrolledDevices[0].deviceId);
    const blockedAfterRevoke = await client.resolveRemoteTrackMediaResponse(new Request(wavUrl));
    const diagAfterRevoke = client.getClientDiagnosticsSnapshot();
    results.push({
      name: 'REVOKED_DEVICE_REJECTED',
      ok: blockedAfterRevoke.status === 401 || blockedAfterRevoke.status === 403,
      detail: 'status=' + blockedAfterRevoke.status + ' diagLastCode=' + diagAfterRevoke.lastErrorCode,
    });

    await fs.writeFile(${JSON.stringify(outJson)}, JSON.stringify({ results, diagBeforeRevoke, clientDiag: diagAfterRevoke }, null, 2));
    win.destroy();
    await client.disconnect();
    await host.stop();
    clientConn.close();
    hostConn.close();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  } catch (err) {
    fsSync.writeFileSync(${JSON.stringify(outJson)}, JSON.stringify({ fatal: String((err as Error)?.stack || err), results }, null, 2));
  } finally {
    app.exit(0);
  }
}
void run();
`;

  await fs.writeFile(runnerTs, runnerSource, 'utf8');
  try {
    const esbuild = await import('esbuild');
    await esbuild.build({
      entryPoints: [runnerTs],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      banner: {
        js: `try{module.paths.unshift(${JSON.stringify(path.join(process.cwd(), 'node_modules').replace(/\\/g, '/'))});}catch{}`,
      },
      outfile: runnerCjs,
      external: ['electron', 'better-sqlite3', '@mgz-dev/alac', 'music-metadata'],
      loader: { '.ts': 'ts' },
    });

    const childEnv = { ...process.env };
    delete childEnv.ELECTRON_RUN_AS_NODE;
    const res = spawnSync(
      path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
      [runnerCjs],
      { env: childEnv, windowsHide: true, timeout: 45_000 },
    );
    assert.equal(res.status, 0, `Electron E2E runner exited with status ${res.status}`);
    const parsed = JSON.parse(await fs.readFile(outJson, 'utf8')) as {
      fatal?: string;
      results: Array<{ name: string; ok: boolean; detail: string }>;
      diagBeforeRevoke?: { lastTrackFailure: unknown };
      clientDiag?: { lastTrackFailure: { errorCode?: string } | null };
    };
    assert.ok(!parsed.fatal, `Electron E2E fatal error: ${parsed.fatal}`);
    assert.equal(parsed.results.length, 9);
    for (const r of parsed.results) {
      assert.equal(r.ok, true, `Chromium E2E scenario ${r.name} failed: ${r.detail}`);
    }
    assert.equal(
      parsed.diagBeforeRevoke?.lastTrackFailure ?? null,
      null,
      'Normal playback + seek + pause scenarios must NOT log false lastTrackFailure',
    );
    assert.equal(
      parsed.clientDiag?.lastTrackFailure?.errorCode,
      'ERR_REMOTE_ACCESS_REVOKED',
    );
  } finally {
    await fs.rm(runnerTs, { force: true }).catch(() => {});
    await fs.rm(runnerCjs, { force: true }).catch(() => {});
    await fs.rm(outJson, { force: true }).catch(() => {});
  }
});
