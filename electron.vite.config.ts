import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const configDirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: path.resolve(configDirname, 'src/main/index.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(configDirname, 'src/shared'),
      },
    },
  },
  preload: {
    build: {
      outDir: 'out/preload',
      // Required for Electron sandbox: true — preload must be self-contained CommonJS
      externalizeDeps: false,
      isolatedEntries: true,
      rollupOptions: {
        input: {
          index: path.resolve(configDirname, 'src/preload/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(configDirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: path.resolve(configDirname, 'src/renderer'),
    build: {
      outDir: path.resolve(configDirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: path.resolve(configDirname, 'src/renderer/index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(configDirname, 'src/shared'),
        '@renderer': path.resolve(configDirname, 'src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
