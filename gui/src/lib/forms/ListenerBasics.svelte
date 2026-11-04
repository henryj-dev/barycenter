<script lang="ts">
  /**
   * 리스너 만들기 2 / 2 의 머리와 「기본」 구획 — 다섯 프로토콜이 같이 쓴다.
   * 콘솔 시안 `fieldsFor('listeners', v, true, 'drawer')` 의 「기본」: 이름 · 바인드 주소 · 포트 · 활성화(+ HTTP 계열은 호스트 — `children`).
   * 맨 위 「프로토콜 HTTPS · 프로토콜 변경」 은 1 / 2 단계로 돌아간다(시안 `drProtoD`).
   */
  import type { Snippet } from 'svelte';
  import { Button, FormRow, FormSection, Switch, TextInput } from '#lib/ui';
  import { KEY_HELP, LISTENER_ERR, keyError, portError } from './checks';
  import BindField from './BindField.svelte';

  let { protocol, key = $bindable(), bind = $bindable(), port = $bindable(), enabled = $bindable(true), children }: {
    /** 보이는 이름 — HTTP · HTTPS · TCP · UDP · TLS 패스스루. */
    protocol: string;
    key: string;
    bind: string;
    port: string;
    /** 활성화 — 끄면 만들어도 소켓을 열지 않는다. */
    enabled?: boolean;
    /** 「기본」 구획 끝에 더 둘 칸(HTTP 계열의 호스트). */
    children?: Snippet;
  } = $props();
  const portErr = $derived(port.trim() === '' ? undefined : portError(port) === undefined ? undefined : LISTENER_ERR.port);
</script>

<div class="proto">프로토콜 <b>{protocol}</b><Button variant="text" size="xs" href="/traffic/listener/new">프로토콜 변경</Button></div>

<FormSection title="기본">
  <FormRow label="이름" for="ln-key" error={keyError(key)} help={KEY_HELP}>
    <TextInput id="ln-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" />
  </FormRow>
  <BindField id="ln-bind" bind:bind fresh />
  <FormRow label="포트" for="ln-port" error={portErr}>
    <TextInput id="ln-port" bind:value={port} invalid={portErr !== undefined} inputmode="numeric" />
  </FormRow>
  <FormRow label="활성화"><Switch bind:checked={enabled}>{enabled ? '켜짐' : '꺼짐'}</Switch></FormRow>
  {#if children}{@render children()}{/if}
</FormSection>

<style>
  /* 시안 `drProtoD`: 13px · --tx2 · 간격 8px, 「프로토콜 변경」 은 12px 강조색 글자. */
  .proto { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--tx2); }
  .proto b { color: var(--tx); }
  .proto :global(.btn) { padding: 0; height: auto; font-size: 12px; }
</style>
