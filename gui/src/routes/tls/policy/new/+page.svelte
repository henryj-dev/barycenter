<script lang="ts">
  import { getContext } from 'svelte';
  import AddTlsPolicy from '#lib/AddTlsPolicy.svelte';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

{#if !desk.live}
  <p class="d-empty">연결하면 여기서 만든다.</p>
{:else}
  <Writable>
    <AddTlsPolicy editing={desk.editing} add={(key, minVersion) => { void desk.insertTlsPolicy(key, minVersion).then(after); }} />
  </Writable>
{/if}
