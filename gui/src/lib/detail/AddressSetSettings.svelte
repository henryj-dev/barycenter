<script lang="ts">
  /**
   * 주소 집합 설정 폼 — 시안의 「기본」 구획: 이름 · 대역 목록.
   *
   * 공개 목록에서 받은 집합(`source: cloudflare`)은 손으로 고치지 않는다(시안) — 다시 받는 것은 CLI
   * `bary address-set create --name <이름> --cloudflare` 다(같은 이름이면 덮는다). 시안의 「목록 다시 받기」 버튼은 API 가 없다. 모양은 만들기 폼과 같은 `putAddressSetPatch` 가 만든다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { putAddressSetPatch } from '@web/edit';
  import { itemOf, resourcePath } from '@web/resources';
  import { Banner, Button, Form, FormRow, FormSection, ListInput, TextArea, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import { sourceAllowLine } from '#lib/forms/checks';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'addressSet', key));
  const source = $derived(item?.['source'] === 'cloudflare' ? 'cloudflare' as const : undefined);

  let cidrs = $state('');
  let problem = $state<string | undefined>();
  let loaded = $state<string | undefined>();

  $effect(() => {
    if (item === undefined || loaded === key) return;
    cidrs = Array.isArray(item['cidrs']) ? (item['cidrs'] as string[]).join('\n') : '';
    loaded = key;
  });

  /** 집합 안에는 대역만 — `@` 참조는 줄에서 바로 막는다(만들기 폼과 같다). */
  const cidrLine = (line: string): string | undefined =>
    (line.startsWith('@') ? '집합은 다른 집합을 참조하지 않아요. 대역을 직접 넣어요.' : sourceAllowLine(line));
  const ready = $derived(source === undefined && cidrs.trim() !== ''
    && cidrs.split(/[\s,]+/).every((l) => l.trim() === '' || cidrLine(l.trim()) === undefined));
  const save = (): void => {
    if (!ready || desk.editing) return;
    problem = undefined;
    try {
      const [op] = putAddressSetPatch(key, { cidrs });
      if (op !== undefined) void desk.putResource('addressSet', op.key, op.body).then(after(resourcePath('addressSet', op.key)));
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#if item !== undefined}
  <Writable target>
    <Form note="저장하면 커밋해요. 이 집합을 쓰는 리스너가 적용 대기에 올라요." onsubmit={save}>
      <FormSection title="기본">
        <FormRow label="이름" help="이름은 바꿀 수 없어요. 리스너에서는 @이름 으로 써요."><TextInput value={`@${key}`} disabled /></FormRow>
        <FormRow label="대역 목록" required
          help={source === undefined ? 'CIDR 이나 IP 를 한 줄에 하나씩 넣어요. 같은 줄은 하나로 접어요.' : 'Cloudflare 공개 목록에서 받아와요. 직접 고칠 수 없어요.'}>
          {#if source === undefined}
            <ListInput label="대역 목록" bind:value={cidrs} check={cidrLine} />
          {:else}
            <TextArea aria-label="대역 목록" value={cidrs} rows={Math.min(12, Math.max(4, cidrs.split('\n').length))} readonly />
          {/if}
        </FormRow>
      </FormSection>
      {#if source !== undefined}
        <Banner tone="info">목록을 다시 받으려면 CLI 에서 <code>bary address-set create --name {key} --cloudflare</code> 를 실행해요. 같은 이름이면 덮어써요.</Banner>
      {/if}
      {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
      {#snippet actions()}
        {#if source === undefined}
          <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '저장 중' : '저장'}</Button>
          <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
        {/if}
      {/snippet}
    </Form>
  </Writable>
{/if}
