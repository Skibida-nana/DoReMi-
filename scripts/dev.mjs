import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const forwardedArgs = process.argv.slice(2);

const hasWebPreviewFlags = forwardedArgs.some(
  (arg) =>
    arg === '--port' ||
    arg.startsWith('--port=') ||
    arg === '--host' ||
    arg.startsWith('--host='),
);

const isHeadlessLinux =
  process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;

const useRendererOnlyPreview = hasWebPreviewFlags || isHeadlessLinux;

let binPath;
let childArgs;

if (useRendererOnlyPreview) {
  const vitePkgDir = path.dirname(require.resolve('vite/package.json'));
  binPath = path.join(vitePkgDir, 'bin', 'vite.js');
  childArgs = ['--config', 'vite.config.ts', ...forwardedArgs];
  console.log(
    '[Lossless Player] Starting renderer-only UI preview (headless/web preview mode). Run "npm run dev" on Windows desktop for the Electron app.',
  );
} else {
  const electronVitePkgDir = path.dirname(require.resolve('electron-vite/package.json'));
  binPath = path.join(electronVitePkgDir, 'bin', 'electron-vite.js');
  childArgs = ['dev', ...forwardedArgs];
}

const child = spawn(process.execPath, [binPath, ...childArgs], {
  stdio: 'inherit',
  env: process.env,
});

const forwardSignal = (signal) => {
  if (!child.killed) {
    child.kill(signal);
  }
};

process.on('SIGINT', () => forwardSignal('SIGINT'));
process.on('SIGTERM', () => forwardSignal('SIGTERM'));

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
