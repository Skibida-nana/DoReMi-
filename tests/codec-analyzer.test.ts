import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  AudioAnalyzerService,
  classifyAudioStream,
  detectSampleFormat,
  inspectWavPackFileMode,
  parseR128TrackGainDb,
  parseReplayGainAndLoudnessTags,
  resolveDecoderStrategy,
} from '../src/main/services/codec/audio-analyzer';
import { CodecManager } from '../src/main/services/codec/codec-manager';

async function createTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeMockExecutable(dir: string, fileName: string, scriptBody: string): Promise<string> {
  const fullPath = path.join(dir, fileName);
  await fs.writeFile(fullPath, `#!/usr/bin/env node\n${scriptBody}\n`, 'utf8');
  await fs.chmod(fullPath, 0o755);
  return fullPath;
}

function buildWavPackHeader(flags: number): Buffer {
  const buf = Buffer.alloc(32, 0);
  buf.write('wvpk', 0, 'ascii');
  buf.writeUInt32LE(flags, 24);
  return buf;
}

test('Phase 03B Analyzer: classifies lossless-codec honestly (never fake verified-lossless) and rejects lossy PCM variants', () => {
  const flac = classifyAudioStream({ codecName: 'flac', container: 'flac' });
  assert.equal(flac.status, 'lossless-codec');
  assert.notEqual(flac.status as string, 'verified-lossless');

  const alac = classifyAudioStream({ codecName: 'alac', container: 'mov,mp4,m4a' });
  assert.equal(alac.status, 'lossless-codec');

  const pcmInt = classifyAudioStream({
    codecName: 'pcm_s24le',
    container: 'wav',
    rawSampleFmt: 's32',
  });
  assert.equal(pcmInt.status, 'uncompressed-pcm');
  assert.equal(detectSampleFormat('pcm_s24le', 's32'), 'pcm-int');

  const pcmFloat = classifyAudioStream({
    codecName: 'pcm_f32le',
    container: 'wav',
    rawSampleFmt: 'flt',
  });
  assert.equal(pcmFloat.status, 'uncompressed-pcm');
  assert.equal(detectSampleFormat('pcm_f32le', 'flt'), 'pcm-float');

  // Lossy PCM variants MUST NOT be misclassified as uncompressed lossless PCM
  assert.equal(
    classifyAudioStream({ codecName: 'adpcm_ima_wav', container: 'wav' }).status,
    'lossy-compressed',
  );
  assert.equal(
    classifyAudioStream({ codecName: 'pcm_mulaw', container: 'wav' }).status,
    'lossy-compressed',
  );
  assert.equal(
    classifyAudioStream({ codecName: 'pcm_alaw', container: 'wav' }).status,
    'lossy-compressed',
  );

  // Standard lossy codecs
  assert.equal(classifyAudioStream({ codecName: 'mp3', container: 'mp3' }).status, 'lossy-compressed');
  assert.equal(classifyAudioStream({ codecName: 'opus', container: 'ogg' }).status, 'lossy-compressed');
  assert.equal(classifyAudioStream({ codecName: 'aac', container: 'mp4' }).status, 'lossy-compressed');
  assert.equal(detectSampleFormat('mp3', 'fltp'), 'lossy');

  // Extension-only M4A without real stream probe must be unknown (never guessed as ALAC or AAC)
  const unknownM4a = classifyAudioStream({
    codecName: '',
    container: 'M4A',
    codecInferredFromExtension: true,
  });
  assert.equal(unknownM4a.status, 'unknown');
});

test('Phase 03B Analyzer: distinguishes WavPack lossless, hybrid+wvc, hybrid-no-wvc (lossy), and unknown', async () => {
  const tmp = await createTempDir('doremi-wv-');
  try {
    // 1. Pure lossless WavPack (HYBRID_FLAG 0x08 = 0)
    const losslessWv = path.join(tmp, 'pure.wv');
    await fs.writeFile(losslessWv, buildWavPackHeader(0x00));
    const losslessMode = await inspectWavPackFileMode(losslessWv);
    assert.equal(losslessMode, 'lossless');
    assert.equal(
      classifyAudioStream({ codecName: 'wavpack', container: 'wv', wavpackMode: losslessMode }).status,
      'lossless-codec',
    );

    // 2. Hybrid WavPack WITH companion .wvc file
    const hybridWithWvc = path.join(tmp, 'hybrid_ok.wv');
    await fs.writeFile(hybridWithWvc, buildWavPackHeader(0x08));
    await fs.writeFile(path.join(tmp, 'hybrid_ok.wvc'), Buffer.from('wvpk-correction-data'));
    const hybridOkMode = await inspectWavPackFileMode(hybridWithWvc);
    assert.equal(hybridOkMode, 'hybrid-with-correction');
    assert.equal(
      classifyAudioStream({ codecName: 'wavpack', container: 'wv', wavpackMode: hybridOkMode }).status,
      'wavpack-hybrid',
    );

    // 3. Hybrid WavPack WITHOUT companion .wvc file -> lossy!
    const hybridNoWvc = path.join(tmp, 'hybrid_lossy.wv');
    await fs.writeFile(hybridNoWvc, buildWavPackHeader(0x08));
    const hybridLossyMode = await inspectWavPackFileMode(hybridNoWvc);
    assert.equal(hybridLossyMode, 'hybrid-without-correction');
    assert.equal(
      classifyAudioStream({ codecName: 'wavpack', container: 'wv', wavpackMode: hybridLossyMode }).status,
      'wavpack-lossy',
    );

    // 4. Unknown / unreadable WavPack header -> unknown (never assumes lossless!)
    const unknownWv = path.join(tmp, 'unknown.wv');
    await fs.writeFile(unknownWv, Buffer.from('NOT_A_WVPK_HEADER'));
    const unknownMode = await inspectWavPackFileMode(unknownWv);
    assert.equal(unknownMode, 'unknown');
    assert.equal(
      classifyAudioStream({ codecName: 'wavpack', container: 'wv', wavpackMode: unknownMode }).status,
      'unknown',
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('Phase 03B Analyzer: strictly separates ReplayGain, RFC 7845 R128_TRACK_GAIN, and Integrated LUFS', () => {
  // RFC 7845 Q7.8 integer (-512 / 256 = -2 dB)
  assert.equal(parseR128TrackGainDb('-512'), -2);
  assert.equal(parseR128TrackGainDb('256'), 1);
  assert.equal(parseR128TrackGainDb('-3.25 dB'), -3.25);

  const parsed = parseReplayGainAndLoudnessTags({
    REPLAYGAIN_TRACK_GAIN: '-6.42 dB',
    REPLAYGAIN_TRACK_PEAK: '0.988123',
    R128_TRACK_GAIN: '-768', // -3.0 dB relative gain, NOT Integrated LUFS!
  });

  assert.equal(parsed.replayGain.trackGainDb, -6.42);
  assert.equal(parsed.replayGain.trackPeak, 0.988123);
  assert.equal(parsed.r128TrackGainDb, -3);
  // Integrated LUFS MUST remain null when only R128_TRACK_GAIN is present!
  assert.equal(parsed.loudness.integratedLufs, null);
  assert.equal(parsed.loudness.measured, false);

  const withExplicitLufs = parseReplayGainAndLoudnessTags({
    LOUDNESS_INTEGRATED: '-14.2 LUFS',
    LOUDNESS_TRUE_PEAK: '-1.1 dBTP',
    LOUDNESS_RANGE: '7.5 LU',
  });
  assert.equal(withExplicitLufs.loudness.integratedLufs, -14.2);
  assert.equal(withExplicitLufs.loudness.truePeakDbtp, -1.1);
  assert.equal(withExplicitLufs.loudness.loudnessRangeLu, 7.5);
  assert.equal(withExplicitLufs.loudness.measured, false);
});

test('Phase 03B Analyzer: honest decoderStrategy distinguishes integrated playback vs pending Phase 04 CLI candidates', () => {
  const ready = new Set(['wvunpack', 'ffmpeg']);

  const alac = resolveDecoderStrategy({ ext: '.m4a', codec: 'alac', container: 'mp4', readyCodecs: ready });
  assert.equal(alac.strategy, 'alac-wasm');
  assert.equal(alac.pendingPlaybackIntegration, false);

  const flac = resolveDecoderStrategy({ ext: '.flac', codec: 'flac', container: 'flac', readyCodecs: ready });
  assert.equal(flac.strategy, 'supported-playback-engine');
  assert.equal(flac.pendingPlaybackIntegration, false);

  const wv = resolveDecoderStrategy({ ext: '.wv', codec: 'wavpack', container: 'wv', readyCodecs: ready });
  assert.equal(wv.strategy, 'native-decoder-candidate');
  assert.equal(wv.pendingPlaybackIntegration, true);

  const ape = resolveDecoderStrategy({ ext: '.ape', codec: 'ape', container: 'ape', readyCodecs: ready });
  assert.equal(ape.strategy, 'ffmpeg-fallback-candidate');
  assert.equal(ape.pendingPlaybackIntegration, true);

  const noDecoders = resolveDecoderStrategy({
    ext: '.tak',
    codec: 'tak',
    container: 'tak',
    readyCodecs: new Set(),
  });
  assert.equal(noDecoders.strategy, 'unsupported');
  assert.equal(noDecoders.pendingPlaybackIntegration, true);
});

test('Phase 03B Analyzer: granular FFprobe error taxonomy & no fake default channels/bitDepth/sampleRate', async () => {
  const tmp = await createTempDir('doremi-analyzer-');
  const userData = path.join(tmp, 'userdata');
  const binDir = path.join(tmp, 'bins');
  await fs.mkdir(binDir, { recursive: true });

  // Plain binary file with unknown extension/content so fallback cannot know channels/bitDepth/sampleRate
  const mysteryFile = path.join(tmp, 'mystery.bin');
  await fs.writeFile(mysteryFile, Buffer.from('random-bytes-without-audio-headers'));

  try {
    // 1. FFprobe missing -> offline fallback reports ffprobeStatus = 'missing' and channels/bitDepth/sampleRate = null
    const cmMissing = new CodecManager({
      userDataDir: path.join(userData, 'missing'),
      platform: process.platform,
      arch: process.arch,
      allowPosixTestScripts: true,
    });
    const analyzerMissing = new AudioAnalyzerService(cmMissing);
    const reportMissing = await analyzerMissing.analyzeFile(mysteryFile);
    assert.equal(reportMissing.analyzerBackend, 'music-metadata-fallback');
    assert.equal(reportMissing.ffprobeStatus, 'missing');
    assert.equal(reportMissing.channels, null);
    assert.equal(reportMissing.bitDepth, null);
    assert.equal(reportMissing.sampleRateHz, null);
    assert.equal(reportMissing.estimatedPcmBitrateBps, null);
    assert.ok(reportMissing.sourceAuthenticityNote.includes('KHÔNG chứng minh'));
    assert.ok(reportMissing.playbackOutputNote.includes('Bit-Perfect'));

    // 2. FFprobe installed & trusted, returning valid JSON -> distinguishes ok, R128_TRACK_GAIN, no fake defaults
    const okFfprobe = await writeMockExecutable(
      binDir,
      'ffprobe-ok',
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
          codec_long_name: 'FLAC (Free Lossless Audio Codec)',
          sample_fmt: 's32',
          sample_rate: '96000',
          bits_per_raw_sample: '24',
          channels: 2,
          channel_layout: 'stereo',
          duration: '180.5',
          tags: {
            REPLAYGAIN_TRACK_GAIN: '-5.5 dB',
            R128_TRACK_GAIN: '-512'
          }
        }],
        format: {
          format_name: 'flac',
          format_long_name: 'raw FLAC',
          duration: '180.5',
          bit_rate: '2400000'
        }
      }));
      process.exit(0);
      `,
    );

    const cmOk = new CodecManager({
      userDataDir: path.join(userData, 'ok'),
      platform: process.platform,
      arch: process.arch,
      allowPosixTestScripts: true,
    });
    await cmOk.importCustomBinary('ffprobe', okFfprobe, {
      userConfirmed: true,
      originNote: 'unit-test-ok',
    });
    const analyzerOk = new AudioAnalyzerService(cmOk);
    const reportOk = await analyzerOk.analyzeFile(mysteryFile);
    assert.equal(reportOk.analyzerBackend, 'ffprobe');
    assert.equal(reportOk.ffprobeStatus, 'ok');
    assert.equal(reportOk.losslessStatus, 'lossless-codec');
    assert.equal(reportOk.sampleRateHz, 96000);
    assert.equal(reportOk.bitDepth, 24);
    assert.equal(reportOk.channels, 2);
    assert.equal(reportOk.r128TrackGainDb, -2);
    assert.equal(reportOk.loudness.integratedLufs, null);
    assert.equal(reportOk.replayGain.trackGainDb, -5.5);

    // 3. FFprobe installed, returns exit code 1 -> reports 'execution-failed' (NOT 'missing'!)
    const failFfprobe = await writeMockExecutable(
      binDir,
      'ffprobe-fail',
      `
      const args = process.argv.slice(2);
      if (args.includes('-version')) {
        console.log('ffprobe version 7.0-mock');
        process.exit(0);
      }
      console.error('Invalid data found when processing input');
      process.exit(1);
      `,
    );
    const cmFail = new CodecManager({
      userDataDir: path.join(userData, 'fail'),
      platform: process.platform,
      arch: process.arch,
      allowPosixTestScripts: true,
    });
    await cmFail.importCustomBinary('ffprobe', failFfprobe, {
      userConfirmed: true,
      originNote: 'unit-test-fail',
    });
    const reportFail = await new AudioAnalyzerService(cmFail).analyzeFile(mysteryFile);
    assert.equal(reportFail.ffprobeStatus, 'execution-failed');
    assert.ok(reportFail.warnings.some((w) => w.includes('thất bại')));
    assert.ok(!reportFail.warnings.some((w) => w.includes('Chưa cài đặt FFprobe')));

    // 4. FFprobe installed, returns invalid JSON -> reports 'invalid-json'
    const badJsonFfprobe = await writeMockExecutable(
      binDir,
      'ffprobe-badjson',
      `
      const args = process.argv.slice(2);
      if (args.includes('-version')) {
        console.log('ffprobe version 7.0-mock');
        process.exit(0);
      }
      console.log('{not-valid-json');
      process.exit(0);
      `,
    );
    const cmBadJson = new CodecManager({
      userDataDir: path.join(userData, 'badjson'),
      platform: process.platform,
      arch: process.arch,
      allowPosixTestScripts: true,
    });
    await cmBadJson.importCustomBinary('ffprobe', badJsonFfprobe, {
      userConfirmed: true,
      originNote: 'unit-test-badjson',
    });
    const reportBadJson = await new AudioAnalyzerService(cmBadJson).analyzeFile(mysteryFile);
    assert.equal(reportBadJson.ffprobeStatus, 'invalid-json');

    // 5. FFprobe installed, times out -> reports 'timeout'
    const slowFfprobe = await writeMockExecutable(
      binDir,
      'ffprobe-timeout',
      `
      const args = process.argv.slice(2);
      if (args.includes('-version')) {
        console.log('ffprobe version 7.0-mock');
        process.exit(0);
      }
      setInterval(() => {}, 10000);
      `,
    );
    const cmTimeout = new CodecManager({
      userDataDir: path.join(userData, 'timeout'),
      platform: process.platform,
      arch: process.arch,
      allowPosixTestScripts: true,
    });
    await cmTimeout.importCustomBinary('ffprobe', slowFfprobe, {
      userConfirmed: true,
      originNote: 'unit-test-timeout',
    });
    const reportTimeout = await new AudioAnalyzerService(cmTimeout, {
      ffprobeTimeoutMs: 150,
    }).analyzeFile(mysteryFile);
    assert.equal(reportTimeout.ffprobeStatus, 'timeout');

    // 6. FFprobe installed, returns JSON with no audio stream -> reports 'audio-stream-not-found'
    const noAudioFfprobe = await writeMockExecutable(
      binDir,
      'ffprobe-noaudio',
      `
      const args = process.argv.slice(2);
      if (args.includes('-version')) {
        console.log('ffprobe version 7.0-mock');
        process.exit(0);
      }
      console.log(JSON.stringify({ streams: [{ codec_type: 'video', codec_name: 'h264' }], format: {} }));
      process.exit(0);
      `,
    );
    const cmNoAudio = new CodecManager({
      userDataDir: path.join(userData, 'noaudio'),
      platform: process.platform,
      arch: process.arch,
      allowPosixTestScripts: true,
    });
    await cmNoAudio.importCustomBinary('ffprobe', noAudioFfprobe, {
      userConfirmed: true,
      originNote: 'unit-test-noaudio',
    });
    const reportNoAudio = await new AudioAnalyzerService(cmNoAudio).analyzeFile(mysteryFile);
    assert.equal(reportNoAudio.ffprobeStatus, 'audio-stream-not-found');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
