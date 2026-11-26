import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AudioProcessingService,
  arePathsSamePhysicalFile,
  resolveConversionOutputPath,
  validateOutputPathSafety,
  verifyAudioContainerHeader,
} from '../src/main/services/codec/audio-processing-service';
import {
  FfmpegCapabilityDetector,
  parseFfmpegDecodersOutput,
  parseFfmpegEncodersOutput,
  parseFfmpegFormatsOutput,
  parseFfmpegSampleFormatsOutput,
} from '../src/main/services/codec/ffmpeg-capabilities';
import { ResourcePolicyManager } from '../src/main/services/codec/resource-policy';
import {
  createMockCodecManager,
  createSimulatedPathSafetyOps,
  probeOsLinkSupport,
  writeCrossPlatformMockCli,
} from './helpers/cross-platform-codec-harness';
import type {
  CodecId,
  ConversionProgressEvent,
  FfmpegCapabilities,
  SourceAudioSpec,
} from '../src/shared/types/codec-engine';
import {
  buildConversionCommandPlan,
  buildStreamingTranscodePlan,
  normalizeConvertOptions,
  resolveFfmpegEncoderForTarget,
  resolvePcmCodecForTarget,
} from '../src/shared/utils/codec-command-builder';
import { SERVER_TRANSCODING_PROFILES } from '../src/shared/utils/codec-registry';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMockExecutable(dir: string, fileName: string, scriptBody: string): Promise<string> {
  return writeCrossPlatformMockCli(dir, fileName, scriptBody);
}

function createFakeWavBuffer(): Buffer {
  // Minimal valid 44-byte RIFF/WAVE header + 16 bytes of PCM samples
  const buf = Buffer.alloc(60, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(52, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(2, 22); // stereo
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(44100 * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(16, 40);
  return buf;
}

test('Phase 03B Conversion: normalizeConvertOptions defaults concurrency to 1 (Power Saving) and caps by resource mode', () => {
  const defaults = normalizeConvertOptions();
  assert.equal(defaults.concurrency, 1);
  assert.equal(defaults.resourceMode, 'power-saving');

  // Power Saving caps concurrency at 1 even if caller asks for 4
  const clampedPowerSaving = normalizeConvertOptions({ concurrency: 4, resourceMode: 'power-saving' });
  assert.equal(clampedPowerSaving.concurrency, 1);

  const balanced = normalizeConvertOptions({ concurrency: 4, resourceMode: 'balanced' });
  assert.equal(balanced.concurrency, 2);

  const performance = normalizeConvertOptions({ concurrency: 8, resourceMode: 'performance' });
  assert.equal(performance.concurrency, 3);
});

test('Phase 03B Conversion: preserves exact source bit depth (16/24/32/float) without silently forcing 24-bit', () => {
  const pcm16 = resolvePcmCodecForTarget({
    bitDepthOption: 'source',
    sourceSpec: { bitDepth: 16, sampleFormat: 'pcm-int' },
    targetFormat: 'wav',
    allowFloatPcm: true,
  });
  assert.equal(pcm16.pcmCodec, 'pcm_s16le');

  const pcm24 = resolvePcmCodecForTarget({
    bitDepthOption: 'source',
    sourceSpec: { bitDepth: 24, sampleFormat: 'pcm-int' },
    targetFormat: 'wav',
    allowFloatPcm: true,
  });
  assert.equal(pcm24.pcmCodec, 'pcm_s24le');

  const pcm32Int = resolvePcmCodecForTarget({
    bitDepthOption: 'source',
    sourceSpec: { bitDepth: 32, sampleFormat: 'pcm-int' },
    targetFormat: 'wav',
    allowFloatPcm: true,
  });
  assert.equal(pcm32Int.pcmCodec, 'pcm_s32le');

  const pcm32FloatWav = resolvePcmCodecForTarget({
    bitDepthOption: 'source',
    sourceSpec: { bitDepth: 32, sampleFormat: 'pcm-float' },
    targetFormat: 'wav',
    allowFloatPcm: true,
  });
  assert.equal(pcm32FloatWav.pcmCodec, 'pcm_f32le');

  const pcm64FloatWav = resolvePcmCodecForTarget({
    bitDepthOption: 'source',
    sourceSpec: { bitDepth: 64, sampleFormat: 'pcm-float' },
    targetFormat: 'wav',
    allowFloatPcm: true,
  });
  assert.equal(pcm64FloatWav.pcmCodec, 'pcm_f64le');

  // Float PCM -> FLAC cannot stay float; emits honest warning
  const floatToFlac = resolvePcmCodecForTarget({
    bitDepthOption: 'source',
    sourceSpec: { bitDepth: 32, sampleFormat: 'pcm-float' },
    targetFormat: 'flac',
    allowFloatPcm: false,
  });
  assert.equal(floatToFlac.pcmCodec, 'pcm_s24le');
  assert.ok(floatToFlac.warning && floatToFlac.warning.includes('float'));

  // Unknown source bit depth never silently claims 24-bit without warning
  const unknownSpec = resolvePcmCodecForTarget({
    bitDepthOption: 'source',
    sourceSpec: undefined,
    targetFormat: 'wav',
    allowFloatPcm: true,
  });
  assert.equal(unknownSpec.pcmCodec, null);
  assert.ok(unknownSpec.warning);
});

test('Phase 03B Conversion: preserves sample rate & multichannel, fixes lan-lossless-flac, and distinguishes attached_pic vs video', () => {
  const ready = new Set<CodecId>(['ffmpeg']);
  const sourceSpec: SourceAudioSpec = {
    codecName: 'flac',
    sampleRateHz: 96000,
    bitDepth: 24,
    channels: 6,
    sampleFormat: 'pcm-int',
    isLosslessCodec: true,
    hasAttachedPic: false,
    hasVideoStream: true,
  };

  // Preserves source sample rate & 6 channels (no -ar or -ac injected), strips regular video stream (never -map 0:v?)
  const flacPlan = buildConversionCommandPlan({
    sourcePath: '/music/surround.flac',
    outputPath: '/out/surround.wav',
    options: {
      targetFormat: 'wav',
      sampleRateHz: 'source',
      bitDepth: 'source',
      channels: 'source',
      preserveArtwork: true,
      preferNativeEncoder: false,
    },
    availableCodecs: ready,
    sourceAudioSpec: sourceSpec,
  });
  assert.ok(!flacPlan.steps[0].args.includes('-ar'));
  assert.ok(!flacPlan.steps[0].args.includes('-ac'));
  assert.ok(flacPlan.steps[0].args.includes('pcm_s24le'));
  assert.ok(!flacPlan.steps[0].args.includes('0:v?'));

  // When source HAS attached_pic, maps specifically 0:v:m:attached_pic? (not uncontrolled 0:v?)
  const withArtPlan = buildConversionCommandPlan({
    sourcePath: '/music/album.wav',
    outputPath: '/out/album.flac',
    options: {
      targetFormat: 'flac',
      preserveArtwork: true,
      preserveMetadata: true,
      preferNativeEncoder: false,
    },
    availableCodecs: ready,
    sourceAudioSpec: {
      ...sourceSpec,
      hasAttachedPic: true,
      hasVideoStream: false,
    },
  });
  assert.ok(withArtPlan.steps[0].args.includes('0:v:m:attached_pic?'));
  assert.ok(!withArtPlan.steps[0].args.includes('0:v?'));

  // When source has regular video stream (not attached_pic), strips video with -vn even if preserveArtwork is true
  const videoNotArtPlan = buildConversionCommandPlan({
    sourcePath: '/music/concert.mkv',
    outputPath: '/out/concert.flac',
    options: {
      targetFormat: 'flac',
      preserveArtwork: true,
      preferNativeEncoder: false,
    },
    availableCodecs: ready,
    sourceAudioSpec: {
      ...sourceSpec,
      hasAttachedPic: false,
      hasVideoStream: true,
    },
  });
  assert.ok(videoNotArtPlan.steps[0].args.includes('-vn'));
  assert.ok(!videoNotArtPlan.steps[0].args.includes('0:v:m:attached_pic?'));

  // Lossy -> Lossless conversion warns transparently
  const lossyToLossless = buildConversionCommandPlan({
    sourcePath: '/music/song.mp3',
    outputPath: '/out/song.flac',
    options: { targetFormat: 'flac', preferNativeEncoder: false },
    availableCodecs: ready,
    sourceAudioSpec: { codecName: 'mp3', isLosslessCodec: false, sampleFormat: 'lossy' },
  });
  assert.ok(lossyToLossless.warnings.some((w) => w.includes('lossy')));

  // Streaming profile lan-lossless-flac does NOT force `-ac 2`
  const lanProfile = SERVER_TRANSCODING_PROFILES.find((p) => p.id === 'lan-lossless-flac');
  assert.ok(lanProfile);
  assert.equal(lanProfile.channels, null);
  const streamPlan = buildStreamingTranscodePlan('/music/5.1.flac', lanProfile, ready);
  assert.ok(!streamPlan.args.includes('-ac'));
  assert.ok(!streamPlan.args.includes('-ar'));
});

test('Phase 03B Conversion: native adapters cover refalac, fhgaacenc, mpcenc & FFmpeg capability gating', () => {
  // refalac preferred over qaac for ALAC
  const refalacPlan = buildConversionCommandPlan({
    sourcePath: '/music/master.wav',
    outputPath: '/out/master.m4a',
    options: { targetFormat: 'alac', preferNativeEncoder: true },
    availableCodecs: new Set<CodecId>(['refalac', 'qaac', 'ffmpeg']),
  });
  assert.equal(refalacPlan.steps[0].codecId, 'refalac');

  // fhgaacenc used for AAC when qaac is absent
  const fhgPlan = buildConversionCommandPlan({
    sourcePath: '/music/master.wav',
    outputPath: '/out/master.m4a',
    options: { targetFormat: 'aac', bitrateKbps: 256, preferNativeEncoder: true },
    availableCodecs: new Set<CodecId>(['fhgaacenc', 'ffmpeg']),
  });
  assert.equal(fhgPlan.steps[0].codecId, 'fhgaacenc');

  // mpcenc used for Musepack SV8
  const mpcPlan = buildConversionCommandPlan({
    sourcePath: '/music/master.wav',
    outputPath: '/out/master.mpc',
    options: { targetFormat: 'mpc', musepackQuality: 6, preferNativeEncoder: true },
    availableCodecs: new Set<CodecId>(['mpcenc', 'ffmpeg']),
  });
  assert.equal(mpcPlan.steps[0].codecId, 'mpcenc');
  assert.ok(mpcPlan.steps[0].args.includes('--quality'));
  assert.ok(mpcPlan.steps[0].args.includes('6'));

  // Stock FFmpeg has NO mpc encoder -> throws cleanly instead of emitting broken `-c:a mpc8`
  assert.throws(() => {
    buildConversionCommandPlan({
      sourcePath: '/music/master.wav',
      outputPath: '/out/master.mpc',
      options: { targetFormat: 'mpc', preferNativeEncoder: false },
      availableCodecs: new Set<CodecId>(['ffmpeg']),
      ffmpegCapabilities: {
        executablePath: '/bin/ffmpeg',
        detectedAt: new Date().toISOString(),
        encoders: ['flac', 'alac', 'aac'],
        decoders: ['flac'],
        formats: ['wav', 'flac'],
        sampleFormats: ['s16', 's32'],
      },
    });
  }, /mpcenc|không tích hợp/i);

  // FFmpeg missing libmp3lame is detected cleanly by capability gating
  const limitedCaps: FfmpegCapabilities = {
    executablePath: '/bin/ffmpeg',
    detectedAt: new Date().toISOString(),
    encoders: ['flac', 'alac', 'aac'],
    decoders: ['flac'],
    formats: ['flac', 'mp4'],
    sampleFormats: ['s16', 's32'],
  };
  const mp3Check = resolveFfmpegEncoderForTarget('mp3', limitedCaps);
  assert.equal(mp3Check.supported, false);
  const aacCheck = resolveFfmpegEncoderForTarget('aac', limitedCaps);
  assert.equal(aacCheck.supported, true);
  assert.equal(aacCheck.encoderName, 'aac');
});

test('Phase 03B Conversion: FFmpeg capability parsers and cached trust-gated FfmpegCapabilityDetector', async () => {
  const encoders = parseFfmpegEncodersOutput(`
 Encoders:
  A....D flac                 FLAC (Free Lossless Audio Codec)
  A....D libmp3lame           libmp3lame MP3
  A....D libopus              libopus Opus
  `);
  assert.deepEqual(encoders, ['flac', 'libmp3lame', 'libopus']);

  const decoders = parseFfmpegDecodersOutput(`
  A....D alac                 ALAC (Apple Lossless Audio Codec)
  `);
  assert.deepEqual(decoders, ['alac']);

  const formats = parseFfmpegFormatsOutput(`
  DE flac            raw FLAC
  DE wav             WAV / WAVE
  `);
  assert.deepEqual(formats, ['flac', 'wav']);

  const sampleFmts = parseFfmpegSampleFormatsOutput(`
name   depth
s16       16
s32       32
fltp      32
  `);
  assert.deepEqual(sampleFmts, ['fltp', 's16', 's32']);

  // Trust-gated + cached FfmpegCapabilityDetector
  const tmp = await createTempDir('doremi-ffcaps-');
  const userData = path.join(tmp, 'userdata');
  const binDir = path.join(tmp, 'bins');
  const counterFile = path.join(tmp, 'count.txt');
  await fs.mkdir(binDir, { recursive: true });

  const mockFfmpeg = await writeMockExecutable(
    binDir,
    'ffmpeg',
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('-version')) {
      console.log('ffmpeg version 7.0-mock');
      process.exit(0);
    }
    const prev = fs.existsSync(${JSON.stringify(counterFile)}) ? Number(fs.readFileSync(${JSON.stringify(counterFile)}, 'utf8')) : 0;
    fs.writeFileSync(${JSON.stringify(counterFile)}, String(prev + 1));
    if (args.includes('-encoders')) {
      console.log(' A....D flac FLAC\\n A....D libmp3lame LAME\\n A....D libopus Opus');
    } else if (args.includes('-decoders')) {
      console.log(' A....D flac FLAC');
    } else if (args.includes('-formats')) {
      console.log(' DE flac raw FLAC');
    } else if (args.includes('-sample_fmts')) {
      console.log('s16 16\\ns32 32');
    }
    process.exit(0);
    `,
  );

  try {
    const codecManager = createMockCodecManager({
      userDataDir: userData,
      platform: process.platform,
      arch: process.arch,
    });
    const detector = new FfmpegCapabilityDetector(codecManager);

    // Before trusting/importing ffmpeg -> returns null without running anything
    assert.equal(await detector.detect(), null);

    // Import with user consent
    await codecManager.importCustomBinary('ffmpeg', mockFfmpeg, {
      userConfirmed: true,
      originNote: 'unit-test-mock',
    });

    const first = await detector.detect();
    assert.ok(first);
    assert.ok(first.encoders.includes('libmp3lame'));
    const callsAfterFirst = Number(await fs.readFile(counterFile, 'utf8'));
    assert.equal(callsAfterFirst, 4);

    // Second call hits stat cache -> zero extra spawns!
    const second = await detector.detect();
    assert.deepEqual(second?.encoders, first.encoders);
    const callsAfterSecond = Number(await fs.readFile(counterFile, 'utf8'));
    assert.equal(callsAfterSecond, 4);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Phase 03B Conversion: Source File Protection (canonical escape, simulated links, Windows case) & Output Collision Reservation Lock', async () => {
  const tmp = await createTempDir('doremi-protect-');
  const srcDir = path.join(tmp, 'src');
  const outDir = path.join(tmp, 'out');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  const sourcePath = path.join(srcDir, 'track.flac');
  await fs.writeFile(sourcePath, Buffer.from('fLaC-original-master-data'));

  try {
    // 1. Deterministic DI protection tests (always run regardless of kernel symlink privileges):
    //    a) Simulated file symlink inside outDir pointing back to sourcePath
    const symCandidate = path.join(outDir, 'track.flac');
    await fs.writeFile(symCandidate, Buffer.from('placeholder'));
    const simSymlinkOps = createSimulatedPathSafetyOps({
      realpathOverrides: { [symCandidate]: sourcePath },
      symlinkPaths: new Set([symCandidate]),
    });
    assert.equal(await arePathsSamePhysicalFile(sourcePath, symCandidate, process.platform, simSymlinkOps), true);
    const symlinkSafety = await validateOutputPathSafety({
      sourcePath,
      candidatePath: symCandidate,
      outputDir: outDir,
      fsOps: simSymlinkOps,
    });
    assert.equal(symlinkSafety.safe, false);

    //    b) Simulated directory junction inside outDir escaping to outside srcDir
    const junctionEscapedCandidate = path.join(outDir, 'linked-src', 'track.flac');
    const simJunctionOps = createSimulatedPathSafetyOps({
      realpathOverrides: {
        [path.join(outDir, 'linked-src')]: srcDir,
        [junctionEscapedCandidate]: sourcePath,
      },
    });
    const junctionSafety = await validateOutputPathSafety({
      sourcePath,
      candidatePath: junctionEscapedCandidate,
      outputDir: outDir,
      fsOps: simJunctionOps,
    });
    assert.equal(junctionSafety.safe, false);

    //    c) Simulated NTFS hard link sharing physical (dev, ino)
    const hardCandidate = path.join(outDir, 'hard-copy.flac');
    await fs.writeFile(hardCandidate, Buffer.from('hard-alias'));
    const simHardlinkOps = createSimulatedPathSafetyOps({
      sharedInodePaths: new Set([sourcePath, hardCandidate]),
    });
    assert.equal(await arePathsSamePhysicalFile(sourcePath, hardCandidate, process.platform, simHardlinkOps), true);

    const resolvedRedirect = await resolveConversionOutputPath({
      sourcePath,
      outputDir: outDir,
      extension: '.flac',
      conflictPolicy: 'overwrite',
      fsOps: simSymlinkOps,
    });
    assert.notEqual(path.resolve(resolvedRedirect.outputPath), path.resolve(symCandidate));
    assert.ok(resolvedRedirect.outputPath.includes('(Converted)'));
    await fs.rm(symCandidate);
    await fs.rm(hardCandidate);

    // 2. Output Path Collision Reservation across concurrent jobs
    const reserved = new Set<string>();
    const cleanOutDir = path.join(tmp, 'clean-out');
    await fs.mkdir(cleanOutDir, { recursive: true });

    const r1 = await resolveConversionOutputPath({
      sourcePath,
      outputDir: cleanOutDir,
      extension: '.mp3',
      conflictPolicy: 'rename',
      reservedPaths: reserved,
    });
    reserved.add(path.resolve(r1.outputPath));

    const r2 = await resolveConversionOutputPath({
      sourcePath,
      outputDir: cleanOutDir,
      extension: '.mp3',
      conflictPolicy: 'rename',
      reservedPaths: reserved,
    });
    assert.notEqual(r1.outputPath, r2.outputPath);
    assert.ok(r2.outputPath.includes('(1).mp3'));

    // Skip policy respects reservation too
    const rSkip = await resolveConversionOutputPath({
      sourcePath,
      outputDir: cleanOutDir,
      extension: '.mp3',
      conflictPolicy: 'skip',
      reservedPaths: reserved,
    });
    assert.equal(rSkip.skipped, true);

    // Overwrite policy detects active reservation conflict so caller serializes instead of clobbering
    const rOverwrite = await resolveConversionOutputPath({
      sourcePath,
      outputDir: cleanOutDir,
      extension: '.mp3',
      conflictPolicy: 'overwrite',
      reservedPaths: reserved,
    });
    assert.equal(rOverwrite.conflictWithReservation, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Phase 4.5C OS Reparse Integration: real kernel file symlink, directory junction & hardlink safety when OS permits', async (t) => {
  const caps = await probeOsLinkSupport();
  if (!caps.fileSymlink && !caps.junction && !caps.hardLink) {
    t.skip(
      `OS kernel reparse links blocked in current environment (fileSymlink=${caps.fileSymlinkErrorCode}, junction=${caps.junctionErrorCode}, hardLink=${caps.hardLinkErrorCode}). Run outside restricted sandbox / with Developer Mode to verify OS kernel links.`,
    );
    return;
  }

  const tmp = await createTempDir('doremi-os-reparse-');
  const srcDir = path.join(tmp, 'src');
  const outDir = path.join(tmp, 'out');
  await fs.mkdir(srcDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  const sourcePath = path.join(srcDir, 'track.flac');
  await fs.writeFile(sourcePath, Buffer.from('fLaC-real-os-reparse'));

  try {
    if (caps.fileSymlink) {
      const symlinkDest = path.join(outDir, 'sym-track.flac');
      await fs.symlink(sourcePath, symlinkDest, 'file');
      assert.equal(await arePathsSamePhysicalFile(sourcePath, symlinkDest), true);
      assert.equal((await validateOutputPathSafety({ sourcePath, candidatePath: symlinkDest, outputDir: outDir })).safe, false);
    }
    if (caps.junction) {
      const junctionDir = path.join(outDir, 'junction-src');
      await fs.symlink(srcDir, junctionDir, 'junction');
      const junctionCandidate = path.join(junctionDir, 'track.flac');
      assert.equal(await arePathsSamePhysicalFile(sourcePath, junctionCandidate), true);
      assert.equal((await validateOutputPathSafety({ sourcePath, candidatePath: junctionCandidate, outputDir: outDir })).safe, false);
    }
    if (caps.hardLink) {
      const hardDest = path.join(outDir, 'hard-track.flac');
      await fs.link(sourcePath, hardDest);
      assert.equal(await arePathsSamePhysicalFile(sourcePath, hardDest), true);
      assert.equal((await validateOutputPathSafety({ sourcePath, candidatePath: hardDest, outputDir: outDir })).safe, false);
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Phase 03B Conversion: Queue Pause/Resume, Honest Progress, Output Verification, Safe Overwrite & Cancel-vs-Retry Guard', async () => {
  const tmp = await createTempDir('doremi-queue-');
  const userData = path.join(tmp, 'userdata');
  const binDir = path.join(tmp, 'bins');
  const outDir = path.join(tmp, 'out');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  const wavSource = path.join(tmp, 'song.wav');
  await fs.writeFile(wavSource, createFakeWavBuffer());

  // Mock flac encoder: honors --version, writes valid "fLaC" header when encoding, supports slow mode via env or filename
  const mockFlac = await writeMockExecutable(
    binDir,
    'flac',
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('flac 1.4.3-mock');
      process.exit(0);
    }
    const outIdx = args.indexOf('-o');
    const outPath = outIdx >= 0 ? args[outIdx + 1] : null;
    const inPath = args[args.length - 1] || '';
    if (inPath.includes('corrupt')) {
      // Write invalid magic header to test Output Verification rejection
      fs.writeFileSync(outPath, Buffer.from('NOT_FLAC_GARBAGE_BYTES'));
      process.exit(0);
    }
    if (inPath.includes('slow')) {
      process.stderr.write('10% complete\\n');
      setTimeout(() => {
        if (outPath) {
          fs.writeFileSync(outPath, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(64, 1)]));
        }
        process.exit(0);
      }, 600);
      return;
    }
    process.stderr.write('50% complete\\n');
    setTimeout(() => {
      fs.writeFileSync(outPath, Buffer.concat([Buffer.from('fLaC'), Buffer.alloc(64, 7)]));
      process.exit(0);
    }, 40);
    `,
  );

  const codecManager = createMockCodecManager({
    userDataDir: userData,
    platform: process.platform,
    arch: process.arch,
  });
  await codecManager.importCustomBinary('flac', mockFlac, {
    userConfirmed: true,
    originNote: 'unit-test-flac',
  });

  const progressEvents: ConversionProgressEvent[] = [];
  const policy = new ResourcePolicyManager('power-saving');
  const service = new AudioProcessingService({
    codecManager,
    resourcePolicy: policy,
    onJobProgress: (ev) => progressEvents.push(ev),
  });

  try {
    // 1. Pause Queue prevents new queued jobs from starting until resumeQueue()
    service.pauseQueue();
    const pausedSnap = await service.enqueueConversion(
      [{ sourcePath: wavSource, title: 'Song 1' }],
      { targetFormat: 'flac', outputDirectory: outDir },
    );
    assert.equal(pausedSnap.isPaused, true);
    assert.equal(pausedSnap.queuedCount, 1);
    assert.equal(pausedSnap.activeCount, 0);

    service.resumeQueue();
    await service.waitForCleanup();

    const completedSnap = service.getQueueSnapshot();
    assert.equal(completedSnap.completedCount, 1);
    const job1 = completedSnap.jobs[0];
    assert.equal(job1.status, 'completed');
    assert.equal(job1.verification?.status, 'verified-container-only');
    assert.equal(job1.verification?.containerHeaderValid, true);
    assert.ok(job1.outputPath && (await fs.stat(job1.outputPath)).size > 0);

    // Verify honest progress: NEVER emitted hardcoded 2% on start!
    const job1Events = progressEvents.filter((e) => e.jobId === job1.id);
    assert.equal(job1Events[0].progressPercent, 0);
    assert.equal(job1Events[0].progressMode, 'indeterminate');
    assert.ok(!job1Events.some((e) => e.progressPercent === 2));
    assert.equal(job1Events[job1Events.length - 1].progressPercent, 100);

    // 2. Output verification rejects corrupt output & preserves existing file during overwrite!
    const corruptSource = path.join(tmp, 'corrupt.wav');
    await fs.writeFile(corruptSource, createFakeWavBuffer());
    const existingGoodOut = path.join(outDir, 'corrupt.flac');
    await fs.writeFile(existingGoodOut, Buffer.from('fLaC-ORIGINAL-EXISTING-OUTPUT'));

    await service.enqueueConversion([{ sourcePath: corruptSource, title: 'Corrupt' }], {
      targetFormat: 'flac',
      outputDirectory: outDir,
      conflictPolicy: 'overwrite',
    });
    await service.waitForCleanup();

    const corruptJob = service.getQueueSnapshot().jobs.find((j) => j.title === 'Corrupt');
    assert.equal(corruptJob?.status, 'failed');
    assert.equal(corruptJob?.verification?.status, 'failed');
    // Existing destination file was NEVER clobbered by corrupt output!
    const preserved = await fs.readFile(existingGoodOut, 'utf8');
    assert.equal(preserved, 'fLaC-ORIGINAL-EXISTING-OUTPUT');

    // 3. Cancel-vs-Retry race guard: immediate retry while canceling is blocked until cleanup finishes
    const slowSource = path.join(tmp, 'slow.wav');
    await fs.writeFile(slowSource, createFakeWavBuffer());

    const slowSnap = await service.enqueueConversion([{ sourcePath: slowSource, title: 'Slow' }], {
      targetFormat: 'flac',
      outputDirectory: outDir,
    });
    const slowJobId = slowSnap.jobs.find((j) => j.title === 'Slow')!.id;

    // Wait briefly so child process spawns
    await new Promise((r) => setTimeout(r, 80));
    service.cancelJob(slowJobId);

    // Calling retryFailedJobs() immediately while cleanup is still in progress MUST NOT restart slowJob yet
    const immediateRetry = service.retryFailedJobs();
    const afterImmediate = immediateRetry.jobs.find((j) => j.id === slowJobId);
    assert.equal(afterImmediate?.status, 'canceled');

    // Once cleanup finishes, retryFailedJobs() safely re-queues and completes
    await service.waitForCleanup();
    service.retryFailedJobs();
    const afterSafeRetry = service.getQueueSnapshot().jobs.find((j) => j.id === slowJobId);
    assert.ok(afterSafeRetry?.status === 'queued' || afterSafeRetry?.status === 'running');
    await service.waitForCleanup();
  } finally {
    await service.disposeAsync();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Phase 03B Conversion: Startup & Inactivity/Stall Timeout kills hung encoder and cleans temp files', async () => {
  const tmp = await createTempDir('doremi-timeout-');
  const userData = path.join(tmp, 'userdata');
  const binDir = path.join(tmp, 'bins');
  const outDir = path.join(tmp, 'out');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  const wavSource = path.join(tmp, 'hang.wav');
  await fs.writeFile(wavSource, createFakeWavBuffer());

  // Mock flac that hangs silently forever on encode
  const hangingFlac = await writeMockExecutable(
    binDir,
    'flac',
    `
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('flac 1.4.3-hang');
      process.exit(0);
    }
    setInterval(() => {}, 10000);
    `,
  );

  const codecManager = createMockCodecManager({
    userDataDir: userData,
    platform: process.platform,
    arch: process.arch,
  });
  await codecManager.importCustomBinary('flac', hangingFlac, {
    userConfirmed: true,
    originNote: 'unit-test-hang',
  });

  const service = new AudioProcessingService({
    codecManager,
    startupTimeoutMs: 180,
    inactivityTimeoutMs: 250,
    processKillGraceMs: 100,
  });

  try {
    await service.enqueueConversion([{ sourcePath: wavSource, title: 'HangTest' }], {
      targetFormat: 'flac',
      outputDirectory: outDir,
    });
    await service.waitForCleanup();

    const job = service.getQueueSnapshot().jobs[0];
    assert.equal(job.status, 'failed');
    assert.ok(
      job.terminationReason === 'startup-timeout' || job.terminationReason === 'inactivity-timeout',
    );
    // No orphan temp files remain in outDir
    const outFiles = await fs.readdir(outDir);
    assert.equal(outFiles.filter((f) => f.startsWith('.doremi-tmp-')).length, 0);
  } finally {
    await service.disposeAsync();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Phase 03B Conversion: verifyAudioContainerHeader validates magic bytes per format', async () => {
  const tmp = await createTempDir('doremi-magic-');
  try {
    const flacFile = path.join(tmp, 'a.flac');
    await fs.writeFile(flacFile, Buffer.from('fLaC0000'));
    assert.equal((await verifyAudioContainerHeader(flacFile, 'flac')).valid, true);
    assert.equal((await verifyAudioContainerHeader(flacFile, 'wav')).valid, false);

    const wvFile = path.join(tmp, 'a.wv');
    await fs.writeFile(wvFile, Buffer.from('wvpk0000'));
    assert.equal((await verifyAudioContainerHeader(wvFile, 'wv')).valid, true);

    const mpcFile = path.join(tmp, 'a.mpc');
    await fs.writeFile(mpcFile, Buffer.from('MPCK0000'));
    assert.equal((await verifyAudioContainerHeader(mpcFile, 'mpc')).valid, true);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Phase 03B Conversion: verified-full with FFprobe and lossless-to-lossless PCM comparison (matched & mismatch)', async () => {
  const tmp = await createTempDir('doremi-pcmcmp-');
  const userData = path.join(tmp, 'userdata');
  const binDir = path.join(tmp, 'bins');
  const outDir = path.join(tmp, 'out');
  await fs.mkdir(binDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  const wavMatch = path.join(tmp, 'match.wav');
  const wavMismatch = path.join(tmp, 'mismatch.wav');
  await fs.writeFile(wavMatch, createFakeWavBuffer());
  await fs.writeFile(wavMismatch, createFakeWavBuffer());

  // Mock flac writes valid fLaC output; for mismatch source writes marker bytes
  const mockFlac = await writeMockExecutable(
    binDir,
    'flac',
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('--version')) {
      console.log('flac 1.4.3-mock');
      process.exit(0);
    }
    const outIdx = args.indexOf('-o');
    const outPath = args[outIdx + 1];
    const inPath = args[args.length - 1];
    const tag = inPath.includes('mismatch') ? 'MISMATCH' : 'MATCH_OK';
    fs.writeFileSync(outPath, Buffer.from('fLaC' + tag));
    process.exit(0);
    `,
  );

  // Mock ffprobe reports valid FLAC audio stream
  const mockFfprobe = await writeMockExecutable(
    binDir,
    'ffprobe',
    `
    const args = process.argv.slice(2);
    if (args.includes('-version')) {
      console.log('ffprobe version 7.0-mock');
      process.exit(0);
    }
    console.log(JSON.stringify({
      streams: [{
        codec_type: 'audio',
        codec_name: 'flac',
        sample_fmt: 's16',
        sample_rate: '44100',
        bits_per_raw_sample: '16',
        channels: 2,
        duration: '10.0'
      }],
      format: { format_name: 'flac', duration: '10.0' }
    }));
    process.exit(0);
    `,
  );

  // Mock ffmpeg decodes to deterministic PCM bytes (identical for match, altered for mismatch)
  const mockFfmpeg = await writeMockExecutable(
    binDir,
    'ffmpeg',
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    if (args.includes('-version')) {
      console.log('ffmpeg version 7.0-mock');
      process.exit(0);
    }
    if (args.includes('-encoders')) {
      console.log(' A....D flac FLAC');
      process.exit(0);
    }
    if (args.includes('-decoders') || args.includes('-formats') || args.includes('-sample_fmts')) {
      process.exit(0);
    }
    const inIdx = args.indexOf('-i');
    const inPath = inIdx >= 0 ? args[inIdx + 1] : '';
    const data = fs.readFileSync(inPath);
    if (data.includes(Buffer.from('MISMATCH'))) {
      process.stdout.write(Buffer.from('ALTERED_PCM_STREAM_BYTES'));
    } else {
      process.stdout.write(Buffer.from('CANONICAL_PCM_STREAM_BYTES'));
    }
    process.exit(0);
    `,
  );

  const codecManager = createMockCodecManager({
    userDataDir: userData,
    platform: process.platform,
    arch: process.arch,
  });
  await codecManager.importCustomBinary('flac', mockFlac, { userConfirmed: true, originNote: 'test' });
  await codecManager.importCustomBinary('ffprobe', mockFfprobe, { userConfirmed: true, originNote: 'test' });
  await codecManager.importCustomBinary('ffmpeg', mockFfmpeg, { userConfirmed: true, originNote: 'test' });

  const service = new AudioProcessingService({ codecManager });
  try {
    await service.enqueueConversion(
      [
        {
          sourcePath: wavMatch,
          title: 'PcmMatch',
          sourceAudioSpec: {
            codecName: 'pcm_s16le',
            bitDepth: 16,
            sampleRateHz: 44100,
            channels: 2,
            sampleFormat: 'pcm-int',
            isLosslessCodec: true,
            durationSec: 10,
          },
        },
        {
          sourcePath: wavMismatch,
          title: 'PcmMismatch',
          sourceAudioSpec: {
            codecName: 'pcm_s16le',
            bitDepth: 16,
            sampleRateHz: 44100,
            channels: 2,
            sampleFormat: 'pcm-int',
            isLosslessCodec: true,
            durationSec: 10,
          },
        },
      ],
      {
        targetFormat: 'flac',
        outputDirectory: outDir,
        verifyPcmOnLossless: true,
      },
    );
    await service.waitForCleanup();

    const snap = service.getQueueSnapshot();
    const matchJob = snap.jobs.find((j) => j.title === 'PcmMatch');
    const mismatchJob = snap.jobs.find((j) => j.title === 'PcmMismatch');

    assert.equal(matchJob?.status, 'completed');
    assert.equal(matchJob?.verification?.status, 'verified-full');
    assert.equal(matchJob?.verification?.pcmComparisonStatus, 'matched');

    assert.equal(mismatchJob?.status, 'failed');
    assert.equal(mismatchJob?.verification?.status, 'failed');
    assert.equal(mismatchJob?.verification?.pcmComparisonStatus, 'mismatch');
  } finally {
    await service.disposeAsync();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
