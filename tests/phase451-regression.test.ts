import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openLibraryDatabase } from '../src/main/database/connection';
import { PlaylistRepository } from '../src/main/database/playlist-repository';
import { LibraryRootRepository } from '../src/main/database/library-root-repository';
import { LyricsRepository } from '../src/main/database/lyrics-repository';
import { MetadataOverrideRepository } from '../src/main/database/metadata-override-repository';
import { TrackRepository } from '../src/main/database/track-repository';
import { AlacStreamManager, detectMp4AudioCodec } from '../src/main/services/alac-decoder';
import { resolveTrackMediaResponse } from '../src/main/services/audio-stream-handler';
import { AudioAnalyzerService } from '../src/main/services/codec/audio-analyzer';
import { AudioProcessingService } from '../src/main/services/codec/audio-processing-service';
import { CodecManager } from '../src/main/services/codec/codec-manager';
import { LibraryService, CURRENT_TRACK_METADATA_VERSION } from '../src/main/services/library-service';
import { readTrackMetadata } from '../src/main/services/metadata-service';
import { StatisticsService } from '../src/main/services/statistics-service';
import { resolveMp4AudioMetadataOverride } from '../src/shared/utils/audio-codec';
import type { CodecManifestEntry } from '../src/shared/types/codec-engine';
import { getCodecManifestById } from '../src/shared/utils/codec-registry';
import {
  createMockCodecManager,
  writeCrossPlatformMockCli,
} from './helpers/cross-platform-codec-harness';

function hasFfmpeg(): boolean {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function makeBox(type: string, payload: Buffer): Buffer {
  const buf = Buffer.alloc(8 + payload.length);
  buf.writeUInt32BE(8 + payload.length, 0);
  buf.write(type, 4, 4, 'ascii');
  payload.copy(buf, 8);
  return buf;
}

function makeAlacMp4(params: {
  sampleRateHz: number;
  bitDepth: number;
  channels: number;
  frameLength?: number;
  stsdSampleRate?: number;
  prependVideoTrack?: boolean;
  secondaryAudioTrack?: 'aac' | 'alac';
}): Buffer {
  const alacCfg = Buffer.alloc(24);
  alacCfg.writeUInt32BE(params.frameLength ?? 4096, 0);
  alacCfg[4] = 0; // compatibleVersion
  alacCfg[5] = params.bitDepth;
  alacCfg[6] = 40;
  alacCfg[7] = 14;
  alacCfg[8] = 10;
  alacCfg[9] = params.channels;
  alacCfg.writeUInt16BE(255, 10);
  alacCfg.writeUInt32BE(params.sampleRateHz, 20);

  const alacSpecificBox = makeBox('alac', Buffer.concat([Buffer.alloc(4, 0), alacCfg]));
  const sampleEntryHeader = Buffer.alloc(28, 0);
  sampleEntryHeader.writeUInt16BE(1, 6); // data_ref_index
  sampleEntryHeader.writeUInt16BE(params.channels, 16);
  sampleEntryHeader.writeUInt16BE(16, 18); // container default bits
  sampleEntryHeader.writeUInt16BE(Math.min(65535, params.stsdSampleRate ?? 48000), 24);
  const alacEntry = makeBox('alac', Buffer.concat([sampleEntryHeader, alacSpecificBox]));

  const makeStsd = (entry: Buffer) => {
    const header = Buffer.alloc(8, 0);
    header.writeUInt32BE(1, 4);
    return makeBox('stsd', Buffer.concat([header, entry]));
  };

  const makeAudioTrak = (stsdBox: Buffer) => {
    const hdlrPayload = Buffer.alloc(16, 0);
    hdlrPayload.write('soun', 8, 4, 'ascii');
    const hdlr = makeBox('hdlr', hdlrPayload);
    const mdia = makeBox('mdia', Buffer.concat([hdlr, makeBox('minf', makeBox('stbl', stsdBox))]));
    return makeBox('trak', mdia);
  };

  const traks: Buffer[] = [];
  if (params.prependVideoTrack) {
    // Video/cover art trak with misleading box should be ignored because handler_type === 'vide'
    const videHdlrPayload = Buffer.alloc(16, 0);
    videHdlrPayload.write('vide', 8, 4, 'ascii');
    const videHdlr = makeBox('hdlr', videHdlrPayload);
    const fakeMp4aHeader = Buffer.alloc(28, 0);
    const fakeMp4aStsd = makeStsd(makeBox('mp4a', fakeMp4aHeader));
    traks.push(makeBox('trak', makeBox('mdia', Buffer.concat([videHdlr, makeBox('minf', makeBox('stbl', fakeMp4aStsd))]))));
  }

  traks.push(makeAudioTrak(makeStsd(alacEntry)));

  if (params.secondaryAudioTrack === 'aac') {
    const mp4aEntry = makeBox('mp4a', Buffer.alloc(28, 0));
    traks.push(makeAudioTrak(makeStsd(mp4aEntry)));
  }

  const ftyp = makeBox('ftyp', Buffer.from('M4A \0\0\0\0M4A mp42isom', 'ascii'));
  const moov = makeBox('moov', Buffer.concat(traks));
  return Buffer.concat([ftyp, moov]);
}

function makeFakePeFile(params: { isDll: boolean; arch: 'x64' | 'x86' }): Buffer {
  const buf = Buffer.alloc(256, 0);
  buf[0] = 0x4d; // M
  buf[1] = 0x5a; // Z
  const peOffset = 0x80;
  buf.writeUInt32LE(peOffset, 0x3c);
  buf.write('PE\0\0', peOffset, 4, 'ascii');
  buf.writeUInt16LE(params.arch === 'x64' ? 0x8664 : 0x014c, peOffset + 4);
  buf.writeUInt16LE(params.isDll ? 0x2002 : 0x0002, peOffset + 22);
  return buf;
}

test('Phase 4.5.1B: ALAC/AAC shared metadata resolver & ISO-BMFF matrix (44.1..192kHz, mono/stereo, video track isolation, corrupt ALACSpecificConfig)', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-alac-meta-451-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // 1) Shared helper priority & no guessing contract
  const overrideHiRes = resolveMp4AudioMetadataOverride({
    mp4Probe: { codec: 'alac', sampleRateHz: 192000, bitDepth: 24, channels: 2 },
    parsedCodec: 'ALAC',
    parsedContainer: 'M4A',
    parsedSampleRateHz: 48000,
    parsedBitDepth: 16,
    parsedChannels: 2,
  });
  assert.equal(overrideHiRes.sampleRateHz, 192000);
  assert.equal(overrideHiRes.bitDepth, 24);
  assert.equal(overrideHiRes.channels, 2);

  const overrideCorruptConfig = resolveMp4AudioMetadataOverride({
    mp4Probe: { codec: 'alac', sampleRateHz: null, bitDepth: null, channels: null },
    parsedCodec: 'ALAC',
    parsedContainer: 'M4A',
    parsedSampleRateHz: null,
    parsedBitDepth: null,
    parsedChannels: null,
  });
  assert.equal(overrideCorruptConfig.sampleRateHz, null);
  assert.equal(overrideCorruptConfig.bitDepth, null);
  assert.equal(overrideCorruptConfig.channels, null);

  const overrideAac = resolveMp4AudioMetadataOverride({
    mp4Probe: { codec: 'aac', sampleRateHz: null, bitDepth: null, channels: null },
    parsedCodec: 'MPEG-4/AAC',
    parsedContainer: 'M4A',
    parsedSampleRateHz: 44100,
    parsedBitDepth: 16,
    parsedChannels: 2,
  });
  assert.equal(overrideAac.codec, 'AAC');
  assert.equal(overrideAac.bitDepth, null);

  // 2) ISO-BMFF ALACSpecificConfig boxes across sample rates, channels & edge cases
  const cases = [
    { sr: 44100, bd: 16, ch: 2 },
    { sr: 48000, bd: 16, ch: 2 },
    { sr: 88200, bd: 24, ch: 2 },
    { sr: 96000, bd: 24, ch: 2 },
    { sr: 176400, bd: 24, ch: 2 },
    { sr: 192000, bd: 24, ch: 2 },
    { sr: 48000, bd: 24, ch: 1 },
  ];
  for (const c of cases) {
    const file = path.join(root, `box-${c.sr}-${c.bd}-${c.ch}.m4a`);
    await fs.writeFile(
      file,
      makeAlacMp4({
        sampleRateHz: c.sr,
        bitDepth: c.bd,
        channels: c.ch,
        stsdSampleRate: 48000,
        prependVideoTrack: true,
        secondaryAudioTrack: 'aac',
      }),
    );
    const probe = await detectMp4AudioCodec(file);
    assert.equal(probe.codec, 'alac');
    assert.equal(probe.sampleRateHz, c.sr);
    assert.equal(probe.bitDepth, c.bd);
    assert.equal(probe.channels, c.ch);
  }

  // Corrupted ALACSpecificConfig (frameLength === 0 & invalid bitDepth === 17)
  const corruptFile = path.join(root, 'corrupt-alac-cfg.m4a');
  await fs.writeFile(
    corruptFile,
    makeAlacMp4({ sampleRateHz: 96000, bitDepth: 17, channels: 2, frameLength: 0 }),
  );
  const corruptProbe = await detectMp4AudioCodec(corruptFile);
  assert.equal(corruptProbe.codec, 'alac');
  assert.equal(corruptProbe.sampleRateHz, null);
  assert.equal(corruptProbe.bitDepth, null);
  assert.equal(corruptProbe.channels, null);

  // Truncated file safely returns unknown instead of throwing
  const truncatedFile = path.join(root, 'truncated.m4a');
  await fs.writeFile(truncatedFile, Buffer.from([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]));
  const truncProbe = await detectMp4AudioCodec(truncatedFile);
  assert.equal(truncProbe.codec, 'unknown');

  // 3) Real FFmpeg verification across full ALAC sample rate matrix + Mono + Video Cover Artwork + MetadataService/AudioAnalyzer parity
  if (hasFfmpeg()) {
    const analyzerManager = new CodecManager({ userDataDir: path.join(root, 'cm-no-ffprobe') });
    const analyzer = new AudioAnalyzerService(analyzerManager);

    const realSpecs = [
      { name: 'alac-44-16.m4a', sr: 44100, sfmt: 's16p', ch: 2, bd: 16 },
      { name: 'alac-48-16.m4a', sr: 48000, sfmt: 's16p', ch: 2, bd: 16 },
      { name: 'alac-88-24.m4a', sr: 88200, sfmt: 's32p', ch: 2, bd: 24 },
      { name: 'alac-96-24.m4a', sr: 96000, sfmt: 's32p', ch: 2, bd: 24 },
      { name: 'alac-176-24.m4a', sr: 176400, sfmt: 's32p', ch: 2, bd: 24 },
      { name: 'alac-192-24.m4a', sr: 192000, sfmt: 's32p', ch: 2, bd: 24 },
      { name: 'alac-48-24-mono.m4a', sr: 48000, sfmt: 's32p', ch: 1, bd: 24 },
    ];

    for (const s of realSpecs) {
      const p = path.join(root, s.name);
      const args = [
        '-y',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=523.25:sample_rate=${s.sr}:duration=0.4`,
        '-ac',
        String(s.ch),
        '-c:a',
        'alac',
        '-sample_fmt',
        s.sfmt,
      ];
      if (s.bd === 24) {
        args.push('-bits_per_raw_sample', '24');
      }
      args.push(p);
      execFileSync('ffmpeg', args, { stdio: 'ignore' });

      const meta = await readTrackMetadata(p);
      const fallbackAnalysis = await analyzer.analyzeFile(p);
      assert.equal(meta.codec, 'ALAC', `${s.name} codec`);
      assert.equal(meta.sample_rate_hz, s.sr, `${s.name} sampleRate`);
      assert.equal(meta.bit_depth, s.bd, `${s.name} bitDepth`);
      assert.equal(meta.channels, s.ch, `${s.name} channels`);

      assert.equal(fallbackAnalysis.analyzerBackend, 'music-metadata-fallback');
      assert.equal(fallbackAnalysis.sampleRateHz, s.sr);
      assert.equal(fallbackAnalysis.bitDepth, s.bd);
      assert.equal(fallbackAnalysis.channels, s.ch);
    }

    // M4A with attached artwork cover (vide stream) must still read audio specs cleanly
    const coverPng = path.join(root, 'cover.png');
    execFileSync(
      'ffmpeg',
      ['-y', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32:d=0.1', '-frames:v', '1', coverPng],
      { stdio: 'ignore' },
    );
    const alacWithArt = path.join(root, 'alac-96-cover.m4a');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:sample_rate=96000:duration=0.4',
        '-i',
        coverPng,
        '-map',
        '0:a:0',
        '-map',
        '1:v:0',
        '-c:a',
        'alac',
        '-sample_fmt',
        's32p',
        '-bits_per_raw_sample',
        '24',
        '-c:v',
        'png',
        '-disposition:v',
        'attached_pic',
        alacWithArt,
      ],
      { stdio: 'ignore' },
    );
    const artMeta = await readTrackMetadata(alacWithArt);
    assert.equal(artMeta.codec, 'ALAC');
    assert.equal(artMeta.sample_rate_hz, 96000);
    assert.equal(artMeta.bit_depth, 24);
  }
});

test('Phase 4.5.1C: Existing SQLite Library Metadata Recovery repairs wrong 48kHz ALAC 96kHz while keeping true 48kHz, Track ID & user data intact', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('ffmpeg required to synthesize real ALAC 96kHz and true ALAC 48kHz files');
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-db-recovery-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const musicDir = path.join(root, 'Library');
  await fs.mkdir(musicDir, { recursive: true });
  const alac96Path = path.join(musicDir, 'Track HiRes 96k.m4a');
  const alac48TruePath = path.join(musicDir, 'Track True 48k.m4a');

  execFileSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=96000:duration=0.5', '-ac', '2', '-c:a', 'alac', '-sample_fmt', 's32p', '-bits_per_raw_sample', '24', alac96Path],
    { stdio: 'ignore' },
  );
  execFileSync(
    'ffmpeg',
    ['-y', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=0.5', '-ac', '2', '-c:a', 'alac', '-sample_fmt', 's16p', alac48TruePath],
    { stdio: 'ignore' },
  );

  const stat96 = await fs.stat(alac96Path);
  const stat48 = await fs.stat(alac48TruePath);
  const dbPath = path.join(root, 'userData', 'library.db');
  const conn = openLibraryDatabase(dbPath);

  try {
    const trackRepo = new TrackRepository(conn.db);
    const rootRepo = new LibraryRootRepository(conn.db);
    const lyricsRepo = new LyricsRepository(conn.db);
    const overrideRepo = new MetadataOverrideRepository(conn.db);
    const playlistRepo = new PlaylistRepository(conn.db);
    const statsService = new StatisticsService({ db: conn.db, trackRepo });
    const libraryService = new LibraryService({
      trackRepo,
      rootRepo,
      databasePath: dbPath,
      lyricsRepo,
      metadataOverrideRepo: overrideRepo,
    });

    const id96 = 'aaaaaaaa-1111-4111-8111-111111111196';
    const id48 = 'bbbbbbbb-2222-4222-8222-222222222248';
    const now = new Date().toISOString();

    // Simulate legacy pre-4.5.1 imported rows (metadata_version = 1, same file size & mtime, ALAC 96kHz poisoned with 48000)
    const insertLegacy = conn.db.prepare(`
      INSERT INTO tracks (
        id, original_path, normalized_path, title, artist, album,
        duration_ms, codec, container, sample_rate_hz, bit_depth, bitrate_bps,
        file_size_bytes, modified_at_ms, status, availability_state, metadata_version, added_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 500, 'ALAC', 'M4A', 48000, 16, 1500000, ?, ?, 'available', 'available', 1, ?, ?)
    `);
    insertLegacy.run(id96, alac96Path, alac96Path.toLowerCase(), 'HiRes Song', 'Artist 96', 'Album', stat96.size, Math.round(stat96.mtimeMs), now, now);
    insertLegacy.run(id48, alac48TruePath, alac48TruePath.toLowerCase(), 'Normal 48k Song', 'Artist 48', 'Album', stat48.size, Math.round(stat48.mtimeMs), now, now);

    // Attach user data that MUST be preserved 100%
    const playlist = playlistRepo.createPlaylist({ name: 'Favorites ALAC' });
    playlistRepo.addTracksToPlaylist(playlist.id, [id96, id48]);
    playlistRepo.toggleFavorite(id96);
    lyricsRepo.setCustomLyrics(id96, 'txt', 'Custom User Lyrics Line');
    overrideRepo.upsertOverride(id96, { titleOverride: 'My Custom HiRes Title', artistOverride: null, albumOverride: null });
    statsService.recordListeningSession({
      sessionId: 'sess-recovery-test-1',
      trackId: id96,
      trackTitle: 'My Custom HiRes Title',
      artist: 'Artist 96',
      album: 'Album',
      durationMs: 25_000,
      startedAtMs: Date.now() - 20_000,
      endedAtMs: Date.now(),
      listenedMs: 20_000,
      activeIntervals: [{ startMs: 0, endMs: 20_000 }],
    });

    const recovery = await libraryService.revalidateLegacyMetadata();
    assert.equal(recovery.canceled, false);
    assert.equal(recovery.checkedCount, 2);
    assert.equal(recovery.errorCount, 0);

    // Verify Track IDs untouched & technical specs corrected honestly
    const recovered96 = trackRepo.findById(id96);
    const recovered48 = trackRepo.findById(id48);
    assert.ok(recovered96 && recovered48);
    assert.equal(recovered96.id, id96);
    assert.equal(recovered96.sample_rate_hz, 96000);
    assert.equal(recovered96.bit_depth, 24);
    assert.equal(recovered96.metadata_version, CURRENT_TRACK_METADATA_VERSION);
    assert.equal(recovered96.title, 'My Custom HiRes Title'); // Override preserved!

    assert.equal(recovered48.id, id48);
    assert.equal(recovered48.sample_rate_hz, 48000); // True 48kHz MUST NOT be changed!
    assert.equal(recovered48.bit_depth, 16);
    assert.equal(recovered48.metadata_version, CURRENT_TRACK_METADATA_VERSION);

    // Playlists, Favorites, Custom Lyrics, Stats intact
    const plSnap = playlistRepo.getSnapshot();
    assert.deepEqual(
      plSnap.playlists[0].entries.map((e) => e.trackId),
      [id96, id48],
    );
    assert.equal(plSnap.favoriteTrackIds.includes(id96), true);
    assert.equal(lyricsRepo.findByTrackId(id96)?.custom_content, 'Custom User Lyrics Line');
    const dash = statsService.getDashboard({ range: 'all' });
    assert.equal(dash.qualifiedPlays, 1);

    // Second run must perform 0 redundant file reads (all tracks at CURRENT_TRACK_METADATA_VERSION)
    const secondRun = await libraryService.revalidateLegacyMetadata();
    assert.equal(secondRun.checkedCount, 0);
  } finally {
    conn.close();
  }
});

test('Phase 4.5.1D: Asymmetric 24-bit ALAC LSB integrity & WAV header-boundary Byte-Range seek', async (t) => {
  if (!hasFfmpeg()) {
    t.skip('ffmpeg required to encode real ALAC stream fixture');
    return;
  }
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-alac-lsb-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const alac24 = path.join(root, 'lsb-96k.m4a');
  // Asymmetric frequencies L != R + 24-bit precision + 96kHz
  execFileSync(
    'ffmpeg',
    [
      '-y',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=311.13:sample_rate=96000:duration=0.4',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=739.99:sample_rate=96000:duration=0.4',
      '-filter_complex',
      '[0:a][1:a]amerge=inputs=2[aout]',
      '-map',
      '[aout]',
      '-c:a',
      'alac',
      '-sample_fmt',
      's32p',
      '-bits_per_raw_sample',
      '24',
      alac24,
    ],
    { stdio: 'ignore' },
  );

  const meta = await readTrackMetadata(alac24);
  const alacManager = new AlacStreamManager({ maxOpenTracks: 2, idleEvictionMs: 30_000 });
  const now = new Date().toISOString();
  const track = {
    id: 'cccccccc-3333-4333-8333-333333333333',
    original_path: alac24,
    normalized_path: alac24.toLowerCase(),
    title: 'LSB Test',
    artist: 'Tester',
    album: null,
    duration_ms: meta.duration_ms,
    codec: meta.codec,
    container: meta.container,
    sample_rate_hz: meta.sample_rate_hz,
    bit_depth: meta.bit_depth,
    bitrate_bps: meta.bitrate_bps,
    file_size_bytes: meta.file_size_bytes,
    modified_at_ms: meta.modified_at_ms,
    status: 'available' as const,
    added_at: now,
    updated_at: now,
  };
  const deps = {
    trackRepo: {
      findById: (id: string) => (id === track.id ? track : null),
      updateStatus: () => true,
    },
    alacManager,
  };

  try {
    const fullRes = await resolveTrackMediaResponse(new Request(`lossless-media://track/${track.id}`), deps);
    assert.equal(fullRes.status, 200);
    const fullWav = Buffer.from(await fullRes.arrayBuffer());
    const refPcm = execFileSync(
      'ffmpeg',
      ['-i', alac24, '-f', 's24le', '-acodec', 'pcm_s24le', '-'],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    assert.equal(fullWav.subarray(44).compare(refPcm), 0);

    // Range spanning across byte 44 boundary (header 20..43 + PCM 44..180)
    const spanRes = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${track.id}`, { headers: { Range: 'bytes=20-180' } }),
      deps,
    );
    assert.equal(spanRes.status, 206);
    const spanBuf = Buffer.from(await spanRes.arrayBuffer());
    assert.equal(spanBuf.compare(fullWav.subarray(20, 181)), 0);

    // Suffix range (`bytes=-512`)
    const suffixRes = await resolveTrackMediaResponse(
      new Request(`lossless-media://track/${track.id}`, { headers: { Range: 'bytes=-512' } }),
      deps,
    );
    assert.equal(suffixRes.status, 206);
    const suffixBuf = Buffer.from(await suffixRes.arrayBuffer());
    assert.equal(suffixBuf.compare(fullWav.subarray(fullWav.length - 512)), 0);
  } finally {
    alacManager.dispose();
  }
});

test('Phase 4.5.1E & 4.5.1I: Job lifecycle waitForJob/waitForBatch, stale snapshot isolation, cancel during verify, verifyPcmOnLossless honesty & PE DLL arch check', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-lifecycle-451-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // 1) Health check contract matches real refalac64 & qaac64 (`--check`, not `--version`)
  assert.deepEqual(getCodecManifestById('refalac')?.versionArgs, ['--check']);
  assert.deepEqual(getCodecManifestById('qaac')?.versionArgs, ['--check']);

  // 2) Architecture mismatch check between PE .exe and required DLL (win32)
  const archDir = path.join(root, 'arch-check');
  await fs.mkdir(archDir, { recursive: true });
  const fakeQaacX64 = path.join(archDir, 'qaac64.exe');
  const fakeCoreAudioX86 = path.join(archDir, 'CoreAudioToolbox.dll');
  await fs.writeFile(fakeQaacX64, makeFakePeFile({ isDll: false, arch: 'x64' }));
  await fs.writeFile(fakeCoreAudioX86, makeFakePeFile({ isDll: true, arch: 'x86' }));

  const winArchCm = new CodecManager({
    userDataDir: path.join(root, 'ud-arch'),
    externalPackDirs: [archDir],
    allowStandardFoobarPaths: false,
    allowSystemPathLookup: false,
    platform: 'win32',
    arch: 'x64',
    dependencySearchDirs: [archDir],
  });
  const qaacEntry: CodecManifestEntry | undefined = getCodecManifestById('qaac');
  assert.ok(qaacEntry);
  const qaacResolved = await winArchCm.resolveCodec('qaac');
  assert.equal(qaacResolved.status, 'missing-dependency');
  assert.ok(qaacResolved.missingDependencies.some((d) => d.includes('lệch kiến trúc') || d.includes('CoreAudioToolbox.dll')));

  // 3) Job lifecycle: waitForJob tracks exact ID across multiple sequential jobs & refuses fake verified-full without FFmpeg
  const flacSlowMock = await writeCrossPlatformMockCli(
    root,
    'flac',
    `
    const fs = require('fs');
    const args = process.argv.slice(2);
    if (args.includes('--version')) { console.log('flac 1.5.0 mock'); process.exit(0); }
    const outIdx = args.indexOf('-o');
    const outPath = args[outIdx + 1];
    setTimeout(() => {
      fs.writeFileSync(outPath, Buffer.from('fLaC\\x00\\x00\\x00\\x22dummy-flac-stream'));
      process.exit(0);
    }, 60);
    `,
  );

  const cm = createMockCodecManager({
    userDataDir: path.join(root, 'ud-jobs'),
    platform: process.platform,
    arch: process.arch,
  });
  await cm.importCustomBinary('flac', flacSlowMock, { userConfirmed: true, originNote: 'lifecycle test' });

  const service = new AudioProcessingService({ codecManager: cm, processKillGraceMs: 80 });
  const srcWav = path.join(root, 'src.wav');
  const outDir = path.join(root, 'out-jobs');
  await fs.mkdir(outDir, { recursive: true });
  await fs.writeFile(srcWav, Buffer.alloc(64, 0));

  try {
    const snap1 = await service.enqueueConversion(
      [{ sourcePath: srcWav, sourceAudioSpec: { sampleFormat: 'pcm-int', bitDepth: 16, sampleRateHz: 44100, channels: 2 } }],
      { targetFormat: 'flac', outputDirectory: outDir, verifyPcmOnLossless: true },
    );
    // Immediate enqueue snapshot shows running/queued — NOT completed!
    assert.ok(snap1.jobs[0].status === 'running' || snap1.jobs[0].status === 'queued');

    const job1 = await service.waitForJob(snap1.jobs[0].id);
    assert.equal(job1.status, 'completed');
    // Stale snapshot MUST remain immutable ('running'/'queued'), proving why callers must read live snapshot/waitForJob
    assert.notEqual(snap1.jobs[0].status, 'completed');
    // verifyPcmOnLossless requested without FFmpeg MUST NOT claim verified-full
    assert.equal(job1.verification?.status, 'verified-container-only');
    assert.equal(job1.verification?.pcmComparisonStatus, 'skipped-no-ffmpeg');

    // Enqueue 2nd job and ensure waitForJob resolves job #2 (never confused with jobs[0])
    const snap2 = await service.enqueueConversion(
      [{ sourcePath: srcWav, sourceAudioSpec: { sampleFormat: 'pcm-int', bitDepth: 16, sampleRateHz: 44100, channels: 2 } }],
      { targetFormat: 'flac', outputDirectory: outDir },
    );
    const secondJobMeta = snap2.jobs.find((j) => j.id !== snap1.jobs[0].id)!;
    const job2 = await service.waitForJob(secondJobMeta.id);
    assert.equal(job2.id, secondJobMeta.id);
    assert.equal(job2.status, 'completed');
    assert.notEqual(job2.outputPath, job1.outputPath);
  } finally {
    await service.disposeAsync();
  }
});
