<script lang="ts">
  /**
   * TLS 상세의 개요 탭 — 콘솔 시안 `tOv` 블록: `ovRows`(열 이름 + 그 행의 칸 글)를 격자(`OverviewGrid`, 최소 220px)로 놓는다.
   * 인증서는 디자인 시스템 §5 「상세 페이지 패턴」 의 주체 · SAN · 지문 칸을 더하고, ACME 인증서면 「ACME 주문」 상자를 끝에 둔다.
   * 값은 API 가 준 것만이다. 지문은 API 가 주지 않는다(「—」). SAN 은 자료에서 읽은 이름이다(도메인 칸은 설정의 이름).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import Acme from '#lib/detail/Acme.svelte';
  import OverviewGrid from '#lib/detail/OverviewGrid.svelte';
  import { COLS, cellsOf } from './tls-view.ts';

  let { kind }: { kind: keyof typeof COLS } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const row = $derived(kind === 'certificate' ? desk.certs.rows.find((r) => r.key === key) : undefined);
  const rows = $derived.by(() => {
    const cells = cellsOf(desk, kind, key);
    const base = COLS[kind].map((l, i) => ({ l, v: cells[i]?.t ?? '—', mono: cells[i]?.kind === 'mono' }));
    if (kind !== 'certificate' || item === undefined) return base;
    const subject = typeof item['subject'] === 'string' ? item['subject'].replace(/\n/g, ', ') : '—';
    const san = row?.hasMaterial === true && row.domains.length > 0 ? row.domains.join(', ') : '—';
    return [...base, { l: '주체', v: subject, mono: true }, { l: 'SAN', v: san, mono: true }, { l: '지문', v: '—', mono: true }];
  });
</script>

{#if item !== undefined}
  {#if kind === 'certificate'}<OverviewGrid {rows}><Acme /></OverviewGrid>{:else}<OverviewGrid {rows} />{/if}
{/if}
