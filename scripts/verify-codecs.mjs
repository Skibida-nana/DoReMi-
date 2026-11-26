import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

const RESTRICTED_FILENAMES = new Set([
  'coreaudiotoolbox.dll',
  'enc_fhgaac.dll',
  'takc.exe',
  'qaac.exe',
  'qaac64.exe',
  'fhgaacenc.exe',
  'fdkaac.exe',
]);

export function verifyCodecResources(rootDir = projectRoot) {
  const codecsDir = path.join(rootDir, 'resources', 'codecs');
  const manifestPath = path.join(codecsDir, 'manifest.json');
  const errors = [];
  const warnings = [];
  const bundledFiles = [];

  if (!fs.existsSync(manifestPath)) {
    errors.push('Missing resources/codecs/manifest.json.');
  } else {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (parsed.schemaVersion !== 2) {
        errors.push(`Invalid manifest schemaVersion=${String(parsed.schemaVersion)} (expected 2).`);
      }
      if (!parsed.defaultEncoderPack || typeof parsed.defaultEncoderPack !== 'object') {
        errors.push('manifest.json missing defaultEncoderPack object.');
      }
    } catch (err) {
      errors.push(`Invalid JSON in resources/codecs/manifest.json: ${err?.message || err}`);
    }
  }

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        const rel = path.relative(codecsDir, full).replace(/\\/g, '/');
        bundledFiles.push(rel);
        if (RESTRICTED_FILENAMES.has(lower)) {
          errors.push(`Redistribution-restricted binary found in bundled resources/codecs/: ${rel}`);
        }
      }
    }
  };
  walk(codecsDir);

  if (bundledFiles.length === 1 && bundledFiles[0] === 'manifest.json') {
    warnings.push(
      'resources/codecs/ currently contains manifest.json only (no bundled .exe binaries staged in workspace).',
    );
  }

  return {
    ok: errors.length === 0,
    bundledFiles,
    errors,
    warnings,
  };
}

const isCliEntry =
  Boolean(process.argv[1]) &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isCliEntry) {
  const result = verifyCodecResources(projectRoot);
  if (!result.ok) {
    console.error('[verify-codecs] FAILED:');
    for (const err of result.errors) console.error(` - ${err}`);
    process.exit(1);
  }
  console.log(`[verify-codecs] OK (${result.bundledFiles.length} file(s): ${result.bundledFiles.join(', ')})`);
  for (const warn of result.warnings) {
    console.log(`[verify-codecs] NOTE: ${warn}`);
  }
}
