/**
 * **응답한 노드의 이름** — 값 검사와 렌더 모양 (conf/served-by.ts, 2026-11-14)
 *
 * 실제 응답은 `tests/golden/error-pages.test.ts` 가, 세대 조각은 `tests/store/served-by-fragment.test.ts` 가 잰다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { SERVED_BY_FILE, servedByFragment, servedByFromEnv } from '../../src/conf/served-by.js';
import type { Model } from '../../src/model/provisional.js';

const host = (): string => 'web-01.az01-icn-own';
const EMPTY: Model = {
  listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

describe('BARY_SERVED_BY', () => {
  it('비었거나 없으면 끈다', () => {
    expect(servedByFromEnv(undefined, host)).toBeUndefined();
    expect(servedByFromEnv('', host)).toBeUndefined();
    expect(servedByFromEnv('  ', host)).toBeUndefined();
  });

  it('별칭은 그대로, `@hostname` 은 호스트 이름', () => {
    expect(servedByFromEnv('icn-a1', host)).toBe('icn-a1');
    expect(servedByFromEnv('@hostname', host)).toBe('web-01.az01-icn-own');
  });

  it('conf · 헤더 · HTML 을 깰 수 있는 값은 기동에서 거부한다', () => {
    for (const bad of ['a b', 'a"b', 'a;b', '$host', '<x>', '-lead', 'a'.repeat(65), '한글']) {
      expect(() => servedByFromEnv(bad, host), bad).toThrow(/BARY_SERVED_BY/);
    }
    expect(() => servedByFromEnv('@hostname', () => 'bad host')).toThrow(/BARY_SERVED_BY/);
    expect(() => servedByFragment('a"b')).toThrow();
  });

  it('조각은 map 의 default 한 줄이다', () => {
    expect(servedByFragment('icn-a1')).toMatch(/^default "icn-a1";$/m);
  });
});

describe('렌더 — 자리만 낸다', () => {
  it('map 이 세대 조각을 끌어들이고, headers-more 가 있을 때만 헤더를 낸다', () => {
    const on = render(EMPTY, { streamRealip: false, headersMore: true }).conf;
    const off = render(EMPTY, { streamRealip: false }).conf;
    for (const c of [on, off]) {
      expect(c).toContain(`map $status $bary_served_by {`);
      expect(c).toContain(`include ${SERVED_BY_FILE}*;`);
    }
    expect(on).toContain('more_set_headers "X-Served-By: $bary_served_by";');
    expect(off).not.toContain('X-Served-By');
  });

  it('오류 페이지는 노드 이름이 있을 때만 그 자리를 채운다', () => {
    const c = render(EMPTY, { streamRealip: false }).conf;
    expect(c).toMatch(/map \$bary_served_by \$bary_err_served \{\s*"" "";/);
    expect(c).toMatch(/map \$bary_served_by \$bary_err_jserved \{\s*"" "";/);
  });
});
