<script lang="ts">
  import { getContext } from 'svelte';
  import Status from '$lib/Status.svelte';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

<Status
  view={desk.status}
  live={desk.live}
  recovering={desk.recovering}
  recover={() => { void desk.recover(); }}
/>
