<script lang="ts">
  import { getContext } from 'svelte';
  import Rendered from '$lib/Rendered.svelte';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

<Rendered view={desk.rendered} live={desk.live} />
