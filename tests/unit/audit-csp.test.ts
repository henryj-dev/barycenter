/**
 * CSP `script-src` — 검수 2026-08-24 G2
 *
 * ── `headers.ts` 가 미룬 이유
 *
 * > 여기 있는 것은 **한 줄로 얻는 것들**뿐이다. 전체 CSP(스크립트 출처 제한)는 GUI 빌드가
 * > 인라인을 내는지에 달려 있다.
 *
 * 그래서 **산출물을 실제로 열었다.** 사실은 이렇다 (`gui/build/*.html`, 9 개 전부 같다):
 *
 *   · 인라인 `<script>` **하나** — SvelteKit 부트스트랩. `nonce` 속성이 없다
 *   · 인라인 `style="display:contents"` **속성 하나** — `<style>` 블록은 없다
 *   · 나머지 JS·CSS 는 전부 외부 파일
 *
 * ── 해시를 베껴 적지 않는다
 *
 * 인라인 스크립트를 허용하는 길은 셋이다. `'unsafe-inline'` 은 정책의 뜻을 없앤다.
 * nonce 는 서빙 때 HTML 을 다시 쓰는 것이라 정적 서빙을 버려야 한다. 남는 것이
 * **해시**인데, 그 해시는 **빌드마다 바뀐다** — 모듈 파일 이름이 내용 해시이고
 * SvelteKit 의 전역 이름(`__sveltekit_abh1v7`)도 빌드마다 다르다.
 *
 * 그러니 `headers.ts` 에 해시를 박아 두면 **다음 빌드에 화면이 죽는다.** 이 저장소가
 * 반복해서 적은 그대로다 — *"도구가 답하는 것을 사람이 베껴 적으면 그 사본은 반드시
 * 낡는다."* 서빙하는 그 파일에서 **유도한다.**
 *
 * ── `style-src` 는 왜 `'unsafe-inline'` 인가
 *
 * `style="display:contents"` 는 **속성**이라 해시로 못 잡는다(CSP3 의
 * `'unsafe-hashes'` 가 있지만 지원이 고르지 않다). 그리고 스타일 속성으로 할 수 있는
 * 공격은 스크립트와 급이 다르다 — **지어내지 않고 있는 그대로 좁힌다**: 스크립트는
 * 해시로 잠그고 스타일 속성만 연다.
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { Db } from '../../src/store/pg.js';

const GUI = new URL('../../gui/build', import.meta.url).pathname;

let server: Server | undefined;

afterEach(async () => {
  for (const d of fixtures.splice(0)) rmSync(d, { recursive: true, force: true });
  const s = server;
  server = undefined;
  if (s !== undefined) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
});

async function listen(guiRoot = GUI): Promise<string> {
  server = createApi({
    db: { query: async () => ({ rows: [] }) } as unknown as Db,
    store: {} as ConfigStore,
    control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'r', hash: hashToken('t'), scopes: ['read'] }]),
    election: { state: { isLeader: true } } as unknown as LeaderElection,
    guiRoot,
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** 그 HTML 의 인라인 스크립트 본문들. */
const inlineScripts = (html: string): string[] =>
  [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');

const sha256b64 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('base64');

const built = existsSync(GUI);

/**
 * **빌드에 안 매달리는 무대.**
 *
 * 아래 `describe.skipIf(!built)` 는 실제 산출물을 잰다 — 값이 있지만 `gui/build` 가
 * 없는 트리에서는 통째로 건너뛴다. 그러면 **재현물이 아무것도 안 지킨다**:
 * `pinned.mjs` 가 정확히 그것을 잡았다(*"수정 전에도 초록이다"*).
 *
 * 그래서 기전은 **손으로 만든 HTML** 로 따로 못 박는다. 재는 것이 「서빙하는 바이트에서
 * 해시를 유도하는가」이므로, 그 바이트를 우리가 쓰면 된다.
 */
function guiFixture(html: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-csp-'));
  writeFileSync(join(dir, 'index.html'), html, 'utf8');
  fixtures.push(dir);
  return dir;
}
const fixtures: string[] = [];

const INLINE = '<html><head><script>window.X=1</script></head><body>hi</body></html>';

describe('CSP — 서빙하는 바이트에서 유도한다', () => {
  /**
   * **이것이 G2 의 재현물이다.** 빌드 산출물에 안 매달린다.
   */
  it('인라인 부트스트랩의 해시가 실려 있다 — 산출물에서 유도한다', async () => {
    const url = await listen(guiFixture(INLINE));
    const csp = (await fetch(`${url}/`)).headers.get('content-security-policy') ?? '';
    expect(csp, csp).toContain("script-src 'self'");
    expect(csp, csp).toContain(`'sha256-${sha256b64('window.X=1')}'`);
    expect(csp, csp).toContain("connect-src 'self'");
    // **`'unsafe-inline'` 으로 도망가지 않는다.** 있으면 해시가 무의미해진다.
    expect(csp, csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
  });

  /** 인라인이 없으면 해시도 없다 — 없는 것을 지어내지 않는다. */
  it('인라인이 없으면 해시를 안 붙인다', async () => {
    const url = await listen(guiFixture('<html><body>hi</body></html>'));
    const csp = (await fetch(`${url}/`)).headers.get('content-security-policy') ?? '';
    expect(csp, csp).toContain("script-src 'self'");
    expect(csp, csp).not.toContain('sha256-');
  });

  /** 인라인이 둘이면 둘 다. 하나만 열면 나머지가 조용히 막힌다. */
  it('인라인이 여럿이면 전부 해시를 낸다', async () => {
    const url = await listen(guiFixture(
      '<html><script>a()</script><script>b()</script></html>'));
    const csp = (await fetch(`${url}/`)).headers.get('content-security-policy') ?? '';
    expect(csp, csp).toContain(`'sha256-${sha256b64('a()')}'`);
    expect(csp, csp).toContain(`'sha256-${sha256b64('b()')}'`);
  });

  /** `src=` 가 있는 것은 외부 파일이라 `'self'` 가 덮는다 — 해시를 안 낸다. */
  it('외부 스크립트에는 해시를 안 낸다', async () => {
    const url = await listen(guiFixture('<html><script src="./a.js"></script></html>'));
    const csp = (await fetch(`${url}/`)).headers.get('content-security-policy') ?? '';
    expect(csp, csp).not.toContain('sha256-');
  });

  /**
   * **빌드가 바뀌면 자동으로 다시 뽑는다.** 캐시가 낡으면 다음 빌드에 화면이 죽고,
   * 그게 이 항목이 해시를 베껴 적지 않기로 한 이유 전부다.
   */
  it('파일이 바뀌면 해시도 바뀐다 — 캐시가 안 낡는다', async () => {
    const dir = guiFixture(INLINE);
    const url = await listen(dir);
    const before = (await fetch(`${url}/`)).headers.get('content-security-policy') ?? '';
    expect(before).toContain(`'sha256-${sha256b64('window.X=1')}'`);

    writeFileSync(join(dir, 'index.html'),
      '<html><head><script>window.X=2</script></head></html>', 'utf8');
    const after = (await fetch(`${url}/`)).headers.get('content-security-policy') ?? '';
    expect(after, after).toContain(`'sha256-${sha256b64('window.X=2')}'`);
    expect(after, after).not.toContain(`'sha256-${sha256b64('window.X=1')}'`);
  });
});

describe.skipIf(!built)('CSP — 실제 산출물', () => {
  it('응답 헤더에 `script-src` 가 있다', async () => {
    const url = await listen();
    const r = await fetch(`${url}/`);
    expect(r.status).toBe(200);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp, csp).toContain("script-src 'self'");
    // 그리고 원래 있던 것이 안 없어졌다.
    expect(csp, csp).toContain("frame-ancestors 'none'");
  });

  /**
   * **화면이 깨진 자리를 근거로 좁힌다.** 산출물에 인라인 스크립트가 하나 있으므로,
   * `script-src 'self'` 만으로는 그 부트스트랩이 막혀 화면이 안 뜬다. 그 하나만
   * 해시로 연다 — `'unsafe-inline'` 이 아니다.
   */
  it('실제 빌드의 인라인 부트스트랩 해시가 실려 있다', async () => {
    const url = await listen();
    const r = await fetch(`${url}/`);
    const csp = r.headers.get('content-security-policy') ?? '';
    const bodies = inlineScripts(readFileSync(`${GUI}/index.html`, 'utf8'));
    expect(bodies.length, '산출물이 바뀌었다 — 인라인 스크립트 수를 다시 본다').toBe(1);
    expect(csp, csp).toContain(`'sha256-${sha256b64(bodies[0]!)}'`);
    // **`'unsafe-inline'` 은 없다.** 있으면 해시가 무의미해진다.
    expect(csp, csp).not.toContain("script-src 'self' 'unsafe-inline'");
  });

  /** 페이지마다 다른 인라인이면 페이지마다 다른 해시여야 한다. */
  it('페이지마다 그 페이지의 해시를 낸다', async () => {
    const url = await listen();
    const pages = readdirSync(GUI).filter((f) => f.endsWith('.html'));
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      const r = await fetch(`${url}/${page}`);
      const csp = r.headers.get('content-security-policy') ?? '';
      for (const body of inlineScripts(readFileSync(`${GUI}/${page}`, 'utf8'))) {
        expect(csp, `${page}: ${csp}`).toContain(`'sha256-${sha256b64(body)}'`);
      }
    }
  });

  /**
   * **산출물이 실제로 참조하는 외부 출처만 연다.**
   *
   * 화면이 구글 폰트를 쓴다(`<link href="https://fonts.googleapis.com/css2?…">`).
   * `'self'` 만 두면 화면이 깨진다 — 이 항목의 규칙이 *"깨진 자리를 근거로 좁힌다.
   * 지어내지 않는다"* 였다.
   *
   * ⚠️ **이 검사는 그 사실이 바뀌면 빨개져야 한다.** 폰트를 자기 자산으로 들이면
   * 정책에서 그 두 줄이 사라져야 하고, 그때 여기가 먼저 말한다.
   */
  it('산출물이 참조하는 외부 출처만 열려 있다', async () => {
    const html = readFileSync(`${GUI}/index.html`, 'utf8');
    // **부분문자열이 아니라 출처 자리에서 본다** (검수 2026-08-24 SCAN-7).
    // `includes` 는 `https://evil.test/fonts.googleapis.com/…` 도 참이라, 재는 것이
    // "구글 폰트를 쓰는가" 가 아니라 "그 글자가 어딘가 있는가" 가 된다.
    const usesGoogleFonts = /\bhttps:\/\/fonts\.googleapis\.com[/"']/.test(html);
    const url = await listen();
    const csp = (await fetch(`${url}/`)).headers.get('content-security-policy') ?? '';

    if (usesGoogleFonts) {
      expect(csp, csp).toContain('style-src');
      expect(csp, csp).toContain('https://fonts.googleapis.com');
      expect(csp, csp).toContain('https://fonts.gstatic.com');
    } else {
      // 폰트를 자기 자산으로 들였다 — 정책도 좁아져야 한다.
      expect(csp, '산출물이 외부 폰트를 안 쓰는데 정책이 열려 있다')
        .not.toContain('fonts.googleapis.com');
    }
  });

  /** `connect-src` 로 데이터가 밖으로 나가는 길을 막는다 — SSE 도 이 지시어다. */
  it('`connect-src` 가 같은 출처로 묶는다', async () => {
    const url = await listen();
    const csp = (await fetch(`${url}/`)).headers.get('content-security-policy') ?? '';
    expect(csp, csp).toContain("connect-src 'self'");
  });

  /**
   * **HTML 이 아닌 것에는 스크립트 해시를 안 붙인다.** 붙여 봐야 뜻이 없고,
   * 붙이려면 그 파일도 읽어야 한다.
   */
  it('정적 자산에는 해시를 안 붙인다 — 읽을 이유가 없다', async () => {
    const url = await listen();
    const r = await fetch(`${url}/index.html`);
    expect(r.status).toBe(200);
    const asset = readdirSync(`${GUI}/_app/immutable/entry`).find((f) => f.endsWith('.js'));
    if (asset === undefined) return;
    const a = await fetch(`${url}/_app/immutable/entry/${asset}`);
    expect(a.status).toBe(200);
    expect(a.headers.get('content-security-policy') ?? '', 'JS 에 해시가 붙었다')
      .not.toContain('sha256-');
  });

  /** **API 응답의 CSP 는 안 바뀐다.** GUI 가 없는 배포의 거동이 그대로다. */
  it('API 응답의 CSP 는 그대로다', async () => {
    const url = await listen();
    const r = await fetch(`${url}/healthz`);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp, csp).toContain("frame-ancestors 'none'");
    expect(csp, csp).not.toContain('sha256-');
  });
});
