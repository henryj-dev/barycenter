<script lang="ts">
  /**
   * 만들기 — 목록 위에 드로어로 연다(콘솔 시안 `drawer`). 주소(`/traffic/pool/new…`)는 그대로라 새로고침 · 링크가 같다.
   * 닫으면 목록으로 간다(`FormDrawer`).
   */
  import PoolList from '#lib/lists/PoolList.svelte';
  import PoolForm from '#lib/forms/PoolForm.svelte';
  import FormDrawer from '#lib/forms/FormDrawer.svelte';
</script>

<PoolList />
<FormDrawer kind="pool" back="/traffic/pool"><PoolForm /></FormDrawer>
