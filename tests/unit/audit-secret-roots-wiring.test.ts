/**
 * 시크릿 GC root **배선** — 검수 2026-08-24 D1
 *
 * ── 왜 함수가 아니라 배선을 재는가
 *
 * `expandVersionRoots` 자체의 단위 테스트는 이미 있고 **초록이다**
 * (`tests/unit/secret-gc.test.ts` — "세대에서 뽑은 버전 root 를 넓힌다"). 그 테스트는
 * `allRefs` 에 **저장소의 실제 참조 목록**을 넘긴다. 그게 그 함수의 계약이다.
 *
 * 그런데 데몬은 이렇게 불렀다:
 *
 * ```js
 * const raw   = await collectSecretRoots({ db, prefix });
 * const all   = [...raw].filter((r) => !r.startsWith('@'));   // ← 이미 root 인 것들
 * const roots = expandVersionRoots(raw, all);
 * ```
 *
 * `all` 이 *이미 root 인 참조*라 넓히기가 더할 수 있는 것이 하나도 없다. 그리고 함수는
 * `@` 자리표를 결과에서 빼므로 **root 부류 ②(디스크의 세대가 참조하는 자료)가 통째로
 * 사라진다.** 함수는 옳고 호출부가 틀렸다 — 그래서 함수를 재는 테스트로는 안 잡힌다.
 *
 * ── 이 파일이 재는 것
 *
 * `collectSecretRoots` 하나만 부른다. **넓히기가 그 안에 있어야** 부를 자리가 하나가 되고,
 * 하나면 잘못 부를 수가 없다. 그것이 이 수정의 요점이다.
 *
 * ── 비대칭
 *
 * `secret-roots.ts` 머리말이 적어 뒀다: *"여기서 하나라도 놓치면 살아 있는 개인키를
 * 지운다."* 증상은 S8 이 실측했다 — 열린 fd 로 트래픽은 계속 흐르고 **다음 reload 가
 * 깨진다.** 그래서 아래 단언은 *"안 지운다"* 쪽이다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSecretStore } from '../../src/dp/secrets.js';
import { collectSecretRoots } from '../../src/control/secret-roots.js';
import { sweepSecrets } from '../../src/dp/secret-gc.js';
import type { Row } from '../../src/store/pg.js';

let root = '';
let prefix = '';
let store: FsSecretStore;

/**
 * **아무것도 안 답하는 DB.**
 *
 * root 부류 ①(최근 리비전) · ③(ACME 계정) · ④(주문)를 전부 비운다. 그래야 남는 보호가
 * **② 하나뿐**이고, ② 가 무효라는 사실이 그대로 드러난다.
 */
const emptyDb = { query: async (): Promise<{ rows: Row[]; rowCount: number | null }> => ({ rows: [], rowCount: 0 }) };

function mint(cn: string): { pem: string; key: string } {
  const base = join(root, `m-${cn}-${Math.random().toString(36).slice(2)}`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90',
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`,
    '-keyout', `${base}.key`, '-out', `${base}.crt`,
  ], { stdio: 'ignore' });
  return { pem: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
}

/** 자료 하나를 넣고 참조를 돌려준다. 최소 나이 보호를 풀어 둔다. */
async function put(name: string, cn: string): Promise<string> {
  const p = mint(cn);
  const ref = await store.put(name, { fullchain: p.pem, privkey: p.key });
  const dir = join(root, name, ref.version);
  const past = (Date.now() - 86_400_000) / 1000;
  utimesSync(dir, past, past);
  return ref.ref;
}

const versionOf = (ref: string): string => (ref.split('@')[1] ?? '');
const dirOf = (ref: string): string => {
  const [, rest] = ref.split('://');
  const [name, version] = (rest ?? '').split('@');
  return join(root, name!, version!);
};

/**
 * 세대 하나를 디스크에 만든다 — `certs/<인증서 키>/<버전>/` 만.
 *
 * **세대 디렉토리는 시크릿 *이름* 을 모른다.** 인증서 키로 갈려 있기 때문이고, 그래서
 * root 수집이 `@<버전>` 자리표만 모을 수 있다. 이 비대칭이 `expandVersionRoots` 가
 * 존재하는 이유 전부다.
 */
function stageGeneration(generation: string, certKey: string, version: string): void {
  const dir = join(prefix, 'generations', generation, 'certs', certKey, version);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'fullchain.pem'), 'x');
  writeFileSync(join(dir, 'privkey.pem'), 'x');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bary-roots-'));
  prefix = mkdtempSync(join(tmpdir(), 'bary-prefix-'));
  store = new FsSecretStore(root);
});

afterEach(() => {
  // 0500 이라 권한을 되돌려야 지워진다 (§4.8 — 자료를 그렇게 지킨다).
  try { execFileSync('chmod', ['-R', 'u+w', root]); } catch { /* 이미 없으면 그만 */ }
  rmSync(root, { recursive: true, force: true });
  rmSync(prefix, { recursive: true, force: true });
});

describe('GC root 배선 — 디스크의 세대가 참조하는 자료', () => {
  it('**세대에만 있는 버전은 안 지운다** — 부류 ② 가 실제로 걸린다', async () => {
    // 같은 이름에 셋. `keepPerName` 기본값 2 가 **최신 둘**을 지키므로, 세대가 가리키는
    // 것을 제일 오래된 것으로 둔다 — 그러면 남는 보호가 ② 하나뿐이다.
    const oldest = await put('web', 'a.test');
    await put('web', 'b.test');
    await put('web', 'c.test');

    // 인증서 키(`edge`)와 시크릿 이름(`web`)이 **다르다.** 그것이 정상이고,
    // 세대에서 이름을 못 읽는 이유다.
    stageGeneration('r7-e3', 'edge', versionOf(oldest));

    const roots = await collectSecretRoots({ db: emptyDb, prefix, secrets: store });
    const out = sweepSecrets({ root, roots, minAgeMs: 0 });

    // **`failed` 도 본다.** `removed` 만 보면 "지우려다 실패한 것" 이 안 보인다.
    expect(out.failed).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(existsSync(dirOf(oldest))).toBe(true);
  });

  it('세대가 안 가리키는 옛 버전은 지운다 — 보호가 넓기만 한 것이 아니다', async () => {
    const orphan = await put('web', 'a.test');
    await put('web', 'b.test');
    await put('web', 'c.test');

    // 세대는 **다른 버전**을 가리킨다.
    stageGeneration('r7-e3', 'edge', 'f'.repeat(32));

    const roots = await collectSecretRoots({ db: emptyDb, prefix, secrets: store });
    const out = sweepSecrets({ root, roots, minAgeMs: 0 });

    expect(out.failed).toEqual([]);
    expect(out.removed).toEqual([orphan]);
    expect(existsSync(dirOf(orphan))).toBe(false);
  });

  it('`@` 자리표는 결과에 안 남는다 — sweep 이 그것을 참조로 읽으면 안 된다', async () => {
    const ref = await put('web', 'a.test');
    stageGeneration('r7-e3', 'edge', versionOf(ref));

    const roots = await collectSecretRoots({ db: emptyDb, prefix, secrets: store });

    expect([...roots].some((r) => r.startsWith('@'))).toBe(false);
    expect(roots.has(ref)).toBe(true);
  });

  it('세대가 없으면 부류 ② 도 없다 — 없는 것을 지어내지 않는다', async () => {
    const ref = await put('web', 'a.test');

    const roots = await collectSecretRoots({ db: emptyDb, prefix, secrets: store });

    expect(roots.has(ref)).toBe(false);
  });
});
