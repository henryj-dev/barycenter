<script lang="ts">
  /**
   * 인증 앱 등록 — 비밀을 보여 주고 코드를 받는다. 코드는 부모가 들고 간다(`bind:code`).
   * QR 은 아직 없다: 휴대폰에서는 아래 링크를 누르면 인증 앱이 열리고, 아니면 비밀을 손으로 넣는다.
   */
  import { FormRow, FormSection, TextInput } from '#lib/ui';
  let { secret, uri, code = $bindable('') }: { secret: string; uri: string; code?: string } = $props();
  const grouped = $derived(secret.match(/.{1,4}/g)?.join(' ') ?? secret);
</script>

<div class="totp">
  <p>인증 앱(Google Authenticator 등)에 이 계정을 더해요. 아래 비밀을 넣거나, 이 기기에서 링크를 열어요.</p>
  <code class="secret">{grouped}</code>
  <a href={uri}>이 기기의 인증 앱으로 열기 ↗</a>
  <FormSection stack>
    <FormRow label="앱에 뜬 6자리 코드" for="totp-code">
      <TextInput id="totp-code" inputmode="numeric" autocomplete="one-time-code" bind:value={code} width="200px" required />
    </FormRow>
  </FormSection>
</div>

<style>
  .totp { display: grid; gap: 8px; padding: 12px 14px; border: 1px solid var(--bd); border-radius: var(--r-md); background: var(--bg-page); }
  p { margin: 0; font: var(--t-small); color: var(--tx2); }
  .secret { font: 500 14px/22px var(--mono); color: var(--tx); letter-spacing: .08em; word-break: break-all; }
  a { color: var(--accent); font: var(--t-small); }
</style>
