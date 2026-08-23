/**
 * S9 — "TLS 인데 SNI 가 없다" 를 설정 가능으로 승격했다 (§4.1, §12.0, §13.8)
 *
 * `spike/s9` 가 실물에서 잰 것을 여기서 계약으로 굳힌다:
 *
 *     TLS + SNI 없음   → $ssl_preread_protocol 이 차 있다      (별도 분기)
 *     malformed        → preread 가 DECLINED, protocol 이 비었다 (비-TLS 와 한 통)
 *     preread timeout  → nginx 가 연결을 끊는다                  (분기에 안 온다)
 *
 * **갈린다는 사실이 승격의 조건 전부다.** 그래서 여기서 제일 중요한 검사는 "새 필드가
 * 렌더된다" 가 아니라 **"파싱 실패는 여전히 어디로도 안 간다"** 이다 — 그게 §4.1 이
 * 지키려던 것이고, 승격이 그걸 깨면 승격을 하지 말았어야 한다.
 */
import { describe, expect, it } from 'vitest';
import { render } from '../../src/conf/render.js';
import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';
import { putPassthroughListenerPatch } from '../../src/web/edit.js';
import { listenerCreatePatch } from '../../src/cli/listener.js';
import type { Model } from '../../src/model/provisional.js';

const pool = (key: string) => ({
  key, protocolClass: 'tcp' as const, algorithm: 'round_robin' as const,
});
const backend = (key: string, p: string) => ({
  key, pool: p, host: '10.0.0.1', port: 443, weight: 1,
});

function model(extra: Record<string, unknown>): Model {
  return {
    listeners: [{
      key: 'pt', bind: '0.0.0.0', port: 8443, enabled: true,
      protocol: 'tls_passthrough', ...extra,
    }],
    pools: [pool('named'), pool('fallback'), pool('lonely')],
    backends: [backend('b1', 'named'), backend('b2', 'fallback'), backend('b3', 'lonely')],
    httpRoutes: [],
    passthroughRoutes: [{
      key: 'r1', listener: 'pt', snis: ['a.example.com'], priority: 100,
      action: { kind: 'proxy', pool: 'named' },
    }],
    certificates: [], tlsPolicies: [], sniBindings: [],
  } as unknown as Model;
}

describe('S9 — on_no_sni 승격', () => {
  it('안 걸면 map 이 하나다 — 쓰지 않는 분기를 미리 만들지 않는다', () => {
    const conf = render(model({})).conf;
    expect(conf).not.toContain('$ssl_preread_protocol');
    // 빈 SNI 는 빈 값으로 간다 = proxy_pass 실패 = 연결 종료. 이게 기본이다.
    expect(conf).toContain('map $ssl_preread_server_name');
  });

  it("'reject' 를 명시해도 분기를 안 만든다 — 동작이 기본과 같다", () => {
    const conf = render(model({ onNoSni: 'reject' })).conf;
    expect(conf).not.toContain('$ssl_preread_protocol');
  });

  it('풀을 걸면 $ssl_preread_protocol map 이 난다', () => {
    const conf = render(model({ onNoSni: { pool: 'fallback' } })).conf;
    expect(conf).toContain('map $ssl_preread_protocol');
  });

  /**
   * **이 회차의 핵심.** protocol 이 빈 분기는 계속 빈 값이어야 한다. 여기에 폴백
   * 업스트림이 들어가면 TLS 로 안 읽히는 바이트가 사용자의 백엔드에 닿는다 —
   * §4.1 이 처음부터 막으려던 것이고, S9 가 통과했다고 해서 열리는 것이 아니다.
   */
  it('파싱 실패·비-TLS 는 폴백을 걸어도 어디로도 안 간다', () => {
    const conf = render(model({ onNoSni: { pool: 'fallback' } })).conf;
    const m = /map \$ssl_preread_protocol \$\w+ \{([^}]*)\}/.exec(conf);
    expect(m).not.toBeNull();
    const body = m![1];
    // 빈 키의 값이 비어 있어야 한다.
    expect(body).toMatch(/(^|\n)\s*""\s+"";/);
    expect(body).not.toMatch(/(^|\n)\s*""\s+bary_up/);
  });

  it('폴백 풀의 upstream 이 실제로 난다 — 라우트가 안 쓰는 풀이어도', () => {
    // 'lonely' 는 라우트도 unmatched 도 안 쓴다. usedPools 에 안 넣으면 map 이
    // 정의되지 않은 업스트림을 가리키고 `nginx -t` 가 게시 전에 죽는다.
    const conf = render(model({ onNoSni: { pool: 'lonely' } })).conf;
    const m = /map \$ssl_preread_protocol \$\w+ \{([^}]*)\}/.exec(conf)!;
    const target = /default\s+(\S+);/.exec(m[1]!)![1]!;
    expect(target).not.toBe('""');
    expect(conf).toContain(`upstream ${target} {`);
  });

  it('unmatched 와 no-SNI 를 동시에 다른 풀로 보낼 수 있다', () => {
    const conf = render(model({
      onUnmatchedSni: { pool: 'fallback' }, onNoSni: { pool: 'lonely' },
    })).conf;
    const proto = /map \$ssl_preread_protocol \$\w+ \{([^}]*)\}/.exec(conf)![1];
    const name = /map \$ssl_preread_server_name \$\w+ \{([^}]*)\}/.exec(conf)![1];
    const noSniTarget = /default\s+(\S+);/.exec(proto!)![1];
    const unmatchedTarget = /default\s+(\S+);/.exec(name!)![1];
    expect(noSniTarget).not.toBe(unmatchedTarget);
  });

  it('없는 풀을 가리키면 검증기가 막는다 — 조용히 reject 가 되지 않는다', () => {
    const issues = validateModel(model({ onNoSni: { pool: 'nope' } }));
    expect(issues.some((i) => JSON.stringify(i).includes('nope'))).toBe(true);
  });

  it('패스스루가 아닌 리스너에 붙으면 검증기가 막는다', () => {
    const issues = validateModel({
      ...model({}),
      listeners: [{
        key: 'h', bind: '0.0.0.0', port: 80, enabled: true, protocol: 'http',
        http: { defaultAction: { pool: 'named' } }, onNoSni: { pool: 'fallback' },
      }],
    } as never);
    expect(issues.some((i) => JSON.stringify(i).includes('onNoSni'))).toBe(true);
  });

  it('해독기가 onNoSni 를 받는다', () => {
    const out = decodeModel({
      listeners: [{
        key: 'pt', bind: '0.0.0.0', port: 8443, enabled: true,
        protocol: 'tls_passthrough', onNoSni: { pool: 'fallback' },
      }],
      pools: [], backends: [], httpRoutes: [], passthroughRoutes: [],
      certificates: [], tlsPolicies: [], sniBindings: [],
    });
    expect(out.ok).toBe(true);
    const l = (out as { model: { listeners: { onNoSni?: unknown }[] } }).model.listeners[0]!;
    expect(l.onNoSni).toEqual({ pool: 'fallback' });
  });

  it('해독기가 모르는 모양은 거부한다', () => {
    const out = decodeModel({
      listeners: [{
        key: 'pt', bind: '0.0.0.0', port: 8443, enabled: true,
        protocol: 'tls_passthrough', onNoSni: 'fallback',
      }],
      pools: [], backends: [], httpRoutes: [], passthroughRoutes: [],
      certificates: [], tlsPolicies: [], sniBindings: [],
    });
    expect(out.ok).toBe(false);
  });

  it('편집 표면이 noSniPool 을 낸다', () => {
    const [op] = putPassthroughListenerPatch('pt', {
      bind: '0.0.0.0', port: 8443, pool: 'a', noSniPool: 'b',
    });
    expect(op!.body.onUnmatchedSni).toEqual({ pool: 'a' });
    expect(op!.body.onNoSni).toEqual({ pool: 'b' });
  });

  it('빈 문자열은 필드를 안 만든다 — "" 는 "안 정했다" 다', () => {
    const [op] = putPassthroughListenerPatch('pt', {
      bind: '0.0.0.0', port: 8443, noSniPool: '   ',
    });
    expect(op!.body.onNoSni).toBeUndefined();
  });

  it('CLI 가 --no-sni-pool 을 패치까지 나른다', () => {
    const patch = listenerCreatePatch({
      name: 'pt', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 8443,
      noSniPool: 'fallback',
    })!;
    expect(JSON.stringify(patch)).toContain('onNoSni');
  });

  it('패스스루가 아니면 CLI 도 안 나른다', () => {
    const patch = listenerCreatePatch({
      name: 'h', protocol: 'http', bind: '0.0.0.0', port: 80, pool: 'named',
      noSniPool: 'fallback',
    })!;
    expect(JSON.stringify(patch)).not.toContain('onNoSni');
  });

  /**
   * GUI 도 같은 빌더를 지난다 (`putPassthroughListenerPatch`). 화면이 두 폴백을 **따로**
   * 낼 수 있어야 §12.1 의 *"GUI 는 맨 뒤로 미루지 않는다"* 가 이 기능에도 성립한다.
   */
  it('두 폴백을 서로 다른 풀로 낼 수 있다 — 화면이 칸을 둘 두는 이유다', () => {
    const [op] = putPassthroughListenerPatch('pt', {
      bind: '0.0.0.0', port: 8443, pool: 'unmatched', noSniPool: 'nosni',
    });
    expect(op!.body.onUnmatchedSni).toEqual({ pool: 'unmatched' });
    expect(op!.body.onNoSni).toEqual({ pool: 'nosni' });
  });

  it('한쪽만 골라도 된다 — 다른 쪽은 끊는다', () => {
    const [only] = putPassthroughListenerPatch('pt', {
      bind: '0.0.0.0', port: 8443, noSniPool: 'nosni',
    });
    expect(only!.body.onUnmatchedSni).toBeUndefined();
    expect(only!.body.onNoSni).toEqual({ pool: 'nosni' });
  });
});
