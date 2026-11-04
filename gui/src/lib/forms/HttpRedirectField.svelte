<script lang="ts">
  /**
   * HTTPS 리스너의 「HTTP 로 오면 HTTPS 로 보내기」 (2026-10-31). 켜면 같은 바인드의 이 포트(보통 80)에 평문
   * server 를 세우고 `301 https://…` 로 보낸다. 호스트 · 출발지 제한은 이 리스너의 것을 따른다.
   * ACME 확인(http-01)은 리다이렉트보다 앞서 그대로 답한다.
   */
  import { FormRow, FormSection, Switch, TextInput } from '#lib/ui';
  import { portError } from './checks';

  let { on = $bindable(), port = $bindable(), httpsPort, bare = false }: {
    /** 구획 없이 칸만 — 설정 탭은 「동작」 구획 안에 둔다(시안). */
    bare?: boolean;
    on: boolean;
    port: string;
    /** 같은 포트로는 못 연다 — 한 포트에 평문과 TLS 를 함께 못 연다. */
    httpsPort: string;
  } = $props();

  const error = $derived(
    !on ? undefined
      : portError(port) ?? (port.trim() === httpsPort.trim() ? 'HTTPS 포트와 같아요. 한 포트에 평문과 TLS 를 함께 못 열어요.' : undefined),
  );
</script>

{#snippet rows()}
  <FormRow label={bare ? 'HTTP로 온 요청을 HTTPS로 보내기' : 'HTTP → HTTPS'}>
    <Switch bind:checked={on}>{on ? '켜짐' : '꺼짐'}</Switch>
  </FormRow>
  {#if on}
    <FormRow label="HTTP 포트" for="ln-redirect-port" {error} help="기본은 80이에요.">
      <TextInput id="ln-redirect-port" bind:value={port} invalid={error !== undefined} inputmode="numeric" />
    </FormRow>
  {/if}
{/snippet}

{#if bare}{@render rows()}{:else}<FormSection title="HTTP 리다이렉트">{@render rows()}</FormSection>{/if}
