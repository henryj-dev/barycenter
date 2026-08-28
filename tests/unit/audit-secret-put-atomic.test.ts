/**
 * 반쪽으로 죽은 자료는 재업로드가 고친다 — 검수 2026-08-24 D8
 *
 * ── `put` 의 주석이 옳은 절반만 말한다
 *
 * > **fullchain 을 먼저 쓰고 key 를 마지막에 쓴다.** 중간에 죽으면 key 가 없는
 * > 디렉토리가 남고, `get` 이 그걸 읽으려다 던진다 — 반쪽짜리를 조용히 쓰는 것보다 낫다.
 *
 * 조용히 쓰는 것보다 나은 것은 맞다. **그런데 거기서 끝나지 않는다.**
 *
 *   const dir = join(this.root, name, version);
 *   if (!existsSync(dir)) { …쓴다… }
 *
 * 버전이 **내용 주소**다 — 같은 바이트를 다시 올리면 같은 `version` 이 나온다. 그러면
 * `existsSync(dir)` 이 참이라 **쓰기를 통째로 건너뛴다.** 즉 반쪽으로 죽은 디렉토리는
 * **재업로드로 못 고친다.** 그리고 재업로드는 운영자가 제일 먼저 할 일이다.
 *
 * 나가는 길은 손으로 그 디렉토리를 지우는 것뿐인데, 그게 필요하다는 것을 알려면
 * 먼저 `get` 이 던지는 것을 보고 → 경로를 짚고 → 안이 반쪽인 걸 알아채야 한다.
 * **자료 디렉토리는 `0500` 이라 지우는 것도 한 단계가 더 있다.**
 *
 * ── 왜 「죽는 것」이 가정이 아닌가
 *
 * `put` 은 REST 업로드와 ACME finalize 양쪽에서 불린다. 그 사이에 프로세스가 죽는
 * 방법은 여럿이다 — 배포 롤링, OOM 킬, 노드 축출. 이 저장소는 그 부류를 이미
 * 여러 번 다뤘다(`materializeGeneration` 의 tmp+rename, `#migrateLocked` 의 잠금).
 * **같은 자리에 같은 방어가 없던 것뿐이다.**
 *
 * ── 재현 방법
 *
 * 프로세스를 진짜로 죽이지 않는다. 죽었을 때 **디스크에 남는 모양**을 그대로
 * 만들어 놓고 그 상태에서 `put` 을 부른다 — 재현물이 재려는 것은 죽는 순간이 아니라
 * **죽은 뒤에 복구가 되는가**이기 때문이다.
 */
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsSecretStore } from '../../src/dp/secrets.js';

let root = '';
let store: FsSecretStore;

/** 실제 인증서 한 벌 — `inspectMaterial` 이 검증하므로 진짜여야 한다. */
function mintPair(): { fullchain: string; privkey: string } {
  const base = join(root, 'mint');
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90',
    '-subj', '/CN=a.test', '-addext', 'subjectAltName=DNS:a.test',
    '-keyout', `${base}.key`, '-out', `${base}.crt`,
  ], { stdio: 'ignore' });
  return {
    fullchain: readFileSync(`${base}.crt`, 'utf8'),
    privkey: readFileSync(`${base}.key`, 'utf8'),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bary-putatomic-'));
  store = new FsSecretStore(root);
});

afterEach(() => {
  if (root === '') return;
  // **0500 디렉토리는 그냥 못 지운다** — `FsSecretStore` 가 자료를 그렇게 지킨다 (§4.8).
  try { execFileSync('chmod', ['-R', 'u+w', root]); } catch { /* 이미 없으면 그만 */ }
  rmSync(root, { recursive: true, force: true });
});

/**
 * `put` 이 반쪽에서 죽은 모양을 디스크에 만든다.
 *
 * `stage` 가 몇 번째 write 뒤에 죽었는지다 — 0 이면 `mkdir` 직후, 1 이면 fullchain
 * 만, 2 면 key 까지.
 */
function halfWritten(
  name: string, version: string, m: { fullchain: string; privkey: string }, stage: 0 | 1 | 2,
): string {
  const dir = join(root, name, version);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (stage >= 1) writeFileSync(join(dir, 'fullchain.pem'), m.fullchain, { mode: 0o400 });
  if (stage >= 2) writeFileSync(join(dir, 'privkey.pem'), m.privkey, { mode: 0o400 });
  chmodSync(dir, 0o500);
  return dir;
}

describe('반쪽으로 죽은 자료', () => {
  it.each([0, 1, 2] as const)(
    '반쪽으로 죽은 자료는 재업로드가 고친다 (%i 번째 쓰기 뒤에 죽었을 때)',
    async (stage) => {
      const m = mintPair();
      // 먼저 정상 경로로 버전을 알아낸다 — 내용 주소라 값이 정해져 있다.
      const probe = new FsSecretStore(mkdtempSync(join(tmpdir(), 'bary-probe-')));
      const version = (await probe.put('cert-a', m)).version;

      halfWritten('cert-a', version, m, stage);

      // **운영자가 제일 먼저 할 일.** 같은 바이트를 다시 올린다.
      const ref = await store.put('cert-a', m);
      expect(ref.version).toBe(version);

      // 그리고 읽힌다.
      const got = await store.get(ref.ref);
      expect(got.fullchain).toBe(m.fullchain);
      expect(got.privkey).toBe(m.privkey);
      // 사실도 있다 — 없으면 만료를 영영 모른다.
      expect(store.facts(ref.ref)?.notAfter).toBeTruthy();
    });

  it('온전한 자료는 다시 안 쓴다 — 내용 주소의 멱등이 안 깨졌다', async () => {
    const m = mintPair();
    const a = await store.put('cert-a', m);
    const b = await store.put('cert-a', m);
    expect(b.version).toBe(a.version);
    expect(b.ref).toBe(a.ref);
    expect((await store.get(b.ref)).privkey).toBe(m.privkey);
  });

  it('임시 디렉토리를 안 남긴다 — GC 가 그것을 버전으로 읽으면 안 된다', async () => {
    const m = mintPair();
    await store.put('cert-a', m);
    const versions = readdirSync(join(root, 'cert-a'));
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatch(/^[a-f0-9]{32}$/);
    // `listRefs` 도 그 하나만 본다.
    expect((await store.listRefs()).filter((r) => r.startsWith('store://cert-a@'))).toHaveLength(1);
  });
});

describe('남은 임시 디렉토리', () => {
  /**
   * **이 위험은 수정이 만든 것이다.** tmp+rename 으로 바꾸면 크래시가
   * `<version>.tmp-<nonce>` 를 남길 수 있고, 그것을 버전으로 읽는 쪽이 둘이다:
   * `listRefs`(GC 의 root 넓히기)와 `secret-gc` 의 `keepPerName`.
   *
   * 뒤엣것이 실제 위험이다 — tmp 는 **mtime 이 제일 커서** 보호 자리를 차지하고,
   * 그만큼 진짜 최신 버전이 보호 밖으로 밀려난다. 지켜야 할 것이 안 지켜지는 쪽이라
   * 조용하다.
   */
  it('크래시가 남긴 임시 디렉토리를 버전으로 안 읽는다', async () => {
    const m = mintPair();
    const ref = await store.put('cert-a', m);

    // 크래시가 남긴 모양을 그대로 만든다 — 진짜 버전보다 **나중에** 생긴다.
    const leftover = join(root, 'cert-a', `${ref.version}.tmp-deadbeefcafe`);
    mkdirSync(leftover, { recursive: true, mode: 0o700 });
    writeFileSync(join(leftover, 'fullchain.pem'), m.fullchain, { mode: 0o400 });

    expect(readdirSync(join(root, 'cert-a'))).toHaveLength(2);
    // 그래도 참조는 하나다.
    expect((await store.listRefs()).filter((r) => r.startsWith('store://cert-a@')))
      .toEqual([ref.ref]);
  });

  it('GC 도 그것을 버전으로 안 센다 — 보호 자리를 안 뺏는다', async () => {
    const { sweepSecrets } = await import('../../src/dp/secret-gc.js');
    const m = mintPair();
    const ref = await store.put('cert-a', m);

    const leftover = join(root, 'cert-a', `${ref.version}.tmp-deadbeefcafe`);
    mkdirSync(leftover, { recursive: true, mode: 0o700 });

    /**
     * **tmp 를 확실히 더 새것으로 만든다.**
     *
     * 처음엔 그냥 나중에 만들기만 했는데 두 mtime 이 같은 밀리초라 정렬이 안 갈렸고,
     * `readdirSync` 순서상 진짜 버전이 먼저 와서 보호 자리를 지켰다 — **수정 전에도
     * 초록이었다.** `pinned.mjs` 가 그것을 잡았다. 시간을 손으로 벌린다.
     */
    utimesSync(join(root, 'cert-a', ref.version), new Date(0), new Date(1_000));
    utimesSync(leftover, new Date(0), new Date(100_000));

    // `keepPerName: 1` — tmp 를 버전으로 세면 그것이 유일한 보호 자리를 먹고
    // **진짜 자료가 지워진다.**
    const out = sweepSecrets({ root, roots: new Set<string>(), keepPerName: 1, minAgeMs: 0 });
    expect(existsSync(join(root, 'cert-a', ref.version))).toBe(true);
    expect(out.removed).not.toContain(ref.ref);
  });
});

describe('반쪽으로 죽은 키', () => {
  it('`putKey` 도 같은 자리다 — 빈 디렉토리를 재업로드가 고친다', async () => {
    const m = mintPair();
    const probe = new FsSecretStore(mkdtempSync(join(tmpdir(), 'bary-probe2-')));
    const version = (await probe.putKey('acct', m.privkey)).version;

    const dir = join(root, 'keys', 'acct', version);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o500);
    expect(existsSync(join(dir, 'privkey.pem'))).toBe(false);

    const ref = await store.putKey('acct', m.privkey);
    expect(ref.version).toBe(version);
    expect(await store.getKey(ref.ref)).toBe(m.privkey);
  });
});
