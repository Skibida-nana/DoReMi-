import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AudioProcessingService } from '../src/main/services/codec/audio-processing-service';
import { CodecManager } from '../src/main/services/codec/codec-manager';
import {
  auditCodecDistributionMatrix,
  getStandardFoobarEncoderSearchDirs,
  resolveBundledManifestFilePath,
  resolveDefaultBundledCodecsDir,
  validateBundledCodecManifestSchema,
  validateProcessLaunchTarget,
} from '../src/main/services/codec/process-execution';
import { buildConversionCommandPlan } from '../src/shared/utils/codec-command-builder';
import {
  createMockCodecManager,
  writeCrossPlatformMockCli,
} from './helpers/cross-platform-codec-harness';

function createMinimalWavBuffer(): Buffer {
  const buf = Buffer.alloc(60, 0);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(52, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(44100, 24);
  buf.writeUInt32LE(44100 * 4, 28);
  buf.writeUInt16LE(4, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(16, 40);
  return buf;
}

test('Phase 4.5F: resources/codecs/manifest.json validates cleanly & license distribution matrix separates OSS vs restricted components', async () => {
  const manifestPath = resolveBundledManifestFilePath();
  const raw = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const validation = validateBundledCodecManifestSchema(raw);
  assert.equal(validation.valid, true, `Manifest validation errors: ${validation.errors.join('; ')}`);
  assert.equal(validation.schemaVersion, 2);
  assert.ok(validation.bundledAllowedIds.includes('flac'));
  assert.ok(validation.bundledAllowedIds.includes('refalac'));
  assert.ok(validation.bundledAllowedIds.includes('lame'));
  assert.ok(validation.bundledAllowedIds.includes('opusenc'));
  assert.ok(validation.bundledAllowedIds.includes('oggenc'));
  assert.ok(validation.bundledAllowedIds.includes('wavpack'));
  assert.ok(validation.bundledAllowedIds.includes('mpcenc'));

  // Proprietary/external-runtime codecs must NEVER be classified BUNDLED_ALLOWED
  const matrix = auditCodecDistributionMatrix();
  const byId = new Map(matrix.map((m) => [m.id, m]));
  assert.equal(byId.get('tak')?.distributionPolicy, 'REDISTRIBUTION_RESTRICTED');
  assert.notEqual(byId.get('qaac')?.distributionPolicy, 'BUNDLED_ALLOWED');
  assert.notEqual(byId.get('fhgaacenc')?.distributionPolicy, 'BUNDLED_ALLOWED');
  assert.notEqual(byId.get('fdkaac')?.distributionPolicy, 'BUNDLED_ALLOWED');
  assert.notEqual(byId.get('ffmpeg')?.distributionPolicy, 'BUNDLED_ALLOWED');
  assert.equal(byId.get('alac-wasm')?.distributionPolicy, 'BUNDLED_ALLOWED');

  // Verify electron-builder.yml keeps codecs as external resources outside ASAR
  const builderYml = await fs.readFile(path.resolve(process.cwd(), 'electron-builder.yml'), 'utf8');
  assert.match(builderYml, /extraResources:\s*[\r\n]+\s*-\s*from:\s*resources\/codecs\s*[\r\n]+\s*to:\s*codecs/m);
});

test('Phase 4.5I: Packaged vs Dev vs Portable resource path resolution avoids hardcoded drive letters', () => {
  // Packaged NSIS or Portable ZIP launched from another drive (`E:\Portable\DoReMi`) with `C:\Windows\System32` cwd
  const existing = new Set([
    path.resolve('E:\\Portable\\DoReMi\\resources\\codecs\\win32-x64'),
    path.resolve('E:\\Portable\\DoReMi\\resources\\codecs\\manifest.json'),
  ]);
  const existsMock = (p: string) => existing.has(path.resolve(p));

  const pkgDir = resolveDefaultBundledCodecsDir({
    platform: 'win32',
    arch: 'x64',
    resourcesPath: 'E:\\Portable\\DoReMi\\resources',
    execPath: 'E:\\Portable\\DoReMi\\DoReMi.exe',
    cwd: 'C:\\Windows\\System32',
    existsSync: existsMock,
  });
  assert.equal(pkgDir, path.resolve('E:\\Portable\\DoReMi\\resources\\codecs\\win32-x64'));

  const pkgManifest = resolveBundledManifestFilePath({
    resourcesPath: 'E:\\Portable\\DoReMi\\resources',
    cwd: 'C:\\Windows\\System32',
    existsSync: existsMock,
  });
  assert.equal(pkgManifest, path.resolve('E:\\Portable\\DoReMi\\resources\\codecs\\manifest.json'));

  // Standard foobar2000 paths are strictly bounded & deterministic (zero whole-drive scan)
  const foobarDirs = getStandardFoobarEncoderSearchDirs('win32', {
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
    APPDATA: 'C:\\Users\\Demo\\AppData\\Roaming',
    LOCALAPPDATA: 'C:\\Users\\Demo\\AppData\\Local',
  });
  assert.equal(foobarDirs.length, 5);
  assert.ok(foobarDirs.some((d) => d.includes('foobar2000\\encoders') || d.includes('foobar2000/encoders')));
});

test('Phase 4.5D: External foobar2000 pack discovery enforces Trust Policy & keeps Custom > User-Pack > Bundled priority', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-ext-foobar-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const externalFoobarDir = path.join(root, 'Program Files', 'foobar2000', 'encoders');
  const extFlac = await writeCrossPlatformMockCli(
    externalFoobarDir,
    'flac',
    `console.log('flac 1.4.3 external-foobar'); process.exit(0);`,
  );

  const manager = createMockCodecManager({
    userDataDir: path.join(root, 'userdata'),
    bundledResourcesDir: path.join(root, 'empty-bundled'),
    externalPackDirs: [externalFoobarDir],
    platform: process.platform,
    arch: process.arch,
  });

  // Discovered in external foobar2000 directory, but UNVERIFIED & NOT executed before consent/checksum!
  const beforeConsent = await manager.resolveCodec('flac');
  assert.equal(beforeConsent.sourceTier, 'system');
  assert.equal(beforeConsent.status, 'unverified');
  assert.equal(beforeConsent.trustStatus, 'unverified');

  // Grant explicit consent -> becomes ready cleanly
  await manager.grantSystemCodecConsent(extFlac, {
    codecId: 'flac',
    originNote: 'foobar2000 Free Encoder Pack verified',
    userConfirmed: true,
  });
  const afterConsent = await manager.resolveCodec('flac');
  assert.equal(afterConsent.status, 'ready');
  assert.equal(afterConsent.version, 'flac 1.4.3 external-foobar');
});

test('Phase 4.5B/H: Windows spaces, Vietnamese Unicode, CJK, quotes, NUL rejection & batch cancellation cleanup', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doremi-winpath-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Verify launch validator blocks unsafe NUL injection
  assert.throws(() => validateProcessLaunchTarget('flac.exe', ['ok', 'bad\0arg']));
  assert.throws(() => validateProcessLaunchTarget('', ['--version']));

  // Complex Unicode / spaces / quotes / parens / CJK paths stay single intact argv elements (no shell splitting)
  const complexDir = path.join(root, "Nhạc Việt Nam (Hi-Res '24) 東京");
  const outDir = path.join(root, "Đích (Xuất) 'Lossless'");
  await fs.mkdir(complexDir, { recursive: true });
  await fs.mkdir(outDir, { recursive: true });
  const complexWav = path.join(complexDir, "Bài Hát — 桜 (Take '1).wav");
  await fs.writeFile(complexWav, createMinimalWavBuffer());

  const directPlan = buildConversionCommandPlan({
    sourcePath: complexWav,
    outputPath: path.join(outDir, "Bài Hát — 桜 (Take '1).flac"),
    options: { targetFormat: 'flac', preferNativeEncoder: true },
    availableCodecs: new Set(['ffmpeg', 'flac']),
    sourceAudioSpec: { sampleFormat: 'pcm-int', bitDepth: 24, sampleRateHz: 96000, channels: 2 },
  });
  assert.equal(directPlan.pipelineMode, 'direct');
  assert.ok(directPlan.steps[0].args.includes(complexWav));

  const complexM4a = path.join(complexDir, "Bài Hát — 桜 (Take '1).m4a");
  const pipePlan = buildConversionCommandPlan({
    sourcePath: complexM4a,
    outputPath: path.join(outDir, "Bài Hát — 桜 (Take '1).flac"),
    options: { targetFormat: 'flac', preferNativeEncoder: true },
    availableCodecs: new Set(['ffmpeg', 'flac']),
    sourceAudioSpec: { codecName: 'alac', sampleFormat: 'pcm-int', bitDepth: 24, sampleRateHz: 96000, channels: 2 },
  });
  // Verify argv keeps the whole Unicode path unsplit & includes `--ignore-chunk-sizes` for FLAC pipe
  assert.equal(pipePlan.pipelineMode, 'piped');
  assert.ok(pipePlan.steps[0].args.includes(complexM4a));
  assert.ok(pipePlan.steps[1].args.includes('--ignore-chunk-sizes'));

  // Cancellation cleanup with Unicode/spaces path: zero leftover temp files & original untouched
  const userDataDir = path.join(root, 'userdata');
  const hangFlac = await writeCrossPlatformMockCli(
    root,
    'flac',
    `
    const args = process.argv.slice(2);
    if (args.includes('--version')) { console.log('flac 1.4.3'); process.exit(0); }
    setInterval(() => {}, 10000);
    `,
  );
  const manager = createMockCodecManager({
    userDataDir,
    platform: process.platform,
    arch: process.arch,
  });
  await manager.importCustomBinary('flac', hangFlac, { userConfirmed: true, originNote: 'cancel-test' });
  const service = new AudioProcessingService({ codecManager: manager, processKillGraceMs: 120 });

  try {
    const snap = await service.enqueueConversion(
      [{ sourcePath: complexWav, title: "Bài 'Việt'" }],
      { targetFormat: 'flac', outputDirectory: outDir },
    );
    await new Promise((r) => setTimeout(r, 80));
    service.cancelJob(snap.jobs[0].id);
    await service.waitForCleanup();
    const outFiles = await fs.readdir(outDir);
    assert.equal(outFiles.filter((f) => f.startsWith('.doremi-tmp-')).length, 0);
    // Verify source file untouched
    assert.equal((await fs.readFile(complexWav)).length, 60);
  } finally {
    await service.disposeAsync();
  }
});

test('Phase 4.5B/D Code Isolation: zero hardcoded developer drive paths inside codec production services', async () => {
  const codecFiles = ['codec-manager.ts', 'audio-processing-service.ts', 'audio-analyzer.ts', 'ffmpeg-capabilities.ts', 'process-execution.ts'];
  for (const name of codecFiles) {
    const content = await fs.readFile(path.resolve(process.cwd(), 'src/main/services/codec', name), 'utf8');
    assert.equal(content.includes('G:\\Source code DoReMi'), false, `${name} must not hardcode workspace drive path`);
  }
  const prodCm = new CodecManager({ userDataDir: os.tmpdir() });
  assert.equal(prodCm.getProcessAdapter().kind, 'native');
});
