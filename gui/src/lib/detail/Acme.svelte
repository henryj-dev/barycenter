<script lang="ts">
  /**
   * 인증서 개요의 「ACME 주문」 상자 — 콘솔 시안 `acmeD` 블록: 「계정 <b>default</b>」 · 「● 유효」 · 「마지막 갱신 … · HTTP-01 · 다음 시도 …」.
   * 값은 실제 API 것만 쓴다 — 주문(`/acme/orders`)에는 시각이 없다. 그래서 「마지막 갱신」 은 지금 자료의 발급 시각(notBefore),
   * 「다음 시도」 는 모른다(「—」).
   *
   * 시안에 없는 기존 표시(같은 상자 안 · 아래):
   *   · 마지막 주문이 실패했으면 이유(`lastError`)와 시도 횟수(`attempts`) — 「왜 아직 안 됐나」 를 물을 자리다.
   *   · 스테이징 CA 로 받은 인증서면 「운영 CA 로 바꾸기」(설정 탭의 ACME 계정으로 간다). 스테이징 인증서는 브라우저가 믿지 않는다.
   *   · 주문 기록(접힘) — 주문마다 상태 · 도메인 · 시도 · 마지막 오류.
   * 계정 바꾸기(「CA 바꾸기」)는 설정 탭의 「ACME 계정」 이 한다(`CertificateSettings`).
   */
  import { getContext, onMount } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, DataTable, Expander, type Column, type Tone } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import { isStaging } from '#lib/forms/AcmeAccountField.svelte';
  import { challengeOf } from '#lib/tls/cert-edit.ts';
  import type { AcmeAccountRow, createDesk } from '#lib/desk.svelte.ts';

  type Order = { id: string; state: string; domains: string[]; attempts: number; lastError: string | null };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'certificate', key));
  const acme = $derived(item?.['acme'] as { account?: string; domains?: string[] } | undefined);
  const row = $derived(desk.certs.rows.find((r) => r.key === key));
  const hasMaterial = $derived(typeof item?.['materialRef'] === 'string');

  let accounts = $state<AcmeAccountRow[] | undefined>();
  onMount(async () => { accounts = await desk.acmeAccounts(); });
  const current = $derived(accounts?.find((a) => a.key === acme?.account));
  const staging = $derived(current !== undefined && isStaging(current.directoryUrl));
  const orders = $derived<Order[]>(desk.acmeOrders.filter((o) => o['certificate'] === key).map((o) => ({
    id: String(o['id']),
    state: String(o['state']),
    domains: Array.isArray(o['domains']) ? (o['domains'] as string[]) : [],
    attempts: typeof o['attempts'] === 'number' ? o['attempts'] : 0,
    lastError: typeof o['lastError'] === 'string' ? o['lastError'] : null,
  })));
  type Mark = { tone: Tone; icon: string; text: string };
  const STATE: Record<string, Mark> = {
    pending: { tone: 'pending', icon: '◐', text: '대기' },
    validating: { tone: 'info', icon: '↻', text: '검증 중' },
    ready: { tone: 'info', icon: '↻', text: '발급 직전' },
    issued: { tone: 'ok', icon: '●', text: '유효' },
    failed: { tone: 'danger', icon: '✕', text: '실패' },
    abandoned: { tone: 'neutral', icon: '○', text: '그만둠' },
  };
  /** 주문 목록은 서버가 최근에 바뀐 것부터 준다(`AcmeStore.list` — updated_at DESC). 그래서 맨 앞이 마지막 주문이다. */
  const last = $derived(orders[0]);
  const expired = $derived((row?.expiresInDays ?? 0) < 0);
  const mark = $derived.by((): Mark => {
    if (last !== undefined && last.state !== 'issued') return STATE[last.state] ?? { tone: 'neutral', icon: '○', text: last.state };
    if (!hasMaterial) return { tone: 'pending', icon: '◐', text: '주문 전' };
    return expired ? { tone: 'danger', icon: '✕', text: '만료됨' } : STATE['issued']!;
  });
  const notBefore = $derived(typeof item?.['notBefore'] === 'string' ? item['notBefore'].slice(0, 10) : '—');
  const challenge = $derived(challengeOf(acme?.domains ?? []));
  let showOrders = $state(false);
  const columns: Column<Order>[] = [
    { key: 'state', label: '상태', width: '120px', sort: (r) => r.state },
    { key: 'domains', label: '도메인', mono: true, text: (r) => r.domains.join(', ') },
    { key: 'attempts', label: '시도', mono: true, align: 'right', width: '70px', text: (r) => String(r.attempts) },
    { key: 'err', label: '마지막 오류' },
    { key: 'id', label: '주문', mono: true, muted: true, hideable: true, hidden: true, text: (r) => r.id },
  ];
</script>

{#snippet cell(r: Order, c: Column<Order>)}
  {#if c.key === 'state'}
    {@const s = STATE[r.state] ?? { tone: 'neutral' as Tone, icon: '○', text: r.state }}<Badge tone={s.tone} icon={s.icon}>{s.text}</Badge>
  {:else if c.key === 'err'}
    {#if r.lastError !== null}<span class="err">{r.lastError}</span>{:else}—{/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if acme !== undefined}
  <div class="acme">
    <div class="t">ACME 주문</div>
    <div class="line">
      <span class="lab">계정 <b>{acme.account ?? '—'}</b></span>
      <Badge tone={mark.tone} icon={mark.icon}>{mark.text}</Badge>
      <span class="sub">마지막 갱신 {notBefore} · {challenge} · 다음 시도 —</span>
    </div>
    {#if last?.state === 'failed' && last.lastError !== null}
      <div class="err">✕ {last.lastError}{last.attempts > 1 ? ` · 시도 ${last.attempts}번` : ''}</div>
    {/if}
    {#if staging && hasMaterial}
      <Writable>
        <div class="stg">▲ 스테이징 CA 로 받은 인증서예요. 브라우저가 믿지 않아요. <a href={resourcePath('certificate', key, 'settings')}>운영 CA 로 바꾸기</a></div>
      </Writable>
    {/if}
    {#if orders.length > 0}
      <div class="orders">
        <Expander bind:open={showOrders}>주문 기록 · {orders.length}</Expander>
        {#if showOrders}
          <DataTable rows={orders} rowKey={(r) => r.id} {columns} {cell} label="ACME 주문" minHeight="0" />
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  /* 값은 콘솔 시안 `acmeD` 블록의 인라인 style 그대로다. */
  .acme { grid-column: 1 / -1; padding: 10px 12px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); }
  .t { font-size: 12px; font-weight: 600; color: var(--tx2); margin-bottom: 6px; }
  .line { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .lab { font-size: 12px; color: var(--tx3); }
  .lab b { font-family: var(--mono); color: var(--tx); }
  .sub { color: var(--tx2); }
  .err { margin-top: 6px; color: var(--danger); font-size: 12px; overflow-wrap: anywhere; }
  .stg { margin-top: 6px; color: var(--warn); font-size: 12px; }
  .stg a { color: var(--accent); margin-left: 6px; }
  .orders { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }
</style>
