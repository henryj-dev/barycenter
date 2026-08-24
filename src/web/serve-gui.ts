/**
 * GUI 정적 파일. API 와 같은 출처에서 내보낸다 — 브라우저 CORS 를 열지 않기 위해.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

import { SECURITY_HEADERS } from '../api/headers.js';

/**
 * HTML 문서의 CSP `script-src` 를 **그 파일에서 유도한다** (검수 G2).
 *
 * ── 왜 유도인가
 *
 * 산출물을 열어 봤다: 페이지마다 인라인 `<script>` 가 **하나** 있고(SvelteKit
 * 부트스트랩) `nonce` 속성이 없다. 허용하는 길은 셋인데 —
 *
 *   `'unsafe-inline'`  정책의 뜻을 없앤다
 *   nonce              서빙 때 HTML 을 다시 써야 한다. 정적 서빙을 버리는 것이다
 *   **해시**           이것뿐인데, **빌드마다 바뀐다**
 *
 * 모듈 파일 이름이 내용 해시이고 SvelteKit 의 전역 이름(`__sveltekit_abh1v7`)도
 * 빌드마다 다르다. 그러니 `headers.ts` 에 박아 두면 **다음 빌드에 화면이 죽는다** —
 * *"도구가 답하는 것을 사람이 베껴 적으면 그 사본은 반드시 낡는다"* 의 한 판이다.
 * 서빙하는 그 바이트에서 뽑는다.
 *
 * ── `style-src` 에 `'unsafe-inline'` 을 두는 이유
 *
 * 산출물에 `style="display:contents"` 가 있다. **속성이라 해시로 못 잡는다**
 * (CSP3 의 `'unsafe-hashes'` 는 지원이 고르지 않다). 스타일 속성으로 할 수 있는 것은
 * 스크립트와 급이 다르므로, **지어내지 않고 있는 그대로** 좁힌다: 스크립트는 해시로
 * 잠그고 스타일만 연다.
 *
 * ── 캐시
 *
 * 파일 경로와 mtime·크기로 캐시한다. 같은 파일을 요청마다 해싱하지 않되, 빌드가
 * 바뀌면 자동으로 다시 뽑는다 — **여기서도 사람이 갱신할 것이 없어야 한다.**
 */
const cspCache = new Map<string, { stamp: string; csp: string }>();

function htmlCsp(path: string): string {
  const st = statSync(path);
  const stamp = `${st.mtimeMs}:${st.size}`;
  const hit = cspCache.get(path);
  if (hit !== undefined && hit.stamp === stamp) return hit.csp;

  const html = readFileSync(path, 'utf8');
  // `src=` 가 있는 것은 외부 파일이라 `'self'` 가 덮는다.
  const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map((m) => `'sha256-${createHash('sha256').update(m[1] ?? '', 'utf8').digest('base64')}'`);

  /**
   * **구글 폰트를 연다** — 산출물이 실제로 그것을 참조하기 때문이다.
   *
   *   <link rel="preconnect" href="https://fonts.googleapis.com" />
   *   <link href="https://fonts.googleapis.com/css2?family=…" rel="stylesheet" />
   *
   * `'self'` 만 두면 **화면이 깨진다** — 지어낸 정책이 아니라 **깨진 자리를 근거로**
   * 좁힌다는 것이 이 항목의 규칙이었다. 스타일시트는 `googleapis`, 폰트 파일은
   * `gstatic` 에서 온다.
   *
   * ⚠️ **이건 결정이지 사실이 아니다.** GUI 가 폰트를 자기 자산으로 들이면 이 두 줄은
   * 사라져야 한다 — 외부 출처가 하나라도 열려 있으면 그만큼 이 화면이 남의 가용성에
   * 매달린다. 지금 상태를 정확히 적어 두는 것이 다음 사람이 그 결정을 할 재료다.
   */
  const csp = [
    "default-src 'self'",
    `script-src 'self'${hashes.length > 0 ? ` ${[...new Set(hashes)].join(' ')}` : ''}`,
    // 위 주석의 이유로 스타일 속성을 열고, 폰트 스타일시트의 출처를 더한다.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    // SSE 도 이 지시어다 (`/api/v1/events`).
    "connect-src 'self'",
    "img-src 'self' data:",
    // 이 화면은 아무것도 안 심고 아무 데도 안 보낸다.
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
  cspCache.set(path, { stamp, csp });
  return csp;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function serveGui(res: ServerResponse, pathname: string, root: string): boolean {
  if (!existsSync(root) || !statSync(root).isDirectory()) return false;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let target = resolve(root, rel);
  const base = resolve(root);
  const inside = target === base || relative(base, target).split(sep)[0] !== '..';
  if (!inside) return false;
  if (existsSync(target) && statSync(target).isDirectory()) {
    const indexed = join(target, 'index.html');
    if (existsSync(indexed)) target = indexed;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    const asHtml = resolve(root, `${rel}.html`);
    if (existsSync(asHtml) && statSync(asHtml).isFile()) {
      target = asHtml;
    } else {
      return false;
    }
  }
  /**
   * **심볼릭 링크까지 본다** (검수 S-10).
   *
   * 위의 `relative()` 검사는 `..` 만 막는다. 루트 **안에** 밖을 가리키는 링크가 있으면
   * 그 파일이 인증 없이 그대로 나간다 — 재현물이 `PRIVATE KEY` 를 받아 냈다.
   * 빌드 산출물에 링크가 생길 이유는 없으므로, 풀어서 다시 확인하는 값이 싸다.
   */
  let real: string;
  let realBase: string;
  try {
    real = realpathSync(target);
    realBase = realpathSync(base);
  } catch {
    return false;
  }
  if (real !== realBase && relative(realBase, real).split(sep)[0] === '..') return false;

  const type = MIME[extname(target)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-cache',
    ...SECURITY_HEADERS,
    // **HTML 에만 전체 CSP 를 낸다** (검수 G2). 자산에 붙여 봐야 뜻이 없고, 붙이려면
    // 그 파일도 읽어야 한다. `SECURITY_HEADERS` 의 것을 여기서 덮는다.
    ...(extname(real) === '.html' ? { 'content-security-policy': htmlCsp(real) } : {}),
  });
  createReadStream(real).pipe(res);
  return true;
}
