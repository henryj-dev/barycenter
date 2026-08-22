/**
 * 검수 2026-08-22 · S-03 — **모르는 role 은 admin 이 아니다**
 *
 * `scopesOfRole` 은 `auditor` 와 `operator` 만 분기하고 **나머지 전부를 admin 으로
 * 떨궜다.** 그리고 `loadTokens()` 는 JSON 을 `as TokenSpec[]` 로 캐스팅할 뿐이었다.
 *
 * 그래서 `BARY_TOKENS` 에 `"role":"operater"` 라고 오타를 내면 그 토큰이
 * `/restore`·`/apply`·`/recover` 를 포함한 **전권**을 얻었다. 기동 로그에도 안 보인다.
 *
 * 이 저장소는 모델에 대해 이미 이 규칙을 세워 뒀다 — *모르는 값은 거부한다, 모르는 키도
 * 거부한다, 강제 변환하지 않는다*(`src/model/decode.ts`). 설정 파일에도 같은 규칙을 건다.
 */
import { describe, expect, it } from 'vitest';

import { parseTokenSpecs, scopesOfRole, type Role } from '../../src/api/auth.js';

const HASH = `sha256:${'a'.repeat(64)}`;

describe('토큰 설정 해독 (검수 S-03)', () => {
  it('모르는 role 은 admin 이 아니라 거부다', () => {
    expect(scopesOfRole('auditor')).toEqual(['read']);
    expect(scopesOfRole('operator')).toEqual(['read', 'write']);
    expect(scopesOfRole('admin')).toEqual(['read', 'write', 'apply', 'admin']);

    // 오타 하나가 전권이 되던 자리다.
    expect(() => scopesOfRole('operater' as Role)).toThrow(/역할/);
    expect(() => scopesOfRole('' as Role)).toThrow(/역할/);
  });

  it('아는 모양만 받는다', () => {
    expect(parseTokenSpecs([{ name: 'ops', hash: HASH, role: 'operator' }]))
      .toEqual([{ name: 'ops', hash: HASH, role: 'operator' }]);
    expect(parseTokenSpecs([{ name: 'ro', hash: HASH, scopes: ['read'] }]))
      .toEqual([{ name: 'ro', hash: HASH, scopes: ['read'] }]);
  });

  it('모르는 값·모르는 키·강제 변환을 거부한다', () => {
    expect(() => parseTokenSpecs([{ name: 'x', hash: HASH, role: 'operater' }]))
      .toThrow(/role/);
    expect(() => parseTokenSpecs([{ name: 'x', hash: HASH, scopes: ['rw'] }]))
      .toThrow(/scopes/);
    // 문자열을 Set 에 넣으면 글자 단위로 쪼개진다 — 조용히 이상한 스코프가 된다.
    expect(() => parseTokenSpecs([{ name: 'x', hash: HASH, scopes: 'read' }]))
      .toThrow(/scopes/);
    expect(() => parseTokenSpecs([{ name: 'x', hash: HASH, roles: 'admin' }]))
      .toThrow(/모르는 필드/);
    expect(() => parseTokenSpecs([{ name: 'x', hash: 'sha256:short' }]))
      .toThrow(/hash/);
    expect(() => parseTokenSpecs([{ name: '', hash: HASH, role: 'admin' }]))
      .toThrow(/name/);
  });

  it('아무 권한도 없는 토큰은 실수다', () => {
    // scopes 도 role 도 없으면 그 토큰은 아무것도 못 한다. 조용히 받아 두면
    // "토큰은 맞는데 403" 을 디버깅하게 된다.
    expect(() => parseTokenSpecs([{ name: 'x', hash: HASH }])).toThrow(/scopes|role/);
  });

  it('배열이 아니거나 비어 있으면 거부한다', () => {
    expect(() => parseTokenSpecs({})).toThrow(/배열/);
    expect(() => parseTokenSpecs([])).toThrow(/비어/);
  });
});
