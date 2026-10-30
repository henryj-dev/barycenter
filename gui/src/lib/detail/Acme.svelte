<script lang="ts">
  /**
   * 인증서의 ACME — 발급 의도(계정 · 도메인)와 주문 상태.
   * 주문은 스케줄러가 연다. 실패하면 이유(`lastError`)와 시도 횟수를 보인다 — 「왜 아직 안 됐나」 를 물을 자리다.
   *
   * **CA 바꾸기** (2026-10-31): 계정만 바꿔 저장하면 러너가 만료를 기다리지 않고 새 계정으로 다시 받는다.
   * 이름 · 도메인 · 이 인증서를 쓰는 리스너 · SNI 는 그대로이고, 새 자료가 나올 때까지 옛 자료가 계속 쓰인다.
   * 스테이징 계정이면 「운영 CA 로 바꿔요」 를 먼저 보인다 — 스테이징 인증서는 브라우저가 믿지 않는다.
   */
  import { getContext, onMount } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, Banner, Button, DataTable, DescriptionList, Disclosure, FieldMessage, FormSection, type Column, type Tone } from '#lib/ui';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import AcmeAccountField, { caLabel, isStaging } from '#lib/forms/AcmeAccountField.svelte';
  import type { AcmeAccountRow, createDesk } from '#lib/desk.svelte.ts';

  type Order = { id: string; state: string; domains: string[]; attempts: number; lastError: string | null };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'certificate', key));
  const acme = $derived(item?.['acme'] as { account?: string; domains?: string[] } | undefined);
  const hasMaterial = $derived(typeof item?.['materialRef'] === 'string');

  let accounts = $state<AcmeAccountRow[] | undefined>();
  onMount(async () => { accounts = await desk.acmeAccounts(); });
  const current = $derived(accounts?.find((a) => a.key === acme?.account));
  const staging = $derived(current !== undefined && isStaging(current.directoryUrl));
  let switching = $state(false);
  let next = $state<string | undefined>();
  /**
   * 계정만 바꾼다 — 자료 참조 · digest · 도메인은 head 값 그대로 다시 싣는다(PUT 은 통째로 덮는다).
   * **모델의 칸만 싣는다.** 화면이 받은 인증서에는 API 가 붙인 표시용 칸(만료 · 사실 …)이 섞여 있어서,
   * 그대로 보내면 해독기가 「모양이 잘못됐다」 로 거절한다.
   */
  const MODEL_FIELDS = ['materialRef', 'chainDigest', 'keyDigest'] as const;
  const switchAccount = (): void => {
    if (item === undefined || acme === undefined || next === undefined) return;
    const body: Record<string, unknown> = {};
    for (const f of MODEL_FIELDS) if (item[f] !== undefined) body[f] = item[f];
    void desk.putResource('certificate', key, { ...body, acme: { account: next, domains: acme.domains ?? [] } })
      .then(after(resourcePath('certificate', key), 'CA 를 바꿨어요'));
    switching = false;
  };
  const orders = $derived<Order[]>(desk.acmeOrders.filter((o) => o['certificate'] === key).map((o) => ({
    id: String(o['id']),
    state: String(o['state']),
    domains: Array.isArray(o['domains']) ? (o['domains'] as string[]) : [],
    attempts: typeof o['attempts'] === 'number' ? o['attempts'] : 0,
    lastError: typeof o['lastError'] === 'string' ? o['lastError'] : null,
  })));
  const STATE: Record<string, { tone: Tone; text: string }> = {
    pending: { tone: 'pending', text: '대기' },
    validating: { tone: 'info', text: '검증 중' },
    ready: { tone: 'info', text: '발급 직전' },
    issued: { tone: 'ok', text: '발급됨' },
    failed: { tone: 'danger', text: '실패' },
    abandoned: { tone: 'neutral', text: '그만둠' },
  };
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
    {@const s = STATE[r.state] ?? { tone: 'neutral' as Tone, text: r.state }}<Badge tone={s.tone}>{s.text}</Badge>
  {:else if c.key === 'err'}
    {#if r.lastError !== null}<span class="err">{r.lastError}</span>{:else}—{/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if acme === undefined}
  <FieldMessage>ACME 로 발급하는 인증서가 아니에요. 자료를 직접 넣었어요.</FieldMessage>
{:else}
  {#if staging && hasMaterial}
    <div class="note">
      <Banner tone="warn">
        스테이징 CA 로 받은 인증서예요. 브라우저가 믿지 않아요. 확인이 끝났으면 운영 CA 로 바꿔요.
        {#snippet action()}<Writable><Button size="sm" variant="primary" onclick={() => { switching = true; }}>운영 CA 로 바꾸기</Button></Writable>{/snippet}
      </Banner>
    </div>
  {/if}
  <DescriptionList labelWidth="120px" items={[
    { label: '계정', value: `${acme.account ?? '—'}${current !== undefined ? ` · ${caLabel(current.directoryUrl)}` : ''}`, mono: true },
    { label: '도메인', value: (acme.domains ?? []).join(', '), mono: true },
    { label: '자료', value: hasMaterial ? '발급됨 — 리스너 · SNI 에 걸 수 있어요' : '아직 없음 — 첫 발급을 기다려요', tone: hasMaterial ? 'ok' : 'warn' },
    { label: '자동 갱신', value: '켜짐 — 만료 전에 스케줄러가 다시 받아요' },
  ]} />
  <Writable>
    <div class="switch">
      <Disclosure title="CA 바꾸기" hint="계정을 바꾸면 만료를 안 기다리고 새 계정으로 다시 받아요" open={switching}>
        <FormSection>
          <AcmeAccountField bind:account={next} label="새 계정" except={acme.account} prefer={staging ? 'production' : undefined} />
        </FormSection>
        <div class="go">
          <Button variant="primary" disabled={next === undefined || desk.editing} loading={desk.editing} onclick={switchAccount}>이 계정으로 다시 발급</Button>
          <FieldMessage>저장하면 스케줄러가 곧 새 주문을 열어요. 이름 · 도메인 · 이 인증서를 쓰는 리스너는 그대로예요. 새 인증서가 나올 때까지 지금 인증서를 계속 써요.</FieldMessage>
        </div>
      </Disclosure>
    </div>
  </Writable>
  <div class="orders">
    <DataTable rows={orders} rowKey={(r) => r.id} {columns} {cell} label="ACME 주문"
      emptyTitle="주문이 아직 없어요" emptyBody="적용하면 스케줄러가 주문을 열어요. 계정의 CA 등록도 그때 해요." minHeight="0" />
  </div>
{/if}

<style>
  .orders { margin-top: 12px; }
  .note { margin-bottom: 12px; }
  .switch { margin-top: 12px; }
  .go { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
  .err { color: var(--danger); font: var(--t-cap); overflow-wrap: anywhere; }
</style>
