<script lang="ts">
  /**
   * 라우트 목록 도구 줄의 분할 컨트롤 — HTTP · 패스스루(시안 `rkTabs`). 목록 표의 `toolbar` 자리에 둔다.
   * 시안은 누름 버튼이지만 여기서는 세그먼트가 주소다(새로고침 · 링크가 같은 종류를 연다) — 그래서 링크이고
   * 고른 쪽은 `aria-current` 다. 모양은 시안 값 그대로: 테두리 --bd-strong · 반경 --r-md · 4px 12px · 12px,
   * 고른 쪽은 --accent 바탕 · --accent-fg 글, 아니면 투명 · --tx2.
   */
  let { current }: { current: 'http' | 'passthrough' } = $props();
  const ITEMS = [
    { key: 'http', label: 'HTTP', href: '/traffic/route/http' },
    { key: 'passthrough', label: '패스스루', href: '/traffic/route/passthrough' },
  ] as const;
</script>

<nav class="seg" aria-label="라우트 종류">
  {#each ITEMS as t (t.key)}
    <a href={t.href} aria-current={t.key === current ? 'page' : undefined}>{t.label}</a>
  {/each}
</nav>

<style>
  .seg { display: flex; border: 1px solid var(--bd-strong); border-radius: var(--r-md); overflow: hidden; }
  a { border: 0; padding: 4px 12px; font-size: 12px; line-height: 18px; background: transparent; color: var(--tx2); text-decoration: none; }
  a[aria-current='page'] { background: var(--accent); color: var(--accent-fg); }
  a:not([aria-current='page']):hover { background-image: linear-gradient(var(--hov), var(--hov)); }
  a:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
</style>
