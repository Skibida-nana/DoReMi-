import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectronRuntime } from './ensure-electron.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

const electron = ensureElectronRuntime({ rootDir: projectRoot, quiet: true });
if (!electron.ok) {
  console.error(`[verify-windows-power] ${electron.message}`);
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-win-power-probe-'));
const probeScript = path.join(tmpDir, 'probe-main.cjs');
const outJsonPath = path.join(projectRoot, 'qa', 'logs', 'phase65-windows-power-verification.json');

function inspectPowerCfgRequests() {
  try {
    const out = execFileSync('powercfg.exe', ['/requests'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    });
    return { elevatedAccess: true, output: out.trim(), error: null };
  } catch (err) {
    const stdout = err && typeof err === 'object' && 'stdout' in err ? String(err.stdout || '') : '';
    const stderr = err && typeof err === 'object' && 'stderr' in err ? String(err.stderr || '') : '';
    return {
      elevatedAccess: false,
      output: stdout.trim(),
      error: (stderr || (err instanceof Error ? err.message : String(err))).trim(),
    };
  }
}

fs.writeFileSync(
  probeScript,
  `
const { app, powerSaveBlocker, powerMonitor } = require('electron');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

function probePowerCfg() {
  try {
    const stdout = execFileSync('powercfg.exe', ['/requests'], { encoding: 'utf8', timeout: 4000, windowsHide: true });
    return { ok: true, stdout };
  } catch (e) {
    return { ok: false, stderr: String((e && (e.stderr || e.message)) || e) };
  }
}

app.whenReady().then(async () => {
  const outFile = process.env.DOREMI_POWER_PROBE_OUT;
  const before = {
    onBatteryPower: typeof powerMonitor.isOnBatteryPower === 'function' ? powerMonitor.isOnBatteryPower() : null,
    powerCfg: probePowerCfg(),
  };

  // Acquire Electron 'prevent-app-suspension' (System sleep blocked; Display sleep NOT blocked!)
  const blockerId = powerSaveBlocker.start('prevent-app-suspension');
  const startedCheck = powerSaveBlocker.isStarted(blockerId);
  await new Promise((r) => setTimeout(r, 250));
  const duringActive = probePowerCfg();

  // Release owned blocker
  powerSaveBlocker.stop(blockerId);
  const stoppedCheck = !powerSaveBlocker.isStarted(blockerId);
  await new Promise((r) => setTimeout(r, 200));
  const afterRelease = probePowerCfg();

  fs.mkdirSync(require('node:path').dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({
    verifiedAt: new Date().toISOString(),
    electronVersion: process.versions.electron,
    platform: process.platform,
    blockerModeTested: 'prevent-app-suspension',
    displaySleepAllowedNormally: true,
    onBatteryPower: before.onBatteryPower,
    blockerId,
    isStartedWhileActive: startedCheck,
    isStoppedAfterRelease: stoppedCheck,
    osPowerCfgBefore: before.powerCfg,
    osPowerCfgDuringActive: duringActive,
    osPowerCfgAfterRelease: afterRelease,
    physicalAutoSleepNote: 'Physical automatic Windows Sleep timer test NOT RUN (never force-suspending active user computer).',
  }, null, 2), 'utf8');
  app.exit(0);
}).catch((err) => {
  console.error(err);
  app.exit(1);
});
`,
  'utf8',
);

try {
  const env = { ...process.env, DOREMI_POWER_PROBE_OUT: outJsonPath };
  delete env.ELECTRON_RUN_AS_NODE;
  const res = spawnSync(electron.binaryPath, [probeScript], {
    cwd: projectRoot,
    env,
    stdio: 'inherit',
    windowsHide: true,
    timeout: 25_000,
  });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
  const postExitPowerCfg = inspectPowerCfgRequests();
  const saved = JSON.parse(fs.readFileSync(outJsonPath, 'utf8'));
  saved.osPowerCfgAfterProcessExit = postExitPowerCfg;
  fs.writeFileSync(outJsonPath, JSON.stringify(saved, null, 2), 'utf8');
  console.log(`WINDOWS_POWER_VERIFIED=${outJsonPath}`);
  console.log(
    JSON.stringify(
      {
        isStartedWhileActive: saved.isStartedWhileActive,
        isStoppedAfterRelease: saved.isStoppedAfterRelease,
        onBatteryPower: saved.onBatteryPower,
        powerCfgElevated: postExitPowerCfg.elevatedAccess,
      },
      null,
      2,
    ),
  );
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
