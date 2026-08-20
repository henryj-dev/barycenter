#!/usr/bin/env node
/**
 * 구현된 API·DDL 동결. 없는 계약을 만들지 않는다.
 *
 *   node scripts/freeze-b.mjs --write   정본을 다시 쓴다
 *   node scripts/freeze-b.mjs --check   드리프트면 non-zero
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const apiPath = join(root, 'SURFACE-API.json');
const ddlPath = join(root, 'SURFACE-DDL.sql');

function routesOf() {
  const src = readFileSync(join(root, 'src/api/server.ts'), 'utf8');
  const out = [];
  for (const m of src.matchAll(/route\('(GET|POST|PATCH|DELETE)', '([^']+)', '([^']+)'/g)) {
    out.push({ method: m[1], path: m[2], scope: m[3] });
  }
  return out;
}

function openApiOf(routes) {
  const paths = {};
  for (const r of routes) {
    const p = r.path.replace(/:([A-Za-z]+)/g, '{$1}');
    paths[p] ??= {};
    paths[p][r.method.toLowerCase()] = {
      operationId: `${r.method}:${r.path}`,
      'x-scope': r.scope,
      responses: { '200': { description: 'implemented' } },
    };
  }
  return {
    openapi: '3.0.3',
    info: { title: 'barycenter implemented API', version: 'v1' },
    paths,
  };
}

function ddlOf() {
  const dir = join(root, 'src/store/migrations');
  return readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()
    .map((n) => `-- ${n}\n${readFileSync(join(dir, n), 'utf8').trim()}\n`).join('\n');
}

const api = `${JSON.stringify(openApiOf(routesOf()), null, 2)}\n`;
const ddl = ddlOf();
const write = process.argv.includes('--write');
const check = process.argv.includes('--check') || !write;

if (write) {
  writeFileSync(apiPath, api);
  writeFileSync(ddlPath, ddl);
  console.log(`wrote ${apiPath} ${ddlPath} (${routesOf().length} routes)`);
}

if (check) {
  const wantApi = readFileSync(apiPath, 'utf8');
  const wantDdl = readFileSync(ddlPath, 'utf8');
  let bad = 0;
  if (wantApi !== api) {
    console.error('SURFACE-API.json 이 구현된 라우트와 다르다');
    bad = 1;
  }
  if (wantDdl !== ddl) {
    console.error('SURFACE-DDL.sql 이 마이그레이션과 다르다');
    bad = 1;
  }
  if (bad === 0) console.log(`ok  B freeze  ${routesOf().length} routes`);
  process.exit(bad);
}
