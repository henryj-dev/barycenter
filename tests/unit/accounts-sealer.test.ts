/**
 * 계정 봉인 어댑터 — KEK 출처(값 · 파일 · 명령) · 로컬 봉인의 **바이트 호환** · Vault transit · 등록부.
 *
 * 호환 시험이 제일 중요하다: 운영 계정 PG 의 `mfa_totp.secret_sealed` 는 옛 `Sealer` 가 만든 값이다. 새 코드가
 * 그것을 못 열면 모든 사람의 인증 앱이 한꺼번에 죽는다. 그래서 **옛 코드를 이 파일에 그대로 얼려 두고** 서로 연다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { resolveKeyFrom } from '../../src/dp/kek-source.js';
import { Sealer } from '../../src/accounts/seal.js';
import { ACCOUNTS_KEK_SOURCE, LocalSealer } from '../../src/accounts/sealer/local.js';
import { routedSealer, sealerFromEnv } from '../../src/accounts/sealer/registry.js';
import { MAX_VAULT_RESPONSE_BYTES, VaultTransitSealer } from '../../src/accounts/sealer/vault-transit.js';

// ── 얼린 옛 코드 (origin/main 의 src/accounts/seal.ts, 2026-11-05) — 고치지 않는다 ─────────────
class FrozenSealer {
  readonly #key: Buffer;
  constructor(keyB64: string) {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) throw new Error('BARY_ACCOUNTS_KEK 는 32바이트를 base64 로 적은 값이어야 한다');
    this.#key = key;
  }
  seal(plain: Buffer, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return ['v1', iv, ct, c.getAuthTag()].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
  }
  open(sealed: string, aad: string): Buffer {
    const [v, iv, ct, tag] = sealed.split('.');
    if (v !== 'v1' || iv === undefined || ct === undefined || tag === undefined) throw new Error('봉인 형식이 아니다');
    const d = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  }
}

const KEY = randomBytes(32);
const B64 = KEY.toString('base64');
const says = (stdout: string) => async () => ({ stdout, stderr: '' });
/** 가짜 Vault 토큰 — 실행 중에 만든다(gitleaks 에 걸리지 않게). */
const FAKE_TOKEN = ['fake', 'vault', 'token'].join('-');

describe('계정 KEK 출처 — 값 · 파일 · 명령 (인증서 KEK 와 같은 코드)', () => {
  it('값을 그대로 주면 그 값이다 — 지금 운영의 길(env 값)', async () => {
    expect((await resolveKeyFrom({ BARY_ACCOUNTS_KEK: B64 }, ACCOUNTS_KEK_SOURCE)).equals(KEY)).toBe(true);
  });

  it('**옛 규칙만큼 너그럽다** — base64url · 패딩 없음도 예전처럼 받는다', async () => {
    const url = KEY.toString('base64url');
    expect((await resolveKeyFrom({ BARY_ACCOUNTS_KEK: url }, ACCOUNTS_KEK_SOURCE)).equals(KEY)).toBe(true);
    expect((await resolveKeyFrom({ BARY_ACCOUNTS_KEK: B64.replace(/=+$/, '') }, ACCOUNTS_KEK_SOURCE)).equals(KEY)).toBe(true);
  });

  it('파일에서 읽는다 — 끝 개행은 다듬는다', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bary-kek-'));
    const f = join(dir, 'kek');
    writeFileSync(f, `${B64}\n`, { mode: 0o600 });
    expect((await resolveKeyFrom({ BARY_ACCOUNTS_KEK_FILE: f }, ACCOUNTS_KEK_SOURCE)).equals(KEY)).toBe(true);
  });

  it('파일이 없거나 비면 던진다 — 경로는 말하고 내용은 안 싣는다', async () => {
    await expect(resolveKeyFrom({ BARY_ACCOUNTS_KEK_FILE: '/nonexistent/kek' }, ACCOUNTS_KEK_SOURCE))
      .rejects.toThrow(/BARY_ACCOUNTS_KEK_FILE \(\/nonexistent\/kek\) 을 읽지 못했다 \(ENOENT\)/);
    await expect(resolveKeyFrom({ BARY_ACCOUNTS_KEK_FILE: '/x' }, ACCOUNTS_KEK_SOURCE, { readFile: async () => ' \n' }))
      .rejects.toThrow(/비었다/);
  });

  it('파일이 상한을 넘으면 던진다', async () => {
    const big = Object.assign(new Error('too large'), { code: 'EFBIG' });
    await expect(resolveKeyFrom({ BARY_ACCOUNTS_KEK_FILE: '/x' }, ACCOUNTS_KEK_SOURCE, { readFile: async () => { throw big; } }))
      .rejects.toThrow(/바이트를 넘는다/);
  });

  it('명령의 stdout 을 쓴다 — 실패에는 이름이 BARY_ACCOUNTS_KEK_CMD 로 나온다', async () => {
    const k = await resolveKeyFrom({ BARY_ACCOUNTS_KEK_CMD: 'systemd-creds cat kek' }, ACCOUNTS_KEK_SOURCE, { run: says(`${B64}\n`) });
    expect(k.equals(KEY)).toBe(true);
    await expect(resolveKeyFrom({ BARY_ACCOUNTS_KEK_CMD: 'x' }, ACCOUNTS_KEK_SOURCE, {
      run: async () => { throw Object.assign(new Error(`Command failed: ${B64}`), { code: 1, stderr: 'nope' }); },
    })).rejects.toThrow(/^BARY_ACCOUNTS_KEK_CMD 가 실패했다 \(종료 코드 1\) — 계정 KEK 없이 사람 계정은 안 뜬다\.\n {2}stderr: nope$/);
  });

  it('**둘 이상 주면 거절한다** — 값 · 파일 · 명령 어느 둘이든', async () => {
    await expect(resolveKeyFrom({ BARY_ACCOUNTS_KEK: B64, BARY_ACCOUNTS_KEK_FILE: '/x' }, ACCOUNTS_KEK_SOURCE)).rejects.toThrow(/둘 다 줬다/);
    await expect(resolveKeyFrom({ BARY_ACCOUNTS_KEK_FILE: '/x', BARY_ACCOUNTS_KEK_CMD: 'y' }, ACCOUNTS_KEK_SOURCE)).rejects.toThrow(/둘 다 줬다/);
  });

  it('아무것도 없으면 셋 중 하나가 필요하다고 말한다', async () => {
    await expect(resolveKeyFrom({}, ACCOUNTS_KEK_SOURCE)).rejects.toThrow(/BARY_ACCOUNTS_KEK_FILE · BARY_ACCOUNTS_KEK_CMD 중 하나/);
  });

  it('32 바이트가 아니면 예전 문구로 던진다 — 오류에 값을 싣지 않는다', async () => {
    const short = randomBytes(16).toString('base64');
    const e = await resolveKeyFrom({ BARY_ACCOUNTS_KEK: short }, ACCOUNTS_KEK_SOURCE).catch((x: Error) => x);
    expect((e as Error).message).toBe('BARY_ACCOUNTS_KEK 는 32바이트를 base64 로 적은 값이어야 한다');
  });

  it('인증서 KEK 는 _FILE 을 받지 않는다(지금 그대로)', async () => {
    const { resolveKek } = await import('../../src/dp/kek-source.js');
    // _FILE 만 주면 「없다」 — 조용히 파일을 읽지 않는다
    await expect(resolveKek({ BARY_SECRET_KEK_FILE: '/x' })).rejects.toThrow(/BARY_SECRET_KEK 가 비었다/);
  });
});

describe('로컬 봉인 — 바이트 호환', () => {
  it('**옛 코드로 봉인한 값을 새 코드가 연다** (LocalSealer · 옛 이름 Sealer · 등록부의 routedSealer)', async () => {
    const frozen = new FrozenSealer(B64);
    const sealed = frozen.seal(Buffer.from('totp-secret-bytes'), 'totp:u1');
    const local = new LocalSealer(KEY);
    const viaLocal = await local.open(sealed, 'totp:u1');
    expect(viaLocal.ok && viaLocal.plain.toString()).toBe('totp-secret-bytes');
    expect(new Sealer(B64).openSync(sealed, 'totp:u1').toString()).toBe('totp-secret-bytes');
    const { sealer } = await sealerFromEnv({ BARY_ACCOUNTS_KEK: B64 });
    const viaEnv = await sealer.open(sealed, 'totp:u1');
    expect(viaEnv.ok && viaEnv.plain.toString()).toBe('totp-secret-bytes');
  });

  it('**새 코드가 봉인한 값을 옛 코드가 연다** — 되돌려도 안전하다', async () => {
    const { sealer } = await sealerFromEnv({ BARY_ACCOUNTS_KEK: B64 });
    const r = await sealer.seal(Buffer.from('abc'), 'totp:u2');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.sealed).toMatch(/^v1\.[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(new FrozenSealer(B64).open(r.sealed, 'totp:u2').toString()).toBe('abc');
  });

  it('다른 행 · 다른 키 · 깨진 값은 결과로 실패한다(던지지 않는다)', async () => {
    const s = new LocalSealer(KEY);
    const r = await s.seal(Buffer.from('x'), 'totp:a');
    if (!r.ok) throw new Error('seal');
    expect(await s.open(r.sealed, 'totp:b')).toMatchObject({ ok: false, reason: 'integrity' });
    expect(await new LocalSealer(randomBytes(32)).open(r.sealed, 'totp:a')).toMatchObject({ ok: false, reason: 'integrity' });
    expect(await s.open('v1.only', 'totp:a')).toMatchObject({ ok: false, reason: 'malformed' });
  });
});

// ── Vault transit ──────────────────────────────────────────────────────────

type Seen = { url: string; init: RequestInit };
/** context 로 묶는 가짜 transit — 파생형 키처럼 context 가 다르면 400. */
function fakeVault(o: { derived?: boolean; status?: number; body?: string; seen?: Seen[] } = {}): typeof fetch {
  const store = new Map<string, { pt: string; ctx: string }>();
  let n = 0;
  return (async (url: string | URL, init?: RequestInit) => {
    o.seen?.push({ url: String(url), init: init ?? {} });
    if (o.status !== undefined) return new Response(o.body ?? '{"errors":["boom"]}', { status: o.status });
    const b = JSON.parse(String(init?.body)) as Record<string, string>;
    if (String(url).includes('/encrypt/')) {
      const ct = `vault:v1:${Buffer.from(`c${n++}`).toString('base64')}`;
      store.set(ct, { pt: b['plaintext']!, ctx: b['context']! });
      return Response.json({ data: { ciphertext: ct, key_version: 1 } });
    }
    const hit = store.get(b['ciphertext']!);
    if (hit === undefined || ((o.derived ?? true) && hit.ctx !== b['context'])) {
      return Response.json({ errors: ['cipher: message authentication failed'] }, { status: 400 });
    }
    return Response.json({ data: { plaintext: hit.pt } });
  }) as typeof fetch;
}

const vault = (f: typeof fetch, extra: Partial<ConstructorParameters<typeof VaultTransitSealer>[0]> = {}): VaultTransitSealer =>
  new VaultTransitSealer({ addr: 'https://vault.test:8200', key: 'bary-totp', tokenFile: '/run/vault/token', fetch: f, readToken: async () => `${FAKE_TOKEN}\n`, ...extra });

describe('Vault transit 봉인', () => {
  it('봉인 · 열기 — 토큰은 헤더로, redirect 는 error, context 는 aad 로', async () => {
    const seen: Seen[] = [];
    const v = vault(fakeVault({ seen }), { namespace: 'ns1' });
    const s = await v.seal(Buffer.from('secret'), 'totp:u1');
    expect(s.ok && s.sealed.startsWith('vault:v1:')).toBe(true);
    if (!s.ok) return;
    const o = await v.open(s.sealed, 'totp:u1');
    expect(o.ok && o.plain.toString()).toBe('secret');
    expect(seen[0]!.url).toBe('https://vault.test:8200/v1/transit/encrypt/bary-totp');
    expect(seen[1]!.url).toBe('https://vault.test:8200/v1/transit/decrypt/bary-totp');
    const h = seen[0]!.init.headers as Record<string, string>;
    expect(h['x-vault-token']).toBe(FAKE_TOKEN);
    expect(h['x-vault-namespace']).toBe('ns1');
    expect(seen[0]!.init.redirect).toBe('error');
    expect(seen[0]!.init.signal).toBeInstanceOf(AbortSignal);
    expect(await v.open(s.sealed, 'totp:u2')).toMatchObject({ ok: false, reason: 'integrity' });
  });

  it('상태 코드의 뜻 — 401/403 denied · 400(decrypt) integrity · 5xx unavailable · 200 인데 필드 없음 unavailable', async () => {
    const ct = `vault:v1:${Buffer.from('x').toString('base64')}`;
    expect(await vault(fakeVault({ status: 403 })).open(ct, 'a')).toMatchObject({ ok: false, reason: 'denied' });
    expect(await vault(fakeVault({ status: 401 })).seal(Buffer.from('x'), 'a')).toMatchObject({ ok: false, reason: 'denied' });
    expect(await vault(fakeVault({ status: 400 })).open(ct, 'a')).toMatchObject({ ok: false, reason: 'integrity' });
    expect(await vault(fakeVault({ status: 400 })).seal(Buffer.from('x'), 'a')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await vault(fakeVault({ status: 503, body: '{"errors":["Vault is sealed"]}' })).open(ct, 'a'))
      .toMatchObject({ ok: false, reason: 'unavailable', detail: expect.stringContaining('Vault is sealed') });
    expect(await vault(fakeVault({ status: 200, body: '{"data":{}}' })).seal(Buffer.from('x'), 'a')).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await vault(fakeVault({ status: 200, body: '<html>proxy</html>' })).open(ct, 'a')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('닿지 못하면 unavailable — 던지지 않는다', async () => {
    const down = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    expect(await vault(down).seal(Buffer.from('x'), 'a')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('**답의 크기에 상한이 있다** — 선언이 넘어도, 선언 없이 실제로 넘어도 끊는다', async () => {
    const huge = 'x'.repeat(MAX_VAULT_RESPONSE_BYTES + 1);
    const declared = (async () => new Response('{}', { headers: { 'content-length': String(MAX_VAULT_RESPONSE_BYTES + 1) } })) as typeof fetch;
    const streamed = (async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(huge)); c.close(); } }))) as typeof fetch;
    for (const f of [declared, streamed]) {
      expect(await vault(f).seal(Buffer.from('x'), 'a')).toMatchObject({ ok: false, reason: 'unavailable', detail: expect.stringContaining('넘는다') });
    }
  });

  it('**https 가 아니면 만들지 않는다** · 이상한 키 이름도', () => {
    expect(() => vault(fakeVault(), { addr: 'http://vault.test:8200' })).toThrow(/https/);
    expect(() => vault(fakeVault(), { key: '../sys' })).toThrow(/키 이름/);
  });

  it('토큰 파일이 비거나 못 읽으면 denied — 토큰 값은 싣지 않는다', async () => {
    expect(await vault(fakeVault(), { readToken: async () => '' }).seal(Buffer.from('x'), 'a')).toMatchObject({ ok: false, reason: 'denied' });
    const r = await vault(fakeVault(), { readToken: async () => { throw Object.assign(new Error('x'), { code: 'EACCES' }); } }).seal(Buffer.from('x'), 'a');
    expect(r).toMatchObject({ ok: false, reason: 'denied', detail: expect.stringContaining('EACCES') });
    const ok = await vault(fakeVault({ status: 403 })).seal(Buffer.from('x'), 'a');
    expect(JSON.stringify(ok)).not.toContain(FAKE_TOKEN);
  });

  it('**probe — 키가 context 로 묶지 않으면(파생형이 아니면) 거부한다**', async () => {
    expect(await vault(fakeVault({ derived: true })).probe()).toEqual({ ok: true });
    expect(await vault(fakeVault({ derived: false })).probe()).toMatchObject({ ok: false, detail: expect.stringContaining('derived=true') });
  });
});

describe('봉인 등록부 — 설정 · 열기 경로', () => {
  const tokenDir = mkdtempSync(join(tmpdir(), 'bary-vault-'));
  const tokenFile = join(tokenDir, 'token');
  writeFileSync(tokenFile, FAKE_TOKEN, { mode: 0o600 });
  const VAULT = { BARY_ACCOUNTS_VAULT_ADDR: 'https://vault.test', BARY_ACCOUNTS_VAULT_KEY: 'bary-totp', BARY_ACCOUNTS_VAULT_TOKEN_FILE: tokenFile };

  it('설정이 없으면 지금과 같다 — local, 키 필수', async () => {
    const r = await sealerFromEnv({ BARY_ACCOUNTS_KEK: B64 });
    expect(r.kind).toBe('local');
    expect(r.openers).toEqual(['v1.']);
    await expect(sealerFromEnv({})).rejects.toThrow(/BARY_ACCOUNTS_KEK/);
  });

  it('모르는 이름 · Vault 반만 · 토큰 env 값은 기동 거부', async () => {
    await expect(sealerFromEnv({ BARY_ACCOUNTS_KEK: B64, BARY_ACCOUNTS_SEAL_KIND: 'kms' })).rejects.toThrow(/모른다/);
    await expect(sealerFromEnv({ BARY_ACCOUNTS_SEAL_KIND: 'vault-transit' })).rejects.toThrow(/VAULT_ADDR/);
    await expect(sealerFromEnv({ BARY_ACCOUNTS_KEK: B64, BARY_ACCOUNTS_VAULT_ADDR: 'https://v' })).rejects.toThrow(/반만/);
    await expect(sealerFromEnv({ ...VAULT, BARY_ACCOUNTS_VAULT_TOKEN: FAKE_TOKEN, BARY_ACCOUNTS_SEAL_KIND: 'vault-transit' }))
      .rejects.toThrow(/TOKEN_FILE\(파일\)로만/);
  });

  it('**vault-transit 으로 바꿔도 옛 v1 값이 열린다**(KEK 를 남겨 두면) — 새 값은 vault: 로 봉인', async () => {
    const old = new FrozenSealer(B64).seal(Buffer.from('legacy'), 'totp:u1');
    const r = await sealerFromEnv({ ...VAULT, BARY_ACCOUNTS_SEAL_KIND: 'vault-transit', BARY_ACCOUNTS_KEK: B64 }, { fetch: fakeVault() });
    expect(r.openers).toEqual(['vault:', 'v1.']);
    const o = await r.sealer.open(old, 'totp:u1');
    expect(o.ok && o.plain.toString()).toBe('legacy');
    const s = await r.sealer.seal(Buffer.from('new'), 'totp:u1');
    expect(s.ok && s.sealed.startsWith('vault:')).toBe(true);
  });

  it('KEK 없이 vault-transit 이면 옛 v1 값은 no-sealer 로 실패한다 — 무엇이 빠졌는지 말한다', async () => {
    const old = new FrozenSealer(B64).seal(Buffer.from('legacy'), 'totp:u1');
    const r = await sealerFromEnv({ ...VAULT, BARY_ACCOUNTS_SEAL_KIND: 'vault-transit' }, { fetch: fakeVault() });
    expect(await r.sealer.open(old, 'totp:u1')).toMatchObject({ ok: false, reason: 'no-sealer', detail: expect.stringContaining('BARY_ACCOUNTS_KEK') });
  });

  it('Vault 의 행 묶기가 안 되면 기동 거부(probe)', async () => {
    await expect(sealerFromEnv({ ...VAULT, BARY_ACCOUNTS_SEAL_KIND: 'vault-transit' }, { fetch: fakeVault({ derived: false }) }))
      .rejects.toThrow(/derived=true/);
  });

  it('routedSealer — 모르는 앞머리는 malformed', async () => {
    expect(await routedSealer(new LocalSealer(KEY)).open('zzz', 'a')).toMatchObject({ ok: false, reason: 'malformed' });
  });
});
