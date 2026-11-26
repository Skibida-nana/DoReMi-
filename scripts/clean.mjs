import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(moduleDir, '..');

for (const dirName of ['out', 'dist', 'release']) {
  const target = path.join(projectRoot, dirName);
  fs.rmSync(target, { recursive: true, force: true });
}

console.log('[clean] Removed out, dist, and release directories.');
