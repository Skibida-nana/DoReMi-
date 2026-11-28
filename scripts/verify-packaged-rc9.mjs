import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

const packagedExe = path.join(
  projectRoot,
  'release',
  'v1.0.0-rc.9',
  'win-unpacked',
  'DoReMi.exe',
);
const asarPath = path.join(
  projectRoot,
  'release',
  'v1.0.0-rc.9',
  'win-unpacked',
  'resources',
  'app.asar',
);
const unpackedSqliteNode = path.join(
  projectRoot,
  'release',
  'v1.0.0-rc.9',
  'win-unpacked',
  'resources',
  'app.asar.unpacked',
  'node_modules',
  'better-sqlite3',
  'prebuilds',
  'win32-x64.node',
);

const useDevRuntime = process.argv.includes('--dev');
if (!useDevRuntime) {
  assert.equal(fs.existsSync(packagedExe), true, `Missing packaged DoReMi.exe at ${packagedExe}`);
  assert.equal(fs.existsSync(asarPath), true, `Missing app.asar at ${asarPath}`);
  assert.equal(
    fs.existsSync(unpackedSqliteNode),
    true,
    `Missing unpacked win32-x64.node at ${unpackedSqliteNode}`,
  );

  const asarContent = fs.readFileSync(asarPath, 'latin1');
  for (const requiredToken of [
    '"version": "1.0.0-rc.9"',
    'HostPowerManager',
    'destroyScopedAgents',
    'getPooledSocketCounts',
    'HostResourceSampler',
    'connect:host-set-power-policy',
    'connect:host-get-resource-breakdown',
    'keep-awake-streaming',
    'keep-awake-host-on',
  ]) {
    assert.equal(
      asarContent.includes(requiredToken),
      true,
      `Expected token "${requiredToken}" inside packaged app.asar`,
    );
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-rc9-pkg-verify-'));
const tmpUserData = path.join(tmpRoot, 'userdata');
const tmpMusicDir = path.join(tmpRoot, 'music');
fs.mkdirSync(tmpUserData, { recursive: true });
fs.mkdirSync(tmpMusicDir, { recursive: true });

const ffmpeg =
  process.env.FFMPEG_PATH ||
  'D:\\Dowload\\FFmpeg\\ffmpeg-2026-11-23-git-05c674c913-full_build\\bin\\ffmpeg.exe';
const sampleFlac = path.join(tmpMusicDir, 'Packaged-RC9-Verify.flac');
const ffRes = spawnSync(
  ffmpeg,
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=44100:duration=3',
    '-ac',
    '2',
    '-sample_fmt',
    's16',
    '-c:a',
    'flac',
    sampleFlac,
  ],
  { windowsHide: true, timeout: 20_000 },
);
if (ffRes.status !== 0 || !fs.existsSync(sampleFlac)) {
  // Fallback deterministic FLAC fixture if ffmpeg path omitted
  fs.writeFileSync(sampleFlac, Buffer.concat([Buffer.from('fLaC'), crypto.randomBytes(64 * 1024)]));
}

try {
  // Boot 1: Full functional run inside real packaged DoReMi.exe
  const boot1Json = path.join(tmpRoot, 'boot1.json');
  const env1 = {
    ...process.env,
    DOREMI_SMOKE_TEST: '1',
    DOREMI_SMOKE_EXTENDED: '1',
    DOREMI_SMOKE_PHASE: 'boot1',
    DOREMI_SMOKE_USER_DATA: tmpUserData,
    DOREMI_SMOKE_AUDIO_FILE: sampleFlac,
    DOREMI_SMOKE_OUT: boot1Json,
  };
  delete env1.ELECTRON_RUN_AS_NODE;

  const targetBin = useDevRuntime
    ? path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
    : packagedExe;
  const targetArgs = useDevRuntime ? [path.join(projectRoot, 'out', 'main', 'index.js')] : [];

  const r1 = spawnSync(targetBin, targetArgs, {
    cwd: projectRoot,
    env: env1,
    encoding: 'utf8',
    timeout: 45_000,
    windowsHide: true,
  });

  const boot1 = fs.existsSync(boot1Json) ? JSON.parse(fs.readFileSync(boot1Json, 'utf8')) : null;
  if (r1.status !== 0 || !boot1?.ok || !boot1?.extendedReport) {
    throw new Error(
      `Packaged RC.9 Boot 1 failed (status=${r1.status}): ${JSON.stringify(boot1)} stderr=${r1.stderr}`,
    );
  }

  const ext1 = boot1.extendedReport;
  if (!useDevRuntime) {
    assert.equal(boot1.isPackaged, true);
  }
  assert.equal(ext1.localCanPlay, true);
  assert.equal(ext1.defaultPowerPolicy, 'follow-system');
  assert.equal(ext1.blockerDuringHostOnPolicy, true);
  assert.equal(ext1.blockerDuringFollowPolicy, false);
  assert.equal(ext1.blockerDuringStreamGrace, true);
  assert.equal(ext1.remoteCanPlay, true);
  assert.equal(ext1.durationsMatch, true);
  assert.equal(ext1.resourceBreakdownSampled, true);
  assert.equal(ext1.reconnectedState, 'CONNECTED_LAN');
  assert.equal(ext1.disconnectedState, 'disconnected');
  assert.equal(ext1.stoppedState, 'STOPPED');
  assert.equal(ext1.stoppedBlockerActive, false);
  assert.equal(ext1.stoppedActiveStreams, 0);

  // Boot 2: Restart packaged DoReMi.exe against same isolated userData to prove SQLite v10 + DPAPI auth + power policy persistence
  const boot2Json = path.join(tmpRoot, 'boot2.json');
  const env2 = {
    ...process.env,
    DOREMI_SMOKE_TEST: '1',
    DOREMI_SMOKE_EXTENDED: '1',
    DOREMI_SMOKE_PHASE: 'boot2_verify_persistence',
    DOREMI_SMOKE_USER_DATA: tmpUserData,
    DOREMI_SMOKE_OUT: boot2Json,
  };
  delete env2.ELECTRON_RUN_AS_NODE;

  const r2 = spawnSync(targetBin, targetArgs, {
    cwd: projectRoot,
    env: env2,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  const boot2 = fs.existsSync(boot2Json) ? JSON.parse(fs.readFileSync(boot2Json, 'utf8')) : null;
  if (r2.status !== 0 || !boot2?.ok || !boot2?.extendedReport) {
    throw new Error(
      `Packaged RC.9 Boot 2 failed (status=${r2.status}): ${JSON.stringify(boot2)} stderr=${r2.stderr}`,
    );
  }

  const ext2 = boot2.extendedReport;
  assert.equal(ext2.persistedTrackCount, 1);
  assert.equal(ext2.persistedPowerPolicy, 'keep-awake-streaming');
  assert.equal(ext2.persistedAuthorizedDevices, 1);
  assert.equal(ext2.persistedRememberedHosts, 1);

  const reportOut = path.join(projectRoot, 'qa', 'logs', 'phase65-packaged-rc9-verification.json');
  fs.mkdirSync(path.dirname(reportOut), { recursive: true });
  fs.writeFileSync(
    reportOut,
    JSON.stringify(
      {
        verifiedAt: new Date().toISOString(),
        packagedExecutable: 'release/v1.0.0-rc.9/win-unpacked/DoReMi.exe',
        version: '1.0.0-rc.9',
        boot1Functional: ext1,
        boot2Persistence: ext2,
      },
      null,
      2,
    ),
    'utf8',
  );
  console.log(`PACKAGED_RC9_FUNCTIONAL_VERIFICATION_OK -> ${reportOut}`);
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
