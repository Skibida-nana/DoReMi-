import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const currentFile = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(currentFile);
const projectRoot = path.resolve(moduleDir, '..');

if (process.env.DOREMI_SYNC_TSX !== '1') {
  const require = createRequire(import.meta.url);
  const tsxPkgDir = path.dirname(require.resolve('tsx/package.json', { paths: [projectRoot] }));
  const tsxCli = path.join(tsxPkgDir, 'dist', 'cli.mjs');
  const res = spawnSync(process.execPath, [tsxCli, currentFile, ...process.argv.slice(2)], {
    cwd: projectRoot,
    env: { ...process.env, DOREMI_SYNC_TSX: '1' },
    stdio: 'inherit',
    windowsHide: true,
  });
  process.exit(res.status ?? 1);
}

const targetFile = path.join(projectRoot, 'docs', 'USER_GUIDE.md');
const isCheckMode = process.argv.includes('--check');

const pkgRaw = await fs.readFile(path.join(projectRoot, 'package.json'), 'utf8');
const pkg = JSON.parse(pkgRaw);
const versionLabel = `v${pkg.version}`;

const guideModuleUrl = pathToFileURL(
  path.join(projectRoot, 'src', 'shared', 'user-guide', 'guide-markdown.ts'),
).href;
const { renderUserGuideMarkdown } = await import(guideModuleUrl);

const expectedMarkdown = renderUserGuideMarkdown(versionLabel);

if (isCheckMode) {
  let existing = '';
  try {
    existing = await fs.readFile(targetFile, 'utf8');
  } catch {
    console.error(`[docs:sync] Missing ${path.relative(projectRoot, targetFile)}. Run npm run docs:sync.`);
    process.exit(1);
  }
  if (existing !== expectedMarkdown) {
    console.error(
      `[docs:sync] ${path.relative(projectRoot, targetFile)} is out of sync with src/shared/user-guide/guide-content.ts. Run npm run docs:sync.`,
    );
    process.exit(1);
  }
  console.log(`[docs:sync] OK: ${path.relative(projectRoot, targetFile)} matches ${versionLabel}.`);
  process.exit(0);
}

await fs.mkdir(path.dirname(targetFile), { recursive: true });
await fs.writeFile(targetFile, expectedMarkdown, 'utf8');
console.log(`[docs:sync] Generated ${path.relative(projectRoot, targetFile)} (${versionLabel}).`);
