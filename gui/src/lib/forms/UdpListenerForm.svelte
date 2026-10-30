<script lang="ts">
  /** UDP 리스너 만들기 — 프리셋(DNS · WireGuard · 게임 · 직접)이 타임아웃과 응답 수를 정한다. */
  import { getContext } from 'svelte';
  import type { UdpPreset } from '@web/edit';
  import { FormRow, FormSection, Select } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import ListenerBasics from './ListenerBasics.svelte';
  import SourceAllowSection from './SourceAllowSection.svelte';
  import { filled, keyError, portError } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'udp').map((p) => ({ value: p.key })));
  const PRESETS: { value: UdpPreset; label: string }[] = [
    { value: 'dns', label: 'dns' },
    { value: 'wireguard', label: 'wireguard' },
    { value: 'game_generic', label: 'game' },
    { value: 'custom', label: 'custom' },
  ];

  let key = $state('');
  let bind = $state('0.0.0.0');
  let port = $state('53');
  let pool = $state<string | undefined>();
  let preset = $state<UdpPreset>('dns');
  let allow = $state('');

  const ready = $derived(filled(key, keyError) && filled(bind) && filled(port, portError) && pool !== undefined);
  const submit = (): void => {
    if (pool === undefined) return;
    void desk.insertUdpListener(key.trim(), { bind: bind.trim(), port: Number(port), pool, preset }, allow).then(after);
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/listener">
  <ListenerBasics protocol="UDP" bind:key bind:bind bind:port />
  <FormSection title="동작">
    <FormRow label="기본 풀" required help={pools.length === 0 ? 'UDP 풀이 없어요. 풀을 먼저 만들어요.' : undefined}>
      <Select label="기본 풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
    </FormRow>
    <FormRow label="프리셋" required>
      <Select label="프리셋" bind:value={preset} options={PRESETS} />
    </FormRow>
  </FormSection>
  <SourceAllowSection bind:value={allow} {port} />
</CreateForm>
