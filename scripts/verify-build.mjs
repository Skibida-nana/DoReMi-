import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

function collectScriptFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectScriptFiles(fullPath));
    } else if (/\.(?:js|mjs|cjs)$/i.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

export function verifyBuildOutput(rootDir = projectRoot) {
  const outDir = path.join(rootDir, 'out');
  const errors = [];
  const checkedFiles = [];

  const requiredFiles = [
    path.join(outDir, 'main', 'index.js'),
    path.join(outDir, 'preload', 'index.cjs'),
    path.join(outDir, 'renderer', 'index.html'),
  ];

  for (const filePath of requiredFiles) {
    if (!fs.existsSync(filePath)) {
      errors.push(`Missing required build output: ${path.relative(rootDir, filePath)}`);
      continue;
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) {
      errors.push(`Empty build output: ${path.relative(rootDir, filePath)}`);
    }
  }

  for (const subDir of ['main', 'preload']) {
    const scriptFiles = collectScriptFiles(path.join(outDir, subDir));
    for (const scriptPath of scriptFiles) {
      try {
        execFileSync(process.execPath, ['--check', scriptPath], {
          encoding: 'utf8',
          stdio: 'pipe',
          windowsHide: true,
        });
        checkedFiles.push(path.relative(rootDir, scriptPath));
      } catch (err) {
        const stderr = err?.stderr ? String(err.stderr).trim() : String(err?.message || err);
        errors.push(`Syntax check failed for ${path.relative(rootDir, scriptPath)}:\n${stderr}`);
      }
    }
  }

  const indexHtmlPath = path.join(outDir, 'renderer', 'index.html');
  if (fs.existsSync(indexHtmlPath)) {
    const html = fs.readFileSync(indexHtmlPath, 'utf8');
    if (!html.includes('id="root"') && !html.includes("id='root'")) {
      errors.push('out/renderer/index.html is missing root mount element (#root).');
    }

    const absAssetRefs = [...html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/gi)].map((m) => m[1]);
    if (absAssetRefs.length > 0) {
      errors.push(
        `out/renderer/index.html contains non-relative asset paths (${absAssetRefs.join(', ')}) that break file:// loading.`,
      );
    }

    const relAssetRefs = [...html.matchAll(/(?:src|href)=["'](\.\/assets\/[^"']+)["']/gi)].map((m) => m[1]);
    if (relAssetRefs.length === 0) {
      errors.push('out/renderer/index.html does not reference any ./assets/ bundles.');
    }

    for (const relRef of relAssetRefs) {
      const targetPath = path.resolve(path.dirname(indexHtmlPath), relRef);
      if (!fs.existsSync(targetPath)) {
        errors.push(`Missing asset referenced by out/renderer/index.html: ${relRef}`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedFiles,
    errors,
  };
}

const isCliEntry =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCliEntry) {
  const result = verifyBuildOutput();
  if (!result.ok) {
    console.error('[verify-build] Build verification FAILED:');
    for (const err of result.errors) {
      console.error(` - ${err}`);
    }
    process.exit(1);
  }
  console.log(`[verify-build] OK (${result.checkedFiles.join(', ')}, renderer assets verified).`);
}
