<script lang="ts">
  import { getContext } from 'svelte';
  import Certs from '$lib/Certs.svelte';
  import { after } from '$lib/after';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

<Certs
  view={desk.certs}
  live={desk.live}
  editing={desk.editing}
  insert={(key, fullchain, privkey) => {
    void desk.insertCertificate(key, { fullchain, privkey }).then(after);
  }}
  listeners={desk.listeners.rows
    .filter((l) => l.mark !== 'leave' && l.protocol === 'https')
    .map((l) => l.key)}
  certificates={desk.certs.rows.filter((c) => c.hasMaterial).map((c) => c.key)}
  bindings={desk.bindings}
  insertSni={(input) => { void desk.insertSniBinding(input).then(after); }}
  withdrawSni={(key) => { void desk.withdraw('sniBinding', key).then(after); }}
  withdraw={(key) => { void desk.withdraw('certificate', key).then(after); }}
/>
