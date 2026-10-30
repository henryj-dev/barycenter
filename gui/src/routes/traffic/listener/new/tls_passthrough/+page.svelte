<script lang="ts">
  // 리스너 만들기 2 / 2 — tls_passthrough 설정.
  import { getContext } from 'svelte';
  import Listeners from '#lib/Listeners.svelte';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

<Listeners
  mode="new"
  protocol="tls_passthrough"
  view={desk.listeners}
  live={desk.live}
  editing={desk.editing}
  pools={desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => p.key)}
  tcpPools={desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => p.key)}
  udpPools={desk.pools.rows.filter((p) => p.protocolClass === 'udp').map((p) => p.key)}
  withdraw={(key) => { void desk.withdraw('listener', key).then(after); }}
  insert={(key, bind, port, pool, opts, allow) => {
    void desk.insertHttpListener(key, { bind, port, pool }, opts, allow).then(after);
  }}
  insertTcp={(key, bind, port, pool, allow) => {
    void desk.insertTcpListener(key, { bind, port, pool }, allow).then(after);
  }}
  insertPassthrough={(key, bind, port, pool, noSniPool, allow) => {
    void desk.insertPassthroughListener(key, {
      bind,
      port,
      ...(pool === undefined ? {} : { pool }),
      ...(noSniPool === undefined ? {} : { noSniPool }),
    }, allow).then(after);
  }}
  insertUdp={(key, bind, port, pool, preset, allow) => {
    void desk.insertUdpListener(key, { bind, port, pool, preset }, allow).then(after);
  }}
  policies={desk.policies}
  certificates={desk.certs.rows.filter((c) => c.hasMaterial).map((c) => c.key)}
  insertHttps={(key, bind, port, pool, policy, certificate, opts, allow) => {
    void desk.insertHttpsListener(key, { bind, port, pool, policy, certificate }, opts, allow).then(after);
  }}
/>
