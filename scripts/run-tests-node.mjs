import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');
const require = createRequire(import.meta.url);

// Preflight check: SQLite integration tests require Electron runtime or Node with N-API >= 10
const probe = spawnSync(
  process.execPath,
  ['-e', "const D = require('better-sqlite3'); const db = new D(':memory:'); db.close();"],
  { cwd: projectRoot, encoding: 'utf8', stdio: 'pipe', windowsHide: true },
);

const forwarded = process.argv.slice(2);
if (probe.status !== 0 && forwarded.length === 0) {
  console.error(
    `[test] Host Node ${process.version} (napi=${process.versions.napi}) cannot load better-sqlite3 prebuild (requires N-API 10 / Electron runtime ABI).`,
  );
  console.error('[test] Run "npm run test:electron" for the full Windows/Electron test suite.');
  process.exit(1);
}

const tsxPkgDir = path.dirname(require.resolve('tsx/package.json', { paths: [projectRoot] }));
const tsxCli = path.join(tsxPkgDir, 'dist', 'cli.mjs');
const targets =
  forwarded.length > 0
    ? forwarded
    : fs
        .readdirSync(path.join(projectRoot, 'tests'))
        .filter((f) => f.endsWith('.test.ts'))
        .sort()
        .map((f) => path.join('tests', f));

const res = spawnSync(process.execPath, [tsxCli, '--test', ...targets], {
  cwd: projectRoot,
  stdio: 'inherit',
  windowsHide: true,
});
process.exit(res.status ?? 1);
