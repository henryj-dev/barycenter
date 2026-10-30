/**
 * GUI 정적 자산 — 글꼴과 favicon (2026-10-31, web-01 콘솔).
 *
 * ① 글꼴 하나가 CSP `font-src 'self'` 에 막혔다. Vite 는 4KB 보다 작은 자산을 CSS 안에 `data:` 로 박는데,
 *    작은 글꼴 조각(Pretendard 서브셋)이 그렇게 들어갔다. CSP 를 넓히지 않고, 글꼴은 늘 파일로 낸다.
 * ② `/favicon.ico` 가 없어서 브라우저의 요청이 GUI 를 지나 API 인증으로 갔다. 로그아웃 상태에서는 그것이
 *    「인증 실패」 로 세어져, 페이지를 몇 번 열면 IP 가 잠겼다(429). 아이콘을 두고 페이지가 그것을 가리킨다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui');

describe('GUI 정적 자산', () => {
  it('글꼴을 CSS 에 data: 로 박지 않는다', () => {
    const cfg = readFileSync(join(GUI, 'vite.config.ts'), 'utf8');
    expect(cfg).toMatch(/assetsInlineLimit: \(file\) => \(\/\\\.\(woff2\?\|ttf\|otf\)\$\/\.test\(file\) \? false/);
  });

  it('favicon 이 있고 페이지가 가리킨다', () => {
    expect(existsSync(join(GUI, 'static/favicon.svg'))).toBe(true);
    expect(readFileSync(join(GUI, 'src/app.html'), 'utf8')).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />');
  });
});
