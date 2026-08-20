<script lang="ts">
  import { getContext } from 'svelte';
  import Audit from '$lib/Audit.svelte';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

<Audit view={desk.audit} live={desk.live} />
