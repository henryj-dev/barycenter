<script lang="ts">
  /**
   * 적용 대기 — 커밋됐지만 트래픽에 아직 안 걸린 plan 의 영향 (시안 §8 영향 요약 카드).
   *
   * **끊기는 것을 먼저 쓴다:** 닫히는 소켓 · 기존 세션 · 라우트 순서 경고 · 엔진 경고. 열리는 소켓도 바뀌는
   * 것이라 같이 둔다. 평면 · 리스너 · 인증서처럼 「어디에 걸리나」 는 접어 둔다.
   * 전역 모드면 읽기만 한다 — 적용 버튼을 안 그린다(설계 §1).
   */
  import { getContext } from 'svelte';
  import { Button, FieldMessage, ImpactCard, type ImpactLine } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  const view = $derived(desk.view);

  const breaking = $derived<ImpactLine[]>(view === undefined ? [] : [
    // 롤백 plan 은 영향을 재지 않았다 — 「없다」 가 아니다.
    ...(view.rollbackOf === undefined ? [] : [{
      tone: 'warn' as const, icon: '▲',
      text: `롤백은 영향을 미리 재지 않아요. 소켓이 열리거나 닫히고 세션이 끊길 수 있어요. 기록 화면에서 r${view.rollbackOf} 와 지금의 차이를 먼저 봐요.`,
    }]),
    ...view.socketsRemoved.map((s) => ({ tone: 'danger' as const, icon: '✕', text: `소켓을 닫아요: ${s}` })),
    ...view.sessions.map((s) => ({ tone: 'warn' as const, icon: '▲', text: s })),
    ...view.routeWarnings.map((s) => ({ tone: 'warn' as const, icon: '▲', text: `라우트 순서 — ${s}` })),
    ...view.capabilityWarnings.map((s) => ({ tone: 'warn' as const, icon: '▲', text: `엔진 — ${s}` })),
    ...view.socketsAdded.map((s) => ({ tone: 'ok' as const, icon: '＋', text: `소켓을 열어요: ${s}` })),
  ]);
  const quiet = $derived(view === undefined || view.rollbackOf !== undefined ? [] : [
    `평면: ${view.planes.join(', ') || '—'}`,
    `리스너: ${view.listeners.join(' · ') || '—'}`,
    ...(view.certificates.length > 0 ? [`인증서: ${view.certificates.join(' · ')}`] : []),
  ]);
</script>

{#if view !== undefined}
  <ImpactCard tone={view.requiresReload ? 'warn' : 'ok'} title={view.headline} {breaking} {quiet} quietLabel="어디에 걸리나 · 평면 · 리스너 · 인증서">
    {#snippet sub()}plan <code>{view.planId}</code> → r{view.revision}{#if view.rollbackOf === undefined && view.socketsAdded.length === 0 && view.socketsRemoved.length === 0} · 소켓 변화 없음{/if}{/snippet}
    {#snippet footer()}
      {#if !ro}
        <Button variant="primary" loading={desk.applying} onclick={() => { void desk.apply(); }}>{desk.applying ? '적용하는 중' : '적용해요'}</Button>
        <FieldMessage>적용하면 트래픽이 바뀌어요.</FieldMessage>
      {:else}
        <FieldMessage>전역 화면은 읽기만 해요. 적용은 그 지역의 GUI 에서 해요.</FieldMessage>
      {/if}
    {/snippet}
  </ImpactCard>
{:else if desk.live}
  <FieldMessage>커밋했지만 적용하지 않은 plan 이 없어요. 리소스를 저장하거나 <code>bary import</code> 를 하면 여기 와요.</FieldMessage>
{/if}

<style>
  code { font-family: var(--mono); font-size: 12px; }
</style>
