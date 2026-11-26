import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureElectronRuntime } from './ensure-electron.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const require = createRequire(import.meta.url);

const electron = ensureElectronRuntime({ rootDir: projectRoot, quiet: true });
if (!electron.ok) {
  console.error(`[benchmark:phase51] ${electron.message}`);
  process.exit(1);
}

const tsxPkgDir = path.dirname(require.resolve('tsx/package.json', { paths: [projectRoot] }));
const tsxCli = path.join(tsxPkgDir, 'dist', 'cli.mjs');
const targetScript = path.join(projectRoot, 'scripts', 'benchmark-phase51.ts');

const res = spawnSync(
  electron.binaryPath,
  [tsxCli, targetScript, ...process.argv.slice(2)],
  {
    cwd: projectRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: 'inherit',
    windowsHide: true,
  },
);

process.exit(res.status ?? 1);
