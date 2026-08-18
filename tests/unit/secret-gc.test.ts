/**
 * SecretStore 청소 (DESIGN.md §8.3 · §8.4)
 *
 * v0.6 이 자동 갱신을 붙이면서 **저절로 자라는 것**이 생겼다. 갱신은 새 버전을 만들 뿐
 * 옛 것을 안 덮으므로(§8.3) 인증서 하나가 90 일마다 버전 하나씩 쌓고, **그 버전들은
 * 개인키를 담고 있다.**
 *
 * ── 이 테스트가 지키는 비대칭 ───────────────────────────────────────────
 *
 * 남기는 쪽으로 틀리면 디스크가 조금 더 쓰인다. **지우는 쪽으로 틀리면 서비스가 죽는다** —
 * S8 이 실측했다: 활성 인증서를 지워도 열린 fd 로 트래픽은 계속 흐르고 **다음 reload 가
 * 깨진다.** 트래픽만 보면 알 수 없다.
 *
 * 그래서 여기 있는 단언은 대부분 *"안 지운다"* 쪽이다.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSecretStore } from '../../src/dp/secrets.js';
import { expandVersionRoots } from '../../src/control/secret-roots.js';
import {
  DEFAULT_KEEP_PER_NAME, sweepSecrets,
} from '../../src/dp/secret-gc.js';

let root = '';
let store: FsSecretStore;

function mint(cn: string): { pem: string; key: string } {
  const base = join(root, `m-${cn}-${Math.random().toString(36).slice(2)}`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90',
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`,
    '-keyout', `${base}.key`, '-out', `${base}.crt`,
  ], { stdio: 'ignore' });
  const { readFileSync } = require('node:fs') as typeof import('node:fs');
  return { pem: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
}

/** 자료 하나를 넣고 참조를 돌려준다. `age` 만큼 과거로 밀어 최소 나이 보호를 푼다. */
function put(name: string, cn: string, ageMs = 86_400_000): string {
  const p = mint(cn);
  const ref = store.put(name, { fullchain: p.pem, privkey: p.key });
  const dir = join(root, name, ref.version);
  const past = (Date.now() - ageMs) / 1000;
  utimesSync(dir, past, past);
  return ref.ref;
}

const dirOf = (ref: string): string => {
  const [scheme, rest] = ref.split('://');
  const [name, version] = (rest ?? '').split('@');
  return scheme === 'key'
    ? join(root, 'keys', name!, version!)
    : join(root, name!, version!);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bary-sgc-'));
  store = new FsSecretStore(root);
});

afterEach(() => {
  // 0500 이라 권한을 되돌려야 지워진다 (§4.8 — 자료를 그렇게 지킨다).
  try { execFileSync('chmod', ['-R', 'u+w', root]); } catch { /* 이미 없으면 그만 */ }
  rmSync(root, { recursive: true, force: true });
});

describe('안 지우는 것들', () => {
  it('**root 는 안 지운다** — 하나라도 놓치면 개인키를 지운다', () => {
    const keep = put('web', 'a.test');
    const drop = put('web', 'b.test');
    const out = sweepSecrets({ root, roots: [keep], keepPerName: 0, minAgeMs: 0 });
    // **`failed` 도 본다.** `removed` 만 보면 "지우려다 실패한 것" 이 안 보이고, 그건
    // 지워야 할 것을 못 지운 것이거나 **지우면 안 될 것을 건드린 것**이다. 실제로
    // 변이 실험에서 후자가 여기로 숨었다 — `keys/` 를 인증서 이름으로 잘못 훑던 변이가
    // `removed` 를 안 바꾸고 `failed` 로만 나타났다.
    expect(out.failed).toEqual([]);
    expect(out.removed).toEqual([drop]);
    expect(existsSync(dirOf(keep))).toBe(true);
    expect(existsSync(dirOf(drop))).toBe(false);
  });

  it('**갓 만든 것은 안 지운다** — 주문이 아직 참조를 안 적었을 수 있다', () => {
    const fresh = put('web', 'a.test', 0);
    const out = sweepSecrets({ root, roots: [], keepPerName: 0, minAgeMs: 3600_000 });
    expect(out.failed).toEqual([]);
    expect(out.removed).toEqual([]);
    expect(out.kept).toContain(fresh);
  });

  it('**이름당 최소 몇 개는 남긴다** — root 계산이 틀렸을 때의 안전망', () => {
    const refs = [put('web', 'a.test'), put('web', 'b.test'), put('web', 'c.test')];
    const out = sweepSecrets({ root, roots: [], minAgeMs: 0 });
    expect(out.failed).toEqual([]);
    // 기본 안전망이 최신 둘을 잡는다. 0 으로 두면 root 버그 한 번에 전부 사라진다.
    expect(out.removed.length).toBe(refs.length - DEFAULT_KEEP_PER_NAME);
  });

  it('키 자료(`key://`)도 함께 훑는다 — 인증서만 보면 계정 키가 영원히 쌓인다', () => {
    const p = mint('k.test');
    const k1 = store.putKey('acct', p.key);
    const k2 = store.putKey('acct2', mint('k2.test').key);
    const past = (Date.now() - 86_400_000) / 1000;
    utimesSync(dirOf(k1.ref), past, past);
    utimesSync(dirOf(k2.ref), past, past);

    const out = sweepSecrets({ root, roots: [k1.ref], keepPerName: 0, minAgeMs: 0 });
    expect(out.failed).toEqual([]);
    expect(out.removed).toEqual([k2.ref]);
    expect(existsSync(dirOf(k1.ref))).toBe(true);
  });

  it('**인증서와 키를 안 섞는다** — 같은 이름이어도 스킴이 다르면 다른 것이다', () => {
    const cert = put('web', 'a.test');
    const key = store.putKey('web', mint('k.test').key);
    const past = (Date.now() - 86_400_000) / 1000;
    utimesSync(dirOf(key.ref), past, past);

    // 인증서만 root 로 준다 — 키는 지워져야 한다.
    const out = sweepSecrets({ root, roots: [cert], keepPerName: 0, minAgeMs: 0 });
    expect(out.failed).toEqual([]);
    expect(out.removed).toEqual([key.ref]);
    expect(existsSync(dirOf(cert))).toBe(true);
  });
});

describe('실제로 지운다', () => {
  it('**0500 디렉토리를 풀고 지운다** — 안 풀면 ENOTEMPTY 로 실패한다', () => {
    const drop = put('web', 'a.test');
    const out = sweepSecrets({ root, roots: [], keepPerName: 0, minAgeMs: 0 });
    expect(out.failed).toEqual([]);
    expect(out.removed).toEqual([drop]);
    expect(existsSync(dirOf(drop))).toBe(false);
  });

  it('갱신을 여러 번 해도 **유계다** — 자동 갱신이 채우는 부채가 이것이다', () => {
    const refs: string[] = [];
    for (let i = 0; i < 12; i += 1) refs.push(put('web', `r${i}.test`));
    // 최근 리비전이 참조하는 것 하나 + 안전망.
    const out = sweepSecrets({ root, roots: [refs[11]!], minAgeMs: 0 });
    expect(out.failed).toEqual([]);
    const left = out.kept.length;
    expect(left).toBeLessThanOrEqual(DEFAULT_KEEP_PER_NAME + 1);
    expect(existsSync(dirOf(refs[11]!))).toBe(true);
  });
});

describe('세대에서 뽑은 버전 root 를 넓힌다', () => {
  it('**버전이 같으면 남긴다** — 세대는 인증서 키로 갈려 시크릿 이름을 모른다', () => {
    const v = 'a'.repeat(32);
    const out = expandVersionRoots(
      new Set([`@${v}`, 'key://acct@bbb']),
      [`store://web@${v}`, `store://other@${v}`, `store://web@${'c'.repeat(32)}`],
    );
    expect(out.has(`store://web@${v}`)).toBe(true);
    expect(out.has(`store://other@${v}`)).toBe(true);
    // 버전이 다르면 안 넓힌다.
    expect(out.has(`store://web@${'c'.repeat(32)}`)).toBe(false);
    // 원래 있던 완전한 참조는 그대로 남는다.
    expect(out.has('key://acct@bbb')).toBe(true);
    // `@version` 자리표는 결과에 안 남는다.
    expect([...out].some((r) => r.startsWith('@'))).toBe(false);
  });
});
