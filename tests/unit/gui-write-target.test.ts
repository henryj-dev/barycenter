/**
 * **전역에서 쓰는 자리는 쓸 지역을 보인다** (#126 3단계 후속).
 *
 * 전역 모드에서 쓰기는 고른 지역으로 간다(`src/global/relay.ts`). 만들기 · 수정 · 삭제 자리는
 * 그 지역 이름을 보여야 한다. 폼은 `Writable target` 으로 「쓸 지역」 한 줄을 달고,
 * 삭제 확인은 적용 · 롤백 확인처럼 문구 끝에 ` 지역: <이름>` 을 단다.
 * 지역 인스턴스에서는 아무것도 안 바뀐다 — `Writable` 은 전역일 때만 그 줄을 그린다.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = (p: string): string => readFileSync(new URL(`../../gui/src/${p}`, import.meta.url), 'utf8');

describe('쓸 지역 표시', () => {
  it('Writable 은 전역에서 지역을 골랐을 때만 「쓸 지역」 줄을 그린다', () => {
    const w = src('lib/global/Writable.svelte');
    expect(w).toMatch(/scope\?\.mode === 'global' \? scope\.region : undefined/);
    expect(w).toMatch(/\{#if target && region !== undefined\}/);
    expect(w).toContain('쓸 지역 <code>{region.name}</code> <a href="/regions">다른 지역 고르기</a>');
  });

  it.each([
    'lib/forms/CreateForm.svelte',
    'lib/listener/ListenerForm.svelte',
    'lib/pool/PoolHealthForm.svelte',
    'lib/detail/BackendSettings.svelte',
    'lib/detail/AddressSetSettings.svelte',
    'lib/detail/Rebuild.svelte',
    'lib/detail/BackendHealth.svelte',
    'lib/detail/Acme.svelte',
  ])('%s 의 쓰는 폼이 target 을 켠다', (p) => {
    expect(src(p)).toMatch(/<Writable target>/);
  });

  it('만들기 화면은 모두 CreateForm 을 거친다 — 빠른 프록시 · 라우트 그룹 포함', () => {
    for (const f of ['QuickProxyForm', 'RouteGroupForm', 'HttpListenerForm', 'TcpListenerForm', 'UdpListenerForm', 'PassthroughListenerForm',
      'PoolForm', 'BackendForm', 'AddressSetForm', 'HttpRouteForm', 'PassthroughRouteForm', 'CertificateForm', 'TlsPolicyForm', 'SniBindingForm']) {
      expect(src(`lib/forms/${f}.svelte`), f).toContain('<CreateForm');
    }
  });

  it('설정 탭은 JSON 만 있는 리소스에서 JsonEdit 에 target 을 넘긴다 — 폼이 여럿이면 첫 폼만', () => {
    expect(src('lib/detail/JsonEdit.svelte')).toMatch(/<Writable \{target\}>/);
    const s = src('lib/detail/Settings.svelte');
    expect(s).toMatch(/\{:else if writable\}\s*<JsonEdit \{kind\} target \/>/);
    expect(s.match(/<JsonEdit \{kind\} target/g)).toHaveLength(1);
    expect(src('lib/pool/PoolTlsForm.svelte')).not.toMatch(/<Writable target>/);
  });

  it.each(['lib/lists/DeleteConfirm.svelte', 'lib/detail/ResourceFrame.svelte'])('%s 의 삭제 확인이 전역에서 지역을 단다', (p) => {
    const s = src(p);
    expect(s).toMatch(/scope\?\.mode === 'global' && scope\.region !== undefined \? ` 지역: \$\{scope\.region\.name\}` : ''/);
    expect(s).toContain('sub={`저장하면 커밋해요. 트래픽은 적용해야 바뀌어요.${where}`}');
  });
});
