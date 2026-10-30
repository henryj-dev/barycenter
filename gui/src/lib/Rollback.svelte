<script lang="ts">
  /**
   * 리비전 롤백 — 적용 대기 화면 아래 구획 (시안). 지금까지 CLI 에만 있던 롤백이다.
   * 롤백은 옛 내용으로 **새 리비전**을 만든다. 트래픽은 위에서 적용해야 바뀐다.
   */
  import { getContext } from 'svelte';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Rev = {
    revision: string; parent: string | null; rollbackOf: string | null; createdAt: string;
    createdBy: string; note: string | null; changeset: string | null;
  };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let rows = $state<Rev[] | undefined>();
  let failed = $state(false);
  /** 롤백은 두 번 누른다 — 처음 누르면 확인 줄이 뜬다. 브라우저 대화상자를 안 쓴다. */
  let asking = $state<string | undefined>();
  $effect(() => {
    void desk.head;
    if (!desk.live) return;
    void desk.revisions().then((r) => { failed = r === undefined; rows = (r ?? []) as Rev[]; });
  });
</script>

<section class="rb">
  <h2>리비전 롤백</h2>
  {#if failed}
    <p class="d-empty">리비전 목록을 못 읽었다. 전역 화면은 지역의 리비전을 중계하지 않는다 — 그 지역의 GUI 에서 한다.</p>
  {:else if rows === undefined}
    <p class="d-empty">읽는 중이다.</p>
  {:else}
    <ol class="d-list">
      {#each rows as r (r.revision)}
        <li>
          <span class="d-mono">r{r.revision}</span>
          {#if r.revision === desk.head}<span class="d-ok">head</span>{/if}
          {#if r.rollbackOf !== null}<span class="d-note">r{r.rollbackOf} 로 롤백</span>{/if}
          <span class="d-note">{r.createdBy} · {new Date(r.createdAt).toLocaleString()}</span>
          {#if r.note !== null}<span class="d-note">— {r.note}</span>{/if}
          {#if r.revision !== desk.head}
            <Writable>
              {#if asking === r.revision}
                <span class="d-warn">r{r.revision} 의 내용으로 새 리비전을 만든다.</span>
                <button type="button" disabled={desk.editing} onclick={() => { asking = undefined; void desk.rollback(r.revision).then(after); }}>롤백한다</button>
                <button type="button" onclick={() => { asking = undefined; }}>그만둔다</button>
              {:else}
                <button type="button" disabled={desk.editing} onclick={() => { asking = r.revision; }}>이 리비전으로 롤백</button>
              {/if}
            </Writable>
          {/if}
        </li>
      {/each}
    </ol>
    <p class="d-note">롤백은 커밋까지다. 트래픽에 걸려면 위에서 적용한다.</p>
  {/if}
</section>

<style>
  .rb { margin-top: 2.5rem; }
  h2 { font-size: 0.95rem; margin: 0 0 0.6rem; }
  button { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.2rem 0.55rem; font-size: 0.75rem; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>
