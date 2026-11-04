<script lang="ts">
  /**
   * TLS 상세의 틀 — `ResourceFrame` 에 시안 값을 넘긴다.
   *   · 제목 옆 배지: 콘솔 시안 `dpBadge` — 그 행의 첫 배지 칸(인증서는 「▲ 2026-11-10 (12일 전)」 · 「✕ … (만료됨)」, 넉넉하면 없다).
   *   · 메타 줄(인증서만, 디자인 시스템 §5): 「발급자 ACME · 만료 2026-11-10 · 사용처 리스너 2 · SNI 3」.
   *   · 버튼(인증서): 업로드는 「자료를 교체해요」(§5) · ACME 는 「수정」(설정 탭, 콘솔 `dpEdit`) — ACME 자료는 스케줄러가 바꾼다.
   *     그 뒤 「삭제…」 는 틀이 그린다.
   */
  import { getContext, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { resourcePath } from '@web/resources';
  import { Button } from '#lib/ui';
  import ResourceFrame from '#lib/detail/ResourceFrame.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { cellsOf, certExp, certIssuer, certUsage, type COLS } from './tls-view.ts';

  let { kind, children }: { kind: keyof typeof COLS; children: Snippet } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const badge = $derived(cellsOf(desk, kind, key).find((c) => c.kind === 'badge'));
  const mark = $derived(badge?.kind === 'badge' ? { tone: badge.tone, icon: badge.icon, text: badge.t } : undefined);
  const cert = $derived(kind === 'certificate' ? desk.certs.rows.find((r) => r.key === key) : undefined);
  const meta = $derived(cert === undefined ? [] : [
    { label: '발급자', value: certIssuer(cert) },
    { label: '만료', value: certExp(cert) || '—', mono: true },
    { label: '사용처', value: certUsage(desk, key) },
  ]);
  const onSettings = $derived(page.url.pathname.replace(/\/$/, '').endsWith('/settings'));
</script>

{#snippet certEdit()}
  {#if cert !== undefined && !cert.acme}
    <Button href={`/tls/certificate/new?key=${encodeURIComponent(key)}&issuer=upload`}>자료를 교체해요</Button>
  {:else if !onSettings}
    <Button href={resourcePath('certificate', key, 'settings')}>수정</Button>
  {/if}
{/snippet}

<ResourceFrame {kind} {meta} {mark} edit={kind === 'certificate' ? certEdit : undefined}>{@render children()}</ResourceFrame>
