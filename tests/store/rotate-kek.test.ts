/**
 * KEK 회전 — `scripts/rotate-kek.mjs` (§4.8.3)
 *
 * **스크립트를 실제로 띄운다.** 로직을 여기서 다시 구현하면 그 사본이 원본과 갈라지는
 * 날 초록인 채로 아무것도 안 지킨다 — 이 저장소가 `carry_env_lines` 와 `TARGETS` 에서
 * 이미 고른 방식이다.
 *
 * 재는 것은 회전이 **약속한 셋**이다:
 *
 *   ① 새 KEK 로 열린다        — 그게 회전의 전부다
 *   ② 자료를 안 건드렸다      — `ciphertext` 와 `nonce` 가 바이트로 같다
 *   ③ 중간에 죽어도 된다      — `kek_id` 가 진행 상황이라 다시 돌리면 남은 것만 집는다
 *
 * ⚠️ 이 파일은 **실물 PG** 가 필요하다. `dist/` 도 필요하다 — 스크립트가 거기서
 * 읽는다(게이트에서는 `build (dist·gui)` 가 앞에 있다).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PgSecretStore } from '../../src/dp/secrets-pg.js';
import { Db, dockerAvailable, pgFor, startPg, stopPg } from './pg-fixture.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'rotate-kek.mjs');

const PG = pgFor('rotatekek');
let db: Db;
let root = '';

const OLD = randomBytes(32);
const NEW = randomBytes(32);

function mintPair(cn: string): { pem: string; key: string } {
  const base = join(root, `mint-${cn}-${Math.random().toString(36).slice(2)}`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90',
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`,
    '-keyout', `${base}.key`, '-out', `${base}.crt`,
  ], { stdio: 'ignore' });
  return { pem: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
}

/** 스크립트를 띄운다. **KEK 는 env 로만 준다** — 인자에 실으면 프로세스 목록에 뜬다. */
function rotate(args: string[], env: Record<string, string> = {}): { out: string; code: number } {
  try {
    const out = execFileSync('node', [SCRIPT, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BARY_DSN: PG.dsn,
        BARY_SECRET_KEK: OLD.toString('base64'),
        BARY_SECRET_KEK_NEW: NEW.toString('base64'),
        ...env,
      },
    });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
  }
}

const rowsOf = async (): Promise<Record<string, unknown>[]> =>
  (await db.query('SELECT * FROM secret_materials ORDER BY name, version')).rows;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  root = mkdtempSync(join(tmpdir(), 'bary-rotatekek-'));
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

let refs: string[] = [];

beforeEach(async () => {
  await db.query('TRUNCATE secret_materials');
  const store = new PgSecretStore({ db, kek: OLD });
  const a = mintPair('a.example');
  const b = mintPair('b.example');
  refs = [
    (await store.put('cert-a', { fullchain: a.pem, privkey: a.key })).ref,
    (await store.put('cert-b', { fullchain: b.pem, privkey: b.key })).ref,
    // **ACME 가 만드는 모양** — 인증서 없는 개인키. 재업로드할 자료가 없어서
    // 회전이 유일한 길인 바로 그것이다.
    (await store.putKey('order-1', newEcKeyPem())).ref,
  ];
});

/** ACME 주문이 드는 개인키 하나. `newEcKey` 를 쓰지 않고 openssl 로 뽑는다. */
function newEcKeyPem(): string {
  const base = join(root, `k-${Math.random().toString(36).slice(2)}`);
  execFileSync('openssl', ['genpkey', '-algorithm', 'EC', '-pkeyopt',
    'ec_paramgen_curve:P-256', '-out', `${base}.pem`], { stdio: 'ignore' });
  return readFileSync(`${base}.pem`, 'utf8');
}

describe('KEK 회전', () => {
  /** ① 회전의 전부 — 새 KEK 로 열리고, 옛 KEK 로는 안 열린다. */
  it('**새 KEK 로 열린다** — ACME 가 만든 키 단독 참조까지', async () => {
    expect(rotate(['--to', 'kms-2']).code).toBe(0);

    const next = new PgSecretStore({ db, kek: NEW, kekId: 'kms-2' });
    await expect(next.get(refs[0]!)).resolves.toHaveProperty('fullchain');
    await expect(next.get(refs[1]!)).resolves.toHaveProperty('fullchain');
    await expect(next.getKey(refs[2]!)).resolves.toContain('PRIVATE KEY');

    // 옛 KEK 는 이제 못 연다 — 그게 회전이 한 일이다.
    const prev = new PgSecretStore({ db, kek: OLD });
    await expect(prev.get(refs[0]!)).rejects.toThrow(/열지 못했다/);
  });

  /**
   * ② **자료를 안 건드렸다.** 설계가 *"회전은 DEK 재감싸기이고 자료 바이트를 다시
   * 읽지 않는다"* 고 적은 것의 실측이다. `wrapped_dek` 만 바뀌어야 한다.
   */
  it('**자료 바이트를 안 건드린다** — `wrapped_dek` 만 바뀐다', async () => {
    const before = await rowsOf();
    expect(rotate(['--to', 'kms-2']).code).toBe(0);
    const after = await rowsOf();

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i += 1) {
      const b = before[i]!;
      const a = after[i]!;
      expect(Buffer.from(a['ciphertext'] as Buffer).equals(Buffer.from(b['ciphertext'] as Buffer)))
        .toBe(true);
      expect(Buffer.from(a['nonce'] as Buffer).equals(Buffer.from(b['nonce'] as Buffer)))
        .toBe(true);
      expect(a['key_digest']).toBe(b['key_digest']);
      expect(a['facts']).toEqual(b['facts']);
      // 바뀐 것 둘.
      expect(a['kek_id']).toBe('kms-2');
      expect(Buffer.from(a['wrapped_dek'] as Buffer).equals(Buffer.from(b['wrapped_dek'] as Buffer)))
        .toBe(false);
    }
  });

  /** ③ `kek_id` 가 진행 상황이다 — 다시 돌리면 남은 것만 집는다. */
  it('**다시 돌려도 안전하다** — 두 번째는 바꿀 것이 없다', async () => {
    expect(rotate(['--to', 'kms-2']).code).toBe(0);
    const again = rotate(['--to', 'kms-2']);
    expect(again.code).toBe(0);
    expect(again.out).toContain('바꿀 것이 없다');
  });

  /** 반쯤 돌다 죽은 상태에서 이어받는다. 한 행만 미리 옮겨 두고 돌린다. */
  it('반쯤 된 상태에서 남은 것만 집는다', async () => {
    // 첫 행만 손으로 새 id 를 달아 둔다 — 「이미 한 것」의 흉내다.
    const one = (await rowsOf())[0]!;
    expect(rotate(['--to', 'kms-2', '--check']).out).toContain('대상 3 행');

    await db.query(
      `UPDATE secret_materials SET kek_id = 'kms-2' WHERE name = $1 AND version = $2`,
      [one['name'], one['version']],
    );
    const out = rotate(['--to', 'kms-2', '--check']).out;
    expect(out).toContain('대상 2 행');
    expect(out).toContain('이미 kms-2 인 행 1 개');
  });

  /** `--check` 는 아무것도 안 쓴다. 안 그러면 「먼저 보고」가 성립하지 않는다. */
  it('`--check` 는 아무것도 안 쓴다', async () => {
    const before = await rowsOf();
    expect(rotate(['--to', 'kms-2', '--check']).code).toBe(0);
    const after = await rowsOf();
    expect(after.map((r) => r['kek_id'])).toEqual(before.map((r) => r['kek_id']));
  });

  /**
   * **같은 키로의 회전은 막는다.** 아무 일도 안 하면서 `kek_id` 만 바꾸면 다음 회전이
   * 「어디까지 했나」를 물을 때 대답이 거짓이 된다.
   */
  it('옛 KEK 와 새 KEK 가 같으면 거절한다 — 회전이 아니다', () => {
    const r = rotate(['--to', 'kms-2'], { BARY_SECRET_KEK_NEW: OLD.toString('base64') });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/같다/);
  });

  /** 새 KEK 가 없으면 안 돈다 — 지어내면 자료를 못 여는 상태로 간다. */
  it('새 KEK 가 없으면 안 돈다', () => {
    const r = rotate(['--to', 'kms-2'], { BARY_SECRET_KEK_NEW: '' });
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/새 KEK/);
  });

  /** `--verify` 는 자료까지 열어 본다 — 재기동 앞의 마지막 확인이다. */
  it('`--verify` 가 자료까지 열어 본다', () => {
    const r = rotate(['--to', 'kms-2', '--verify']);
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/검산\s+3\/3/);
  });

  /**
   * **옛 KEK 로도 안 열리는 행은 실패로 낸다 — 조용히 넘어가지 않는다.**
   *
   * 다른 KEK 환경의 덤프를 복원했거나 자료가 변조된 경우다. 그 행을 건너뛰고 초록을
   * 내면 운영자는 회전이 끝났다고 믿고 재기동한다.
   */
  it('못 여는 행이 있으면 빨갛게 끝난다', async () => {
    await db.query(
      `UPDATE secret_materials SET wrapped_dek = $1 WHERE name = 'cert-a'`,
      [randomBytes(60)],
    );
    const r = rotate(['--to', 'kms-2']);
    expect(r.code).not.toBe(0);
    expect(r.out).toContain('실패 1');
    // 나머지는 그래도 옮겼다 — 한 행 때문에 전부를 멈추지 않는다.
    expect(r.out).toContain('바꿈 2');
  });
});
