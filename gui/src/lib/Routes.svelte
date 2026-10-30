<script lang="ts">
  import Writable from './global/Writable.svelte';
  import type { RoutesView } from '@web/routes-view';
  import AddRoute from './AddRoute.svelte';
  import AddRedirect from './AddRedirect.svelte';
  import AddReject from './AddReject.svelte';
  import AddPassthroughRoute from './AddPassthroughRoute.svelte';
  import AddPassthroughReject from './AddPassthroughReject.svelte';
  import type { RedirectStatus, RejectStatus } from '@web/edit';

  let { mode = 'list-http', view, live, editing, listeners, pools, ptListeners, tcpPools, withdraw, withdrawPt, insert, insertRedirect, insertReject, insertPt, insertPtReject }: {
    view: RoutesView;
    live: boolean;
    editing: boolean;
    listeners: string[];
    pools: string[];
    ptListeners: string[];
    tcpPools: string[];
    withdraw: (key: string) => void;
    withdrawPt: (key: string) => void;
    insert: (input: {
      key: string; listener: string; hosts: string[]; pool: string;
      pathPrefix?: string; websocket?: boolean;
      rewritePrefix?: string; requestHeaders?: string;
    }) => void;
    insertRedirect: (input: {
      key: string; listener: string; hosts: string[]; to: string;
      status: RedirectStatus; pathPrefix?: string;
    }) => void;
    insertReject: (input: {
      key: string; listener: string; hosts: string[];
      status: RejectStatus; pathPrefix?: string;
    }) => void;
    insertPt: (input: { key: string; listener: string; snis: string[]; pool: string }) => void;
    insertPtReject: (input: { key: string; listener: string; snis: string[] }) => void;
    /**
     * `list-http`·`list-passthrough` 는 목록 세그먼트(`/traffic/route/<종류>`),
     * `http`·`passthrough` 는 그 라우트의 만들기 폼(`/traffic/route/<종류>/new`).
     */
    mode?: 'list-http' | 'list-passthrough' | 'http' | 'passthrough';
  } = $props();
</script>

{#if !live}
  <p class="empty">연결하면 head 라우트가 여기 온다.</p>
{:else if mode === 'http'}
  <Writable>
  <AddRoute {listeners} {pools} {editing} add={insert} />
  <AddRedirect {listeners} {editing} add={insertRedirect} />
  <AddReject {listeners} {editing} add={insertReject} />
  </Writable>
{:else}
  <Writable>
  <AddPassthroughRoute listeners={ptListeners} pools={tcpPools} {editing} add={insertPt} />
  <AddPassthroughReject listeners={ptListeners} {editing} add={insertPtReject} />
  </Writable>
{/if}

<style>
  .empty { color: var(--tx2); }
</style>
