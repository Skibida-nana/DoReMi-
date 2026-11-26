import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const require = createRequire(import.meta.url);

function getExpectedBinaryRelativePath(platform) {
  if (platform === 'win32') return 'electron.exe';
  if (platform === 'darwin') return path.join('Electron.app', 'Contents', 'MacOS', 'Electron');
  if (platform === 'linux') return 'electron';
  return null;
}

function hasValidWindowsPeHeader(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(2);
    const bytesRead = fs.readSync(fd, header, 0, 2, 0);
    return bytesRead === 2 && header[0] === 0x4d && header[1] === 0x5a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function inspectElectronRuntime(rootDir = projectRoot) {
  let electronPkgPath;
  try {
    electronPkgPath = require.resolve('electron/package.json', { paths: [rootDir] });
  } catch {
    return {
      ok: false,
      reason: 'missing-package',
      message: 'Package "electron" is not installed in node_modules. Run "npm ci --include=optional".',
    };
  }

  const electronDir = path.dirname(electronPkgPath);
  const pkg = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8'));
  const expectedVersion = String(pkg.version || '').trim();
  const pathTxtFile = path.join(electronDir, 'path.txt');

  if (!fs.existsSync(pathTxtFile)) {
    return {
      ok: false,
      reason: 'missing-path-txt',
      electronDir,
      expectedVersion,
      message: `Missing Electron path.txt at ${pathTxtFile}. Electron binary install has not completed.`,
    };
  }

  const recordedRelPath = fs.readFileSync(pathTxtFile, 'utf8').trim();
  const expectedRelPath = getExpectedBinaryRelativePath(process.platform);
  if (!recordedRelPath) {
    return {
      ok: false,
      reason: 'empty-path-txt',
      electronDir,
      expectedVersion,
      message: `Electron path.txt is empty at ${pathTxtFile}.`,
    };
  }

  if (expectedRelPath && path.normalize(recordedRelPath) !== path.normalize(expectedRelPath)) {
    return {
      ok: false,
      reason: 'platform-mismatch',
      electronDir,
      expectedVersion,
      recordedRelPath,
      expectedRelPath,
      message: `Electron path.txt points to "${recordedRelPath}", expected "${expectedRelPath}" for ${process.platform}.`,
    };
  }

  const distDir = path.join(electronDir, 'dist');
  const binaryPath = path.resolve(distDir, recordedRelPath);
  const relFromDist = path.relative(distDir, binaryPath);
  if (relFromDist.startsWith('..') || path.isAbsolute(relFromDist)) {
    return {
      ok: false,
      reason: 'unsafe-binary-path',
      electronDir,
      expectedVersion,
      binaryPath,
      message: `Unsafe Electron binary path in path.txt: "${recordedRelPath}".`,
    };
  }

  if (!fs.existsSync(binaryPath)) {
    return {
      ok: false,
      reason: 'missing-binary',
      electronDir,
      expectedVersion,
      binaryPath,
      message: `Electron binary does not exist at ${binaryPath}.`,
    };
  }

  const stat = fs.statSync(binaryPath);
  if (!stat.isFile() || stat.size < 1_000_000) {
    return {
      ok: false,
      reason: 'corrupt-binary',
      electronDir,
      expectedVersion,
      binaryPath,
      message: `Electron binary appears incomplete (${stat.size} bytes) at ${binaryPath}.`,
    };
  }

  if (process.platform === 'win32' && !hasValidWindowsPeHeader(binaryPath)) {
    return {
      ok: false,
      reason: 'invalid-pe-header',
      electronDir,
      expectedVersion,
      binaryPath,
      message: `Electron binary at ${binaryPath} does not have a valid Windows PE header.`,
    };
  }

  const probe = spawnSync(
    binaryPath,
    ['-p', 'process.versions.electron'],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    },
  );

  const reportedVersion = (probe.stdout || '').trim();
  if (probe.error || probe.status !== 0 || reportedVersion !== expectedVersion) {
    return {
      ok: false,
      reason: 'probe-failed',
      electronDir,
      expectedVersion,
      binaryPath,
      reportedVersion,
      probeStatus: probe.status,
      probeError: probe.error ? probe.error.message : (probe.stderr || '').trim(),
      message: `Electron binary probe failed (status=${probe.status}, reported="${reportedVersion}", expected="${expectedVersion}").`,
    };
  }

  return {
    ok: true,
    electronDir,
    binaryPath,
    version: reportedVersion,
    sizeBytes: stat.size,
  };
}

export function ensureElectronRuntime(options = {}) {
  const { checkOnly = false, quiet = false, rootDir = projectRoot } = options;
  const initial = inspectElectronRuntime(rootDir);
  if (initial.ok) {
    if (!quiet) {
      console.log(`[ensure-electron] Electron ${initial.version} ready at ${initial.binaryPath}`);
    }
    return initial;
  }

  if (initial.reason === 'missing-package' || checkOnly || process.env.DOREMI_SKIP_ELECTRON_INSTALL === '1') {
    if (!quiet) {
      console.error(`[ensure-electron] ${initial.message}`);
    }
    return initial;
  }

  const installScript = path.join(initial.electronDir, 'install.js');
  if (!fs.existsSync(installScript)) {
    return {
      ok: false,
      reason: 'missing-install-script',
      message: `Electron install script not found at ${installScript}.`,
    };
  }

  const maxAttempts = 2;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (!quiet) {
      console.log(
        `[ensure-electron] ${initial.message} Running electron/install.js (attempt ${attempt}/${maxAttempts})...`,
      );
    }

    const res = spawnSync(process.execPath, [installScript], {
      cwd: initial.electronDir,
      stdio: quiet ? 'pipe' : 'inherit',
      env: process.env,
      timeout: 180_000,
      windowsHide: true,
    });

    if (res.status === 0 && !res.error) {
      const verified = inspectElectronRuntime(rootDir);
      if (verified.ok) {
        if (!quiet) {
          console.log(`[ensure-electron] Installed and verified Electron ${verified.version}.`);
        }
        return verified;
      }
      if (!quiet) {
        console.warn(`[ensure-electron] Post-install verification failed: ${verified.message}`);
      }
    } else if (!quiet) {
      const reason = res.error ? res.error.message : `exit code ${res.status}`;
      console.warn(`[ensure-electron] install.js attempt ${attempt} failed (${reason}).`);
    }
  }

  return inspectElectronRuntime(rootDir);
}

const isCliEntry =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCliEntry) {
  const checkOnly = process.argv.includes('--check-only') || process.argv.includes('--check');
  const quiet = process.argv.includes('--quiet');
  const result = ensureElectronRuntime({ checkOnly, quiet });
  if (!result.ok) {
    if (quiet && result.message) {
      console.error(`[ensure-electron] ${result.message}`);
    }
    process.exit(1);
  }
}
