<script lang="ts">
  /**
   * 인증서 개요의 「ACME 주문」 상자 — 콘솔 시안 `acmeD` 블록: 「계정 <b>default</b>」 · 「● 유효」 · 「마지막 갱신 … · HTTP-01 · 다음 시도 …」.
   * 값은 실제 API 것만 쓴다. 「마지막 갱신」 은 지금 자료의 발급 시각(notBefore)이다. 「다음 시도」 는 실패한 주문의
   * `nextAttemptAt`(러너가 다시 볼 시각)이고, 다른 상태에서는 「—」 다(2026-11-20).
   *
   * 시안에 없는 기존 표시(같은 상자 안 · 아래):
   *   · 마지막 주문이 실패했으면 이유(`lastError`)와 시도 횟수(`attempts`) — 「왜 아직 안 됐나」 를 물을 자리다.
   *   · 스테이징 CA 로 받은 인증서면 「운영 CA 로 바꾸기」(설정 탭의 ACME 계정으로 간다). 스테이징 인증서는 브라우저가 믿지 않는다.
   *   · 주문 기록(접힘) — 주문마다 상태 · 도메인 · 시도 · 마지막 오류.
   * 계정 바꾸기(「CA 바꾸기」)는 설정 탭의 「ACME 계정」 이 한다(`CertificateSettings`).
   *
   * 손으로 움직이기 (2026-11-20, 쓸 수 있을 때만):
   *   · 「지금 다시 시도」 — 마지막 주문이 실패 · 포기일 때. 실패면 백오프를 지우고, 포기면 새 주문을 연다.
   *     포기한 뒤에는 러너가 새 주문을 안 낸다 — 원인을 고친 사람이 이것을 누른다.
   *   · 「지금 갱신…」 — 자료가 있고 진행 중인 주문이 없을 때. 만료가 멀어도 새 주문을 연다(확인 창 — CA 가 주문 수를 센다).
   */
  import { getContext, onMount } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, Button, ConfirmDialog, DataTable, Expander, toast, type Column, type ConfirmLine, type Tone } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import Writable from '#lib/global/Writable.svelte';
  import { isStaging } from '#lib/forms/AcmeAccountField.svelte';
  import { challengeOf } from '#lib/tls/cert-edit.ts';
  import type { AcmeAccountRow, createDesk } from '#lib/desk.svelte.ts';

  type Order = { id: string; state: string; domains: string[]; attempts: number; lastError: string | null; nextAttemptAt: string | null };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
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
    nextAttemptAt: typeof o['nextAttemptAt'] === 'string' ? o['nextAttemptAt'] : null,
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
  /** 「다음 시도」 — 실패한 주문의 다시 볼 시각(이 브라우저의 시간대). */
  const nextTry = $derived.by((): string => {
    if (last?.state !== 'failed' || last.nextAttemptAt === null) return '—';
    const d = new Date(last.nextAttemptAt);
    if (Number.isNaN(d.getTime())) return '—';
    const p = (n: number): string => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  });
  const canWrite = $derived(scope?.blocked !== true);
  const canRetry = $derived(last?.state === 'failed' || last?.state === 'abandoned');
  /** 진행 중인 주문이 없고 자료가 있다 — 만료를 기다리지 않고 새로 받을 수 있다. */
  const canRenew = $derived(hasMaterial && (last === undefined || last.state === 'issued' || last.state === 'abandoned') && !canRetry);
  let asking = $state(false);
  const renewLines: ConfirmLine[] = [
    { tone: 'ok', icon: '●', text: '새 주문을 열어요. 발급은 데몬이 하고, 끝나면 새 자료로 바꿔요.' },
    { tone: 'warn', icon: '▲', text: 'CA 는 같은 도메인의 발급 수를 제한해요 (Let’s Encrypt: 주 5회).' },
  ];
  const act = async (kind: 'retry' | 'renew'): Promise<void> => {
    const r = await desk.acmeAction(key, kind);
    asking = false;
    if (!r.ok) { toast.fail(kind === 'retry' ? '다시 시도하지 못했어요' : '갱신을 시작하지 못했어요', r.message); return; }
    toast.ok(r.created ? '새 주문을 열었어요' : '주문을 지금 다시 시도해요', `${key} — 진행은 이 상자에 나와요`);
  };
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
      <span class="sub">마지막 갱신 {notBefore} · {challenge} · 다음 시도 {nextTry}</span>
      {#if canWrite && canRetry}
        <Button size="sm" disabled={desk.editing} onclick={() => { void act('retry'); }}>지금 다시 시도</Button>
      {:else if canWrite && canRenew}
        <Button size="sm" variant="secondary" disabled={desk.editing} onclick={() => { asking = true; }}>지금 갱신…</Button>
      {/if}
    </div>
    {#if last?.state === 'failed' && last.lastError !== null}
      <div class="err">✕ {last.lastError}{last.attempts > 1 ? ` · 시도 ${last.attempts}번` : ''}</div>
    {/if}
    {#if last?.state === 'abandoned'}
      <div class="err">○ 여러 번 실패해서 자동 시도를 멈췄어요. 원인을 고친 뒤 「지금 다시 시도」 를 눌러요.{last.lastError !== null ? ` 마지막 오류: ${last.lastError}` : ''}</div>
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
  <ConfirmDialog bind:open={asking} title={`지금 갱신: 인증서 ${key}`} sub="만료를 기다리지 않고 ACME 로 새로 받아요."
    lines={renewLines} danger={false} confirmLabel="새 주문 열기" busy={desk.editing}
    oncancel={() => { asking = false; }} onconfirm={() => { void act('renew'); }} />
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
