<script lang="ts">
  /**
   * 리스너 만들기 2 / 2 의 머리와 「기본」 구획 — 다섯 프로토콜이 같이 쓴다(시안: 이름 · 바인드 주소 · 포트).
   * 맨 위 「프로토콜 HTTP · 프로토콜 변경」 은 1 / 2 단계로 돌아간다.
   */
  import { FormRow, FormSection, TextInput } from '#lib/ui';
  import { KEY_HELP, bindHelp, keyError, portError } from './checks';

  let { protocol, key = $bindable(), bind = $bindable(), port = $bindable() }: {
    /** 보이는 이름 — HTTP · HTTPS · TCP · UDP · TLS 패스스루. */
    protocol: string;
    key: string;
    bind: string;
    port: string;
  } = $props();
</script>

<p class="proto">프로토콜 <b>{protocol}</b> <a href="/traffic/listener/new">프로토콜 변경</a></p>

<FormSection title="기본">
  <FormRow label="이름" for="ln-key" required error={keyError(key)} help={KEY_HELP}>
    <TextInput id="ln-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="web" />
  </FormRow>
  <FormRow label="바인드 주소" for="ln-bind" required help={bindHelp(bind)}>
    <TextInput id="ln-bind" bind:value={bind} autocomplete="off" />
  </FormRow>
  <FormRow label="포트" for="ln-port" required error={portError(port)}>
    <TextInput id="ln-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" width="120px" />
  </FormRow>
</FormSection>

<style>
  .proto { margin: 0; font: var(--t-small); color: var(--tx2); }
  .proto b { color: var(--tx); }
  .proto a { margin-left: 8px; color: var(--accent); font: var(--t-cap); }
</style>
