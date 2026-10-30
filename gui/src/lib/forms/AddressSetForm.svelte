<script lang="ts">
  /**
   * 주소 집합 만들기 (#114) — 이름과 대역 목록. 리스너의 출발지 제한이 `@이름` 으로 참조한다.
   * 모양은 CLI `bary address-set` 과 같은 `putAddressSetPatch` 가 만든다(끊기 · 중복 접기 · 집합 참조 거절).
   */
  import { getContext } from 'svelte';
  import { putAddressSetPatch } from '@web/edit';
  import { FormRow, FormSection, ListInput, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError, sourceAllowLine } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let key = $state('');
  let cidrs = $state('');
  let problem = $state<string | undefined>();

  /** 집합 안에는 대역만 — `@` 참조는 줄에서 바로 막는다. */
  const cidrLine = (line: string): string | undefined =>
    (line.startsWith('@') ? '집합은 다른 집합을 참조하지 않아요. 대역을 직접 넣어요.' : sourceAllowLine(line));
  const ready = $derived(filled(key, keyError) && cidrs.trim() !== '' && cidrs.split(/[\s,]+/).every((l) => l.trim() === '' || cidrLine(l.trim()) === undefined));
  const submit = (): void => {
    problem = undefined;
    try {
      const [op] = putAddressSetPatch(key, { cidrs });
      if (op !== undefined) void desk.putResource('addressSet', op.key, op.body).then(after);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  };
</script>

<CreateForm {ready} {problem} onsubmit={submit} cancelHref="/traffic/address-set">
  <FormSection title="기본">
    <FormRow label="이름" for="as-key" required error={keyError(key)} help={`${KEY_HELP} 리스너에서는 @이름 으로 써요.`}>
      <TextInput id="as-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" placeholder="office" />
    </FormRow>
    <FormRow label="대역 목록" required help="CIDR 이나 IP 를 한 줄에 하나씩 넣어요. 같은 줄은 하나로 접어요.">
      <ListInput label="대역 목록" bind:value={cidrs} check={cidrLine} placeholder={'203.0.113.0/24\n2001:db8::/32'} />
    </FormRow>
  </FormSection>
</CreateForm>
