/**
 * 렌더러는 검증된 모델만 받는다 — 4차 검수 Critical
 *
 * v3 까지 `render()` 는 잘못된 입력을 조용히 성능 저하가 아니라 **의미 변경**으로 흡수했다.
 *   · `bind: '127.0.0.1x'` → `normalizeBind` 실패 → `listen 8080;` (전 인터페이스 노출)
 *   · 참조가 깨진 라우트/리스너 → 산출물에서 조용히 사라짐
 * 오타 하나가 루프백 의도를 전 인터페이스 노출로 바꾸면 안 된다. **fail closed** 다.
 */
import { describe, expect, it } from 'vitest';
import { validateModel, ModelValidationError } from '../../src/validate/model.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const base: Model = {
  listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
};

const tcp = (bind: string): Model => ({
  ...base,
  listeners: [{ key: 'l', protocol: 'tcp', bind, port: 8080, enabled: true, defaultPool: 'p' }],
  pools: [{ key: 'p', protocolClass: 'tcp', algorithm: 'round_robin' }],
  backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 11, weight: 1 }],
});

describe('바인드 주소 — 조용한 확대를 막는다', () => {
  it('잘못된 bind 를 오류로 잡는다', () => {
    const issues = validateModel(tcp('127.0.0.1x'));
    expect(issues.map((i) => i.code)).toContain('invalid_bind_address');
    expect(issues[0]!.subjects).toEqual(['l']);
  });

  it('**렌더가 거부한다** — 와일드카드로 바꿔서 내지 않는다', () => {
    expect(() => render(tcp('127.0.0.1x'))).toThrow(ModelValidationError);
  });

  it('오타 없는 루프백은 그대로 렌더된다', () => {
    expect(render(tcp('127.0.0.1')).conf).toContain('listen 127.0.0.1:8080;');
  });

  it('IPv6 는 대괄호와 ipv6only=on 을 명시한다 — 기본값에 기대지 않는다 (E30)', () => {
    expect(render(tcp('::1')).conf).toContain('listen [::1]:8080 ipv6only=on;');
  });
});

describe('참조 무결성 — 조용한 누락을 막는다', () => {
  it('없는 풀을 참조하는 리스너는 오류다', () => {
    const m: Model = { ...tcp('0.0.0.0'), pools: [], backends: [] };
    expect(validateModel(m).map((i) => i.code)).toContain('unknown_pool');
  });

  it('없는 리스너를 참조하는 라우트는 오류다', () => {
    const m: Model = {
      ...base,
      httpRoutes: [{ key: 'r', listener: 'nope', hosts: ['a.example.com'], priority: 1,
                     action: { kind: 'reject', status: 404 } }],
    };
    expect(validateModel(m).map((i) => i.code)).toContain('unknown_listener');
  });

  it('백엔드가 없는 풀을 참조하면 오류다 — 렌더에서 사라지게 두지 않는다', () => {
    const m: Model = { ...tcp('0.0.0.0'), backends: [] };
    expect(validateModel(m).map((i) => i.code)).toContain('pool_has_no_backend');
  });
});

describe('소켓 겹침과 라우트 오류가 렌더까지 가지 않는다', () => {
  it('겹치는 리스너는 오류다', () => {
    const m: Model = {
      ...tcp('0.0.0.0'),
      listeners: [
        { key: 'a', protocol: 'tcp', bind: '0.0.0.0', port: 8080, enabled: true, defaultPool: 'p' },
        { key: 'b', protocol: 'tcp', bind: '10.0.0.5', port: 8080, enabled: true, defaultPool: 'p' },
      ],
    };
    expect(validateModel(m).map((i) => i.code)).toContain('socket_conflict');
  });

  it('비활성 리스너는 소켓을 예약하지 않는다', () => {
    const m: Model = {
      ...tcp('0.0.0.0'),
      listeners: [
        { key: 'a', protocol: 'tcp', bind: '0.0.0.0', port: 8080, enabled: true, defaultPool: 'p' },
        { key: 'b', protocol: 'tcp', bind: '0.0.0.0', port: 8080, enabled: false, defaultPool: 'p' },
      ],
    };
    expect(validateModel(m).filter((i) => i.code === 'socket_conflict')).toEqual([]);
  });

  it('라우트 컴파일 오류도 렌더를 막는다', () => {
    const m: Model = {
      ...base,
      listeners: [{ key: 'w', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true }],
      pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin' }],
      backends: [{ key: 'b', pool: 'p', host: '10.0.0.1', port: 80, weight: 1 }],
      httpRoutes: [
        { key: 'r1', listener: 'w', hosts: ['a.example.com'], priority: 1,
          action: { kind: 'proxy', pool: 'p', websocket: false } },
        { key: 'r2', listener: 'w', hosts: ['a.example.com'], priority: 2,
          action: { kind: 'proxy', pool: 'p', websocket: false } },
      ],
    };
    expect(validateModel(m).map((i) => i.code)).toContain('route_compile_error');
    expect(() => render(m)).toThrow(ModelValidationError);
  });
});

describe('오류를 모아서 보고한다 — plan 이 한 번에 보여줘야 한다', () => {
  it('여러 오류가 동시에 나온다', () => {
    const m: Model = {
      ...base,
      listeners: [{ key: 'l', protocol: 'tcp', bind: 'nope', port: 8080, enabled: true, defaultPool: 'ghost' }],
    };
    const codes = validateModel(m).map((i) => i.code).sort();
    expect(codes).toEqual(['invalid_bind_address', 'unknown_pool']);
  });
});
