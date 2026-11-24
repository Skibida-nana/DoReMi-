import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  CodecManager,
  computeFileSha256,
  isRealPathStrictlyWithinDirectory,
  validateExecutableFileHeader,
  validateRemoteManifestSchema,
} from '../src/main/services/codec/codec-manager';
import {
  isPrivateOrReservedIp,
  validateSafeUpdateManifestUrl,
} from '../src/shared/utils/codec-command-builder';
import {
  DEFAULT_CODEC_MANIFEST,
  FOOBAR_PACK_SUPPORTING_FILES,
  getCodecManifestById,
  getFoobarPackCodecEntries,
  matchFilenameToCodecId,
} from '../src/shared/utils/codec-registry';

/**
 * Builds a minimal structurally valid Windows PE header fixture for testing PE parsing & architecture checks.
 * Note: Fixture tests verify header/security/state logic only — NOT real Windows native execution.
 */
function buildPeFixture(options: {
  machine: number; // 0x8664 = x64, 0x014c = x86, 0xaa64 = arm64
  isDll?: boolean;
  executableFlag?: boolean;
  validPeSignature?: boolean;
  peOffset?: number;
  extraBytes?: number;
}): Buffer {
  const peOffset = options.peOffset ?? 0x80;
  const totalLen = Math.max(peOffset + 64, 256) + (options.extraBytes ?? 0);
  const buf = Buffer.alloc(totalLen, 0);
  // DOS MZ header
  buf[0] = 0x4d;
  buf[1] = 0x5a;
  buf.writeUInt32LE(peOffset, 0x3c);

  if (peOffset + 24 <= buf.length) {
    if (options.validPeSignature !== false) {
      buf[peOffset] = 0x50; // P
      buf[peOffset + 1] = 0x45; // E
      buf[peOffset + 2] = 0x00;
      buf[peOffset + 3] = 0x00;
    } else {
      buf[peOffset] = 0x42; // B
      buf[peOffset + 1] = 0x41; // A
      buf[peOffset + 2] = 0x44; // D
      buf[peOffset + 3] = 0x00;
    }
    buf.writeUInt16LE(options.machine, peOffset + 4);
    let characteristics = options.executableFlag === false ? 0 : 0x0002;
    if (options.isDll) {
      characteristics |= 0x2000;
    }
    buf.writeUInt16LE(characteristics, peOffset + 22);
  }
  return buf;
}

/**
 * Builds a minimal structurally valid Linux ELF header fixture for architecture compatibility tests.
 */
function buildElfFixture(machine: number, elfClass: 1 | 2 = 2): Buffer {
  const buf = Buffer.alloc(64, 0);
  buf[0] = 0x7f;
  buf[1] = 0x45; // E
  buf[2] = 0x4c; // L
  buf[3] = 0x46; // F
  buf[4] = elfClass; // 1 = 32-bit, 2 = 64-bit
  buf[5] = 1; // Little-endian
  buf[6] = 1; // EV_CURRENT
  buf.writeUInt16LE(2, 16); // ET_EXEC
  buf.writeUInt16LE(machine, 18); // 0x3e = x86_64, 0x03 = x86, 0xb7 = arm64
  return buf;
}

async function createTempWorkspace(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'doremi-phase03a-'));
}

async function writeMockScript(filePath: string, body: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  await fs.chmod(filePath, 0o755);
}

test('Executable Security: rejects invalid files, bare 2-byte MZ, bad PE signature, and DLL masquerading as EXE', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // 1. Plain text file
  const textFile = path.join(root, 'not-a-bin.exe');
  await fs.writeFile(textFile, 'hello world not an executable binary');
  const textRes = await validateExecutableFileHeader(textFile, 'win32', { hostArch: 'x64' });
  assert.equal(textRes.valid, false);

  // 2. Only 2 bytes MZ (must NOT pass)
  const bareMz = path.join(root, 'bare-mz.exe');
  await fs.writeFile(bareMz, Buffer.from([0x4d, 0x5a, 0x90, 0x00]));
  const bareMzRes = await validateExecutableFileHeader(bareMz, 'win32', { hostArch: 'x64' });
  assert.equal(bareMzRes.valid, false);
  assert.match(bareMzRes.reason ?? '', /DOS header|64/i);

  // 3. Invalid PE signature after e_lfanew
  const badPe = path.join(root, 'bad-pe.exe');
  await fs.writeFile(badPe, buildPeFixture({ machine: 0x8664, validPeSignature: false }));
  const badPeRes = await validateExecutableFileHeader(badPe, 'win32', { hostArch: 'x64' });
  assert.equal(badPeRes.valid, false);
  assert.match(badPeRes.reason ?? '', /PE/i);

  // 4. Out-of-bounds e_lfanew
  const oobPe = path.join(root, 'oob-pe.exe');
  const oobBuf = Buffer.alloc(96, 0);
  oobBuf[0] = 0x4d;
  oobBuf[1] = 0x5a;
  oobBuf.writeUInt32LE(99999, 0x3c);
  await fs.writeFile(oobPe, oobBuf);
  const oobRes = await validateExecutableFileHeader(oobPe, 'win32', { hostArch: 'x64' });
  assert.equal(oobRes.valid, false);

  // 5. DLL masquerading as EXE rejected; accepted when expectDll: true
  const dllFile = path.join(root, 'nsutil.dll');
  await fs.writeFile(dllFile, buildPeFixture({ machine: 0x014c, isDll: true }));
  const asExe = await validateExecutableFileHeader(dllFile, 'win32', { hostArch: 'x64' });
  assert.equal(asExe.valid, false);
  assert.equal(asExe.isPeDll, true);
  const asDll = await validateExecutableFileHeader(dllFile, 'win32', {
    hostArch: 'x64',
    expectDll: true,
  });
  assert.equal(asDll.valid, true);
  assert.equal(asDll.isPeDll, true);

  // 6. POSIX script rejected by default
  const shFile = path.join(root, 'flac');
  await writeMockScript(shFile, 'echo "flac 1.4.3"');
  const shStrict = await validateExecutableFileHeader(shFile, 'linux', { hostArch: 'x64' });
  assert.equal(shStrict.valid, false);
});

test('Architecture Compatibility: Windows x64 allows both PE x64 and PE x86 (WoW64), rejects PE ARM64, and Linux never runs PE', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const peX64 = path.join(root, 'flac64.exe');
  const peX86 = path.join(root, 'fhgaacenc.exe');
  const peArm64 = path.join(root, 'flac-arm64.exe');
  const elfArm64 = path.join(root, 'flac-linux-arm64');

  await fs.writeFile(peX64, buildPeFixture({ machine: 0x8664 }));
  await fs.writeFile(peX86, buildPeFixture({ machine: 0x014c }));
  await fs.writeFile(peArm64, buildPeFixture({ machine: 0xaa64 }));
  await fs.writeFile(elfArm64, buildElfFixture(0xb7, 2));

  // Windows x64 accepts x64 & x86
  const win64OnWin64 = await validateExecutableFileHeader(peX64, 'win32', { hostArch: 'x64' });
  assert.equal(win64OnWin64.valid, true);
  assert.equal(win64OnWin64.architecture, 'x64');
  assert.equal(win64OnWin64.compatibleWithHost, true);

  const win86OnWin64 = await validateExecutableFileHeader(peX86, 'win32', { hostArch: 'x64' });
  assert.equal(win86OnWin64.valid, true);
  assert.equal(win86OnWin64.architecture, 'x86');
  assert.equal(win86OnWin64.compatibleWithHost, true);

  // Windows x64 rejects ARM64
  const armOnWin64 = await validateExecutableFileHeader(peArm64, 'win32', { hostArch: 'x64' });
  assert.equal(armOnWin64.valid, true);
  assert.equal(armOnWin64.architecture, 'arm64');
  assert.equal(armOnWin64.compatibleWithHost, false);
  assert.equal(armOnWin64.executableInCurrentRuntime, false);

  // Linux x64 rejects ELF ARM64
  const elfArmOnLinux64 = await validateExecutableFileHeader(elfArm64, 'linux', { hostArch: 'x64' });
  assert.equal(elfArmOnLinux64.valid, true);
  assert.equal(elfArmOnLinux64.architecture, 'arm64');
  assert.equal(elfArmOnLinux64.compatibleWithHost, false);

  // Linux host marks valid Windows PE in bundled pack as pending-desktop-verification and NEVER executes it
  const userDataDir = path.join(root, 'userdata');
  const bundledDir = path.join(root, 'bundled');
  await fs.mkdir(bundledDir, { recursive: true });
  await fs.writeFile(path.join(bundledDir, 'flac.exe'), buildPeFixture({ machine: 0x8664 }));

  const manager = new CodecManager({
    userDataDir,
    bundledResourcesDir: bundledDir,
    platform: 'linux',
    arch: 'x64',
  });
  const flac = await manager.resolveCodec('flac');
  assert.equal(flac.status, 'pending-desktop-verification');
  assert.equal(flac.trustStatus, 'pending-desktop-verification');
  assert.equal(flac.architecture, 'x64');
  assert.equal(flac.version, null);
});

test('Binary Trust Policy & Checksum Mismatch: untrusted or tampered custom binary is NEVER executed', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const userDataDir = path.join(root, 'userdata');
  const sentinelFile = path.join(root, 'should-never-exist.txt');
  const customFlacDir = path.join(userDataDir, 'codecs', 'custom', 'flac');
  const customFlacPath = path.join(customFlacDir, 'flac');

  // Drop an unverified script directly into custom/flac/ that would create sentinelFile if executed
  await writeMockScript(customFlacPath, `touch "${sentinelFile}"\necho "flac 1.4.3"`);

  const manager = new CodecManager({
    userDataDir,
    bundledResourcesDir: path.join(root, 'empty-bundled'),
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
  });

  // 1. Without user consent or official checksum -> unverified & NEVER executed
  const unverified = await manager.resolveCodec('flac');
  assert.equal(unverified.status, 'unverified');
  assert.equal(unverified.trustStatus, 'unverified');
  assert.equal(unverified.userConsentGranted, false);
  await assert.rejects(() => fs.access(sentinelFile));

  // 2. Grant explicit user consent -> now trusted and allowed to run version probe
  const consent = await manager.grantCustomCodecConsent('flac', {
    originNote: 'Local test fixture verified by user',
    userConfirmed: true,
  });
  assert.ok(consent);
  assert.equal(consent.userConfirmed, true);

  const ready = await manager.resolveCodec('flac');
  assert.equal(ready.status, 'ready');
  assert.equal(ready.trustStatus, 'trusted');
  assert.equal(ready.userConsentGranted, true);
  assert.match(ready.version ?? '', /flac 1\.4\.3/i);

  // 3. Tamper with the binary on disk -> cache invalidates & SHA-256 mismatch revokes consent!
  const sentinel2 = path.join(root, 'tampered-sentinel.txt');
  await writeMockScript(customFlacPath, `touch "${sentinel2}"\necho "flac 9.9.9 tampered"`);
  const afterTamper = await manager.resolveCodec('flac');
  assert.equal(afterTamper.status, 'unverified');
  assert.equal(afterTamper.trustStatus, 'unverified');
  assert.equal(afterTamper.userConsentGranted, false);
  await assert.rejects(() => fs.access(sentinel2));

  // 4. Official checksum mismatch -> invalid & NEVER executed
  const sentinel3 = path.join(root, 'checksum-sentinel.txt');
  const bundledDir = path.join(root, 'bundled-checksum');
  await writeMockScript(path.join(bundledDir, 'lame'), `touch "${sentinel3}"\necho "LAME 3.100"`);

  const checksumManager = new CodecManager({
    userDataDir: path.join(root, 'userdata-checksum'),
    bundledResourcesDir: bundledDir,
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
    trustedChecksums: {
      lame: { lame: '0'.repeat(64) }, // intentionally wrong expected SHA-256
    },
  });

  const mismatch = await checksumManager.resolveCodec('lame');
  assert.equal(mismatch.status, 'invalid');
  assert.equal(mismatch.trustStatus, 'invalid');
  assert.equal(mismatch.checksumVerified, false);
  assert.match(mismatch.errorMessage ?? '', /SHA-256/i);
  await assert.rejects(() => fs.access(sentinel3));
});

test('Dependency Verification: QAAC & fhgaacenc are marked missing-dependency when required DLLs are absent', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const userDataDir = path.join(root, 'userdata');
  const bundledDir = path.join(root, 'bundled');
  await fs.mkdir(bundledDir, { recursive: true });
  await fs.writeFile(path.join(bundledDir, 'qaac64.exe'), buildPeFixture({ machine: 0x8664 }));
  await fs.writeFile(path.join(bundledDir, 'fhgaacenc.exe'), buildPeFixture({ machine: 0x014c }));

  const manager = new CodecManager({
    userDataDir,
    bundledResourcesDir: bundledDir,
    platform: 'linux',
    arch: 'x64',
  });

  const qaacMissing = await manager.resolveCodec('qaac');
  assert.equal(qaacMissing.status, 'missing-dependency');
  assert.equal(qaacMissing.trustStatus, 'missing-dependency');
  assert.deepEqual(qaacMissing.missingDependencies, ['CoreAudioToolbox.dll']);

  const fhgMissing = await manager.resolveCodec('fhgaacenc');
  assert.equal(fhgMissing.status, 'missing-dependency');
  assert.equal(fhgMissing.trustStatus, 'missing-dependency');
  assert.deepEqual(fhgMissing.missingDependencies, ['nsutil.dll', 'enc_fhgaac.dll']);

  // Supply valid PE DLL dependencies -> missingDependencies clears (moves to pending-desktop-verification on Linux)
  const depDir = path.join(root, 'deps');
  await fs.mkdir(depDir, { recursive: true });
  await fs.writeFile(path.join(depDir, 'CoreAudioToolbox.dll'), buildPeFixture({ machine: 0x8664, isDll: true }));
  await fs.writeFile(path.join(bundledDir, 'nsutil.dll'), buildPeFixture({ machine: 0x014c, isDll: true }));
  await fs.writeFile(path.join(depDir, 'enc_fhgaac.dll'), buildPeFixture({ machine: 0x014c, isDll: true }));

  const managerWithDeps = new CodecManager({
    userDataDir: path.join(root, 'userdata-with-deps'),
    bundledResourcesDir: bundledDir,
    dependencySearchDirs: [depDir],
    platform: 'linux',
    arch: 'x64',
  });

  const qaacWithDeps = await managerWithDeps.resolveCodec('qaac');
  assert.deepEqual(qaacWithDeps.missingDependencies, []);
  assert.equal(qaacWithDeps.status, 'pending-desktop-verification');

  const fhgWithDeps = await managerWithDeps.resolveCodec('fhgaacenc');
  assert.deepEqual(fhgWithDeps.missingDependencies, []);
  assert.equal(fhgWithDeps.status, 'pending-desktop-verification');
});

test('System PATH Disabled by Default & Opt-in System PATH still enforces Trust Policy', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const fakeBinDir = path.join(root, 'fake-path-bin');
  const sysFlac = path.join(fakeBinDir, 'flac');
  await writeMockScript(sysFlac, 'echo "flac 1.4.3 system"');

  const originalPath = process.env.PATH;
  process.env.PATH = `${fakeBinDir}${path.delimiter}${originalPath ?? ''}`;
  t.after(() => {
    process.env.PATH = originalPath;
  });

  const manager = new CodecManager({
    userDataDir: path.join(root, 'userdata'),
    bundledResourcesDir: path.join(root, 'empty-bundled'),
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
  });

  // Default: allowSystemPathLookup MUST be false
  assert.equal(manager.getDiscoveryPolicy().allowSystemPathLookup, false);
  const missingByDefault = await manager.resolveCodec('flac');
  assert.equal(missingByDefault.status, 'missing');
  assert.equal(missingByDefault.sourceTier, 'missing');

  // Enable System PATH -> detected as system tier, but still unverified until user consents!
  manager.setDiscoveryPolicy({ allowSystemPathLookup: true });
  const unverifiedSys = await manager.resolveCodec('flac');
  assert.equal(unverifiedSys.sourceTier, 'system');
  assert.equal(unverifiedSys.status, 'unverified');
  assert.equal(unverifiedSys.trustStatus, 'unverified');

  // Grant explicit consent for that exact system binary -> becomes ready
  await manager.grantSystemCodecConsent(sysFlac, {
    codecId: 'flac',
    originNote: 'System FLAC approved by user',
    userConfirmed: true,
  });
  const readySys = await manager.resolveCodec('flac');
  assert.equal(readySys.sourceTier, 'system');
  assert.equal(readySys.status, 'ready');
  assert.equal(readySys.trustStatus, 'trusted');
});

test('Health Verification: rejects non-zero exit code with text & rejects unrelated banner output; permits explicit adapter exit code', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bundledDir = path.join(root, 'bundled');
  // 1. flac exits 1 even though it prints text -> MUST fail (flac accepts only [0])
  await writeMockScript(path.join(bundledDir, 'flac'), 'echo "flac 1.4.3 fake fail"; exit 1');
  // 2. lame exits 0 but prints unrelated identity banner -> MUST fail identity check
  await writeMockScript(path.join(bundledDir, 'lame'), 'echo "totally random tool v1.0"; exit 0');
  // 3. mpcdec exits 1 with matching musepack/mpcdec identity -> allowed by adapter rule [0, 1]
  await writeMockScript(path.join(bundledDir, 'mpcdec'), 'echo "mpcdec - Musepack SV8 decoder"; exit 1');

  const manager = new CodecManager({
    userDataDir: path.join(root, 'userdata'),
    bundledResourcesDir: bundledDir,
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
  });

  const flac = await manager.resolveCodec('flac');
  assert.equal(flac.status, 'invalid');
  assert.match(flac.errorMessage ?? '', /mã thoát|1/i);

  const lame = await manager.resolveCodec('lame');
  assert.equal(lame.status, 'invalid');
  assert.match(lame.errorMessage ?? '', /không khớp nhận diện/i);

  const mpcdec = await manager.resolveCodec('mpcdec');
  assert.equal(mpcdec.status, 'ready');
  assert.match(mpcdec.version ?? '', /mpcdec/i);
});

test('Streaming SHA-256 & Verification Cache Invalidation work accurately across multi-chunk files', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // Create a 300 KB buffer (> 4 streaming chunks of 64 KB)
  const payload = crypto.randomBytes(300 * 1024);
  const binPath = path.join(root, 'large-fixture.bin');
  await fs.writeFile(binPath, payload);

  const expected = crypto.createHash('sha256').update(payload).digest('hex');
  const streamed = await computeFileSha256(binPath);
  assert.equal(streamed, expected);

  // Cache invalidation when bundled binary changes on disk
  const bundledDir = path.join(root, 'bundled');
  const flacBin = path.join(bundledDir, 'flac');
  await writeMockScript(flacBin, 'echo "flac 1.4.2"');

  const manager = new CodecManager({
    userDataDir: path.join(root, 'userdata'),
    bundledResourcesDir: bundledDir,
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
  });

  const first = await manager.resolveCodec('flac');
  assert.equal(first.status, 'ready');
  assert.equal(first.version, 'flac 1.4.2');

  // Modify binary content & size -> cache must auto-invalidate without forceRescan
  await writeMockScript(flacBin, 'echo "flac 1.4.3 updated-banner"');
  const second = await manager.resolveCodec('flac');
  assert.equal(second.status, 'ready');
  assert.equal(second.version, 'flac 1.4.3 updated-banner');
  assert.notEqual(second.sha256, first.sha256);
});

test('Discovery Optimization: default concurrency = 1, single-codec resolution avoids full scan, and in-flight requests deduplicate', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const bundledDir = path.join(root, 'bundled');
  const lockFile = path.join(root, 'active-probe.lock');
  const overlapFlag = path.join(root, 'overlap-detected.flag');
  const lameLog = path.join(root, 'lame-probed.log');

  // Each mock encoder creates a lock file, sleeps briefly, checks for overlap, then cleans up
  const concurrencyProbeBody = (banner: string, extraLog?: string) => `
if [ -f "${lockFile}" ]; then
  echo "OVERLAP" >> "${overlapFlag}"
fi
touch "${lockFile}"
${extraLog ? `echo "probed" >> "${extraLog}"` : ''}
sleep 0.04
rm -f "${lockFile}"
echo "${banner}"
`;

  await writeMockScript(path.join(bundledDir, 'flac'), concurrencyProbeBody('flac 1.4.3'));
  await writeMockScript(path.join(bundledDir, 'lame'), concurrencyProbeBody('LAME 3.100', lameLog));
  await writeMockScript(path.join(bundledDir, 'opusenc'), concurrencyProbeBody('opusenc 0.2'));

  const manager = new CodecManager({
    userDataDir: path.join(root, 'userdata'),
    bundledResourcesDir: bundledDir,
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
  });

  assert.equal(manager.getDiscoveryPolicy().maxProbeConcurrency, 1);

  // 1. Single-codec resolution must NOT probe lame!
  const flacPath = await manager.resolveExecutablePath('flac');
  assert.equal(flacPath, path.join(bundledDir, 'flac'));
  await assert.rejects(() => fs.access(lameLog));

  // 2. Concurrent getInventory calls deduplicate and obey concurrency = 1 (zero overlap!)
  const [inv1, inv2] = await Promise.all([
    manager.getInventory(true),
    manager.getInventory(false),
  ]);
  assert.equal(inv1.summary.ready >= 4, true); // alac-wasm + flac + lame + opusenc
  assert.equal(inv2.generatedAt, inv1.generatedAt);
  await assert.rejects(() => fs.access(overlapFlag));
});

test('Codec Fallback: falls back from broken Custom Codec to working Bundled Codec without erasing user custom config', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const userDataDir = path.join(root, 'userdata');
  const bundledDir = path.join(root, 'bundled');
  await writeMockScript(path.join(bundledDir, 'flac'), 'echo "flac 1.4.3 bundled"');

  // Place a corrupted custom flac binary
  const customDir = path.join(userDataDir, 'codecs', 'custom', 'flac');
  await fs.mkdir(customDir, { recursive: true });
  await fs.writeFile(path.join(customDir, 'flac'), 'corrupted-not-an-executable');

  const manager = new CodecManager({
    userDataDir,
    bundledResourcesDir: bundledDir,
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
  });

  const resolved = await manager.resolveCodec('flac');
  assert.equal(resolved.status, 'ready');
  assert.equal(resolved.sourceTier, 'bundled');
  assert.equal(resolved.fallbackUsed, true);
  assert.ok((resolved.fallbackWarnings?.length ?? 0) >= 1);

  // User's custom file was NOT deleted automatically
  await fs.access(path.join(customDir, 'flac'));

  // Compatible provider fallback across codec IDs
  const provider = await manager.resolveCompatibleProvider(['refalac', 'qaac', 'flac']);
  assert.equal(provider?.id, 'flac');
});

test('Safe Custom Import, Active-Use Lock & Failed Import Recovery preserve existing working binary', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const userDataDir = path.join(root, 'userdata');
  const goodSource = path.join(root, 'good-flac');
  const badSource = path.join(root, 'bad-flac');
  const updatedGoodSource = path.join(root, 'updated-flac');

  await writeMockScript(goodSource, 'echo "flac 1.4.2 custom"');
  await writeMockScript(badSource, 'echo "broken binary"; exit 2');
  await writeMockScript(updatedGoodSource, 'echo "flac 1.4.3 custom-v2"');

  const manager = new CodecManager({
    userDataDir,
    bundledResourcesDir: path.join(root, 'empty-bundled'),
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
  });

  // 1. Import valid custom binary with user consent
  const firstImport = await manager.importCustomBinary('flac', goodSource, {
    userConfirmed: true,
    originNote: 'User custom build 1.4.2',
  });
  assert.equal(firstImport.imported, true);
  assert.equal(firstImport.entry?.version, 'flac 1.4.2 custom');

  // 2. Attempt to replace with failing binary -> must fail in staging & keep 1.4.2 intact!
  const failedReplace = await manager.importCustomBinary('flac', badSource, {
    userConfirmed: true,
    originNote: 'Broken build',
  });
  assert.equal(failedReplace.imported, false);
  assert.equal(failedReplace.entry?.status, 'ready');
  assert.equal(failedReplace.entry?.version, 'flac 1.4.2 custom');

  // 3. Active-use guard blocks replacing or removing while codec is in use
  manager.markCodecInUse('flac');
  const blockedWhileInUse = await manager.importCustomBinary('flac', updatedGoodSource, {
    userConfirmed: true,
  });
  assert.equal(blockedWhileInUse.imported, false);
  assert.match(blockedWhileInUse.error ?? '', /đang được sử dụng/i);
  await assert.rejects(() => manager.removeCustomBinary('flac'), /đang được sử dụng/i);
  manager.releaseCodecInUse('flac');

  // 4. Safe replacement succeeds once released
  const secondImport = await manager.importCustomBinary('flac', updatedGoodSource, {
    userConfirmed: true,
    originNote: 'User custom build 1.4.3',
  });
  assert.equal(secondImport.imported, true);
  assert.equal(secondImport.entry?.version, 'flac 1.4.3 custom-v2');
});

test('Safe Pack Import, Symlink Rejection & Synchronized Rollback restore binaries, DLLs, licenses, and codec-state.json', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const userDataDir = path.join(root, 'userdata');
  const packV1 = path.join(root, 'pack-v1');
  const packV2 = path.join(root, 'pack-v2');
  const outsideFile = path.join(root, 'outside-secret-lame');
  await fs.mkdir(packV1, { recursive: true });
  await fs.mkdir(packV2, { recursive: true });
  await writeMockScript(outsideFile, 'echo "LAME 3.100 outside"');

  // Pack v1: flac 1.4.2 + nsutil.dll (valid PE DLL) + flac_license.txt + escaping symlink (must be rejected)
  await writeMockScript(path.join(packV1, 'flac'), 'echo "flac 1.4.2 pack-v1"');
  await fs.writeFile(path.join(packV1, 'nsutil.dll'), buildPeFixture({ machine: 0x014c, isDll: true }));
  await fs.writeFile(path.join(packV1, 'flac_license.txt'), 'BSD-3-Clause FLAC License v1');
  await fs.symlink(outsideFile, path.join(packV1, 'lame'));

  // Pack v2: flac 1.4.3 + lame_license.txt (no nsutil.dll)
  await writeMockScript(path.join(packV2, 'flac'), 'echo "flac 1.4.3 pack-v2"');
  await fs.writeFile(path.join(packV2, 'lame_license.txt'), 'LGPL-2.0 LAME License v2');

  const manager = new CodecManager({
    userDataDir,
    bundledResourcesDir: path.join(root, 'empty-bundled'),
    platform: 'linux',
    arch: 'x64',
    allowPosixTestScripts: true,
  });

  // Check realpath helper directly against escaping symlink
  const symCheck = await isRealPathStrictlyWithinDirectory(path.join(packV1, 'lame'), packV1);
  assert.equal(symCheck.safe, false);

  // Import Pack v1
  const resV1 = await manager.importEncoderPackFromFolder(packV1, {
    verifiedPackVersion: '2026.03.13',
    verifiedPackDate: '2026-03-13',
  });
  assert.equal(resV1.importedCount, 1);
  assert.deepEqual(resV1.importedCodecs, ['flac']); // escaping symlink 'lame' was skipped!
  assert.deepEqual(resV1.importedSupportingDlls, ['nsutil.dll']);
  assert.deepEqual(resV1.importedLicenseFiles, ['flac_license.txt']);
  assert.equal(resV1.inventory.pack.installedPackVersion, '2026.03.13');
  assert.equal(resV1.inventory.pack.installedPackDate, '2026-03-13');

  // Import Pack v2 (creates synchronized backup of Pack v1)
  const resV2 = await manager.importEncoderPackFromFolder(packV2, {
    verifiedPackVersion: '2026.04.01',
    verifiedPackDate: '2026-04-01',
  });
  assert.equal(resV2.importedCount, 1);
  assert.equal(resV2.inventory.pack.installedPackVersion, '2026.04.01');
  assert.equal(resV2.inventory.pack.hasRollbackSnapshot, true);
  assert.deepEqual(resV2.inventory.pack.installedLicenseFiles, ['lame_license.txt']);
  const v2Flac = await manager.resolveCodec('flac');
  assert.equal(v2Flac.version, 'flac 1.4.3 pack-v2');

  // Rollback -> must restore Pack v1 binary, nsutil.dll, flac_license.txt AND codec-state.json metadata!
  const rollback = await manager.rollbackPack();
  assert.equal(rollback.rolledBack, true);
  assert.equal(rollback.inventory.pack.installedPackVersion, '2026.03.13');
  assert.equal(rollback.inventory.pack.installedPackDate, '2026-03-13');
  assert.equal(rollback.inventory.pack.installedPackSource, 'user-pack');
  assert.deepEqual(rollback.inventory.pack.installedSupportingDlls, ['nsutil.dll']);
  assert.deepEqual(rollback.inventory.pack.installedLicenseFiles, ['flac_license.txt']);

  const restoredFlac = await manager.resolveCodec('flac');
  assert.equal(restoredFlac.version, 'flac 1.4.2 pack-v1');
  await fs.access(path.join(userDataDir, 'codecs', 'pack', 'nsutil.dll'));
  await fs.access(path.join(userDataDir, 'codecs', 'pack', 'flac_license.txt'));

  // Verify codec-state.json on disk is truly synchronized
  const persistedState = JSON.parse(
    await fs.readFile(path.join(userDataDir, 'codecs', 'codec-state.json'), 'utf8'),
  );
  assert.equal(persistedState.installedPackVersion, '2026.03.13');
  assert.equal(persistedState.installedPackDate, '2026-03-13');
  assert.deepEqual(persistedState.installedSupportingDlls, ['nsutil.dll']);
  assert.deepEqual(persistedState.installedLicenseFiles, ['flac_license.txt']);
});

test('Remote Manifest Security: blocks unsafe URLs, private IPv4/IPv6 DNS, redirects, oversized payloads, and invalid JSON schemas', async (t) => {
  const root = await createTempWorkspace();
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  // 1. Unsafe URL patterns
  const unsafeUrls = [
    'http://example.com/manifest.json',
    'https://user:pass@example.com/manifest.json',
    'https://example.com:8443/manifest.json',
    'https://localhost/manifest.json',
    'https://sub.localhost/manifest.json',
    'https://127.0.0.1/manifest.json',
    'https://169.254.169.254/latest/meta-data',
    'https://10.0.0.5/manifest.json',
    'https://192.168.1.10/manifest.json',
    'https://172.16.0.1/manifest.json',
    'https://[::1]/manifest.json',
    'https://[::ffff:127.0.0.1]/manifest.json',
    'https://[fc00::1]/manifest.json',
    'https://[fe80::1]/manifest.json',
    'https://2130706433/manifest.json',
    'https://0x7f000001/manifest.json',
    'https://service.internal/manifest.json',
    'https://93.184.216.34/manifest.json', // direct IP blocked
  ];
  for (const url of unsafeUrls) {
    assert.equal(validateSafeUpdateManifestUrl(url).valid, false, `Expected unsafe URL rejected: ${url}`);
  }
  assert.equal(validateSafeUpdateManifestUrl('https://updates.doremi.example/manifest.json').valid, true);

  // Private IPv4/IPv6 helper checks
  assert.equal(isPrivateOrReservedIp('127.0.0.1'), true);
  assert.equal(isPrivateOrReservedIp('100.64.0.1'), true);
  assert.equal(isPrivateOrReservedIp('::1'), true);
  assert.equal(isPrivateOrReservedIp('::ffff:169.254.169.254'), true);
  assert.equal(isPrivateOrReservedIp('fe80::1234'), true);
  assert.equal(isPrivateOrReservedIp('93.184.216.34'), false);
  assert.equal(isPrivateOrReservedIp('2606:2800:220:1:248:1893:25c8:1946'), false);

  // 2. DNS resolving to private IP (anti-SSRF / anti-DNS-rebinding)
  let fetcherCalled = false;
  const privateDnsManager = new CodecManager({
    userDataDir: path.join(root, 'u1'),
    dnsResolver: async () => [{ address: '127.0.0.1', family: 4 }],
    remoteFetcher: async () => {
      fetcherCalled = true;
      return { statusCode: 200, headers: {}, bodyText: '{}' };
    },
  });
  const dnsBlocked = await privateDnsManager.fetchAndValidateRemoteManifest(
    'https://rebind.example.com/manifest.json',
  );
  assert.equal(dnsBlocked.ok, false);
  assert.equal(fetcherCalled, false);

  // 3. Unsafe HTTP Redirect (302) rejected outright
  const redirectManager = new CodecManager({
    userDataDir: path.join(root, 'u2'),
    dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
    remoteFetcher: async () => ({
      statusCode: 302,
      headers: { location: 'http://127.0.0.1/secret' },
    }),
  });
  const redirectRes = await redirectManager.fetchAndValidateRemoteManifest(
    'https://updates.example.com/manifest.json',
  );
  assert.equal(redirectRes.ok, false);
  if (!redirectRes.ok) {
    assert.match(redirectRes.reason, /chuyển hướng|302/i);
  }

  // 4. Oversized manifest (> 64 KB) rejected
  const oversizedManager = new CodecManager({
    userDataDir: path.join(root, 'u3'),
    dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
    remoteFetcher: async () => ({
      statusCode: 200,
      headers: {},
      bodyText: 'x'.repeat(70 * 1024),
    }),
  });
  const oversizedRes = await oversizedManager.fetchAndValidateRemoteManifest(
    'https://updates.example.com/manifest.json',
  );
  assert.equal(oversizedRes.ok, false);
  if (!oversizedRes.ok) {
    assert.match(oversizedRes.reason, /vượt giới hạn/i);
  }

  // 5. Invalid JSON schema & version format rejected; valid schema accepted
  assert.equal(validateRemoteManifestSchema(['not-an-object']).valid, false);
  assert.equal(
    validateRemoteManifestSchema({ schemaVersion: 99, manifestVersion: '2026.03.13' }).valid,
    false,
  );
  assert.equal(
    validateRemoteManifestSchema({ schemaVersion: 2, manifestVersion: 'latest; rm -rf /' }).valid,
    false,
  );
  assert.equal(
    validateRemoteManifestSchema(JSON.parse('{"__proto__": {}, "schemaVersion": 2, "manifestVersion": "2026.03.13"}'))
      .valid,
    false,
  );

  const validRemoteManager = new CodecManager({
    userDataDir: path.join(root, 'u4'),
    dnsResolver: async () => [{ address: '93.184.216.34', family: 4 }],
    remoteFetcher: async ({ pinnedIp }) => {
      assert.equal(pinnedIp, '93.184.216.34');
      return {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        bodyText: JSON.stringify({
          schemaVersion: 2,
          manifestVersion: '2026.05.01',
          packName: 'DoReMi Default Encoder Pack',
          notes: ['Updated FLAC & Opus metadata.'],
        }),
      };
    },
  });
  const validRemote = await validRemoteManager.fetchAndValidateRemoteManifest(
    'https://updates.example.com/manifest.json',
  );
  assert.equal(validRemote.ok, true);
  if (validRemote.ok) {
    assert.equal(validRemote.manifest.manifestVersion, '2026.05.01');
  }
});

test('Encoder Pack Registry Consistency matches exact foobar2000 Free Encoder Pack 2026-03-13 inventory', async () => {
  const foobarEntries = getFoobarPackCodecEntries();
  const foobarIds = foobarEntries.map((e) => e.id).sort();

  // Exact 9 encoder executables in foobar2000 Free Encoder Pack 2026-03-13
  assert.deepEqual(foobarIds, [
    'fhgaacenc',
    'flac',
    'lame',
    'mpcenc',
    'oggenc',
    'opusenc',
    'qaac',
    'refalac',
    'wavpack',
  ]);

  // Verify filename matching for all 9 real pack executables
  assert.equal(matchFilenameToCodecId('fhgaacenc.exe'), 'fhgaacenc');
  assert.equal(matchFilenameToCodecId('flac.exe'), 'flac');
  assert.equal(matchFilenameToCodecId('lame.exe'), 'lame');
  assert.equal(matchFilenameToCodecId('mpcenc.exe'), 'mpcenc');
  assert.equal(matchFilenameToCodecId('oggenc2.exe'), 'oggenc');
  assert.equal(matchFilenameToCodecId('opusenc.exe'), 'opusenc');
  assert.equal(matchFilenameToCodecId('qaac64.exe'), 'qaac');
  assert.equal(matchFilenameToCodecId('refalac64.exe'), 'refalac');
  assert.equal(matchFilenameToCodecId('wavpack.exe'), 'wavpack');

  // Verify non-pack codecs are NOT marked includedInFoobarPack
  for (const nonPackId of [
    'opusdec',
    'wvunpack',
    'mpcdec',
    'fdkaac',
    'tak',
    'mac',
    'ffmpeg',
    'ffprobe',
    'alac-wasm',
  ] as const) {
    const entry = getCodecManifestById(nonPackId);
    assert.ok(entry, `Missing registry entry for ${nonPackId}`);
    assert.equal(entry.includedInFoobarPack, false, `${nonPackId} must NOT be marked includedInFoobarPack`);
  }

  // Distinct identities: refalac vs qaac vs alac-wasm; fhgaacenc vs fdkaac
  assert.equal(getCodecManifestById('refalac')?.requiredDependencies.length, 0);
  assert.equal(getCodecManifestById('qaac')?.requiredDependencies[0]?.name, 'CoreAudioToolbox.dll');
  assert.equal(getCodecManifestById('alac-wasm')?.group, 'builtin-wasm');
  assert.equal(getCodecManifestById('fhgaacenc')?.group, 'default-encoder-pack');
  assert.equal(getCodecManifestById('fdkaac')?.group, 'optional-encoder');

  // No fabricated SHA-256 checksums in DEFAULT_CODEC_MANIFEST
  for (const entry of DEFAULT_CODEC_MANIFEST) {
    assert.equal(entry.expectedSha256, null, `Checksum must not be fabricated for ${entry.id}`);
  }

  // Supporting DLL & 5 license files accurately tracked
  const supportingNames = FOOBAR_PACK_SUPPORTING_FILES.map((f) => f.fileName).sort();
  assert.deepEqual(supportingNames, [
    'fhgaacenc_license.txt',
    'flac_license.txt',
    'lame_license.txt',
    'nsutil.dll',
    'opusenc_license.txt',
    'wavpack_license.txt',
  ]);

  // Verify resources/codecs/manifest.json stays synchronized with codec-registry.ts
  const rawManifest = await fs.readFile(
    path.resolve(process.cwd(), 'resources', 'codecs', 'manifest.json'),
    'utf8',
  );
  const jsonManifest = JSON.parse(rawManifest) as {
    schemaVersion: number;
    defaultEncoderPack: Record<string, { expectedSha256: string | null }>;
    supportingDlls: Array<{ fileName: string }>;
    licenseFiles: string[];
  };
  assert.equal(jsonManifest.schemaVersion, 2);
  assert.deepEqual(Object.keys(jsonManifest.defaultEncoderPack).sort(), foobarIds);
  assert.deepEqual(
    jsonManifest.supportingDlls.map((d) => d.fileName),
    ['nsutil.dll'],
  );
  assert.deepEqual([...jsonManifest.licenseFiles].sort(), [
    'fhgaacenc_license.txt',
    'flac_license.txt',
    'lame_license.txt',
    'opusenc_license.txt',
    'wavpack_license.txt',
  ]);
  for (const [id, spec] of Object.entries(jsonManifest.defaultEncoderPack)) {
    assert.equal(spec.expectedSha256, null, `manifest.json must not fabricate checksum for ${id}`);
  }
});
