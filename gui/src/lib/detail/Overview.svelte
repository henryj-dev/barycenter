<script lang="ts">
  /** 개요 탭 — 사람이 먼저 보는 칸 · 상태 · 연결 수. 모든 칸은 설정 탭에 있다. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { detailOfListener } from '@web/listeners-view';
  import { itemOf, relationsOf, resourcePath, summaryOf, type ResourceKind } from '@web/resources';
  import { reasonLabels } from '@web/pools-view';
  import { Badge, Card, DescriptionList, type Tone } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import Acme from './Acme.svelte';
  import BackendHealth from './BackendHealth.svelte';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const lines = $derived(item === undefined ? [] : kind === 'listener' ? detailOfListener(item) : summaryOf(kind, item));
  const rel = $derived(relationsOf(desk.model, { kind, key }));
  /** 상태 한 줄 — 리소스마다 이미 받은 값에서 읽는다. 모르면 안 쓴다. */
  const state = $derived.by((): { text: string; tone: Tone; icon?: string } | undefined => {
    if (kind === 'listener') {
      const row = desk.listeners.rows.find((r) => r.key === key && r.mark !== 'leave');
      if (row === undefined) return undefined;
      return row.mark === 'join' ? { text: '적용하면 열려요', tone: 'pending' } : { text: '서빙 중', tone: 'ok' };
    }
    if (kind === 'backend') {
      const h = desk.health.find((x) => x.backendKey === key)?.state ?? 'unknown';
      const t = desk.traffic.get(key);
      if (t !== undefined && !t.receivingTraffic) return { text: `트래픽 없음 — ${reasonLabels(t.reasons).join(' · ')}`, tone: 'warn' };
      return h === 'healthy' ? { text: '정상', tone: 'ok' } : h === 'unhealthy' ? { text: '비정상', tone: 'danger' } : { text: '관측 없음', tone: 'neutral' };
    }
    if (kind === 'certificate') {
      const c = desk.certs.rows.find((r) => r.key === key);
      if (c === undefined) return undefined;
      if (!c.hasMaterial && c.acme) return { text: `발급 대기${c.orderState ? ` · 주문 ${c.orderState}` : ''} — 발급되면 HTTPS 에 걸 수 있어요`, tone: 'pending' };
      if (!c.hasMaterial) return { text: '자료 없음 — HTTPS 에 못 써요', tone: 'danger' };
      if (c.expiresInDays === undefined) return { text: '자료 있음', tone: 'ok' };
      if (c.expiresInDays < 0) return { text: '만료됨', tone: 'danger' };
      return { text: `${c.expiresInDays}일 뒤 만료`, tone: c.expiresInDays < 30 ? 'warn' : 'ok' };
    }
    return undefined;
  });
  const missing = $derived(rel.uses.some((u) => u.missing));
</script>

{#if item !== undefined}
  <div class="ov">
    {#if state !== undefined}<div><Badge tone={state.tone} icon={state.icon}>{state.text}</Badge></div>{/if}
    <Card title="요약">
      <DescriptionList labelWidth="160px" items={lines.map((l) => ({ label: l.label, value: l.value, mono: true }))} />
    </Card>
    <Card title="연결">
      <p class="rel">
        이것이 쓰는 리소스 <b>{rel.uses.length}</b>개 · 이것을 쓰는 리소스 <b>{rel.usedBy.length}</b>개
        {#if missing}<Badge tone="danger">없는 대상을 가리켜요</Badge>{/if}
        {#if desk.model !== undefined}<a href={resourcePath(kind, key, 'resources')}>연결된 리소스 보기 →</a>{/if}
      </p>
    </Card>
    <!-- 시안: 백엔드의 헬스·트래픽 이유와 인증서의 ACME 주문은 개요에 있다. -->
    {#if kind === 'backend'}<Card title="헬스"><BackendHealth /></Card>{/if}
    {#if kind === 'certificate'}<Card title="ACME"><Acme /></Card>{/if}
  </div>
{/if}

<style>
  .ov { display: flex; flex-direction: column; gap: 16px; max-width: 860px; }
  .rel { margin: 0; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font: var(--t-body); color: var(--tx2); }
  .rel b { color: var(--tx); font-family: var(--mono); }
  .rel a { color: var(--accent); font: var(--t-small); margin-left: auto; }
</style>
