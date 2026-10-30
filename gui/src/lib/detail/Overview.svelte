<script lang="ts">
  /** 개요 탭 — 사람이 먼저 보는 칸 · 상태 · 연결 수. 모든 칸은 설정 탭에 있다. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { detailOfListener } from '@web/listeners-view';
  import { itemOf, relationsOf, resourcePath, summaryOf, type ResourceKind } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { reasonLabels } from '@web/pools-view';
  import Acme from './Acme.svelte';
  import BackendHealth from './BackendHealth.svelte';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const lines = $derived(item === undefined ? [] : kind === 'listener' ? detailOfListener(item) : summaryOf(kind, item));
  const rel = $derived(relationsOf(desk.model, { kind, key }));
  /** 상태 한 줄 — 리소스마다 이미 받은 값에서 읽는다. 모르면 안 쓴다. */
  const state = $derived.by((): { text: string; tone: 'ok' | 'warn' | '' } | undefined => {
    if (kind === 'listener') {
      const row = desk.listeners.rows.find((r) => r.key === key && r.mark !== 'leave');
      if (row === undefined) return undefined;
      return row.mark === 'join' ? { text: '적용하면 열린다', tone: 'warn' } : { text: '서빙 중', tone: 'ok' };
    }
    if (kind === 'backend') {
      const h = desk.health.find((x) => x.backendKey === key)?.state ?? 'unknown';
      const t = desk.traffic.get(key);
      if (t !== undefined && !t.receivingTraffic) return { text: `트래픽 없음 — ${reasonLabels(t.reasons).join(' · ')}`, tone: 'warn' };
      return { text: `헬스 ${h}`, tone: h === 'healthy' ? 'ok' : h === 'unhealthy' ? 'warn' : '' };
    }
    if (kind === 'certificate') {
      const c = desk.certs.rows.find((r) => r.key === key);
      if (c === undefined) return undefined;
      if (!c.hasMaterial) return { text: '자료 없음 — HTTPS 에 못 쓴다', tone: 'warn' };
      return c.expiresInDays === undefined ? { text: '자료 있음', tone: 'ok' }
        : { text: `${c.expiresInDays}일 뒤 만료`, tone: c.expiresInDays < 30 ? 'warn' : 'ok' };
    }
    return undefined;
  });
</script>

{#if item !== undefined}
  {#if state !== undefined}<p class={state.tone === 'ok' ? 'd-ok' : state.tone === 'warn' ? 'd-warn' : 'd-note'}>{state.text}</p>{/if}
  <dl class="d-dl">
    {#each lines as line (line.label)}
      <dt>{line.label}</dt><dd>{line.value}</dd>
    {/each}
  </dl>
  <p class="d-note">
    이것이 쓰는 리소스 {rel.uses.length}개 · 이것을 쓰는 리소스 {rel.usedBy.length}개
    {#if rel.uses.some((u) => u.missing)}<span class="d-warn"> · 없는 대상을 가리킨다</span>{/if}
    {#if desk.model !== undefined}— <a class="d-link" href={resourcePath(kind, key, 'resources')}>연결된 리소스</a>{/if}
  </p>
  <!-- 시안: 백엔드의 헬스·트래픽 이유와 인증서의 ACME 주문은 개요에 있다. -->
  {#if kind === 'backend'}<h3 class="d-h3">헬스</h3><BackendHealth />{/if}
  {#if kind === 'certificate'}<h3 class="d-h3">ACME</h3><Acme />{/if}
{/if}
