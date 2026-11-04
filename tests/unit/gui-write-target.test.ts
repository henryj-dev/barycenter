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
    // 리스너 · 풀 · 백엔드 · 주소 집합의 설정 탭은 시안 `tSet` 틀(SettingsFrame) 하나가 「쓸 지역」 을 단다.
    'lib/detail/SettingsFrame.svelte',
    'lib/pool/PoolHealthForm.svelte',
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

  it('리스너 · 풀 · 백엔드 · 주소 집합의 설정 폼은 SettingsFrame 위에 있다', () => {
    for (const p of ['lib/listener/ListenerForm.svelte', 'lib/pool/PoolSettings.svelte', 'lib/detail/BackendSettings.svelte', 'lib/detail/AddressSetSettings.svelte']) {
      expect(src(p), p).toMatch(/<SettingsFrame kind="/);
    }
  });

  it('설정 탭은 JSON 만 있는 리소스에서 JsonEdit 에 target 을 넘긴다 — 폼이 여럿이면 첫 폼만', () => {
    expect(src('lib/detail/JsonEdit.svelte')).toMatch(/<Writable \{target\}>/);
    const s = src('lib/detail/Settings.svelte');
    expect(s).toMatch(/\{:else if writable\}\s*<JsonEdit \{kind\} target \/>/);
    expect(s.match(/<JsonEdit \{kind\} target/g)).toHaveLength(1);
    expect(src('lib/pool/PoolTlsForm.svelte')).not.toMatch(/<Writable target>/);
  });

  it('삭제 확인이 전역에서 지역을 단다 — 목록과 상세 머리가 같은 DeleteConfirm 을 쓴다', () => {
    const s = src('lib/lists/DeleteConfirm.svelte');
    expect(s).toMatch(/scope\?\.mode === 'global' && scope\.region !== undefined \? ` 지역: \$\{scope\.region\.name\}` : ''/);
    expect(s).toContain('sub={`저장하면 커밋해요. 트래픽은 적용해야 바뀌어요.${where}`}');
    expect(src('lib/detail/ResourceFrame.svelte')).toMatch(/<DeleteConfirm\b/);
  });
});

/**
 * **쓸 수 있는가는 한곳에서 판정한다** (#126 3단계 후속, 설계 재검토).
 *
 * 클러스터의 팔로워는 읽기를 답하지만 쓰기는 503 `not_leader` 로 막는다(`src/api/server.ts`).
 * GUI 는 그것을 몰라 버튼을 열어 두었고, 누르면 서버의 해라체 말이 그대로 보였다.
 * 이제 `scope.readOnly` 가 「전역에서 지역을 고르기 전」 과 「팔로워」 를 같이 보고,
 * `scope.blocked` 가 거기에 「고른 지역과 연락 없음」 을 더한다. 목록 · 폼 · 적용 · 롤백이 이것으로 닫힌다.
 */
describe('쓰기 판정 — 팔로워 · 연락 없음', () => {
  const scope = src('lib/global/scope.svelte.ts');

  it('readOnly 는 지역을 고르기 전이거나 팔로워다 · blocked 는 거기에 연락 없음을 더한다', () => {
    expect(scope).toContain("const isReadOnly = (): boolean => (mode === 'global' && region === undefined) || follower !== undefined;");
    expect(scope).toContain('get readOnly() { return isReadOnly(); }');
    expect(scope).toContain('get blocked() { return isReadOnly() || isLost(); }');
    // 지역을 다시 고르면 그 지역의 리더 여부를 새로 본다.
    expect(scope).toMatch(/choose\(r: RegionSummary \| undefined\) \{[^}]*follower = undefined;/);
  });

  it('팔로워 안내는 해요체 한 줄이고 리더 이름을 모르면 이름을 뺀다', () => {
    expect(scope).toContain("`이 노드는 팔로워예요. 수정은 리더${leader === undefined ? '' : `(${leader})`}에서 해요.`");
  });

  it('안전망: 503 not_leader 의 말을 팔로워 안내로 바꾼다 — 지역 인스턴스에서도, 전역 중계에서도', () => {
    expect(scope).toContain("if (body['code'] !== 'not_leader') return r;");
    expect(scope).toContain('message: followerMessage(follower.leader)');
    expect(scope).toContain("if (mode !== 'global' || r0 === undefined) return leaderSafe(await f(input, init));");
    expect(scope).toContain('if (r.status === 503) return leaderSafe(r);');
  });

  it('셸은 상태 스냅샷을 받은 뒤에만 팔로워로 판정하고, 리더 이름 · 주소는 cluster/nodes 에서 읽는다', () => {
    const layout = src('routes/+layout.svelte');
    expect(layout).toContain('const standby = $derived(desk.live && desk.head !== undefined && !desk.status.leader.isLeader);');
    expect(layout).toContain('desk.clusterNodes().then');
    expect(layout).toContain('scope.follow({ ...(leader === undefined');
  });

  // 2026-11-04 결정(전역 = 전체 합산, design-global-mode §2.5): 지역을 안 골랐으면 「읽기만」 이 아니라 합산이다.
  // 지역 하나에 쓰는 자리(폼 · 적용)만 「지역을 골라 좁혀 보면 써요」 라고 한다. 합산 목록은 행마다 그 지역에 쓴다.
  it('WriteNote 가 까닭을 말한다 — 전체 합산 · 연락 없음 · 팔로워(리더에서 열기 ↗)', () => {
    const n = src('lib/global/WriteNote.svelte');
    expect(n).not.toContain('지역을 고르기 전에는 읽기만 해요.');
    expect(n).toContain('전체 합산에서는 여기서 쓰지 않아요. 지역을 골라 좁혀 보면 그 지역에 써요.');
    expect(n).toContain('{LOST_MESSAGE}');
    expect(n).toContain('{followerMessage(scope.follower.leader)}');
    expect(n).toContain('리더에서 열기 ↗');
    expect(src('lib/global/Writable.svelte')).toMatch(/\{#if scope\?\.blocked === true\}\s*<div class="elsewhere"><WriteNote \/><\/div>/);
  });

  it.each(['AddressSetList', 'BackendList', 'CertificateList', 'HttpRouteList', 'ListenerList', 'PassthroughRouteList', 'PoolList', 'SniBindingList', 'TlsPolicyList'])(
    '목록 %s 은 blocked 로 만들기 · 수정 · 삭제를 닫고 까닭을 보인다', (f) => {
      const s = src(`lib/lists/${f}.svelte`);
      expect(s).toContain('const ro = $derived(scope?.blocked === true);');
      expect(s).toContain('<WriteNote spaced />');
    });

  it('상세 틀 · 목록 옆 상세도 blocked 로 닫는다 — 목록 옆 상세는 합산이면 그 행의 지역으로 판정한다', () => {
    expect(src('lib/detail/ResourceFrame.svelte')).toContain('const ro = $derived(scope?.blocked === true);');
    expect(src('lib/detail/ListSplit.svelte')).toContain('const ro = $derived(agg.on ? entry?.writable !== true : scope?.blocked === true);');
  });

  it('적용 · 롤백은 읽기 전용이면 까닭(WriteNote)을 보이고, 「전역 화면은 읽기만 해요」 라고 하지 않는다', () => {
    const p = src('lib/ops/PendingImpact.svelte');
    expect(p.match(/<WriteNote \/>/g)).toHaveLength(2);
    expect(p).not.toContain('전역 화면은 읽기만 해요');
    expect(src('lib/ops/RevisionRollback.svelte')).toContain('<div class="foot"><WriteNote /></div>');
  });
});

describe('전역 문구 · 지역 상자', () => {
  it('연락 없는 지역의 이름은 어디서나 「연락 없음」 하나다', () => {
    // 순수 모듈(합산 알림도 쓴다)에 두고 scope 가 다시 내보낸다.
    expect(src('lib/global/aggregate.ts')).toContain("export const LOST_LABEL = '연락 없음';");
    expect(src('lib/global/scope.svelte.ts')).toContain("export { LOST_LABEL } from './aggregate.ts';");
    for (const p of ['routes/regions/+page.svelte', 'lib/ops/PendingImpact.svelte', 'lib/ops/Dashboard.svelte', 'routes/+layout.svelte']) {
      const s = src(p);
      expect(s, p).toContain('LOST_LABEL');
      expect(s, p).not.toContain('연결 안 됨');
      expect(s, p).not.toContain('모름 — 닿지 않아요');
    }
  });

  // 2026-11-04 결정: 지역을 안 골랐으면 전체 합산이다 — 「◎ 전역 · 전체 합산」 줄이 지역 줄 위에 있고, 읽기 전용이라고 하지 않는다.
  it('사이드바는 「◎ 전역 · 전체 합산」 줄과 지역마다 한 줄을 그리고, 합산의 쓰기를 말한다 · 접으면 작은 상자', () => {
    const sb = src('lib/shell/Sidebar.svelte');
    expect(sb).not.toContain('전역 화면은 읽기만 해요');
    expect(sb).not.toContain('지역을 고르기 전에는 읽기만 해요.');
    expect(sb).toContain("{aggregate ? '행을 고치면 그 행의 지역에 써요. 만들 때는 지역을 골라요.' : '고른 지역에 바로 써요.'}");
    expect(sb).toMatch(/<span class="rn">전역<\/span><span class="rv">전체 합산<\/span>[\s\S]*\{#each regions as r \(r\.name\)\}/);
    expect(sb).toContain("onclick={() => { if (!aggregate) onwiden?.(); }}");
    expect(sb).toContain('지역 · {regions.length}곳');
    expect(sb).toContain('{#each regions as r (r.name)}');
    expect(sb).toMatch(/\{:else if global && regionHref\}\s*<div class="regions mini">/);
    const layout = src('routes/+layout.svelte');
    expect(layout).toContain('regions={sideRegions} chosen={scope.region?.name} onpick={pickRegion} onwiden={widen}');
    expect(layout).toContain("text: pending > 0 ? `대기 ${pending}` : ''");
  });
});
