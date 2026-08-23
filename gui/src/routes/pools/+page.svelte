<script lang="ts">
  import { getContext } from 'svelte';
  import Pools from '$lib/Pools.svelte';
  import { after } from '$lib/after';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

<Pools
  traffic={desk.traffic}
  view={desk.pools}
  live={desk.live}
  editing={desk.editing}
  withdraw={(key) => { void desk.withdraw('backend', key).then(after); }}
  withdrawPool={(key) => { void desk.withdraw('pool', key).then(after); }}
  drain={(key) => { void desk.drain(key); }}
  insert={(pool, key, host, port) => {
    void desk.insertBackend(key, { pool, host, port }).then(after);
  }}
  openPool={(input) => { void desk.insertPool(input).then(after); }}
  openHashPool={(input) => { void desk.insertHashPool(input).then(after); }}
  openSourceIpHashPool={(input) => { void desk.insertSourceIpHashPool(input).then(after); }}
/>
