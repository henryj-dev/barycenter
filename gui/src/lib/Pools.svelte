<script lang="ts">
  import Writable from './global/Writable.svelte';
  import type { KeylessAlgorithm } from '@web/edit';
  import type { PoolsView } from '@web/pools-view';
  import type { ProtocolClass } from '@web/edit';
    import AddPool from './AddPool.svelte';
  import AddHashPool from './AddHashPool.svelte';
  import AddSourceIpHashPool from './AddSourceIpHashPool.svelte';

  let { mode = 'list', view, live, editing, traffic, withdraw, withdrawPool, drain, insert, openPool, openHashPool, openSourceIpHashPool }: {
    view: PoolsView;
    live: boolean;
    editing: boolean;
    withdraw: (key: string) => void;
    withdrawPool: (key: string) => void;
    /** 제안 #9. 없으면 아무 말도 안 한다 — 못 읽은 것과 받는 중은 다르다. */
    traffic?: Map<string, { receivingTraffic: boolean; reasons: string[] }>;
    drain: (key: string) => void;
    insert: (pool: string, key: string, host: string, port: number) => void;
    openPool: (input: {
      pool: string; protocolClass: ProtocolClass; backend: string; host: string; port: number;
      algorithm: KeylessAlgorithm;
    }) => void;
    openHashPool: (input: {
      pool: string; protocolClass: ProtocolClass; hashKey: string;
      backend: string; host: string; port: number;
    }) => void;
    openSourceIpHashPool: (input: {
      pool: string; protocolClass: ProtocolClass; backend: string; host: string; port: number;
    }) => void;
    /** `list` 는 풀·백엔드 표, `new` 는 풀 만들기 폼 (`/traffic/pool/new`). */
    mode?: 'list' | 'new';
  } = $props();

</script>

{#if !live}
  <p class="empty">연결하면 head 풀이 여기 온다.</p>
{:else}
  <Writable>
  <AddPool {editing} add={openPool} />
  <AddHashPool {editing} add={openHashPool} />
  <AddSourceIpHashPool {editing} add={openSourceIpHashPool} />
  </Writable>
{/if}

<style>
  .empty { color: var(--tx2); }
</style>
