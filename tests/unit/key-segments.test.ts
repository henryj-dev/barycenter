/**
 * 리소스 key 가 `:` 로 구간을 잇고 127 자까지 간다 (2026-11-20).
 *
 * 운영자의 이름 규칙 `{호스트}:{서비스}[:{세부}][:{분산 구분}]` — 예: `web-01.dc1:shop:api:01`.
 * 한 규칙이 여러 자리를 지난다: 저장 경계 · 시크릿 이름과 참조 · 주소 집합 참조 · CLI · 화면 · DB 의 CHECK.
 * 한 자리라도 옛 규칙이면 "어디서는 되고 어디서는 안 되는" 이름이 생긴다. 그래서 자리마다 잰다.
 *
 * 시스템이 짓는 이름(`<리스너>~http` · `disc~…`)은 `~` 로 옮겼다 — 사용자 key 와 겹치지 않아야 한다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RESOURCE_KEY_SYNTAX, PATH_SEGMENT_SYNTAX } from '../../src/validate/syntax.js';
import { addressSetRef } from '../../src/validate/ip.js';
import { redirectKeyOf, withRedirectListeners } from '../../src/model/redirect.js';
import { applyDiscoveredEndpoints } from '../../src/control/discovery.js';
import { parseSourceRule } from '../../src/cli/route.js';
import { FsSecretStore, parseRef } from '../../src/dp/secrets.js';
import { ConfigStore } from '../../src/store/config-store.js';
import type { Database } from '../../src/store/db.js';
import { openDbForTest } from '../../src/store/open.js';
import { keyError } from '../../gui/src/lib/forms/key-rule.js';
import type { Model } from '../../src/model/provisional.js';

const NAME = 'web-01.dc1:shop:api:01';

describe('리소스 key 규칙', () => {
  it('구간을 `:` 로 잇는 이름을 받는다', () => {
    for (const k of [NAME, 'web-01.dc1:shop:api', 'a', 'a:b', 'web_1:api-v2.x']) {
      expect(RESOURCE_KEY_SYNTAX.test(k), k).toBe(true);
    }
  });

  it('빈 구간 · 구간 머리의 기호 · 다른 기호는 거절한다', () => {
    for (const k of ['', ':a', 'a:', 'a::b', 'a:-b', 'a:.b', '-a', '.a', 'a b', 'a/b', 'a~http', 'a@b', 'a,b', 'a\n']) {
      expect(RESOURCE_KEY_SYNTAX.test(k), JSON.stringify(k)).toBe(false);
    }
  });

  it('127 자까지 받고 128 자는 거절한다', () => {
    expect(RESOURCE_KEY_SYNTAX.test('a'.repeat(127))).toBe(true);
    expect(RESOURCE_KEY_SYNTAX.test('a'.repeat(128))).toBe(false);
    expect(RESOURCE_KEY_SYNTAX.test(`${'a'.repeat(63)}:${'b'.repeat(63)}`)).toBe(true);
  });

  it('**세대 이름 규칙은 넓히지 않았다** — 셸 인자 자리로 간다', () => {
    expect(PATH_SEGMENT_SYNTAX.test('a:b')).toBe(false);
    expect(PATH_SEGMENT_SYNTAX.test('a'.repeat(64))).toBe(false);
  });

  it('화면의 이름 검사가 서버와 같은 판정을 한다', () => {
    expect(keyError(NAME)).toBeUndefined();
    expect(keyError('a::b')).toMatch(/127자/);
  });

  it('주소 집합 참조 `@이름` 도 같은 규칙이다', () => {
    expect(addressSetRef('@cloudflare:ips:v4')).toBe('cloudflare:ips:v4');
    expect(addressSetRef('@a::b')).toBeUndefined();
    expect(addressSetRef('a:b')).toBeUndefined();
  });
});

describe('시스템이 짓는 이름은 `~` 다 — 사용자 key 와 안 겹친다', () => {
  it('HTTPS 리스너의 리다이렉트 소켓 `<리스너>~http` 가 사용자 리스너 `<리스너>:http` 와 다르다', () => {
    expect(redirectKeyOf('a')).toBe('a~http');
    expect(RESOURCE_KEY_SYNTAX.test(redirectKeyOf('a'))).toBe(false);
    const listeners = [
      { key: 'a', protocol: 'https' as const, bind: '0.0.0.0', port: 443, enabled: true, httpRedirect: { port: 80 } },
      { key: 'a:http', protocol: 'http' as const, bind: '0.0.0.0', port: 8080, enabled: true },
    ];
    const keys = withRedirectListeners(listeners as never).map((l) => l.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('디스커버리로 찾은 백엔드 이름이 사용자 key 규칙 밖이다', () => {
    const model = { backends: [] } as unknown as Model;
    const out = applyDiscoveredEndpoints(model, {
      advertised: true, endpoints: [{ pool: 'p', host: '10.0.0.1', port: 80 }],
    } as never);
    const key = out.backends[0]!.key;
    expect(key).toBe('disc~p~10.0.0.1~80');
    expect(RESOURCE_KEY_SYNTAX.test(key)).toBe(false);
  });
});

describe('CLI `--source-rule` 의 풀', () => {
  it('`,ws` 가 웹소켓이다 — 풀 이름에 `:` 가 있어도 모호하지 않다', () => {
    expect(parseSourceRule(`10.0.0.0/8=pool:${NAME},ws`).action).toEqual({ kind: 'proxy', pool: NAME, websocket: true });
    expect(parseSourceRule(`10.0.0.0/8=pool:${NAME}`).action).toEqual({ kind: 'proxy', pool: NAME, websocket: false });
  });

  it('옛 모양 `pool:<풀>:ws` 는 풀 이름에 `:` 가 없을 때만 웹소켓으로 읽는다', () => {
    expect(parseSourceRule('10.0.0.0/8=pool:app:ws').action).toEqual({ kind: 'proxy', pool: 'app', websocket: true });
    expect(parseSourceRule('10.0.0.0/8=pool:a:b:ws').action).toEqual({ kind: 'proxy', pool: 'a:b:ws', websocket: false });
    expect(() => parseSourceRule('10.0.0.0/8=pool:app,wss')).toThrow(/,ws 만/);
  });
});

describe('시크릿 이름과 참조', () => {
  let dir: string;
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'bary-key-seg-secret-')); });
  // 저장소가 버전 디렉토리를 읽기 전용으로 잠근다 — 쓰기를 돌려 놓고 지운다.
  afterAll(() => {
    try { execFileSync('chmod', ['-R', 'u+w', dir]); } catch { /* 이미 없으면 그만 */ }
    rmSync(dir, { recursive: true, force: true });
  });

  it('`acme-<key>` 처럼 `:` 가 든 이름으로 키를 맡기고 참조를 다시 읽는다', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const store = new FsSecretStore(dir);
    const ref = await store.putKey(`acme-${NAME}`, privateKey.export({ format: 'pem', type: 'pkcs8' }).toString());
    expect(ref.ref.startsWith(`key://acme-${NAME}@`)).toBe(true);
  });

  it('`store://<이름>@<버전>` 의 이름에 `:` 가 있어도 읽는다', () => {
    expect(parseRef(`store://${NAME}@0123456789abcdef0123456789abcdef`).name).toBe(NAME);
  });

  it('`.`·`..`·`/` 는 여전히 거절한다', async () => {
    const store = new FsSecretStore(dir);
    for (const bad of ['..', '.', 'a/b']) {
      await expect(store.putKey(bad, 'x')).rejects.toThrow(/쓸 수 없는/);
    }
  });
});

describe('SQLite — 034 가 CHECK 를 넓힌다 (sqlite_schema 를 직접 고치는 단계)', () => {
  let dir: string;
  let db: Database;
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'bary-key-seg-sqlite-'));
    db = openDbForTest(`sqlite:${join(dir, 'bary.db')}`);
    await db.migrate();
  });
  afterAll(async () => {
    await db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('`:` 가 든 풀을 changeset 으로 저장한다', async () => {
    const store = new ConfigStore(db);
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 'tester');
    await store.patchChangeset(cs, [{ op: 'put', kind: 'pool', key: NAME, body: { protocolClass: 'http', algorithm: 'round_robin' } }], 'tester');
    const plan = await store.plan(cs, 'tester');
    await store.commit(cs, plan.id, 'tester');
    const rows = (await db.query('SELECT key FROM pools WHERE key = $1', [NAME])).rows;
    expect(rows).toHaveLength(1);
  });

  it('**DB 가 마지막 그물이다** — 앱을 건너뛴 나쁜 key 는 CHECK 가 막는다', async () => {
    for (const bad of ['a::b', 'a:', 'a:-b', 'a'.repeat(128)]) {
      await expect(db.query('UPDATE pools SET key = $1 WHERE key = $2', [bad, NAME]), bad).rejects.toThrow();
    }
  });

  it('스키마를 고친 뒤에도 무결성 검사가 통과하고 방어 모드가 돌아와 있다', async () => {
    expect((await db.query('PRAGMA quick_check')).rows[0]).toEqual({ quick_check: 'ok' });
    await expect(db.query("UPDATE sqlite_schema SET sql = sql WHERE name = 'pools'")).rejects.toThrow();
  });
});
