import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { detectMp4AudioCodec } from '../src/main/services/alac-decoder';
import { AudioAnalyzerService } from '../src/main/services/codec/audio-analyzer';
import { AudioProcessingService } from '../src/main/services/codec/audio-processing-service';
import { CodecManager } from '../src/main/services/codec/codec-manager';
import { FfmpegCapabilityDetector } from '../src/main/services/codec/ffmpeg-capabilities';
import type {
  AudioAnalysisReport,
  CodecId,
  ConvertTargetFormat,
  SourceAudioSpec,
  SourceSampleFormat,
} from '../src/shared/types/codec-engine';
import { buildConversionCommandPlan } from '../src/shared/utils/codec-command-builder';

export interface StructuredWavFixture {
  id: string;
  filePath: string;
  sampleFormat: SourceSampleFormat;
  bitDepth: 16 | 24 | 32;
  validBits: 16 | 24 | 32;
  sampleRateHz: number;
  channels: 1 | 2;
  durationSec: number;
  frameCount: number;
  referencePcmSha256: string;
  sourceAudioSpec: SourceAudioSpec;
}

/**
 * Generates deterministic multi-feature PCM WAV fixtures with asymmetric L/R channels,
 * active 24-bit LSB values, negative/positive excursions, transients, and brief silence.
 */
async function createStructuredWavFixture(params: {
  dir: string;
  id: string;
  fileName: string;
  sampleFormat: 'pcm-int' | 'pcm-float';
  bitDepth: 16 | 24 | 32;
  sampleRateHz: number;
  channels: 1 | 2;
  durationSec: number;
}): Promise<StructuredWavFixture> {
  const { dir, id, fileName, sampleFormat, bitDepth, sampleRateHz, channels, durationSec } = params;
  const frameCount = Math.max(256, Math.round(sampleRateHz * durationSec));
  const bytesPerSample = bitDepth / 8;
  const blockAlign = channels * bytesPerSample;
  const dataSize = frameCount * blockAlign;
  const headerSize = 44;
  const wavBuf = Buffer.alloc(headerSize + dataSize);
  const pcmOnly = Buffer.alloc(dataSize);

  wavBuf.write('RIFF', 0, 'ascii');
  wavBuf.writeUInt32LE(36 + dataSize, 4);
  wavBuf.write('WAVE', 8, 'ascii');
  wavBuf.write('fmt ', 12, 'ascii');
  wavBuf.writeUInt32LE(16, 16);
  wavBuf.writeUInt16LE(sampleFormat === 'pcm-float' ? 3 : 1, 20);
  wavBuf.writeUInt16LE(channels, 22);
  wavBuf.writeUInt32LE(sampleRateHz, 24);
  wavBuf.writeUInt32LE(sampleRateHz * blockAlign, 28);
  wavBuf.writeUInt16LE(blockAlign, 32);
  wavBuf.writeUInt16LE(bitDepth, 34);
  wavBuf.write('data', 36, 'ascii');
  wavBuf.writeUInt32LE(dataSize, 40);

  const silenceStart = Math.floor(frameCount * 0.45);
  const silenceEnd = Math.floor(frameCount * 0.5);
  const transientIdx = Math.floor(frameCount * 0.72);

  let offset = 0;
  for (let i = 0; i < frameCount; i += 1) {
    for (let ch = 0; ch < channels; ch += 1) {
      let sample = 0;
      if (i >= silenceStart && i < silenceEnd) {
        sample = 0;
      } else if (i === transientIdx) {
        sample = ch === 0 ? 0.875 : -0.825;
      } else {
        const freq = ch === 0 ? 440 : 659.25;
        sample = Math.sin((2 * Math.PI * freq * i) / sampleRateHz) * 0.5;
        if (i % 7 === 0) {
          sample += (ch === 0 ? 1 : -1) * 0.00012; // LSB nuance for 24-bit/32-bit
        }
      }

      if (sampleFormat === 'pcm-float') {
        pcmOnly.writeFloatLE(sample, offset);
      } else if (bitDepth === 16) {
        pcmOnly.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))), offset);
      } else if (bitDepth === 24) {
        const scaled = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388607) + (i % 5) - 2));
        pcmOnly[offset] = scaled & 0xff;
        pcmOnly[offset + 1] = (scaled >> 8) & 0xff;
        pcmOnly[offset + 2] = (scaled >> 16) & 0xff;
      } else {
        const scaled32 = Math.max(-2147483648, Math.min(2147483647, Math.round(sample * 2147483647)));
        pcmOnly.writeInt32LE(scaled32, offset);
      }

      offset += bytesPerSample;
    }
  }

  pcmOnly.copy(wavBuf, headerSize);
  const filePath = path.join(dir, fileName);
  await fs.writeFile(filePath, wavBuf);

  return {
    id,
    filePath,
    sampleFormat,
    bitDepth,
    validBits: bitDepth,
    sampleRateHz,
    channels,
    durationSec: frameCount / sampleRateHz,
    frameCount,
    referencePcmSha256: crypto.createHash('sha256').update(pcmOnly).digest('hex'),
    sourceAudioSpec: {
      codecName: sampleFormat === 'pcm-float' ? 'pcm_f32le' : `pcm_s${bitDepth}le`,
      container: 'WAV',
      sampleFormat,
      isLosslessCodec: true,
      sampleRateHz,
      bitDepth,
      validBitsPerSample: bitDepth,
      channels,
      durationSec: frameCount / sampleRateHz,
      hasAttachedPic: false,
      hasVideoStream: false,
    },
  };
}

function getConfiguredEncoderDirs(): { externalDirs: string[]; allowSystem: boolean } {
  const realDir = process.env.DOREMI_REAL_CODECS_DIR?.trim() || null;
  const ffmpegDir = process.env.DOREMI_REAL_FFMPEG_DIR?.trim() || null;
  const externalDirs = [realDir, ffmpegDir].filter((v): v is string => Boolean(v));
  return { externalDirs, allowSystem: true };
}

async function grantConsentsInTestScope(
  manager: CodecManager,
  codecIds: readonly CodecId[],
): Promise<void> {
  for (const id of codecIds) {
    const entry = await manager.resolveCodec(id, false);
    if (entry.executablePath && entry.status === 'unverified') {
      await manager.grantSystemCodecConsent(entry.executablePath, {
        codecId: id,
        originNote: 'Phase 4.5.1 test scope isolated consent',
        userConfirmed: true,
      });
    }
  }
}

test('Phase 4.5.1 Real Encoder Matrix: separate FFmpeg & Foobar2000 discovery, native vs FFmpeg isolation, lossless PCM fidelity & lossy checks', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-real-451-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const { externalDirs, allowSystem } = getConfiguredEncoderDirs();
  const realUserData = path.join(root, 'userdata-combined');
  const manager = new CodecManager({
    userDataDir: realUserData,
    externalPackDirs: externalDirs,
    allowStandardFoobarPaths: true,
    allowSystemPathLookup: allowSystem,
  });

  // Never trust unconsented binaries silently; grant ONLY inside this isolated temp userDataDir
  if (externalDirs.length > 0 || allowSystem) {
    await grantConsentsInTestScope(manager, [
      'flac',
      'refalac',
      'wavpack',
      'lame',
      'opusenc',
      'oggenc',
      'mpcenc',
      'ffmpeg',
      'ffprobe',
    ]);
  }

  const readySet = await manager.getReadyCodecSet();
  const nonBuiltinReady = Array.from(readySet).filter((id) => id !== 'alac-wasm');
  if (nonBuiltinReady.length === 0) {
    t.skip(
      'No verified external encoders/FFmpeg detected in environment. Set DOREMI_REAL_CODECS_DIR or add FFmpeg to PATH to execute Phase 4.5.1 real encoder suite.',
    );
    return;
  }

  const fixturesDir = path.join(root, 'fixtures');
  await fs.mkdir(fixturesDir, { recursive: true });
  const fx16_44 = await createStructuredWavFixture({
    dir: fixturesDir,
    id: 'fx16_44',
    fileName: 'Bài 16bit — 44.1kHz 日本語.wav',
    sampleFormat: 'pcm-int',
    bitDepth: 16,
    sampleRateHz: 44100,
    channels: 2,
    durationSec: 0.35,
  });
  const fx16_48 = await createStructuredWavFixture({
    dir: fixturesDir,
    id: 'fx16_48',
    fileName: 'fixture-16-48000.wav',
    sampleFormat: 'pcm-int',
    bitDepth: 16,
    sampleRateHz: 48000,
    channels: 2,
    durationSec: 0.35,
  });
  const fx24_96 = await createStructuredWavFixture({
    dir: fixturesDir,
    id: 'fx24_96',
    fileName: 'fixture-24-96000.wav',
    sampleFormat: 'pcm-int',
    bitDepth: 24,
    sampleRateHz: 96000,
    channels: 2,
    durationSec: 0.35,
  });
  const fx24_192 = await createStructuredWavFixture({
    dir: fixturesDir,
    id: 'fx24_192',
    fileName: 'fixture-24-192000.wav',
    sampleFormat: 'pcm-int',
    bitDepth: 24,
    sampleRateHz: 192000,
    channels: 2,
    durationSec: 0.25,
  });
  const fx24_mono = await createStructuredWavFixture({
    dir: fixturesDir,
    id: 'fx24_mono',
    fileName: 'fixture-24-48000-mono.wav',
    sampleFormat: 'pcm-int',
    bitDepth: 24,
    sampleRateHz: 48000,
    channels: 1,
    durationSec: 0.35,
  });
  const fx32_float = await createStructuredWavFixture({
    dir: fixturesDir,
    id: 'fx32_float',
    fileName: 'fixture-32f-48000.wav',
    sampleFormat: 'pcm-float',
    bitDepth: 32,
    sampleRateHz: 48000,
    channels: 2,
    durationSec: 0.35,
  });

  await t.test('Optional dependency behavior (QAAC CoreAudioToolbox.dll & FHG AAC enc_fhgaac.dll)', async (subT) => {
    const qaac = await manager.resolveCodec('qaac');
    const fhg = await manager.resolveCodec('fhgaacenc');
    if (qaac.executablePath) {
      assert.ok(
        qaac.status === 'missing-dependency' || qaac.status === 'ready' || qaac.status === 'unverified',
        `Unexpected QAAC status: ${qaac.status}`,
      );
      if (qaac.status === 'missing-dependency') {
        assert.ok(qaac.missingDependencies.some((d) => d.includes('CoreAudioToolbox.dll')));
      }
    } else {
      subT.skip('qaac64.exe not present in test paths');
    }
    if (fhg.executablePath) {
      assert.ok(
        fhg.status === 'missing-dependency' || fhg.status === 'ready' || fhg.status === 'unverified',
        `Unexpected FHG AAC status: ${fhg.status}`,
      );
      if (fhg.status === 'missing-dependency') {
        assert.ok(fhg.missingDependencies.some((d) => d.includes('enc_fhgaac.dll')));
      }
    }
  });

  await t.test('Native Encoder Matrix (strict native-only CodecManager so FFmpeg fallback cannot mask missing native binary)', async (subT) => {
    const nativeOnlyManager = new CodecManager({
      userDataDir: path.join(root, 'userdata-native-only'),
      externalPackDirs: externalDirs,
      allowStandardFoobarPaths: true,
      allowSystemPathLookup: false,
    });
    const nativeTargets: Array<{
      id: CodecId;
      format: ConvertTargetFormat;
      fixtures: StructuredWavFixture[];
      expectedLabel: string;
    }> = [
      {
        id: 'flac',
        format: 'flac',
        fixtures: [fx16_44, fx24_96, fx24_192, fx24_mono],
        expectedLabel: 'FLAC Reference Encoder',
      },
      {
        id: 'refalac',
        format: 'alac',
        fixtures: [fx16_44, fx24_96, fx24_192, fx24_mono],
        expectedLabel: 'Reference ALAC (refalac64)',
      },
      {
        id: 'wavpack',
        format: 'wv',
        fixtures: [fx16_44, fx24_96, fx32_float],
        expectedLabel: 'WavPack Native Encoder',
      },
      {
        id: 'lame',
        format: 'mp3',
        fixtures: [fx16_44, fx16_48],
        expectedLabel: 'LAME MP3 Encoder',
      },
      {
        id: 'opusenc',
        format: 'opus',
        fixtures: [fx16_48, fx24_96],
        expectedLabel: 'Opus Tools Encoder',
      },
      {
        id: 'oggenc',
        format: 'ogg',
        fixtures: [fx16_44],
        expectedLabel: 'Ogg Vorbis (oggenc2)',
      },
    ];

    await grantConsentsInTestScope(nativeOnlyManager, nativeTargets.map((n) => n.id));
    const nativeReady = await nativeOnlyManager.getReadyCodecSet();
    const analyzer = new AudioAnalyzerService(manager);
    const nativeService = new AudioProcessingService({
      codecManager: nativeOnlyManager,
      audioAnalyzer: analyzer,
    });

    try {
      let ranAtLeastOne = false;
      const ffmpegExe = readySet.has('ffmpeg') ? await manager.resolveExecutablePath('ffmpeg') : null;
      const ffprobeReady = readySet.has('ffprobe');

      for (const spec of nativeTargets) {
        await subT.test(`Native ${spec.id} -> ${spec.format}`, async (fmtT) => {
          if (!nativeReady.has(spec.id)) {
            fmtT.skip(`Native encoder ${spec.id} is not available/ready in configured pack`);
            return;
          }
          ranAtLeastOne = true;
          const outDir = path.join(root, `out-native-${spec.id}`);
          await fs.mkdir(outDir, { recursive: true });

          for (const fx of spec.fixtures) {
            const hashBefore = await fs.readFile(fx.filePath).then((b) => crypto.createHash('sha256').update(b).digest('hex'));
            const isLosslessTarget = spec.format === 'flac' || spec.format === 'alac' || spec.format === 'wv';

            // Verify command plan matches AudioProcessingService target choices (strict preferNativeEncoder: true)
            const plan = buildConversionCommandPlan({
              sourcePath: fx.filePath,
              outputPath: path.join(outDir, `${fx.id}.${spec.format}`),
              options: {
                targetFormat: spec.format,
                preferNativeEncoder: true,
                sampleRateHz: 'source',
                bitDepth: 'source',
                channels: 'source',
              },
              availableCodecs: nativeReady,
              sourceAudioSpec: fx.sourceAudioSpec,
            });
            assert.equal(plan.encoderLabel, spec.expectedLabel);
            assert.deepEqual(plan.requiredCodecs, [spec.id]);

            const enqueueSnap = await nativeService.enqueueConversion(
              [
                {
                  sourcePath: fx.filePath,
                  title: `Tiếng Việt 日本語 ${fx.id}`,
                  artist: 'DoReMi Native Suite',
                  album: 'Phase 4.5.1',
                  sourceAudioSpec: fx.sourceAudioSpec,
                },
              ],
              {
                targetFormat: spec.format,
                outputDirectory: outDir,
                preferNativeEncoder: true,
                sampleRateHz: 'source',
                bitDepth: 'source',
                channels: 'source',
                // When testing native-only without FFmpeg in nativeOnlyManager, validate container & verify PCM via independent FFmpeg probe below
                verifyPcmOnLossless: false,
              },
            );

            const enqueuedJob = enqueueSnap.jobs.find(
              (j) => j.sourcePath === path.resolve(fx.filePath) && j.targetFormat === spec.format && j.status !== 'completed',
            ) ?? enqueueSnap.jobs[enqueueSnap.jobs.length - 1];
            assert.ok(enqueuedJob, `Enqueued job missing for ${spec.id}/${fx.id}`);

            const completed = await nativeService.waitForJob(enqueuedJob.id);
            assert.equal(completed.status, 'completed', `${spec.id} (${fx.id}) failed: ${completed.errorMessage ?? 'unknown'}`);
            assert.equal(completed.encoderLabel, spec.expectedLabel);
            assert.ok(completed.outputPath && (await fs.stat(completed.outputPath)).size > 0);
            assert.equal(completed.verification?.containerHeaderValid, true);

            // Check source untouched
            const hashAfter = await fs.readFile(fx.filePath).then((b) => crypto.createHash('sha256').update(b).digest('hex'));
            assert.equal(hashAfter, hashBefore, 'Source fixture file must remain immutable');

            // Verify zero leftover temp files
            const dirFiles = await fs.readdir(outDir);
            assert.equal(dirFiles.filter((f) => f.startsWith('.doremi-tmp-')).length, 0);

            if (spec.format === 'alac') {
              const mp4 = await detectMp4AudioCodec(completed.outputPath!);
              assert.equal(mp4.codec, 'alac');
              assert.equal(mp4.sampleRateHz, fx.sampleRateHz);
              assert.equal(mp4.bitDepth, fx.bitDepth);
              assert.equal(mp4.channels, fx.channels);
            }

            // Independent analysis & bit-exact PCM verification via full analyzer + FFmpeg
            if (ffprobeReady && completed.outputPath) {
              const analysis: AudioAnalysisReport = await analyzer.analyzeFile(completed.outputPath);
              assert.equal(analysis.analyzerBackend, 'ffprobe');
              assert.equal(analysis.channels, fx.channels);
              assert.ok(analysis.durationSec !== null && Math.abs(analysis.durationSec - fx.durationSec) < 0.35);

              if (spec.format === 'opus') {
                assert.equal(analysis.sampleRateHz, 48000, 'Opus encodes internally at 48kHz per RFC 6716');
                assert.equal(analysis.losslessStatus, 'lossy-compressed');
              } else if (spec.format === 'mp3') {
                assert.equal(analysis.sampleRateHz, fx.sampleRateHz);
                assert.equal(analysis.losslessStatus, 'lossy-compressed');
                assert.equal(analysis.bitDepth, null);
              } else if (spec.format === 'ogg') {
                assert.equal(analysis.sampleRateHz, fx.sampleRateHz);
                assert.equal(analysis.losslessStatus, 'lossy-compressed');
                assert.equal(analysis.bitDepth, null);
              } else if (isLosslessTarget && ffmpegExe) {
                assert.equal(analysis.sampleRateHz, fx.sampleRateHz);
                assert.equal(analysis.bitDepth, fx.bitDepth);
                const pcmFmt =
                  fx.sampleFormat === 'pcm-float'
                    ? 'f32le'
                    : fx.bitDepth === 16
                      ? 's16le'
                      : 's24le';
                const decodedPcm = execFileSync(
                  ffmpegExe,
                  ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', completed.outputPath, '-map', '0:a:0', '-vn', '-c:a', `pcm_${pcmFmt}`, '-f', pcmFmt, 'pipe:1'],
                  { stdio: ['ignore', 'pipe', 'ignore'] },
                );
                const decodedSha = crypto.createHash('sha256').update(decodedPcm).digest('hex');
                assert.equal(decodedSha, fx.referencePcmSha256, `PCM mismatch for native ${spec.id} on ${fx.id}`);
              }
            }
          }
        });
      }

      if (!ranAtLeastOne) {
        subT.skip('No native encoders from foobar2000 Encoder Pack found in configured paths');
      }
    } finally {
      await nativeService.disposeAsync();
    }
  });

  await t.test('FFmpeg-Only Isolated Matrix (zero native encoders reachable; capability-gated)', async (subT) => {
    if (!readySet.has('ffmpeg') || !readySet.has('ffprobe')) {
      subT.skip('FFmpeg/FFprobe not ready in environment');
      return;
    }

    const ffmpegPath = await manager.resolveExecutablePath('ffmpeg');
    const ffprobePath = await manager.resolveExecutablePath('ffprobe');
    assert.ok(ffmpegPath && ffprobePath);

    // Isolate FFmpeg & FFprobe ONLY using temporary externalDirs containing copies/references?
    // Even simpler: copy or create a dedicated dir? No — use a temp CodecManager whose externalPackDirs points ONLY to parent of ffmpeg/ffprobe
    // Wait: if user placed them on PATH (separate from G:\Soure app\foobar2000\encoders), setting externalPackDirs: [] + allowStandardFoobarPaths: false + allowSystemPathLookup: true keeps native pack isolated!
    // What if ffmpeg & encoders were placed in the SAME DOREMI_REAL_CODECS_DIR? Only consent 'ffmpeg' & 'ffprobe' in ffmpegOnlyManager!
    const ffmpegOnlyManager = new CodecManager({
      userDataDir: path.join(root, 'userdata-ffmpeg-only'),
      externalPackDirs: [path.dirname(ffmpegPath), path.dirname(ffprobePath)],
      allowStandardFoobarPaths: false,
      allowSystemPathLookup: true,
    });
    await grantConsentsInTestScope(ffmpegOnlyManager, ['ffmpeg', 'ffprobe']);
    const ffOnlyReady = await ffmpegOnlyManager.getReadyCodecSet();
    assert.equal(ffOnlyReady.has('flac'), false, 'Native flac must NOT be consented/active in FFmpeg-only matrix');
    assert.equal(ffOnlyReady.has('refalac'), false, 'Native refalac must NOT be consented/active in FFmpeg-only matrix');

    const capDetector = new FfmpegCapabilityDetector(ffmpegOnlyManager);
    const caps = await capDetector.detect(true);
    assert.ok(caps && caps.encoders.length > 0);

    const ffService = new AudioProcessingService({
      codecManager: ffmpegOnlyManager,
      audioAnalyzer: new AudioAnalyzerService(ffmpegOnlyManager),
      ffmpegCapabilities: capDetector,
    });

    try {
      const ffMatrix: Array<{ format: ConvertTargetFormat; fixture: StructuredWavFixture; lossless: boolean }> = [
        { format: 'flac', fixture: fx24_96, lossless: true },
        { format: 'alac', fixture: fx24_96, lossless: true },
        { format: 'wav', fixture: fx32_float, lossless: true },
        { format: 'wv', fixture: fx24_96, lossless: true },
        { format: 'mp3', fixture: fx16_44, lossless: false },
        { format: 'aac', fixture: fx16_48, lossless: false },
        { format: 'opus', fixture: fx16_48, lossless: false },
        { format: 'ogg', fixture: fx16_44, lossless: false },
      ];

      for (const row of ffMatrix) {
        await subT.test(`FFmpeg -> ${row.format} (${row.fixture.id})`, async (fmtT) => {
          let plan;
          try {
            plan = buildConversionCommandPlan({
              sourcePath: row.fixture.filePath,
              outputPath: path.join(root, `plan-check.${row.format}`),
              options: {
                targetFormat: row.format,
                preferNativeEncoder: false,
                sampleRateHz: 'source',
                bitDepth: 'source',
                channels: 'source',
              },
              availableCodecs: ffOnlyReady,
              sourceAudioSpec: row.fixture.sourceAudioSpec,
              ffmpegCapabilities: caps,
            });
          } catch (err) {
            fmtT.skip(`FFmpeg build lacks encoder for ${row.format}: ${err instanceof Error ? err.message : String(err)}`);
            return;
          }

          assert.deepEqual(plan.requiredCodecs, ['ffmpeg']);
          const outDir = path.join(root, `out-ffmpeg-${row.format}`);
          await fs.mkdir(outDir, { recursive: true });

          const enqueueSnap = await ffService.enqueueConversion(
            [
              {
                sourcePath: row.fixture.filePath,
                title: `FFmpeg Test ${row.format}`,
                artist: 'DoReMi FFmpeg Matrix',
                sourceAudioSpec: row.fixture.sourceAudioSpec,
              },
            ],
            {
              targetFormat: row.format,
              outputDirectory: outDir,
              preferNativeEncoder: false,
              sampleRateHz: 'source',
              bitDepth: 'source',
              channels: 'source',
              verifyPcmOnLossless: true,
            },
          );

          const added = enqueueSnap.jobs[enqueueSnap.jobs.length - 1];
          const done = await ffService.waitForJob(added.id);
          assert.equal(done.status, 'completed', `FFmpeg encode failed for ${row.format}: ${done.errorMessage ?? ''}`);
          assert.ok(done.encoderLabel.startsWith('FFmpeg ('));
          assert.equal(done.verification?.status, 'verified-full');
          if (row.lossless) {
            assert.equal(done.verification?.pcmComparisonStatus, 'matched');
            assert.equal(done.verification?.sampleRateHz, row.fixture.sampleRateHz);
            assert.equal(done.verification?.channels, row.fixture.channels);
            // FFmpeg's built-in `wavpack` encoder pads 24-bit int input into 32-bit container sample width while still keeping exact 24-bit PCM samples (verified by matched SHA-256 above); native wavpack.exe preserves 24-bit raw width directly.
            if (row.format !== 'wv') {
              assert.equal(done.verification?.bitDepth, row.fixture.bitDepth);
            } else {
              assert.ok(done.verification?.bitDepth === 24 || done.verification?.bitDepth === 32);
            }
          } else {
            assert.equal(done.verification?.pcmComparisonStatus, 'skipped-lossy');
          }
        });
      }
    } finally {
      await ffService.disposeAsync();
    }
  });
});
