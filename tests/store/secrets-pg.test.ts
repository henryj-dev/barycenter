/**
 * `PgSecretStore` — 봉투 암호화로 PG 에 두는 SecretStore (DESIGN.md §4.8.1)
 *
 * **실물 PG 다.** 흉내로는 못 재는 것이 둘 있다 — 023 의 CHECK 제약(스킴·버전 모양·
 * 체인 짝)과 `bytea` 왕복이다. 인메모리로 흉내 내면 정작 재야 할 것을 안 잰다.
 *
 * 여기서 못 박는 것:
 *
 *   ① 왕복한다 — 넣은 바이트가 그대로 나온다
 *   ② **평문이 DB 에 없다** — 그것이 §4.8 조항의 실질이다
 *   ③ **KEK 가 다르면 안 열린다** — 덤프만으로는 아무것도 못 한다
 *   ④ **행을 옮기면 안 열린다** — AAD 가 참조라서 바꿔치기가 막힌다
 *   ⑤ 내용 주소가 `FsSecretStore` 와 **같은 참조**를 낸다 — 드라이버를 갈아도 참조가 산다
 *   ⑥ 사실 캐시가 동기 창구를 뒷받침한다
 *   ⑦ GC 가 정책을 공유한다
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FsSecretStore } from '../../src/dp/secrets.js';
import { PgSecretStore } from '../../src/dp/secrets-pg.js';
import { sweepSecretsPg } from '../../src/dp/secret-gc-pg.js';
import { newEcKey } from '../../src/acme/der.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('secretspg');
let db: Db;
let store: PgSecretStore;
let root = '';

const KEK = randomBytes(32);

function mintPair(cn: string): { pem: string; key: string } {
  const base = join(root, `mint-${cn}-${Math.random().toString(36).slice(2)}`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90',
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`,
    '-keyout', `${base}.key`, '-out', `${base}.crt`,
  ], { stdio: 'ignore' });
  return { pem: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  root = mkdtempSync(join(tmpdir(), 'bary-secretspg-'));
  store = new PgSecretStore({ db, kek: KEK });
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
  if (root !== '') {
    try { execFileSync('chmod', ['-R', 'u+w', root]); } catch { /* 이미 없으면 그만 */ }
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await db.query('TRUNCATE secret_materials');
  await store.refreshFacts();
});

describe('왕복', () => {
  it('넣은 바이트가 그대로 나온다', async () => {
    const m = mintPair('a.test');
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });
    const got = await store.get(ref.ref);
    expect(got.fullchain).toBe(m.pem);
    expect(got.privkey).toBe(m.key);
  });

  it('키 단독(`key://`)도 왕복한다 — ACME 주문이 쓰는 자리다', async () => {
    const pem = newEcKey().export({ type: 'pkcs8', format: 'pem' }).toString();
    const ref = await store.putKey('acct', pem);
    expect(await store.getKey(ref.ref)).toBe(pem);
  });

  it('**스킴을 안 섞는다** — 키 참조를 인증서 자리에 넣으면 그 자리에서 터진다', async () => {
    const m = mintPair('b.test');
    const certRef = await store.put('web', { fullchain: m.pem, privkey: m.key });
    await expect(store.getKey(certRef.ref)).rejects.toThrow(/키 참조 모양이 아니다/);
  });

  it('같은 자료를 다시 넣으면 **같은 버전**이다 — 내용 주소의 멱등', async () => {
    const m = mintPair('c.test');
    const a = await store.put('web', { fullchain: m.pem, privkey: m.key });
    const b = await store.put('web', { fullchain: m.pem, privkey: m.key });
    expect(b.ref).toBe(a.ref);
    expect((await db.query('SELECT count(*) c FROM secret_materials')).rows[0]!['c']).toBe('1');
  });

  it('**없는 참조는 던진다** — 최신으로 물러나면 롤백이 거짓말이 된다 (§8.3)', async () => {
    const missing = `store://web@${'0'.repeat(32)}`;
    await expect(store.get(missing)).rejects.toThrow(/시크릿이 없다/);
    await expect(store.describe(missing)).rejects.toThrow(/시크릿이 없다/);
  });
});

describe('§4.8 — 평문으로 두지 않는다', () => {
  it('**개인키가 DB 어디에도 평문으로 없다**', async () => {
    const m = mintPair('d.test');
    await store.put('web', { fullchain: m.pem, privkey: m.key });

    // 행 전체를 문자열로 만들어 훑는다 — 열을 하나 늘렸을 때 그것이 평문이면 잡힌다.
    const rows = (await db.query('SELECT * FROM secret_materials')).rows;
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain('PRIVATE KEY');
    expect(dump).not.toContain(m.key.trim());
    // 체인도 안 나간다. 비밀은 아니지만 굳이 평문으로 둘 이유도 없다.
    expect(dump).not.toContain('BEGIN CERTIFICATE');
  });

  it('**KEK 가 다르면 못 연다** — 덤프만 가져간 상대가 할 수 있는 일이 없다', async () => {
    const m = mintPair('e.test');
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });

    const wrong = new PgSecretStore({ db, kek: randomBytes(32) });
    await expect(wrong.get(ref.ref)).rejects.toThrow(/KEK 가 다르거나 자료가 변조됐다/);
  });

  it('**행을 다른 이름 자리로 옮기면 못 연다** — AAD 가 참조다', async () => {
    const m = mintPair('f.test');
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });

    // DB 를 쓸 수 있는 상대가 「이 인증서 자리에 저 자료」로 바꿔치기하는 모양.
    await db.query('UPDATE secret_materials SET name = $1 WHERE name = $2', ['other', 'web']);
    await expect(store.get(`store://other@${ref.version}`))
      .rejects.toThrow(/KEK 가 다르거나 자료가 변조됐다/);
  });

  it('오라클이 안 된다 — KEK 오류와 변조가 **같은 말**을 한다', async () => {
    const m = mintPair('g.test');
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });
    const wrong = new PgSecretStore({ db, kek: randomBytes(32) });

    // **열리면 그것도 실패다.** `catch` 만 보면 열린 경우가 조용히 지나간다.
    const message = async (p: Promise<unknown>): Promise<string> =>
      p.then(() => '열렸다 — 열리면 안 된다', (e: Error) => e.message);

    const kekError = await message(wrong.get(ref.ref));
    await db.query('UPDATE secret_materials SET name = $1', ['other']);
    const tamperError = await message(store.get(`store://other@${ref.version}`));

    expect(kekError.replace('other', 'web')).toBe(tamperError.replace('other', 'web'));
  });
});

describe('참조가 드라이버를 안 가린다', () => {
  it('`FsSecretStore` 와 **같은 참조**를 낸다 — 이전 경로의 전제다', async () => {
    const m = mintPair('h.test');
    const fs = new FsSecretStore(mkdtempSync(join(tmpdir(), 'bary-fscmp-')));
    const fsRef = await fs.put('web', { fullchain: m.pem, privkey: m.key });
    const pgRef = await store.put('web', { fullchain: m.pem, privkey: m.key });

    expect(pgRef.ref).toBe(fsRef.ref);
    expect(pgRef.sha256).toBe(fsRef.sha256);
    expect(pgRef.chainDigest).toBe(fsRef.chainDigest);
    expect(pgRef.keyDigest).toBe(fsRef.keyDigest);
  });

  it('`describe` 가 세대 결박용 digest 를 낸다', async () => {
    const m = mintPair('i.test');
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });
    expect(await store.describe(ref.ref)).toEqual(ref);
  });

  it('`listRefs` 가 두 스킴을 섞어서 낸다 — GC 의 root 넓히기가 쓴다', async () => {
    const m = mintPair('j.test');
    const cert = await store.put('web', { fullchain: m.pem, privkey: m.key });
    const key = await store.putKey('acct',
      newEcKey().export({ type: 'pkcs8', format: 'pem' }).toString());
    expect(await store.listRefs()).toEqual([key.ref, cert.ref].sort());
  });
});

describe('사실 캐시 — 동기 창구', () => {
  it('`put` 이 즉시 채운다 — 자기가 넣은 것은 바로 보인다', async () => {
    const m = mintPair('k.test');
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });
    expect(store.facts(ref.ref)?.domains).toEqual(['k.test']);
  });

  it('**다른 인스턴스가 넣은 것은 refresh 에 들어온다**', async () => {
    const m = mintPair('l.test');
    const other = new PgSecretStore({ db, kek: KEK });
    const ref = await other.put('web', { fullchain: m.pem, privkey: m.key });

    // 아직 이 인스턴스는 모른다 — 그리고 그것은 **「사실을 모른다」이지 「없다」가 아니다.**
    expect(store.facts(ref.ref)).toBeUndefined();
    await store.refreshFacts();
    expect(store.facts(ref.ref)?.domains).toEqual(['l.test']);
  });

  it('**재적재가 자기 쓰기를 안 지운다** — 질의를 기다리는 사이에 들어온 것', async () => {
    const m = mintPair('race.test');
    // `refreshFacts` 의 질의가 **아직 안 끝난 사이**에 `put` 이 끼어든다.
    // 그 질의의 스냅샷에는 이 행이 없으므로, 그대로 갈아 끼우면 사실이 사라진다.
    const refreshing = store.refreshFacts();
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });
    await refreshing;

    expect(store.facts(ref.ref)?.domains).toEqual(['race.test']);
  });

  it('miss 는 `undefined` 다 — 던지면 목록 조회가 통째로 죽는다', () => {
    expect(store.facts(`store://none@${'0'.repeat(32)}`)).toBeUndefined();
    expect(store.facts('영 참조가 아니다')).toBeUndefined();
  });

  it('**자료를 복호화하지 않는다** — KEK 없이도 사실은 적재된다', async () => {
    const m = mintPair('m.test');
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });

    const noKek = new PgSecretStore({ db, kek: randomBytes(32) });
    await noKek.refreshFacts();
    expect(noKek.facts(ref.ref)?.notAfter).toBeTruthy();
    // 그래도 자료는 못 연다. 둘은 다른 권한이다.
    await expect(noKek.get(ref.ref)).rejects.toThrow();
  });
});

describe('청소', () => {
  it('root 는 안 지우고, root 아닌 옛것은 지운다 — 정책은 파일시스템과 같다', async () => {
    const a = mintPair('o.test');
    const b = mintPair('p.test');
    const rKeep = await store.put('web', { fullchain: a.pem, privkey: a.key });
    const rDrop = await store.put('web', { fullchain: b.pem, privkey: b.key });

    const out = await sweepSecretsPg({
      db, roots: [rKeep.ref], keepPerName: 0, minAgeMs: 0,
    });
    expect(out.failed).toEqual([]);
    expect(out.removed).toContain(rDrop.ref);
    expect(out.removed).not.toContain(rKeep.ref);
    expect(await store.listRefs()).toContain(rKeep.ref);
  });

  it('**갓 만든 것은 안 지운다** — 주문이 아직 참조를 안 적었을 수 있다', async () => {
    const m = mintPair('q.test');
    const ref = await store.put('web', { fullchain: m.pem, privkey: m.key });
    const out = await sweepSecretsPg({ db, roots: [], keepPerName: 0 });
    expect(out.removed).toEqual([]);
    expect(out.kept).toContain(ref.ref);
  });

  it('**이름당 안전망이 걸린다** — root 계산이 틀렸을 때 전부 안 지운다', async () => {
    const refs: string[] = [];
    for (const cn of ['r1.test', 'r2.test', 'r3.test']) {
      const m = mintPair(cn);
      refs.push((await store.put('web', { fullchain: m.pem, privkey: m.key })).ref);
    }
    const out = await sweepSecretsPg({ db, roots: [], keepPerName: 2, minAgeMs: 0 });
    expect(out.removed).toHaveLength(1);
    expect(out.kept).toHaveLength(2);
    expect(refs).toContain(out.removed[0]);
  });
});
