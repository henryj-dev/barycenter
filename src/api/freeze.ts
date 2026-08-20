/**
 * 구현된 API·DDL 동결. 없는 계약을 미리 적지 않는다 (§9.1.1).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Scope } from './auth.js';

export type FrozenRoute = { method: string; path: string; scope: Scope };

export function openApiOf(routes: readonly FrozenRoute[]): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const r of routes) {
    const p = r.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const item = paths[p] ?? {};
    item[r.method.toLowerCase()] = {
      operationId: `${r.method}:${r.path}`,
      'x-scope': r.scope,
      responses: { '200': { description: 'implemented' } },
    };
    paths[p] = item;
  }
  return {
    openapi: '3.0.3',
    info: { title: 'barycenter implemented API', version: 'v1' },
    paths,
  };
}

export function ddlFromMigrations(dir: string): string {
  const names = readdirSync(dir).filter((n) => n.endsWith('.sql')).sort();
  return names.map((n) => `-- ${n}\n${readFileSync(join(dir, n), 'utf8').trim()}\n`).join('\n');
}

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../store/migrations');
