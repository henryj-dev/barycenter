<script lang="ts">
  /** 복구 코드는 **지금 한 번만** 보인다. 서버에는 해시만 있다. */
  import { Banner } from '#lib/ui';
  let { codes }: { codes: string[] } = $props();
</script>

<div class="rc" role="status">
  <Banner tone="warn">복구 코드예요. 인증 앱을 잃었을 때 하나씩 써요. <b>지금 따로 적어 둬요. 다시 볼 수 없어요.</b></Banner>
  <div class="codes">{#each codes as c (c)}<code>{c}</code>{/each}</div>
</div>

<style>
  .rc { display: grid; gap: 8px; }
  .codes {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; padding: 12px;
    background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md);
  }
  code { font: 400 13px/20px var(--mono); color: var(--tx); }
</style>
