<script lang="ts">
  import Writable from './global/Writable.svelte';
  import type { ListenerOptionFlags } from '@web/edit';
  import type { ListenersView } from '@web/listeners-view';
  import type { UdpPreset } from '@web/edit';
  import AddListener from './AddListener.svelte';
  import AddTcpListener from './AddTcpListener.svelte';
  import AddPassthroughListener from './AddPassthroughListener.svelte';
  import AddUdpListener from './AddUdpListener.svelte';
    import AddHttpsListener from './AddHttpsListener.svelte';

  let { mode = 'list', protocol, view, live, editing, pools, tcpPools, udpPools, policies, certificates, withdraw, insert, insertTcp, insertPassthrough, insertUdp, insertHttps }: {
    view: ListenersView;
    live: boolean;
    editing: boolean;
    pools: string[];
    tcpPools: string[];
    udpPools: string[];
    policies: string[];
    certificates: string[];
    withdraw: (key: string) => void;
    insert: (key: string, bind: string, port: number, pool: string, opts: ListenerOptionFlags, allow?: string) => void;
    insertTcp: (key: string, bind: string, port: number, pool: string, allow?: string) => void;
    insertPassthrough: (
      key: string, bind: string, port: number, pool?: string, noSniPool?: string, allow?: string,
    ) => void;
    insertUdp: (key: string, bind: string, port: number, pool: string, preset: UdpPreset, allow?: string) => void;
    insertHttps: (
      key: string, bind: string, port: number, pool: string,
      policy: string, certificate: string, opts: ListenerOptionFlags, allow?: string,
    ) => void;
    /** `list` 는 표만, `new` 는 만들기 폼만 (`/traffic/listener/new`). */
    mode?: 'list' | 'new';
    /** 만들기 둘째 단계 — 이 프로토콜의 폼만 (`/traffic/listener/new/<protocol>`). */
    protocol?: 'http' | 'https' | 'tcp' | 'udp' | 'tls_passthrough';
  } = $props();

</script>

{#if !live}
  <p class="empty">연결하면 head 리스너가 여기 온다.</p>
{:else}
  <Writable>
  {#if protocol === 'http'}<AddListener {pools} {editing} add={insert} />{/if}
  {#if protocol === 'tcp'}<AddTcpListener pools={tcpPools} {editing} add={insertTcp} />{/if}
  {#if protocol === 'tls_passthrough'}<AddPassthroughListener pools={tcpPools} {editing} add={insertPassthrough} />{/if}
  {#if protocol === 'udp'}<AddUdpListener pools={udpPools} {editing} add={insertUdp} />{/if}
  {#if protocol === 'https'}<AddHttpsListener {pools} {policies} {certificates} {editing} add={insertHttps} />{/if}
  </Writable>
{/if}

<style>
  .empty { color: var(--tx2); }
</style>
