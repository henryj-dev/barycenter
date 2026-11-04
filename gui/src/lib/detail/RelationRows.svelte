<script lang="ts">
  /**
   * 연결된 리소스 탭(리스너 · 풀 · 백엔드 · 주소 집합) — 콘솔 시안 `tRel` · `relRows` 그대로.
   * 한 줄에 종류(100px, 흐린색) · 이름(고정폭) · 설명(흐린색). 풀은 아래에 「소속 백엔드 · N」 표(시안 `subTabD`)를 더 둔다.
   *
   * 줄은 head 모델의 참조(`relationsOf`)에서 만든다 — 이것이 쓰는 것과 이것을 쓰는 것을 한 목록으로, 설명은 시안 말
   * (「기본 풀」 · 「이 리스너에 연결」 · 「기본 풀로 사용」 · 「출발지 제한에 사용」 …). 풀 · 백엔드는 시안처럼 「헬스체크 · 풀 설정」 줄을 단다.
   * 시안의 「라우트 · N개」 는 라우트를 한 줄씩 늘어놓는다 — 이름을 누르면 그 상세로 간다(있던 동작). 없는 대상은 그렇게 말한다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, itemsOf, relationsOf, resourcePath, type ResourceKind } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { DRAIN_MARK, HEALTH_MARK, backendDraining, backendHealth, hcText } from './facts';

  type Row = { k: string; n: string; note: string; href?: string; missing?: boolean };
  let { kind }: { kind: 'listener' | 'pool' | 'backend' | 'addressSet' } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');

  /** 시안의 종류 이름 — 라우트는 HTTP · 패스스루를 가리지 않고 「라우트」 다. */
  const KIND: Record<ResourceKind, string> = {
    listener: '리스너', httpRoute: '라우트', passthroughRoute: '라우트', pool: '풀', backend: '백엔드', addressSet: '주소 집합',
    certificate: '인증서', tlsPolicy: 'TLS 정책', sniBinding: 'SNI 바인딩',
  };
  /** 이것이 쓰는 것의 설명 — 참조한 자리(시안: 「기본 풀」 · 「기본 인증서」 · 「소속 풀」). */
  const usesNote = (via: string): string => ({
    '기본 동작': '기본 풀', '기본 풀': '기본 풀', 'SNI 매칭 없음': 'SNI 매칭 없음 폴백', 'SNI 없음': 'SNI 없음 폴백',
    'PROXY 수신': '신뢰 대역', '원본 IP 헤더': '신뢰 대역', '풀': '소속 풀',
  }[via] ?? via);
  /** 이것을 쓰는 것의 설명 — 시안: 「이 리스너에 연결」 · 「기본 풀로 사용」 · 「이 풀로 전달」 · 「출발지 제한에 사용」. */
  const usedNote = (via: string, from: ResourceKind): string => {
    if (kind === 'listener') return from === 'sniBinding' ? '이 리스너의 SNI 바인딩' : '이 리스너에 연결';
    if (kind === 'pool') {
      return ({ '기본 동작': '기본 풀로 사용', '기본 풀': '기본 풀로 사용', 'SNI 매칭 없음': 'SNI 폴백으로 사용', 'SNI 없음': 'SNI 폴백으로 사용',
        '프록시': '이 풀로 전달', '출발지 규칙': '출발지 규칙으로 전달' } as Record<string, string>)[via] ?? via;
    }
    if (kind === 'addressSet') return via === '출발지 제한' ? '출발지 제한에 사용' : via === '출발지 규칙' ? '출발지 규칙에 사용' : '신뢰 대역에 사용';
    return via;
  };

  const rows = $derived.by((): Row[] => {
    const rel = relationsOf(desk.model, { kind, key });
    const out: Row[] = [];
    const seen = new Set<string>();
    const push = (r: Row): void => { const id = `${r.k}/${r.n}/${r.note}`; if (!seen.has(id)) { seen.add(id); out.push(r); } };
    for (const e of rel.uses) {
      push({ k: KIND[e.to.kind], n: e.to.key, note: usesNote(e.via), ...(e.missing ? { missing: true } : { href: resourcePath(e.to.kind, e.to.key) }) });
    }
    for (const e of rel.usedBy) {
      if (kind === 'pool' && e.from.kind === 'backend') continue; // 아래 「소속 백엔드」 표가 말한다(시안).
      push({ k: KIND[e.from.kind], n: e.from.key, note: usedNote(e.via, e.from.kind), href: resourcePath(e.from.kind, e.from.key) });
    }
    if (kind === 'backend') {
      const pool = String(itemOf(desk.model, 'backend', key)?.['pool'] ?? '');
      for (const e of relationsOf(desk.model, { kind: 'pool', key: pool }).usedBy.filter((x) => x.from.kind === 'listener')) {
        push({ k: '리스너', n: e.from.key, note: '이 풀을 쓰는 리스너', href: resourcePath('listener', e.from.key) });
      }
      const p = itemOf(desk.model, 'pool', pool);
      if (p !== undefined) push({ k: '헬스체크', n: hcText(p), note: '풀 설정' });
    }
    if (kind === 'pool') {
      const p = itemOf(desk.model, 'pool', key);
      if (p !== undefined) push({ k: '헬스체크', n: hcText(p), note: '풀 설정' });
    }
    return out;
  });
  const members = $derived(kind !== 'pool' ? [] : itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key).map((b) => {
    const k = String(b['key']);
    return { n: k, hp: `${String(b['host'])}:${String(b['port'])}`, w: String(b['weight'] ?? 1), m: backendDraining(desk, k) ? DRAIN_MARK : HEALTH_MARK[backendHealth(desk, k)] };
  }));
</script>

<div class="rel">
  {#each rows as r (`${r.k}/${r.n}/${r.note}`)}
    <div class="row">
      <span class="k">{r.k}</span>
      {#if r.href !== undefined}<a class="n" href={r.href}>{r.n}</a>{:else}<span class="n">{r.n}{#if r.missing} <span class="miss">— head 에 없어요</span>{/if}</span>{/if}
      <span class="note">{r.note}</span>
    </div>
  {/each}
  {#if rows.length === 0}<div class="row"><span class="none">연결된 리소스가 없어요.</span></div>{/if}
</div>

{#if kind === 'pool'}
  <div class="sub">
    <div class="st">소속 백엔드 · {members.length}</div>
    <div class="tbl">
      <div class="tr th"><span>이름</span><span>호스트:포트</span><span>가중치</span><span>헬스</span></div>
      {#each members as b (b.n)}
        <div class="tr">
          <a class="mono lnk" href={resourcePath('backend', b.n)}>{b.n}</a><span class="mono">{b.hp}</span><span class="mono">{b.w}</span>
          <span><span class="bdg" style:background="var(--{b.m.tone}-bg)" style:color="var(--{b.m.tone})">{b.m.icon} {b.m.text}</span></span>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* 값은 시안 `tRel` · `subTabD` 블록의 인라인 style 그대로다. */
  .rel { display: flex; flex-direction: column; border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; font-size: 13px; }
  .row { display: grid; grid-template-columns: 100px 1fr 1fr; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--bd); }
  .k, .note, .none { color: var(--tx3); }
  .none { grid-column: 1 / -1; }
  .n { font-family: var(--mono); color: var(--tx); text-decoration: none; overflow-wrap: anywhere; }
  a.n:hover, .lnk:hover { text-decoration: underline; }
  .miss { font-family: var(--font); color: var(--danger); }
  .sub { display: flex; flex-direction: column; margin-top: 14px; }
  .st { font-size: 12px; font-weight: 600; color: var(--tx2); margin-bottom: 6px; }
  .tbl { border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; font-size: 13px; }
  .tr { display: grid; grid-template-columns: 1fr 1.4fr .6fr 1.2fr; gap: 12px; padding: 0 12px; height: var(--row-h); align-items: center; border-top: 1px solid var(--bd); }
  .tr.th { height: 28px; background: var(--bg-hover); font-size: 12px; font-weight: 600; color: var(--tx2); border-top: 0; }
  .mono { font-family: var(--mono); }
  .lnk { color: var(--tx); text-decoration: none; }
  .bdg { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: var(--r-sm); font-size: 12px; font-weight: 500; }
</style>
