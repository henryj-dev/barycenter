<script lang="ts">
  import { getContext } from 'svelte';
  import type { Scope } from './global/scope.svelte.ts';
  import Writable from './global/Writable.svelte';
  import type { ListenerOptionFlags } from '@web/edit';
  import type { ListenersView } from '@web/listeners-view';
  import type { TlsVersion, UdpPreset } from '@web/edit';
  import AddListener from './AddListener.svelte';
  import AddTcpListener from './AddTcpListener.svelte';
  import AddPassthroughListener from './AddPassthroughListener.svelte';
  import AddUdpListener from './AddUdpListener.svelte';
  import AddTlsPolicy from './AddTlsPolicy.svelte';
  import AddHttpsListener from './AddHttpsListener.svelte';

  let { view, live, editing, pools, tcpPools, udpPools, policies, certificates, withdraw, withdrawPolicy, insert, insertTcp, insertPassthrough, insertUdp, insertPolicy, insertHttps }: {
    view: ListenersView;
    live: boolean;
    editing: boolean;
    pools: string[];
    tcpPools: string[];
    udpPools: string[];
    policies: string[];
    certificates: string[];
    withdraw: (key: string) => void;
    withdrawPolicy: (key: string) => void;
    insert: (key: string, bind: string, port: number, pool: string, opts: ListenerOptionFlags, allow?: string) => void;
    insertTcp: (key: string, bind: string, port: number, pool: string, allow?: string) => void;
    insertPassthrough: (
      key: string, bind: string, port: number, pool?: string, noSniPool?: string, allow?: string,
    ) => void;
    insertUdp: (key: string, bind: string, port: number, pool: string, preset: UdpPreset, allow?: string) => void;
    insertPolicy: (key: string, minVersion: TlsVersion) => void;
    insertHttps: (
      key: string, bind: string, port: number, pool: string,
      policy: string, certificate: string, opts: ListenerOptionFlags, allow?: string,
    ) => void;
  } = $props();
  // 전역 모드면 설정을 읽기만 한다 — 쓰기 버튼을 안 그린다(설계 §1).
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);

  const label = (mark: string): string => {
    if (mark === 'join') return '적용하면 열린다';
    if (mark === 'leave') return '적용하면 닫힌다';
    return '서빙 중';
  };
</script>

{#if !live}
  <p class="empty">연결하면 head 리스너가 여기 온다.</p>
{:else}
  {#if view.rows.length === 0}
    <p class="empty">리스너가 없다. 아래에서 포트를 연다. 패스스루는 인증서를 제시하지 않는다.</p>
  {:else}
    <ul class="ports">
      {#each view.rows as row (row.socket + row.key)}
        <li data-mark={row.mark} data-enabled={row.enabled}>
          <span class="port mono">{row.bind}:{row.port}</span>
          <span class="proto mono">{row.protocol}</span>
          {#if row.mark === 'leave'}
            <span class="key">{row.socket}</span>
          {:else}
            <a class="key" href={`/traffic/listener/${encodeURIComponent(row.key)}`}>{row.key}</a>
          {/if}
          <span class="mark">{label(row.mark)}</span>
          {#if row.sourceAllow.length > 0}
            <span class="allow mono" title={row.sourceAllow.join('\n')}>출발지 {row.sourceAllow.length}개만</span>
          {/if}
          {#if row.mark !== 'leave'}
            {#if !ro}
            <button type="button" disabled={editing} onclick={() => withdraw(row.key)}>설정에서 뺀다</button>
            {/if}
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <Writable>
  <AddListener {pools} {editing} add={insert} />
  <AddTcpListener pools={tcpPools} {editing} add={insertTcp} />
  <AddPassthroughListener pools={tcpPools} {editing} add={insertPassthrough} />
  <AddUdpListener pools={udpPools} {editing} add={insertUdp} />
  </Writable>
  {#if policies.length > 0}
    <h2>TLS 정책</h2>
    <ul class="policies">
      {#each policies as key (key)}
        <li>
          <span class="key">{key}</span>
          {#if !ro}
          <button type="button" disabled={editing} onclick={() => withdrawPolicy(key)}>설정에서 뺀다</button>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
  <Writable>
  <AddTlsPolicy {editing} add={insertPolicy} />
  <AddHttpsListener {pools} {policies} {certificates} {editing} add={insertHttps} />
  </Writable>
{/if}

<style>
  .empty { color: var(--mute); }
  .ports { list-style: none; margin: 1.5rem 0 0; padding: 0; border-top: 1px solid var(--rule); }
  li {
    display: grid;
    grid-template-columns: 11rem 5.5rem 1fr auto auto auto;
    gap: 0.6rem;
    align-items: baseline;
    padding: 0.7rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .mono { font-family: var(--data); }
  .port { font-size: 0.95rem; }
  .proto { color: var(--mute); font-size: 0.8rem; }
  .key { color: var(--mute); font-size: 0.85rem; }
  a.key { color: var(--ink); text-decoration: none; border-bottom: 1px solid var(--rule); justify-self: start; }
  a.key:hover { border-bottom-color: var(--ember); }
  .mark { font-size: 0.75rem; color: var(--mute); }
  /* 출발지 제한 — 목록은 title 로 펼친다. 줄에 다 싣기엔 길다(Cloudflare 만 스물두 개). */
  .allow { font-size: 0.72rem; color: var(--amber, var(--mute)); cursor: help; }
  button {
    background: transparent;
    border: 1px solid var(--rule);
    color: var(--mute);
    padding: 0.2rem 0.45rem;
    font-size: 0.75rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  h2 { font-size: 0.85rem; color: var(--mute); font-weight: 600; margin: 1.5rem 0 0; }
  .policies { list-style: none; margin: 0.4rem 0 0; padding: 0; border-top: 1px solid var(--rule); }
  .policies li {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.6rem;
  }
  li[data-mark='join'] .port,
  li[data-mark='join'] .mark { color: var(--moss); }
  li[data-mark='leave'] .port,
  li[data-mark='leave'] .mark { color: var(--ember); }
  li[data-mark='leave'] .port { text-decoration: line-through; }
  li[data-enabled='false'] { opacity: 0.45; }
  @media (max-width: 640px) {
    li { grid-template-columns: 1fr auto; }
    .proto, .key { grid-column: 1; }
  }
</style>
