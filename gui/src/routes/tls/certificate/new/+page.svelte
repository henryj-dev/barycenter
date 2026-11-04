<script lang="ts">
  /**
   * 만들기 — 목록 위에 드로어로 연다(콘솔 시안 `drawer`). 주소(`/tls/certificate/new…`)는 그대로라 새로고침 · 링크가 같다.
   * 닫으면 목록으로 간다(`FormDrawer`).
   */
  import CertificateList from '#lib/lists/CertificateList.svelte';
  import CertificateForm from '#lib/forms/CertificateForm.svelte';
  import FormDrawer from '#lib/forms/FormDrawer.svelte';
</script>

<CertificateList />
<FormDrawer kind="certificate" back="/tls/certificate"><CertificateForm /></FormDrawer>
