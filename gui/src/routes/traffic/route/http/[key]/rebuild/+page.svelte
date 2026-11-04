<script lang="ts">
  /**
   * URL로 다시 만들기 — 콘솔 시안처럼 드로어로 연다(`FormDrawer kind="rebuild"`, 500px). 주소는 그대로(`<key>/rebuild`)라
   * 새로고침 · 링크가 같다. 아래에는 이 라우트의 개요가 있다. 닫으면 연 자리(목록의 분할 상세 · 상세 머리)로 돌아간다 —
   * 주소로 바로 왔으면 라우트 상세로 간다.
   */
  import { afterNavigate } from '$app/navigation';
  import { page } from '$app/state';
  import { resourcePath } from '@web/resources';
  import FormDrawer from '#lib/forms/FormDrawer.svelte';
  import Rebuild from '#lib/detail/Rebuild.svelte';
  import RouteOverview from '#lib/route/RouteOverview.svelte';

  const detail = $derived(resourcePath('httpRoute', page.params['key'] ?? ''));
  let from = $state<string | undefined>();
  afterNavigate((n) => { if (n.from !== null && n.type !== 'enter') from = n.from.url.pathname; });
</script>

<RouteOverview kind="httpRoute" />
<FormDrawer kind="rebuild" back={from ?? detail}><Rebuild /></FormDrawer>
