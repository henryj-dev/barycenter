<script lang="ts">
  import Writable from './global/Writable.svelte';
  import type { CertsView } from '@web/certs-view';
  import AddCert from './AddCert.svelte';
  import AddSniBinding from './AddSniBinding.svelte';

  let { mode = 'list', view, live, editing, insert, listeners, certificates, bindings, insertSni, withdrawSni, withdraw }: {
    view: CertsView;
    live: boolean;
    editing: boolean;
    insert: (key: string, fullchain: string, privkey: string) => void;
    listeners: string[];
    certificates: string[];
    bindings: { key: string; listener: string; hosts: string[]; certificate: string }[];
    insertSni: (input: { key: string; listener: string; hosts: string[]; certificate: string }) => void;
    withdrawSni: (key: string) => void;
    withdraw: (key: string) => void;
    /** `list` 인증서 표 · `new` 자료 넣기 · `sni` 바인딩 표(`/tls/sni`) · `sni-new` 바인딩 만들기. */
    mode?: 'list' | 'new' | 'sni' | 'sni-new';
  } = $props();

</script>

{#if !live}
  <p class="empty">연결하면 head 인증서가 여기 온다.</p>
{:else if mode === 'new'}
  <Writable>
  <AddCert {editing} add={insert} />
  </Writable>
{:else}
  <Writable>
  <AddSniBinding {listeners} {certificates} {editing} add={insertSni} />
  </Writable>
{/if}

<style>
  .empty { color: var(--tx2); }
</style>
