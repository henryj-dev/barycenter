<script lang="ts">
  /**
   * TLS 상세의 연결된 리소스 탭 — 콘솔 시안 `tRel` 블록: 테두리 상자 안에 줄마다 종류(100px, 흐림) · 이름(고정폭) · 설명(흐림).
   * 줄은 `relationsOf`(이것이 쓰는 것 + 이것을 쓰는 것)에서 온다. 설명은 시안 `relExtra` 문구:
   *   · 인증서 — 리스너 「기본 인증서」 · SNI 바인딩 「호스트 N개」 · 풀 「업스트림 CA」
   *   · TLS 정책 — 리스너 「TLS 정책으로 사용」
   *   · SNI 바인딩 — 리스너 「이 바인딩이 속한 리스너」 · 인증서 「호스트에 연결한 인증서」
   * 시안에 없는 기존 동작: 이름을 누르면 그 상세로 간다(같은 글 모양) · head 에 없는 대상은 위험 색으로 「head 에 없어요」.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, itemOf, relationsOf, resourcePath, type Edge, type ResourceKind } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { sniHosts, type COLS } from './tls-view.ts';

  type Row = { id: string; kind: ResourceKind; key: string; note: string; missing: boolean };
  let { kind }: { kind: keyof typeof COLS } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const rel = $derived(relationsOf(desk.model, { kind, key }));

  const usedNote = (e: Edge): string => {
    if (kind === 'tlsPolicy') return 'TLS 정책으로 사용';
    if (e.from.kind === 'sniBinding') {
      const s = itemOf(desk.model, 'sniBinding', e.from.key);
      return `호스트 ${s === undefined ? 0 : sniHosts(s).length}개`;
    }
    return e.via;
  };
  const usesNote = (e: Edge): string =>
    (e.to.kind === 'listener' ? '이 바인딩이 속한 리스너' : e.to.kind === 'certificate' ? '호스트에 연결한 인증서' : e.via);
  const rows = $derived<Row[]>([
    ...rel.uses.map((e) => ({ id: `u:${e.via}:${e.to.kind}:${e.to.key}`, kind: e.to.kind, key: e.to.key, note: usesNote(e), missing: e.missing })),
    ...rel.usedBy.map((e) => ({ id: `b:${e.via}:${e.from.kind}:${e.from.key}`, kind: e.from.kind, key: e.from.key, note: usedNote(e), missing: false })),
  ]);
</script>

<div class="rel">
  {#each rows as r (r.id)}
    <div class="rl">
      <span class="k">{RESOURCES[r.kind].label}</span>
      {#if r.missing}<span class="n miss">{r.key} — head 에 없어요</span>{:else}<a class="n" href={resourcePath(r.kind, r.key)}>{r.key}</a>{/if}
      <span class="k">{r.note}</span>
    </div>
  {:else}
    <div class="rl none">연결된 리소스가 없어요.</div>
  {/each}
</div>

<style>
  /* 값은 콘솔 시안 `tRel` 블록의 인라인 style 그대로다. */
  .rel { display: flex; flex-direction: column; border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; font-size: 13px; }
  .rl { display: grid; grid-template-columns: 100px 1fr 1fr; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--bd); }
  .rl.none { display: block; color: var(--tx3); }
  .k { color: var(--tx3); }
  .n { font-family: var(--mono); color: var(--tx); text-decoration: none; overflow-wrap: anywhere; }
  a.n:hover { color: var(--accent); text-decoration: underline; }
  .miss { color: var(--danger); }
</style>
