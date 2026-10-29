<script lang="ts">
  /**
   * 리스너 출발지 제한 (`sourceAllow`, 2026-10-29).
   *
   * **다섯 리스너 폼이 이 하나를 함께 쓴다** — `ListenerOptions` 와 같은 이유다. 프로토콜마다
   * 따로 두면 한쪽만 고치는 날이 온다.
   *
   * 기본은 접혀 있다. 값은 붙여 넣은 문자열 그대로 올린다 — 끊기·검사는 `parseSourceAllow`
   * 한 자리다(CLI 의 `--allow` 와 같다).
   *
   * 폼 그리드의 **한 줄을 통째로** 쓴다. 칸 하나에 넣으면 7rem 폭에 접혀 읽을 수 없다.
   */
  let { editing, value = $bindable() }: {
    editing: boolean;
    value: string;
  } = $props();

  let open = $state(false);
  const count = $derived(value.split(/[\s,]+/).filter((s) => s.trim() !== '').length);
</script>

<div class="allow">
  <button type="button" class="toggle" onclick={() => { open = !open; }} disabled={editing}>
    {open ? '▾' : '▸'} 출발지 제한{count > 0 ? ` — ${count}개 대역만 받는다` : ' — 없음 (누구나)'}
  </button>
  {#if open}
    <textarea
      bind:value
      rows="4"
      placeholder={'173.245.48.0/20\n2400:cb00::/32\n203.0.113.7'}
      spellcheck="false"
      disabled={editing}
    ></textarea>
    <p class="note">
      한 줄에 하나, 또는 쉼표·공백으로 끊는다. CIDR 이나 IP 주소 하나. 비우면 제한하지 않는다.
      <strong>연결한 상대(바로 앞 홉)를 본다</strong> — Cloudflare 뒤라면 Cloudflare 대역을 적는다.
      목록: <code>https://www.cloudflare.com/ips-v4/</code> · <code>ips-v6/</code>.
      ACME http-01 을 받는 :80 리스너에 걸면 발급이 막힌다.
    </p>
  {/if}
</div>

<style>
  .allow { grid-column: 1 / -1; margin-top: 0.2rem; }
  .toggle {
    background: transparent;
    border: none;
    color: var(--mute);
    padding: 0.2rem 0;
    font: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  textarea {
    display: block;
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.4rem;
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.35rem 0.45rem;
    font-family: var(--mono, ui-monospace, monospace);
    font-size: 0.78rem;
    resize: vertical;
  }
  .note { font-size: 0.7rem; color: var(--mute); margin: 0.35rem 0 0; line-height: 1.5; }
  button:disabled, textarea:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
