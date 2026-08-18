import { svelte } from '@sveltejs/vite-plugin-svelte';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [svelte()],
  resolve: {
    alias: { '@web': resolve(root, '../src/web') },
  },
  build: { outDir: 'build', emptyOutDir: true },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8088', '/healthz': 'http://127.0.0.1:8088' },
  },
});
