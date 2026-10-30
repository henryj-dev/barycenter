<script lang="ts">
  /** 백엔드 넣기. `?pool=` 이 있으면 그 풀로 시작한다(풀 상세에서 온다). */
  import { page } from '$app/state';
  import BackendForm from '#lib/forms/BackendForm.svelte';
</script>

<BackendForm pool={page.url.searchParams.get('pool') ?? undefined} />
