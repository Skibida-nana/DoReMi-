import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const configDirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig(() => {
  return {
    root: path.resolve(configDirname, 'src/renderer'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@shared': path.resolve(configDirname, 'src/shared'),
        '@renderer': path.resolve(configDirname, 'src/renderer/src'),
      },
    },
    build: {
      outDir: path.resolve(configDirname, 'dist'),
      emptyOutDir: true,
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
