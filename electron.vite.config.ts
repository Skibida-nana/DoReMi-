import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      externalizeDeps: true,
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/main/index.ts'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
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
          index: path.resolve(__dirname, 'src/preload/index.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
      },
    },
  },
  renderer: {
    root: path.resolve(__dirname, 'src/renderer'),
    build: {
      outDir: path.resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: path.resolve(__dirname, 'src/renderer/index.html'),
        },
      },
    },
    resolve: {
      alias: {
        '@shared': path.resolve(__dirname, 'src/shared'),
        '@renderer': path.resolve(__dirname, 'src/renderer/src'),
      },
    },
    plugins: [react(), tailwindcss()],
  },
});
