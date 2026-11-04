<script lang="ts">
  /**
   * 인증 앱 등록 — 비밀을 보여 주고 코드를 받는다. 코드는 부모가 들고 간다(`bind:code`).
   * 시안(초대 수락 2단계): QR 상자(점선 · 빗금 바탕) · 「인증 코드 6자리」 큰 칸 · 도움말.
   * QR 은 아직 없다 — 상자 자리에 비밀과 「이 기기의 인증 앱으로 열기 ↗」 링크를 둔다(휴대폰이면 링크가 앱을 연다).
   */
  import { TextInput } from '#lib/ui';
  import AuthField from '#lib/shell/AuthField.svelte';
  let { secret, uri, code = $bindable('') }: { secret: string; uri: string; code?: string } = $props();
  const grouped = $derived(secret.match(/.{1,4}/g)?.join(' ') ?? secret);
</script>

<div class="totp">
  <div class="qr">
    <span>인증 앱에 이 비밀을 넣어요</span>
    <code class="secret">{grouped}</code>
    <a href={uri}>이 기기의 인증 앱으로 열기 ↗</a>
  </div>
  <AuthField label="인증 코드 6자리" for="totp-code" code help="인증 앱의 코드를 입력해요.">
    <TextInput id="totp-code" inputmode="numeric" maxlength={6} autocomplete="one-time-code" bind:value={code} required />
  </AuthField>
</div>

<style>
  .totp { display: flex; flex-direction: column; gap: 8px; }
  .qr {
    min-height: 132px; border: 1px dashed var(--bd-strong); border-radius: var(--r-md);
    background: repeating-linear-gradient(45deg, var(--bg-page), var(--bg-page) 8px, var(--bg-hover) 8px, var(--bg-hover) 16px);
    display: grid; place-items: center; align-content: center; gap: 6px; padding: 12px;
    font-family: var(--mono); font-size: 12px; color: var(--tx3); text-align: center;
  }
  .secret { font: 600 14px/22px var(--mono); color: var(--tx); letter-spacing: .08em; word-break: break-all; padding: 2px 6px; background: var(--bg-panel); border-radius: var(--r-sm); }
  a { color: var(--accent); font-family: var(--font); font-size: 12px; }
</style>
