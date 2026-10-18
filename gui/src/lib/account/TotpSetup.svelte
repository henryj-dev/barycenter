<script lang="ts">
  /**
   * 인증 앱 등록 — 비밀을 보여 주고 코드를 받는다. 코드는 부모가 들고 간다(`bind:code`).
   * QR 은 아직 없다: 휴대폰에서는 아래 링크를 누르면 인증 앱이 열리고, 아니면 비밀을 손으로 넣는다.
   */
  let { secret, uri, code = $bindable('') }: { secret: string; uri: string; code?: string } = $props();
  const grouped = $derived(secret.match(/.{1,4}/g)?.join(' ') ?? secret);
</script>

<div class="totp">
  <p>인증 앱(Google Authenticator 등)에 이 계정을 더한다.</p>
  <p class="secret">{grouped}</p>
  <p><a href={uri}>이 기기의 인증 앱으로 열기</a></p>
  <label>
    <span>앱에 뜬 6자리 코드</span>
    <input inputmode="numeric" autocomplete="one-time-code" bind:value={code} required />
  </label>
</div>

<style>
  .totp { display: grid; gap: 0.5rem; border-left: 2px solid var(--rule); padding-left: 0.8rem; }
  p { margin: 0; color: var(--mute); font-size: 0.9rem; }
  .secret { font-family: var(--data); color: var(--ink); letter-spacing: 0.08em; word-break: break-all; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; font-family: var(--data); max-width: 10rem; }
</style>
