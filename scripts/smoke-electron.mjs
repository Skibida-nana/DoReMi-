import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectronRuntime } from './ensure-electron.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

function parseArgs(argv) {
  let exePath = null;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--exe' && argv[i + 1]) {
      exePath = path.resolve(projectRoot, argv[i + 1]);
      i += 1;
    }
  }
  return { exePath };
}

const { exePath } = parseArgs(process.argv.slice(2));
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'doremi-startup-smoke-'));
const tmpUserData = path.join(tmpRoot, 'userdata');
const outJson = path.join(tmpRoot, 'smoke-result.json');
fs.mkdirSync(tmpUserData, { recursive: true });

try {
  let binaryToLaunch = exePath;
  let launchArgs = [];

  if (!binaryToLaunch) {
    const electron = ensureElectronRuntime({ rootDir: projectRoot, quiet: true });
    if (!electron.ok) {
      throw new Error(electron.message || 'Electron runtime unavailable for smoke test.');
    }
    const outMain = path.join(projectRoot, 'out', 'main', 'index.js');
    if (!fs.existsSync(outMain)) {
      throw new Error('Missing out/main/index.js. Run "npm run build" first.');
    }
    binaryToLaunch = electron.binaryPath;
    launchArgs = [outMain];
  } else if (!fs.existsSync(binaryToLaunch)) {
    throw new Error(`Target packaged executable not found: ${binaryToLaunch}`);
  }

  const env = {
    ...process.env,
    DOREMI_SMOKE_TEST: '1',
    DOREMI_SMOKE_USER_DATA: tmpUserData,
    DOREMI_SMOKE_OUT: outJson,
  };
  delete env.ELECTRON_RUN_AS_NODE;

  if (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) {
    launchArgs.push('--no-sandbox', '--headless', '--disable-gpu');
  }

  const res = spawnSync(binaryToLaunch, launchArgs, {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });

  const result = fs.existsSync(outJson)
    ? JSON.parse(fs.readFileSync(outJson, 'utf8'))
    : null;

  if (res.error || res.status !== 0 || !result?.ok) {
    const stderr = (res.stderr || '').trim();
    const stdout = (res.stdout || '').trim();
    throw new Error(
      `Startup smoke test failed (status=${res.status}, signal=${res.signal}, error=${res.error?.message ?? 'none'}). ` +
        `Result=${JSON.stringify(result)} stdout="${stdout}" stderr="${stderr}"`,
    );
  }

  console.log(
    `[smoke-electron] OK (packaged=${result.isPackaged}, electron=${result.appInfo?.electronVersion}, ` +
      `rootChildren=${result.rootChildCount}, diagLogs=${result.diagCount})`,
  );
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
}
