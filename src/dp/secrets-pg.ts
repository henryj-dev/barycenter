/**
 * `PgSecretStore` — 봉투 암호화로 PG 에 두는 SecretStore (DESIGN.md §4.8.1)
 *
 * 로드맵 R-1 이 비워 둔 자리다. `FsSecretStore` 는 DP 호스트에 **평문으로** 쓰고,
 * 스스로 *"암호화가 아니다"* 라고 적었다. 남는 위험은 두 가지였다 — 호스트를 잡은
 * 상대에게 파일 권한은 아무것도 아니고, 백업·스냅샷·디스크 복제본에 평문이 남는다.
 *
 * ── §4.8 의 "개인키는 메인 DB 에 평문으로 두지 않는다" 를 어떻게 지키는가
 *
 * 들어가는 것은 **암호문**이다. 자료마다 DEK 를 새로 뽑아 AES-256-GCM 으로 감싸고,
 * 그 DEK 를 다시 KEK 로 감싼다. **KEK 는 이 DB 에 없다.** 덤프를 가져간 상대는
 * 암호문만 든다 — 그것이 파일 권한 `0400` 보다 강한 이유다.
 *
 * ── AAD 가 참조다
 *
 * 자료를 감쌀 때 `<scheme>://<name>@<version>` 을 AAD 로 건다. 그래서 행을 다른
 * 이름·버전 자리로 옮기면 **복호화가 실패한다.** DB 를 쓸 수 있는 상대가 "이 인증서
 * 자리에 저 자료" 로 바꿔치기하는 길이 막힌다. digest 대조(`certificateFiles`)가 이미
 * 한 겹이지만, 그건 세대를 굽는 시점의 검사이고 이건 복호화 시점의 검사다.
 *
 * ── `facts` 는 평문이고 캐시다 (§4.8.1)
 *
 * 만료·SAN·발급자는 비밀이 아니다. 그리고 이것을 읽는 자리 둘이 **동기**다 —
 * `ConfigStore` 의 SAN 커버 검증기와 plan 의 `certificateChanges`. 원격 저장소에
 * 동기로 물을 방법이 없으므로 여기서 캐시로 든다. 평문 열이라 기동 적재가
 * **자료를 하나도 복호화하지 않는다.**
 *
 * **miss 는 「사실을 모른다」다** — 기존 `FsSecretStore` 의 의미와 같다. 검증기는
 * 넘어가고 만료 게이지는 그 인증서를 안 싣는다. 없는 사실을 0 으로 채우지 않는다.
 */
import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes } from 'node:crypto';

import { inspectMaterial, type CertFacts } from './certinfo.js';
import {
  parseKeyRef, parseRef,
  type CertMaterial, type KeyRef, type SecretRef, type SecretStore,
} from './secrets.js';
import type { Queryable } from '../store/pg.js';

/** GCM 의 nonce 12 바이트 · tag 16 바이트. 둘 다 표준 크기다. */
const NONCE = 12;
const TAG = 16;
/** AES-256 이므로 32 바이트. 짧은 키를 늘려 쓰지 않는다 — 늘리면 강도가 이름과 다르다. */
export const KEK_BYTES = 32;

const sha256 = (s: string): string =>
  `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

const versionOf = (parts: string): string =>
  createHash('sha256').update(parts, 'utf8').digest('hex').slice(0, 32);

/**
 * KEK 를 읽는다. **없으면 던진다** (§4.8.1).
 *
 * 없는 것을 기본값으로 지어내면 「암호화된 줄 알았다」가 그대로 돌아온다. 기동에서
 * 죽는 편이 정직하다 — 그 순간에는 아직 아무 자료도 안 들어갔다.
 *
 * base64 와 hex 를 둘 다 받는다. 길이로만 판정하지 않고 **디코드 결과가 32 바이트인지**
 * 본다 — 사람이 32 자 암호를 그대로 붙여 넣는 것이 제일 흔한 실수이고, 그것은 키가
 * 아니라 문자열이다.
 */
export function readKek(raw: string): Buffer {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new Error('BARY_SECRET_KEK 가 비었다 — PG SecretStore 는 KEK 없이 안 뜬다 (§4.8.1)');
  }
  for (const enc of ['base64', 'hex'] as const) {
    // hex 가 아닌 문자열도 `Buffer.from(_, 'hex')` 는 조용히 잘라 낸다. 되돌려
    // 비교해서 **정말 그 인코딩이었는지** 확인한다.
    const buf = Buffer.from(trimmed, enc);
    if (buf.length !== KEK_BYTES) continue;
    if (buf.toString(enc).toLowerCase() !== trimmed.toLowerCase()) continue;
    return buf;
  }
  throw new Error(
    `BARY_SECRET_KEK 가 ${KEK_BYTES} 바이트 키가 아니다 — base64 또는 hex 로 준다 `
    + `(예: openssl rand -base64 ${KEK_BYTES})`,
  );
}

type Envelope = { kekId: string; wrappedDek: Buffer; nonce: Buffer; ciphertext: Buffer };

export type PgSecretStoreOptions = {
  db: Queryable;
  /** 32 바이트. `readKek` 이 만든 것. */
  kek: Buffer;
  /**
   * 이 KEK 를 무엇이라 부르는가. 회전의 자리다 — 행마다 남으므로 어느 키로 감쌌는지
   * 나중에 물을 수 있다. 회전 절차 자체는 아직 없다 (§4.8.1).
   */
  kekId?: string;
};

export class PgSecretStore implements SecretStore {
  readonly #db: Queryable;
  readonly #kek: Buffer;
  readonly #kekId: string;
  /** 참조 → 사실. **동기 창구의 뒷받침이다** (§4.8.1). */
  readonly #facts = new Map<string, CertFacts>();
  /**
   * 이 인스턴스가 넣은 것. **재적재가 자기 쓰기를 지우지 않게 한다.**
   *
   * `refreshFacts` 는 질의를 기다리는 동안 `put` 이 끼어들 수 있고, 그 질의의 스냅샷에는
   * 방금 넣은 행이 없다. 그대로 갈아 끼우면 **자기가 방금 넣은 인증서의 만료를 한 틱
   * 동안 모른다.** 안전한 방향이긴 해도 없앨 수 있는 창이다 — 이 표를 덧씌운다.
   *
   * 여기 든 것은 DB 에 확실히 있으므로 덧씌우기가 거짓을 만들지 않는다.
   */
  readonly #mine = new Map<string, CertFacts>();

  constructor(opts: PgSecretStoreOptions) {
    if (opts.kek.length !== KEK_BYTES) {
      throw new Error(`KEK 는 ${KEK_BYTES} 바이트여야 한다 (받은 것: ${opts.kek.length})`);
    }
    this.#db = opts.db;
    this.#kek = opts.kek;
    this.#kekId = opts.kekId ?? 'env';
  }

  /**
   * 사실 캐시를 통째로 다시 읽는다.
   *
   * **기동에서 한 번, 그 뒤로는 주기적으로.** 다른 인스턴스가 넣은 자료는 이 틱에
   * 들어온다. 그 사이의 miss 는 「사실을 모른다」라 안전한 쪽으로 틀린다.
   *
   * 자료를 **복호화하지 않는다** — `facts` 는 평문 열이다.
   */
  async refreshFacts(): Promise<number> {
    const rows = (await this.#db.query(
      `SELECT name, version, facts FROM secret_materials
        WHERE scheme = 'store' AND facts IS NOT NULL`,
    )).rows;
    this.#facts.clear();
    for (const r of rows) {
      this.#facts.set(`store://${String(r['name'])}@${String(r['version'])}`,
        r['facts'] as CertFacts);
    }
    // 질의를 기다리는 동안 들어온 자기 쓰기를 덧씌운다. 위 주석 참조.
    for (const [ref, facts] of this.#mine) this.#facts.set(ref, facts);
    this.#mine.clear();
    return this.#facts.size;
  }

  facts(ref: string): CertFacts | undefined {
    // 모양이 아니면 `undefined` 다. 던지면 목록 조회가 통째로 죽는다 —
    // `FsSecretStore.facts` 와 같은 판단이다.
    try {
      parseRef(ref);
    } catch {
      return undefined;
    }
    return this.#facts.get(ref);
  }

  async put(name: string, material: CertMaterial): Promise<SecretRef> {
    assertName(name);
    // **저장소도 스스로 검증한다.** API 가 이미 부르지만 그건 좋은 에러 메시지를 위한
    // 것이고, 이쪽은 거짓을 들고 있지 않기 위한 것이다 (§7.2).
    const facts = inspectMaterial(material.fullchain, material.privkey);
    const chainDigest = sha256(material.fullchain);
    const keyDigest = sha256(material.privkey);
    const version = versionOf(`${chainDigest}|${keyDigest}`);
    const ref = `store://${name}@${version}`;

    const env = this.#seal(ref, JSON.stringify(material));
    // **내용 주소라 충돌은 곧 같은 자료다.** 다시 감싸면 암호문 바이트는 달라지지만
    // 평문은 같다 — 이미 있는 것을 굳이 흔들지 않는다.
    await this.#db.query(
      `INSERT INTO secret_materials
         (scheme, name, version, kek_id, wrapped_dek, nonce, ciphertext,
          sha256, chain_digest, key_digest, facts)
       VALUES ('store', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (scheme, name, version) DO NOTHING`,
      [name, version, env.kekId, env.wrappedDek, env.nonce, env.ciphertext,
        sha256(`${chainDigest}|${keyDigest}`), chainDigest, keyDigest,
        JSON.stringify(facts)],
    );
    this.#facts.set(ref, facts);
    this.#mine.set(ref, facts);
    return {
      ref, name, version,
      sha256: sha256(`${chainDigest}|${keyDigest}`),
      chainDigest, keyDigest,
    };
  }

  async get(ref: string): Promise<CertMaterial> {
    const { name, version } = parseRef(ref);
    const plain = await this.#open('store', name, version, ref);
    return JSON.parse(plain) as CertMaterial;
  }

  async describe(ref: string): Promise<SecretRef> {
    const { name, version } = parseRef(ref);
    const r = (await this.#db.query(
      `SELECT sha256, chain_digest, key_digest FROM secret_materials
        WHERE scheme = 'store' AND name = $1 AND version = $2`,
      [name, version],
    )).rows[0];
    // **없으면 던진다.** 최신으로 물러나면 롤백이 거짓말이 된다 (§8.3).
    if (r === undefined) throw new Error(`시크릿이 없다: ${ref}`);
    return {
      ref, name, version,
      sha256: String(r['sha256']),
      chainDigest: String(r['chain_digest']),
      keyDigest: String(r['key_digest']),
    };
  }

  async putKey(name: string, privkey: string): Promise<KeyRef> {
    assertName(name);
    // 진짜 키인지 확인한다 — 아무 문자열이나 받으면 finalize 시점에야 터진다.
    createPrivateKey(privkey);
    const keyDigest = sha256(privkey);
    const version = versionOf(keyDigest);
    const ref = `key://${name}@${version}`;
    const env = this.#seal(ref, privkey);
    await this.#db.query(
      `INSERT INTO secret_materials
         (scheme, name, version, kek_id, wrapped_dek, nonce, ciphertext, key_digest)
       VALUES ('key', $1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (scheme, name, version) DO NOTHING`,
      [name, version, env.kekId, env.wrappedDek, env.nonce, env.ciphertext, keyDigest],
    );
    return { ref, name, version, keyDigest };
  }

  async getKey(ref: string): Promise<string> {
    // `parseKeyRef` 가 `store://` 를 거절한다 — 스킴이 섞이는 것은 표현 불가능하다.
    const { name, version } = parseKeyRef(ref);
    return this.#open('key', name, version, ref);
  }

  async listRefs(): Promise<string[]> {
    const rows = (await this.#db.query(
      'SELECT scheme, name, version FROM secret_materials')).rows;
    return rows
      .map((r) => `${String(r['scheme'])}://${String(r['name'])}@${String(r['version'])}`)
      .sort();
  }

  /** 자료 하나를 봉투에 넣는다. AAD 는 참조다 — 위 머리말 참조. */
  #seal(ref: string, plaintext: string): Envelope {
    const dek = randomBytes(KEK_BYTES);
    const dekNonce = randomBytes(NONCE);
    const c = createCipheriv('aes-256-gcm', dek, dekNonce);
    c.setAAD(Buffer.from(ref, 'utf8'));
    const body = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    const ciphertext = Buffer.concat([c.getAuthTag(), body]);

    const kekNonce = randomBytes(NONCE);
    const w = createCipheriv('aes-256-gcm', this.#kek, kekNonce);
    w.setAAD(Buffer.from(ref, 'utf8'));
    const wrapped = Buffer.concat([w.update(dek), w.final()]);
    return {
      kekId: this.#kekId,
      wrappedDek: Buffer.concat([kekNonce, w.getAuthTag(), wrapped]),
      nonce: dekNonce,
      ciphertext,
    };
  }

  async #open(scheme: 'store' | 'key', name: string, version: string, ref: string): Promise<string> {
    const r = (await this.#db.query(
      `SELECT wrapped_dek, nonce, ciphertext FROM secret_materials
        WHERE scheme = $1 AND name = $2 AND version = $3`,
      [scheme, name, version],
    )).rows[0];
    if (r === undefined) throw new Error(`시크릿이 없다: ${ref}`);

    const wrapped = toBuffer(r['wrapped_dek']);
    const kekNonce = wrapped.subarray(0, NONCE);
    const kekTag = wrapped.subarray(NONCE, NONCE + TAG);
    const u = createDecipheriv('aes-256-gcm', this.#kek, kekNonce);
    u.setAAD(Buffer.from(ref, 'utf8'));
    u.setAuthTag(kekTag);
    let dek: Buffer;
    try {
      dek = Buffer.concat([u.update(wrapped.subarray(NONCE + TAG)), u.final()]);
    } catch {
      // **무엇이 틀렸는지 말하지 않는다.** KEK 가 틀렸는지 자료가 변조됐는지는
      // 밖에서 가릴 일이 아니고, 가려 주면 그것이 오라클이 된다.
      throw new Error(`시크릿을 열지 못했다: ${ref} — KEK 가 다르거나 자료가 변조됐다`);
    }

    const ciphertext = toBuffer(r['ciphertext']);
    const d = createDecipheriv('aes-256-gcm', dek, toBuffer(r['nonce']));
    d.setAAD(Buffer.from(ref, 'utf8'));
    d.setAuthTag(ciphertext.subarray(0, TAG));
    try {
      return Buffer.concat([d.update(ciphertext.subarray(TAG)), d.final()]).toString('utf8');
    } catch {
      throw new Error(`시크릿을 열지 못했다: ${ref} — KEK 가 다르거나 자료가 변조됐다`);
    }
  }
}

function assertName(name: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(name)) {
    throw new Error(`시크릿 이름에 쓸 수 없는 문자가 있다: ${JSON.stringify(name)}`);
  }
}

/**
 * `bytea` 는 드라이버가 `Buffer` 로 주지만, 타입은 `unknown` 이다. 모양이 아니면
 * **던진다** — 조용히 빈 버퍼로 흘리면 복호화가 "변조됐다" 로 잘못 말한다.
 */
function toBuffer(v: unknown): Buffer {
  if (Buffer.isBuffer(v)) return v;
  throw new Error('secret_materials 의 bytea 열이 Buffer 가 아니다');
}
