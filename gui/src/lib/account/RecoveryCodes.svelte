<script lang="ts">
  /** 복구 코드는 **지금 한 번만** 보인다. 서버에는 해시만 있다. */
  let { codes }: { codes: string[] } = $props();
</script>

<div class="codes" role="status">
  <p>복구 코드 — 인증 앱을 잃었을 때 한 번씩 쓴다. <strong>지금 따로 적어 둔다. 다시 볼 수 없다.</strong></p>
  <ol>{#each codes as c (c)}<li>{c}</li>{/each}</ol>
</div>

<style>
  .codes { border: 1px solid var(--ember); padding: 0.8rem; display: grid; gap: 0.5rem; }
  p { margin: 0; font-size: 0.9rem; }
  ol { margin: 0; padding-left: 1.4rem; columns: 2; font-family: var(--data); }
</style>
