<script lang="ts">
  /**
   * 바인드 주소 칸 (2026-10-31). 바인드는 **수신할 소켓의 주소**라, 이 서버에 할당된 IP 와 와일드카드
   * (`0.0.0.0` · `::`)만 고르게 한다. 할당 안 된 주소는 nginx 가 못 연다.
   *
   *   · 주소를 못 읽으면(옛 서버 · 권한) 손으로 받는다 — 서버가 plan 에서 다시 본다
   *   · `ip_nonlocal_bind` 가 켜진 서버는 「직접 입력…」 을 연다(VIP)
   *   · 지금 값이 목록에 없으면 「이 서버에 없음」 으로 보이고 오류를 낸다 — 다른 주소로 바꿀 수 있게
   */
  import { getContext, onMount } from 'svelte';
  import { FormRow, Select, TextInput } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { CUSTOM_BIND, bindError, bindHelp, bindOptions, type BindFacts } from './checks';

  let { bind = $bindable(), id, fresh = false }: {
    bind: string;
    id: string;
    /** 새로 만드는 폼 — 값이 비어 있으면 `0.0.0.0` 으로 시작한다. */
    fresh?: boolean;
  } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  /** null = 읽는 중, undefined = 못 읽었다(손으로 받는다). */
  let facts = $state<BindFacts | undefined | null>(null);
  let custom = $state(false);
  onMount(async () => {
    facts = await desk.hostAddresses().catch(() => undefined);
    if (fresh && bind.trim() === '') bind = '0.0.0.0';
  });

  const options = $derived(facts ? bindOptions(facts, bind) : []);
  const selected = $derived(custom ? CUSTOM_BIND : bind.trim().toLowerCase());
  const error = $derived(facts ? bindError(bind, facts) : undefined);
  const pick = (v: string): void => {
    if (v === CUSTOM_BIND) { custom = true; return; }
    custom = false;
    bind = v;
  };
</script>

<FormRow label="바인드 주소" for={id} required {error} help={error === undefined ? bindHelp(bind) : undefined}>
  {#if facts === null}
    <TextInput {id} value={bind} disabled />
  {:else if facts === undefined}
    <TextInput {id} bind:value={bind} autocomplete="off" />
  {:else}
    <Select label="바인드 주소" value={selected} {options} width="100%" invalid={error !== undefined} onchange={pick} />
    {#if custom}
      <TextInput {id} bind:value={bind} autocomplete="off" placeholder="10.0.0.100" />
    {/if}
  {/if}
</FormRow>
