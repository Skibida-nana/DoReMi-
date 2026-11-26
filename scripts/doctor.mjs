import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectElectronRuntime } from './ensure-electron.mjs';
import { verifyBuildOutput } from './verify-build.mjs';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

function compareSemver(actual, minRequired) {
  const a = actual.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  const b = minRequired.replace(/^v/, '').split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) > (b[i] || 0)) return 1;
    if ((a[i] || 0) < (b[i] || 0)) return -1;
  }
  return 0;
}

function checkPackageInstalled(pkgName) {
  const pkgJsonPath = path.join(projectRoot, 'node_modules', ...pkgName.split('/'), 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
  } catch {
    return null;
  }
}

function probeSqliteWithRuntime(execPath, extraEnv = {}) {
  const script = [
    "const Database = require('better-sqlite3');",
    "const db = new Database(':memory:');",
    "const row = db.prepare('SELECT 1 + 1 AS ok').get();",
    'db.close();',
    "if (!row || row.ok !== 2) process.exit(2);",
    "console.log('SQLITE_PROBE_OK');",
  ].join(' ');

  const res = spawnSync(execPath, ['-e', script], {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    timeout: 15_000,
    windowsHide: true,
  });

  const combined = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  return {
    ok: res.status === 0 && combined.includes('SQLITE_PROBE_OK'),
    status: res.status,
    signal: res.signal,
    error: res.error ? res.error.message : null,
    output: combined,
  };
}

const checks = [];
const record = (level, name, detail) => {
  checks.push({ level, name, detail });
  const tag = level === 'PASS' ? '[PASS]' : level === 'WARN' ? '[WARN]' : level === 'INFO' ? '[INFO]' : '[FAIL]';
  console.log(`${tag} ${name}: ${detail}`);
};

console.log('=== DoReMi Environment Doctor ===');
console.log(`Workspace: ${projectRoot}`);
console.log(`Platform : ${process.platform} ${process.arch}`);

// 1. Node & N-API
const nodeOk = compareSemver(process.version, '22.12.0') >= 0;
record(
  nodeOk ? 'PASS' : 'FAIL',
  'Node.js',
  `${process.version} (modules=${process.versions.modules}, napi=${process.versions.napi}; Electron 45 requires >=22.12.0)`,
);

const napiVersion = Number.parseInt(String(process.versions.napi || '0'), 10);
if (napiVersion < 10) {
  record(
    'WARN',
    'System Node N-API',
    `napi=${process.versions.napi} (< 10). better-sqlite3@13.2.0 prebuild uses N-API 10 (node_api_module_get_api_version_v1), so standalone Node SQLite tests require Node >=22.14 / Node 24 or Electron runtime.`,
  );
} else {
  record('PASS', 'System Node N-API', `napi=${process.versions.napi} (>= 10)`);
}

// 2. Unicode / spaced workspace path check
const hasSpaces = /\s/.test(projectRoot);
const hasNonAscii = /[^\x00-\x7f]/.test(projectRoot);
record(
  'INFO',
  'Workspace Path',
  `spaces=${hasSpaces}, nonAscii=${hasNonAscii} (fs.existsSync=${fs.existsSync(projectRoot)})`,
);

// 3. package.json / package-lock.json sync for core deps
const pkgJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const lockPath = path.join(projectRoot, 'package-lock.json');
if (!fs.existsSync(lockPath)) {
  record('FAIL', 'package-lock.json', 'Missing package-lock.json');
} else {
  const lockJson = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const rootLock = lockJson.packages?.[''];
  const allDeps = { ...(pkgJson.dependencies || {}), ...(pkgJson.devDependencies || {}) };
  const lockDeps = { ...(rootLock?.dependencies || {}), ...(rootLock?.devDependencies || {}) };
  const missingInLock = Object.keys(allDeps).filter((d) => !(d in lockDeps));
  const missingInNodeModules = Object.keys(allDeps).filter((d) => !checkPackageInstalled(d));
  record(
    missingInLock.length === 0 ? 'PASS' : 'FAIL',
    'Lockfile Sync',
    missingInLock.length === 0
      ? `All ${Object.keys(allDeps).length} root dependencies present in package-lock.json`
      : `Missing from package-lock.json: ${missingInLock.join(', ')}`,
  );
  record(
    missingInNodeModules.length === 0 ? 'PASS' : 'FAIL',
    'Installed Dependencies',
    missingInNodeModules.length === 0
      ? 'All declared dependencies & devDependencies exist in node_modules'
      : `Missing in node_modules: ${missingInNodeModules.join(', ')}`,
  );
}

// 4. Platform optional native packages (Win32 x64)
if (process.platform === 'win32' && process.arch === 'x64') {
  const winNativePkgs = [
    '@rolldown/binding-win32-x64-msvc',
    '@tailwindcss/oxide-win32-x64-msvc',
    'lightningcss-win32-x64-msvc',
    '@esbuild/win32-x64',
  ];
  const missingNative = winNativePkgs.filter((p) => !checkPackageInstalled(p));
  record(
    missingNative.length === 0 ? 'PASS' : 'FAIL',
    'Windows Native Build Bindings',
    missingNative.length === 0
      ? winNativePkgs.join(', ')
      : `Missing optional native packages: ${missingNative.join(', ')} (run "npm ci --include=optional")`,
  );
}

// 5. Electron runtime
const electronCheck = inspectElectronRuntime(projectRoot);
record(
  electronCheck.ok ? 'PASS' : 'FAIL',
  'Electron Runtime',
  electronCheck.ok
    ? `Electron ${electronCheck.version} OK (${electronCheck.binaryPath})`
    : `${electronCheck.message} Run "npm run ensure:electron".`,
);

// 6. better-sqlite3 probes (isolated subprocesses)
const nodeSqlite = probeSqliteWithRuntime(process.execPath);
record(
  nodeSqlite.ok ? 'PASS' : napiVersion < 10 ? 'WARN' : 'FAIL',
  'better-sqlite3 (System Node)',
  nodeSqlite.ok
    ? 'Loads & executes :memory: SQLite query cleanly'
    : `Failed under ${process.version} (status=${nodeSqlite.status}; expected if host Node has N-API < 10)`,
);

if (electronCheck.ok) {
  const electronSqlite = probeSqliteWithRuntime(electronCheck.binaryPath, {
    ELECTRON_RUN_AS_NODE: '1',
  });
  record(
    electronSqlite.ok ? 'PASS' : 'FAIL',
    'better-sqlite3 (Electron Runtime)',
    electronSqlite.ok
      ? `Loads & executes :memory: SQLite query cleanly under Electron ${electronCheck.version}`
      : `Failed under Electron runtime (status=${electronSqlite.status}): ${electronSqlite.output}`,
  );
}

// 7. Build output status (advisory if not yet built)
const outMainExists = fs.existsSync(path.join(projectRoot, 'out', 'main', 'index.js'));
if (!outMainExists) {
  record('INFO', 'Production Build Output', 'out/ not built yet (run "npm run build")');
} else {
  const verifyRes = verifyBuildOutput(projectRoot);
  record(
    verifyRes.ok ? 'PASS' : 'FAIL',
    'Production Build Output',
    verifyRes.ok
      ? `Verified (${verifyRes.checkedFiles.join(', ')})`
      : verifyRes.errors.join(' | '),
  );
}

const failures = checks.filter((c) => c.level === 'FAIL');
console.log(`\nSummary: ${failures.length} hard failure(s), ${checks.filter((c) => c.level === 'WARN').length} warning(s).`);
if (failures.length > 0) {
  process.exit(1);
}
