<script lang="ts">
  import { getContext } from 'svelte';
  import Routes from '$lib/Routes.svelte';
  import { after } from '$lib/after';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

<Routes
  view={desk.routes}
  live={desk.live}
  editing={desk.editing}
  listeners={desk.listeners.rows
    .filter((l) => l.mark !== 'leave' && (l.protocol === 'http' || l.protocol === 'https'))
    .map((l) => l.key)}
  pools={desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => p.key)}
  ptListeners={desk.listeners.rows
    .filter((l) => l.mark !== 'leave' && l.protocol === 'tls_passthrough')
    .map((l) => l.key)}
  tcpPools={desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => p.key)}
  withdraw={(key) => { void desk.withdraw('httpRoute', key).then(after); }}
  withdrawPt={(key) => { void desk.withdraw('passthroughRoute', key).then(after); }}
  insert={(input) => { void desk.insertHttpRoute(input).then(after); }}
  insertRedirect={(input) => { void desk.insertHttpRedirect(input).then(after); }}
  insertReject={(input) => { void desk.insertHttpReject(input).then(after); }}
  insertPt={(input) => { void desk.insertPassthroughRoute(input).then(after); }}
  insertPtReject={(input) => { void desk.insertPassthroughReject(input).then(after); }}
/>
