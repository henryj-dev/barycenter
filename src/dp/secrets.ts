/**
 * SecretStore — 인증서 자료의 **불변 버전 저장소** (DESIGN.md §4.8 · §7.2 · §8.3)
 *
 * §4.8 이 못 박았다: *"개인키는 메인 DB 에 평문으로 두지 않는다. SecretStore 드라이버
 * 경유, **불변 버전 참조.** 버전 없는 참조는 롤백을 거짓말로 만든다."*
 *
 * 왜 버전이 필수인가 — S8 이 실측했다. 인증서를 세대 **밖** mutable 경로에 두면 갱신이
 * 덮어써서, conf 를 롤백해도 **갱신된 인증서가 그대로 나온다.** 이름만으로 참조하면
 * 세대에 넣어도 같은 일이 난다.
 *
 * ── 이 구현이 무엇이고 무엇이 아닌가 ───────────────────────────────────
 *
 * `FsSecretStore` 는 DP 호스트의 파일시스템에 **평문으로** 쓴다. 보호는 파일 권한(0400)과
 * "메인 DB 가 아니다" 뿐이다. **암호화가 아니다.** 지금 없는 것을 있다고 적지 않는다.
 *
 * **두 번째 드라이버는 `secrets-pg.ts` 다** (§4.8.1). 봉투 암호화로 PG 에 넣으므로
 * 평문 금지 조항을 지키면서 인스턴스 사이에 공유된다. KMS·Vault 는 여전히 이 인터페이스
 * 뒤에 붙을 자리로 남는다.
 *
 * ── 왜 `facts` 만 동기인가 (§4.8.1)
 *
 * 원격 저장소가 생기면서 자료 바이트를 만지는 여섯은 async 가 됐다. `facts` 는 안 넘겼다 —
 * 그것을 읽는 자리 둘(`ConfigStore` 의 SAN 커버 검증기 · plan 의 `certificateChanges`)이
 * 동기이고, 거기를 async 로 물들이면 커밋 앞 검증과 임팩트 계산이 통째로 바뀐다.
 * 그리고 `facts` 가 다루는 값은 비밀이 아니다.
 *
 * 그래도 §4.8 의 요구 중 지키는 것: 개인키가 PG 에 안 들어가고, 참조가 버전 고정이고,
 * 자료의 digest 를 함께 든다.
 */
import {
  chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';

import { createPrivateKey } from 'node:crypto';

import { inspectMaterial, type CertFacts } from './certinfo.js';

/** 인증서 한 벌. */
export type CertMaterial = {
  /** leaf + 중간 체인. PEM. */
  fullchain: string;
  /** 개인키. PEM. **읽어서 밖으로 돌려주지 않는다** (§8.1). */
  privkey: string;
};

export type SecretRef = {
  /** `store://<name>@<version>` */
  ref: string;
  name: string;
  version: string;
  /** 자료 전체의 digest. 세대 결박용 (§4.8). */
  sha256: string;
  chainDigest: string;
  keyDigest: string;
};

/**
 * **아직 인증서가 없는 개인키** 참조. `key://<name>@<version>`.
 *
 * ── 왜 별도 스킴인가 ────────────────────────────────────────────────────
 *
 * ACME finalize 는 CSR 에 서명한 키와 발급된 인증서가 **짝**이어야 한다. 그런데 키는
 * CSR 을 만들 때 필요하고 인증서는 그 뒤에 온다 — 그 사이에 죽으면 키를 잃고, 그러면
 * 발급된 인증서가 **쓸모없어져 새 주문을 내야 한다.** CA 의 레이트리밋은 그걸 센다.
 *
 * 그래서 키만 먼저 둔다. 그런데 `put` 은 **한 쌍**을 요구한다(§7.2 — 무관한 키-체인이
 * 저장되지 않게). 자리표 인증서를 지어내 짝을 맞추는 길도 있지만 안 골랐다: 어디에도
 * 제시되지 않을 인증서를 만들어 두면 **언젠가 제시된다.**
 *
 * 대신 **스킴을 갈랐다.** `parseRef` 는 `store://` 만 받으므로 키 참조를 인증서 자리에
 * 넣으면 그 자리에서 터진다 — 섞이는 것이 표현 불가능하다.
 */
export type KeyRef = { ref: string; name: string; version: string; keyDigest: string };

export function parseKeyRef(ref: string): { name: string; version: string } {
  const m = /^key:\/\/([A-Za-z0-9._-]+)@([a-f0-9]{16,64})$/.exec(ref);
  if (m === null) {
    throw new Error(`키 참조 모양이 아니다: ${JSON.stringify(ref)} (key://<name>@<version>)`);
  }
  return { name: m[1]!, version: m[2]! };
}

/**
 * **동기로 남는 창구** (§4.8.1).
 *
 * `facts` 가 다루는 값은 **비밀이 아니다** — 만료·SAN·발급자다. 그리고 이것을 읽는
 * 자리 둘이 동기다: `ConfigStore` 의 SAN 커버 검증기와 plan 의 `certificateChanges`.
 * 저장소가 원격(PG)이 되면서 나머지는 async 로 갔지만 이 선은 안 넘긴다 — 넘기면
 * 커밋 앞 검증기와 임팩트 계산이 통째로 물든다.
 *
 * 그래서 원격 드라이버는 이 값을 **캐시로 든다.** miss 는 「사실을 모른다」다.
 */
export interface CertFactsView {
  /**
   * 바이트에서 뽑아 둔 사실 (§7.2 · §4.6). 없으면 `undefined`.
   *
   * **개인키를 안 읽는다.** 만료를 보려고 목록 요청마다 키를 읽어 들이는 것은
   * 쓸데없이 위험하다 — `put` 시점에 뽑아 옆에 적어 둔 것을 읽는다. 참조가 내용
   * 주소이므로 사실도 불변이다.
   */
  facts(ref: string): CertFacts | undefined;
}

export interface SecretStore extends CertFactsView {
  /**
   * 자료를 넣고 **새 버전**을 받는다.
   *
   * 같은 이름에 같은 바이트를 다시 넣으면 **같은 버전**을 돌려준다 — 내용 주소이므로
   * 중복 저장이 없고, 멱등 업로드가 새 버전을 만들어 세대를 무의미하게 늘리지 않는다.
   */
  put(name: string, material: CertMaterial): Promise<SecretRef>;
  /** 버전 고정 참조로 읽는다. 없으면 던진다 — 조용히 옛 것을 주지 않는다. */
  get(ref: string): Promise<CertMaterial>;
  /** 참조를 해석만 한다 (자료를 안 읽는다). */
  describe(ref: string): Promise<SecretRef>;
  /** 인증서 없는 개인키를 둔다 (ACME 주문 진행 중). */
  putKey(name: string, privkey: string): Promise<KeyRef>;
  /** 키만 읽는다. `store://` 참조를 주면 던진다. */
  getKey(ref: string): Promise<string>;
  /**
   * 저장소에 **실재하는 참조 전부** — `store://` 와 `key://` 를 섞어서 (검수 D1).
   *
   * GC 의 root 수집이 쓴다. 세대 디렉토리는 인증서 **키**로 갈려 있어 시크릿 *이름* 을
   * 모르므로, 거기서 뽑을 수 있는 것은 `@<버전>` 자리표뿐이다. 그 자리표를 실제 참조로
   * 넓히려면 **저장소가 무엇을 들고 있는지** 물어야 한다 — 그 창구가 여기다.
   *
   * 전에는 이 창구가 없었고, 대신 `versions(name)` 이 있었는데 **호출자가 0 개였다.**
   * 그래서 root 수집이 넓힐 재료를 못 얻었고, 부류 ②(디스크의 세대가 참조하는 자료)가
   * 조용히 무효였다. 이름을 모르는 쪽에 이름을 묻던 것이 문제였다.
   */
  listRefs(): Promise<string[]>;
}

const sha256 = (s: string): string =>
  `sha256:${createHash('sha256').update(s, 'utf8').digest('hex')}`;

/** `store://name@version` 을 쪼갠다. */
export function parseRef(ref: string): { name: string; version: string } {
  const m = /^store:\/\/([A-Za-z0-9._-]+)@([a-f0-9]{16,64})$/.exec(ref);
  if (m === null) {
    throw new Error(`시크릿 참조 모양이 아니다: ${JSON.stringify(ref)} (store://<name>@<version>)`);
  }
  return { name: m[1]!, version: m[2]! };
}

/**
 * 버전 디렉토리의 이름 모양 (검수 D8).
 *
 * `put` 이 만드는 것은 sha256 앞 32 자다. **이것을 대조하는 이유는 tmp 때문이다** —
 * `replaceDir` 이 `<version>.tmp-<nonce>` 를 잠깐 만들고, 크래시가 그것을 남길 수
 * 있다. 그 이름을 버전으로 읽으면 두 가지가 조용히 틀어진다:
 *
 *   `listRefs`          없는 참조를 GC 의 root 넓히기에 흘린다
 *   `secret-gc` 의 `keepPerName`  방금 만들어진 tmp 가 mtime 이 제일 커서
 *                       **진짜 최신 버전의 보호 자리를 뺏는다**
 *
 * 뒤엣것이 실제 위험이다 — 지켜야 할 것이 안 지켜진다.
 */
export const VERSION_DIR = /^[a-f0-9]{32}$/;

/**
 * **버전 디렉토리를 통째로 갈아 끼운다** (검수 D8).
 *
 * ── 왜 제자리 쓰기로는 안 되나
 *
 * 전에는 이랬다:
 *
 *   const dir = join(root, name, version);
 *   if (!existsSync(dir)) { mkdir; write fullchain; write key; write facts; chmod }
 *
 * `put` 의 주석이 옳은 절반을 말했다 — *"중간에 죽으면 key 가 없는 디렉토리가 남고
 * `get` 이 던진다. 반쪽짜리를 조용히 쓰는 것보다 낫다."* 조용히 쓰는 것보다 나은 건
 * 맞다. **그런데 거기서 끝나지 않는다.**
 *
 * 버전이 **내용 주소**라 같은 바이트를 다시 올리면 같은 `version` 이 나온다. 그러면
 * `existsSync(dir)` 이 참이라 쓰기를 통째로 건너뛴다 — **반쪽으로 죽은 디렉토리는
 * 재업로드로 못 고친다.** 그리고 재업로드는 운영자가 제일 먼저 할 일이다. 나가는 길은
 * 손으로 그 디렉토리를 지우는 것뿐이고, 자료 디렉토리는 `0500` 이라 그것도 한 단계가
 * 더 있다.
 *
 * ── 모양은 `materializeGeneration` 과 같다
 *
 * 임시 이름에 전부 쓰고 · fsync 하고 · rename 한다. rename 은 같은 파일시스템 안에서
 * 원자적이라, 최종 이름으로 보이는 순간 안은 이미 완성돼 있다. 이 저장소가 세대에
 * 쓰는 그 방법이고, **같은 자리에 같은 방어가 없던 것뿐이다.**
 *
 * `complete` 가 필요한 이유: rename 은 비어 있지 않은 디렉토리 위로 못 간다. 온전한
 * 것이 이미 있으면 아무것도 안 하고(멱등), 반쪽이면 **치우고** 갈아 끼운다.
 */
function replaceDir(
  finalDir: string,
  files: readonly { name: string; body: string; mode: number }[],
): void {
  const complete = existsSync(finalDir)
    && files.every((f) => existsSync(join(finalDir, f.name)));
  if (complete) return;

  const staging = `${finalDir}.tmp-${randomBytes(6).toString('hex')}`;
  try {
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    for (const f of files) {
      const path = join(staging, f.name);
      writeFileSync(path, f.body, { mode: f.mode });
      // **바이트가 디스크에 닿은 뒤에 이름을 바꾼다.** 안 그러면 rename 만 살아남고
      // 내용이 빈 파일이 남는 크래시가 있다.
      const fd = openSync(path, 'r');
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    chmodSync(staging, 0o500);
    // 반쪽이 남아 있으면 치운다 — rename 이 그 위로 못 간다. 이미 깨진 것이라
    // 지우는 것이 손해가 아니고, 새 내용은 staging 에 이미 완성돼 있다.
    if (existsSync(finalDir)) {
      chmodSync(finalDir, 0o700);
      rmSync(finalDir, { recursive: true, force: true });
    }
    renameSync(staging, finalDir);
  } finally {
    // 어디서 던졌든 임시 디렉토리를 안 남긴다 — 남으면 `listRefs` 와 GC 가 그것을
    // 버전으로 읽는다.
    if (existsSync(staging)) {
      try {
        chmodSync(staging, 0o700);
        rmSync(staging, { recursive: true, force: true });
      } catch { /* 이미 옮겨졌거나 사라졌으면 그만 */ }
    }
  }
}

export class FsSecretStore implements SecretStore {
  constructor(private readonly root: string) {}

  async put(name: string, material: CertMaterial): Promise<SecretRef> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`시크릿 이름에 쓸 수 없는 문자가 있다: ${JSON.stringify(name)}`);
    }
    // **저장소도 스스로 검증한다.** API 가 이미 `inspectMaterial` 을 부르지만, 그건
    // 좋은 에러 메시지를 주기 위한 것이고 이쪽은 **거짓을 들고 있지 않기 위한** 것이다.
    // 호출자가 하나 늘 때마다 검사를 잊을 자리가 하나 는다 (§7.2).
    const facts = inspectMaterial(material.fullchain, material.privkey);
    const chainDigest = sha256(material.fullchain);
    const keyDigest = sha256(material.privkey);
    // **내용 주소.** 버전이 곧 내용의 함수라, 같은 자료를 다시 올려도 버전이 안 늘어난다.
    const version = createHash('sha256')
      .update(`${chainDigest}|${keyDigest}`, 'utf8').digest('hex').slice(0, 32);

    // **버전 디렉토리를 통째로 갈아 끼운다** (검수 D8). 전에는 제자리에 셋을 차례로
    // 썼고, 중간에 죽으면 재업로드로도 못 고쳤다 — 내용 주소라 `existsSync` 가 참이라
    // 쓰기를 건너뛰기 때문이다. `replaceDir` 머리말이 전말을 적어 뒀다.
    replaceDir(join(this.root, name, version), [
      { name: 'fullchain.pem', body: material.fullchain, mode: 0o400 },
      { name: 'privkey.pem', body: material.privkey, mode: 0o400 },
      // 사실은 **자료가 아니다.** 0444 로 둔다 — 만료를 보는 데 키 권한이 필요하면
      // 만료를 안 보게 된다.
      { name: 'facts.json', body: JSON.stringify(facts, null, 2), mode: 0o444 },
    ]);
    return {
      ref: `store://${name}@${version}`,
      name, version,
      sha256: sha256(`${chainDigest}|${keyDigest}`),
      chainDigest, keyDigest,
    };
  }

  async get(ref: string): Promise<CertMaterial> {
    const { name, version } = parseRef(ref);
    const dir = join(this.root, name, version);
    // **없으면 던진다.** 최신 버전으로 물러나면 롤백이 거짓말이 된다 (§8.3).
    return {
      fullchain: readFileSync(join(dir, 'fullchain.pem'), 'utf8'),
      privkey: readFileSync(join(dir, 'privkey.pem'), 'utf8'),
    };
  }

  async describe(ref: string): Promise<SecretRef> {
    const { name, version } = parseRef(ref);
    const material = await this.get(ref);
    const chainDigest = sha256(material.fullchain);
    const keyDigest = sha256(material.privkey);
    return { ref, name, version, sha256: sha256(`${chainDigest}|${keyDigest}`), chainDigest, keyDigest };
  }

  async putKey(name: string, privkey: string): Promise<KeyRef> {
    if (!/^[A-Za-z0-9._-]+$/.test(name)) {
      throw new Error(`시크릿 이름에 쓸 수 없는 문자가 있다: ${JSON.stringify(name)}`);
    }
    // 진짜 키인지 확인한다 — 아무 문자열이나 받으면 finalize 시점에야 터진다.
    createPrivateKey(privkey);
    const keyDigest = sha256(privkey);
    const version = createHash('sha256').update(keyDigest, 'utf8').digest('hex').slice(0, 32);
    // **인증서 자료와 다른 디렉토리다.** 같은 곳에 두면 `get` 이 반쪽짜리를 만난다.
    replaceDir(join(this.root, 'keys', name, version), [
      { name: 'privkey.pem', body: privkey, mode: 0o400 },
    ]);
    return { ref: `key://${name}@${version}`, name, version, keyDigest };
  }

  async getKey(ref: string): Promise<string> {
    const { name, version } = parseKeyRef(ref);
    return readFileSync(join(this.root, 'keys', name, version, 'privkey.pem'), 'utf8');
  }

  facts(ref: string): CertFacts | undefined {
    const { name, version } = parseRef(ref);
    try {
      return JSON.parse(
        readFileSync(join(this.root, name, version, 'facts.json'), 'utf8')) as CertFacts;
    } catch {
      // **없으면 undefined 다.** 이 파일이 없는 것은 v0.6 1단계에 올라간 자료뿐이고,
      // 그건 "만료를 모른다" 이지 "만료됐다" 가 아니다. 던지면 목록 조회가 통째로 죽는다.
      return undefined;
    }
  }

  /**
   * 저장소에 실재하는 참조 전부.
   *
   * **`secret-gc.ts` 의 `scan()` 과 같은 참조 모양을 내야 한다.** 저쪽은 지울 후보를
   * 훑고 이쪽은 지키 대상을 넓히므로, 모양이 갈리면 **넓힌 root 가 후보와 안 만나
   * 보호가 조용히 사라진다.** 둘을 한 함수로 합치지 않은 이유는 저쪽이 store 인스턴스가
   * 아니라 경로 하나만 받도록 일부러 떼어 둔 것이기 때문이고(§8.4 GC 는 저장소를 모른다),
   * 그 대신 `tests/unit/audit-secret-roots-wiring.test.ts` 가 **둘의 합의**를 못 박는다 —
   * `put` 이 준 참조가 root 에 들어가고 그 디렉토리가 남는지 함께 본다.
   *
   * 못 읽는 것은 **건너뛴다.** 목록이 반쪽이면 GC 가 덜 지킬 뿐이지만, 던지면 GC 가
   * 아예 안 돈다 — 남기는 쪽으로 틀리는 것이 이 모듈의 규칙이다.
   */
  async listRefs(): Promise<string[]> {
    const out: string[] = [];
    const walk = (base: string, scheme: 'store' | 'key'): void => {
      let names: string[];
      try {
        names = readdirSync(base);
      } catch {
        return;
      }
      for (const name of names) {
        // `keys/` 는 인증서 자료 루트 **아래**에 있으므로 이름으로 걸러낸다.
        if (scheme === 'store' && name === 'keys') continue;
        let versions: string[];
        try {
          versions = readdirSync(join(base, name));
        } catch {
          continue;                       // 파일이거나 그 사이 사라졌다
        }
        for (const version of versions) {
          if (!VERSION_DIR.test(version)) continue;
          out.push(`${scheme}://${name}@${version}`);
        }
      }
    };
    walk(this.root, 'store');
    walk(join(this.root, 'keys'), 'key');
    return out.sort();
  }
}

/**
 * 모델이 참조하는 인증서들을 **세대에 넣을 파일 맵**으로 만든다. §7.2 · S8 · S19
 *
 * 왜 세대 안이어야 하는가 — S8 이 실측했다. 인증서를 세대 **밖** mutable 경로에 두면
 * 갱신이 덮어써서, conf 를 롤백해도 **갱신된 인증서가 그대로 제시된다.** 트래픽만 보면
 * 알 수 없다.
 *
 * 그리고 **바이트 복사여야 한다.** S19 가 두 가지 그럴듯한 대안이 각각 어떻게 깨지는지
 * 쟀다:
 *
 *   · 세대를 `cp -r` 로 통째로 → epoch 리터럴이 딸려와 멤버십이 영영 안 닿는다
 *   · 인증서를 symlink 로 → 평소엔 멀쩡하다가 GC 가 옛 세대를 회수하는 순간
 *     **다음 reload 가 실패한다** (열린 fd 로 트래픽은 계속 흐르므로 안 보인다)
 *
 * 그래서 여기서는 자료를 읽어 **바이트를 반환한다.** 참조가 버전 고정이므로(§4.8) 롤백된
 * 모델은 옛 버전을 가리키고, 그 바이트가 새 세대에 그대로 들어간다.
 */
export async function certificateFiles(
  certificates: readonly { key: string; materialRef: string; chainDigest: string; keyDigest: string }[],
  store: SecretStore,
): Promise<{ files: Record<string, string>; modes: Record<string, number> }> {
  const files: Record<string, string> = {};
  const modes: Record<string, number> = {};
  for (const c of certificates) {
    const material = await store.get(c.materialRef);
    // **digest 를 대조한다.** 참조가 가리키는 자료가 DB 가 기억하는 것과 같은지 여기서
    // 본다 — 안 보면 SecretStore 쪽이 조용히 바뀌어도 세대가 그대로 나간다.
    const chain = `sha256:${createHash('sha256').update(material.fullchain, 'utf8').digest('hex')}`;
    const key = `sha256:${createHash('sha256').update(material.privkey, 'utf8').digest('hex')}`;
    if (chain !== c.chainDigest || key !== c.keyDigest) {
      throw new Error(
        `인증서 '${c.key}' 의 자료가 기록된 digest 와 다르다 (${c.materialRef}). ` +
        `SecretStore 가 바뀌었거나 참조가 틀렸다`,
      );
    }
    // **경로에 버전이 들어간다.** 렌더러의 `certPaths` 와 같은 규칙이어야 한다 —
    // 갱신이 곧 다른 conf 가 되게 하는 것이 그 규칙의 요점이다 (render.ts 주석 참조).
    const { version } = parseRef(c.materialRef);
    files[`certs/${c.key}/${version}/fullchain.pem`] = material.fullchain;
    files[`certs/${c.key}/${version}/privkey.pem`] = material.privkey;
    // 개인키는 세대 안에서도 0400 이다. 여기서 안 걸면 SecretStore 가 지킨 것을
    // 세대가 도로 푼다.
    modes[`certs/${c.key}/${version}/privkey.pem`] = 0o400;
    modes[`certs/${c.key}/${version}/fullchain.pem`] = 0o444;
  }
  return { files, modes };
}
