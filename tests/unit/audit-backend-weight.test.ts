/**
 * 백엔드 가중치 하한 — 검수 2026-08-24 D6
 *
 * ── 저장은 되는데 엔진이 안 받는다
 *
 * 해독기는 `weight` 를 `0` 부터 받았다. 그런데 nginx 는 `weight=0` 을 **거절한다** —
 * 실제 엔진 이미지로 재 봤다:
 *
 * ```
 * upstream p { server 127.0.0.1:9001 weight=0; }
 * [emerg] invalid parameter "weight=0"
 * ```
 *
 * Lua 가 없는 엔진에서 이 값은 게시 전 `nginx -t` 에서 터지고, 그때 운영자가 보는 것은
 * 「설정이 이상하다」이지 「가중치 0 은 없다」가 아니다. `validateBackendHost` ·
 * `validatePathPrefix` 를 만든 이유(S-11)와 정확히 같은 자리다 — **실패가 사라지는 게
 * 아니라 옮겨간다.**
 *
 * ── 그리고 두 표면이 이미 갈려 있었다
 *
 * 저작 표면(`putBackendPatch`)은 *"가중치가 1 이상 정수가 아니다"* 로 막는데 해독기는
 * `0` 을 받았다. **GUI·CLI 로는 못 넣고 API·import 로는 들어간다** — 같은 모델에 대해
 * 두 문이 다른 답을 하는 것 자체가 결함이다. 이 파일은 둘이 같은 답을 하는지 잰다.
 */
import { describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { putBackendPatch } from '../../src/web/edit.js';

const backend = (weight: number): unknown => ({
  listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [],
  backends: [{ key: 'b1', pool: 'p1', host: '10.0.0.1', port: 80, weight }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('가중치 하한', () => {
  it('**`0` 은 저장 단계에서 막힌다** — 엔진이 `invalid parameter` 로 거절한다', () => {
    const out = decodeModel(backend(0));
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.issues.map((i) => i.code)).toContain('out_of_range');
    expect(out.issues.some((i) => i.subjects.some((s) => s.includes('weight')))).toBe(true);
  });

  it('`1` 은 받는다 — 기본값이고 렌더가 `weight=` 를 아예 안 낸다', () => {
    expect(decodeModel(backend(1)).ok).toBe(true);
  });

  it('큰 값은 그대로 받는다 — 하한만 올렸지 상한을 안 건드렸다', () => {
    expect(decodeModel(backend(1_000_000)).ok).toBe(true);
    expect(decodeModel(backend(1_000_001)).ok).toBe(false);
  });

  it('**저작 표면과 같은 답을 한다** — 문이 둘인데 답이 다르면 그 자체가 결함이다', () => {
    // 저작 표면은 처음부터 1 을 요구했다. 해독기가 뒤늦게 따라온 것이다.
    expect(() => putBackendPatch('b1', { pool: 'p1', host: '10.0.0.1', port: 80, weight: 0 }))
      .toThrow(/1 이상/);
    expect(decodeModel(backend(0)).ok).toBe(false);
  });
});
