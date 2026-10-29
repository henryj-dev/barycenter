import adapter from '@sveltejs/adapter-static';
import { sveltekit } from '@sveltejs/kit/vite';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const root = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // SvelteKit 3 은 svelte.config.js 를 읽지 않는다 — 설정은 플러그인 인자로 넘긴다.
  // `@web` 별칭은 아래 resolve.alias 와 tsconfig paths 가 맡는다 (kit `alias` 는 폐기 예정).
  plugins: [
    sveltekit({
      preprocess: vitePreprocess(),
      compilerOptions: { runes: true },
      adapter: adapter({
        pages: 'build',
        assets: 'build',
        fallback: undefined,
        strict: true,
      }),
    }),
  ],
  resolve: {
    alias: { '@web': resolve(root, '../src/web') },
  },
  server: {
    proxy: { '/api': 'http://127.0.0.1:8088', '/healthz': 'http://127.0.0.1:8088' },
  },
});
