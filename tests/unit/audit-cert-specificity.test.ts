/**
 * 인증서 선택이 **특정성**으로 갈린다 — 검수 2026-08-24 D14
 *
 * ── 바인딩 키의 알파벳 순서가 인증서를 정했다
 *
 * `certFor` 는 정렬된 바인딩을 훑어 **먼저 덮는 것**을 썼다. 그래서
 * `a.example.com` 을 정확일치 바인딩과 `*.example.com` 바인딩이 둘 다 덮고 인증서가
 * 다르면, 실제로 제시되는 인증서를 **바인딩 키의 알파벳 순서**가 정했다.
 *
 * `sni_binding_conflict` 는 *같은 호스트 문자열*이 두 인증서에 묶인 경우만 잡으므로 이
 * 조합은 통과한다. S17 이 겨눈 실패(커버하지 않는 인증서 제시)의 약한 판이다 — 둘 다
 * 덮기는 하지만 **운영자가 고른 쪽이 아닐 수 있다.**
 *
 * ── 왜 「겹치는 바인딩을 막는다」가 아닌가
 *
 * 그쪽이 이 저장소의 기본 취향(표현 불가능하게 만든다)이지만 여기서는 못 쓴다.
 * 막는 자리가 `validateModel` 인데 **`render()` 가 그것을 부르고, 롤백은 렌더를
 * 지난다** — 겹치는 바인딩이 든 옛 리비전이 렌더 불가가 되어 **롤백이 막힌다.**
 * `assertDirectiveStrings` 의 머리말이 같은 함정을 이미 적어 뒀다.
 *
 * ── 그래서 nginx 와 같은 순서로 고른다
 *
 * `server_name` 의 우선순위가 그대로다: **정확일치 → 긴 와일드카드 → 짧은 와일드카드.**
 * 설명할 것이 없다는 것이 이 안의 값이다. 그리고 기존 설정이 안 깨진다 — 겹치지 않는
 * 배포에서는 고르는 결과가 그대로다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const VERSION = 'a'.repeat(32);

const CERT = (key: string): Model['certificates'][number] => ({
  key,
  materialRef: `store://${key}@${VERSION}`,
  chainDigest: `sha256:${'c'.repeat(64)}`,
  keyDigest: `sha256:${'k'.repeat(64)}`,
} as Model['certificates'][number]);

/**
 * 바인딩 셋을 주고 그 호스트의 server 블록이 어느 인증서를 물었는지 본다.
 *
 * **키 이름을 일부러 어긋나게 준다** — 알파벳 순서로 고르면 `z-exact` 가 지고
 * `a-wild` 가 이긴다. 특정성으로 고르면 반대다.
 */
function chosenFor(
  bindings: { key: string; hosts: string[]; certificate: string }[],
  host = 'a.example.com',
): string {
  const certKeys = [...new Set([...bindings.map((b) => b.certificate), 'fallback'])];
  const model: Model = {
    listeners: [{
      key: 'web', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
      // **기본 인증서는 아무 바인딩도 아니다.** 이 테스트가 재는 것은 바인딩 사이의
      // 선택이므로, 기본값이 답이 되면 아무것도 안 잰다.
      tls: { policy: 'default', defaultCertificate: 'fallback' },
      http: { defaultAction: 'reject' },
    } as Model['listeners'][number]],
    httpRoutes: [{
      key: 'r', listener: 'web', hosts: [host], priority: 1,
      action: { kind: 'reject', status: 403 },
    } as Model['httpRoutes'][number]],
    passthroughRoutes: [],
    pools: [], backends: [],
    certificates: certKeys.map(CERT),
    tlsPolicies: [{ key: 'default', minVersion: '1.2' } as Model['tlsPolicies'][number]],
    sniBindings: bindings.map((b) => ({
      key: b.key, listener: 'web', hosts: b.hosts, certificate: b.certificate,
    } as Model['sniBindings'][number])),
  };
  const conf = render(model, { streamRealip: false }).conf;
  const block = conf.split('server {').find((b) => b.includes(`server_name ${host};`));
  expect(block, `'${host}' server 블록이 없다:\n${conf}`).toBeDefined();
  const m = /ssl_certificate\s+"?([^";\s]+)"?;/.exec(block!);
  expect(m, `ssl_certificate 가 없다:\n${block}`).not.toBeNull();
  // 경로가 `certs/<key>/<version>/fullchain.pem` 이다.
  return m![1]!.split('/')[1]!;
}

describe('인증서 선택', () => {
  /**
   * **이것이 D14 의 재현물이다.** 키 이름이 `a-wild` < `z-exact` 라, 알파벳 순서로
   * 고르면 와일드카드가 이긴다.
   */
  it('정확일치가 와일드카드를 이긴다 — 바인딩 키 순서가 아니라', () => {
    expect(chosenFor([
      { key: 'a-wild', hosts: ['*.example.com'], certificate: 'wild' },
      { key: 'z-exact', hosts: ['a.example.com'], certificate: 'exact' },
    ])).toBe('exact');
  });

  it('순서를 뒤집어도 같다 — 키 이름에 안 흔들린다', () => {
    expect(chosenFor([
      { key: 'a-exact', hosts: ['a.example.com'], certificate: 'exact' },
      { key: 'z-wild', hosts: ['*.example.com'], certificate: 'wild' },
    ])).toBe('exact');
  });

  /**
   * **긴 와일드카드가 짧은 것을 이긴다.** nginx 의 `server_name` 규칙 그대로다.
   */
  it('더 구체적인 와일드카드가 이긴다', () => {
    expect(chosenFor([
      { key: 'a-broad', hosts: ['*.example.com'], certificate: 'broad' },
      { key: 'z-narrow', hosts: ['*.sub.example.com'], certificate: 'narrow' },
    ], 'x.sub.example.com')).toBe('narrow');
  });

  /** 한 바인딩이 여러 호스트를 들면 **그중 제일 잘 맞는 것**으로 점수를 낸다. */
  it('바인딩이 호스트를 여럿 들어도 제일 잘 맞는 것으로 잰다', () => {
    expect(chosenFor([
      { key: 'a-wild', hosts: ['*.example.com', '*.other.net'], certificate: 'wild' },
      { key: 'z-multi', hosts: ['b.other.net', 'a.example.com'], certificate: 'exact' },
    ])).toBe('exact');
  });

  /** **겹치지 않으면 결과가 그대로다.** 안 겹치는 배포의 거동이 안 바뀐다. */
  it('겹치지 않으면 그대로 고른다 — 기존 설정이 안 깨진다', () => {
    expect(chosenFor([
      { key: 'only', hosts: ['*.example.com'], certificate: 'wild' },
    ])).toBe('wild');
  });

  /**
   * **완전히 같은 특정성은 애초에 저장이 안 된다.**
   *
   * `sni_binding_conflict` 가 *같은 호스트 문자열*이 두 인증서에 묶인 것을 막는다 —
   * 그래서 「동점이면 무엇으로 가르나」는 **도달 불가한 물음**이다. 여기서 tie-break
   * 규칙을 발명하면 도달 못 하는 방어를 하나 더 만드는 셈이고, 이 저장소는 그것을
   * *"도달 불가한 방어는 방어가 아니라 죽은 코드"* 라고 부른다.
   *
   * 그 사실을 못 박아 둔다 — 나중에 검증기가 느슨해지면 여기가 먼저 빨개진다.
   */
  it('같은 호스트를 두 인증서에 묶는 것은 검증기가 막는다 — 동점이 안 생긴다', () => {
    expect(() => chosenFor([
      { key: 'b', hosts: ['a.example.com'], certificate: 'two' },
      { key: 'a', hosts: ['a.example.com'], certificate: 'one' },
    ])).toThrow(/sni_binding_conflict/);
  });
});
