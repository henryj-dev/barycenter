<script lang="ts">
  /**
   * HTTPS 리스너의 「HTTP 로 오면 HTTPS 로 보내기」 (2026-10-31). 켜면 같은 바인드의 이 포트(보통 80)에 평문
   * server 를 세우고 `301 https://…` 로 보낸다. 호스트 · 출발지 제한은 이 리스너의 것을 따른다.
   * ACME 확인(http-01)은 리다이렉트보다 앞서 그대로 답한다.
   */
  import { FormRow, FormSection, Switch, TextInput } from '#lib/ui';
  import { portError } from './checks';

  let { on = $bindable(), port = $bindable(), httpsPort }: {
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

<FormSection title="HTTP 리다이렉트">
  <FormRow label="HTTP → HTTPS" help="켜면 평문 HTTP 로 온 요청을 이 HTTPS 리스너로 301 리다이렉트해요. 호스트와 출발지 제한은 이 리스너를 따라요.">
    <Switch bind:checked={on}>켜짐</Switch>
  </FormRow>
  {#if on}
    <FormRow label="HTTP 포트" for="ln-redirect-port" required {error} help={error === undefined ? '이 포트를 다른 HTTP 리스너와 나눠 쓸 수 있어요(호스트가 겹치지 않을 때).' : undefined}>
      <TextInput id="ln-redirect-port" bind:value={port} invalid={error !== undefined} inputmode="numeric" width="120px" />
    </FormRow>
  {/if}
</FormSection>
