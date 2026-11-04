<script lang="ts" module>
  import { fromTokens, sourceRuleErrors, type SetCidrs } from './source-rules';
  import { ruleInputsOf, type RuleRow } from './route-edit';

  /** 라우트 하나의 규칙 수 상한 — 해독기와 같다(`decodeSourceRules`, 렌더가 규칙마다 `error_page` 코드 하나). */
  export const MAX_RULES = 20;

  /** 폼의 규칙 한 줄. 저장할 때 `toSourceRules` 가 `SourceRuleInput` 으로 바꾼다. 모양은 `route-edit.ts` 한 자리다. */
  export type SourceRuleRow = RuleRow;

  export const emptyRule = (): SourceRuleRow => ({
    from: '', address: 'visitor', kind: 'reject', pool: undefined, websocket: false, to: '', redirectStatus: '302', rejectStatus: '403',
  });

  /** 폼 줄 → 저장할 규칙. 대역이 빈 줄은 버린다(`sourceRulesOf` 가 한 번 더 거른다). 수정 폼의 head ↔ 폼과 같은 함수다. */
  export const toSourceRules = ruleInputsOf;

  /**
   * 행마다 오류 — 출발지 칸(대역 · 가려짐)과 동작 칸(풀 · 대상). 출발지가 빈 행은 저장할 때 버리므로 묻지 않는다.
   * 폼은 하나라도 있으면 「만들기」 를 잠근다(`rulesBlocked`).
   */
  export const ruleRowErrors = (rows: readonly SourceRuleRow[], sets: SetCidrs): { from?: string; action?: string }[] => {
    const from = sourceRuleErrors(rows, sets);
    return rows.map((r, i) => {
      const filled = fromTokens(r.from).length > 0;
      const action = !filled ? undefined
        : r.kind === 'proxy' && r.pool === undefined ? '풀을 골라요.'
          : r.kind === 'redirect' && r.to.trim() === '' ? '이동할 URL을 넣어요.' : undefined;
      return { ...(from[i] === undefined ? {} : { from: from[i] }), ...(action === undefined ? {} : { action }) };
    });
  };

  /** 저장을 막는가 — 규칙이 상한을 넘거나 오류가 있는 행이 있다. */
  export const rulesBlocked = (rows: readonly SourceRuleRow[], sets: SetCidrs): boolean =>
    rows.length > MAX_RULES || ruleRowErrors(rows, sets).some((e) => e.from !== undefined || e.action !== undefined);
</script>

<script lang="ts">
  /**
   * **출발지별 동작** (2026-11-02). 라우트 하나에 규칙을 위에서부터 둔다 — 출발지가 규칙의 대역에 들면 그 규칙의 동작을
   * 하고, 맞는 것이 없으면 라우트의 기본 동작이다. 대역은 CIDR · IP · `@주소집합` 을 쉼표나 공백으로 나눠 넣는다.
   *
   * 출발지는 방문자 주소다 — 리스너가 원본 IP 헤더 · PROXY 수신으로 바꾼 뒤의 주소다. 리스너의 출발지 제한은 바꾸기 전
   * 연결 주소를 본다. 그 차이를 칸 아래 도움말이 말한다.
   */
  import { getContext } from 'svelte';
  import { itemsOf } from '@web/resources';
  import { Button, FieldMessage, FormRow, Select, Switch, TextInput } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { setCidrsOf } from './source-rules';

  let { rules = $bindable([]), pools }: {
    rules: SourceRuleRow[];
    pools: { value: string }[];
  } = $props();

  // `@집합` 을 펼쳐 가려짐을 본다 — GUI 가 이미 읽은 주소 집합이다(`desk.model.addressSets`).
  const desk = getContext<ReturnType<typeof createDesk> | undefined>('desk');
  const sets = $derived(setCidrsOf(desk === undefined ? [] : itemsOf(desk.model, 'addressSet')));
  const errs = $derived(ruleRowErrors(rules, sets));

  const KINDS = [
    { value: 'proxy', label: '풀로 보내기' }, { value: 'redirect', label: 'redirect' }, { value: 'reject', label: 'reject' },
  ];
  const ADDRESS = [{ value: 'visitor', label: '방문자 주소' }, { value: 'connection', label: '연결 주소' }];
  const REDIRECT = ['301', '302', '307', '308'].map((v) => ({ value: v }));
  const REJECT = ['403', '404', '444'].map((v) => ({ value: v, ...(v === '444' ? { hint: '응답 없이 끊어요' } : {}) }));

  const move = (i: number, d: -1 | 1): void => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j]!, next[i]!];
    rules = next;
  };
</script>

<div class="rules">
  {#each rules as rule, i (i)}
    <fieldset class="rule">
      <legend>규칙 {i + 1}</legend>
      <FormRow label="출발지" for="sr-from-{i}" error={errs[i]?.from} help="CIDR · IP · @주소집합. 쉼표나 공백으로 여러 개를 넣어요.">
        <TextInput id="sr-from-{i}" bind:value={rule.from} invalid={errs[i]?.from !== undefined} autocomplete="off" placeholder="10.0.0.0/8, @office" />
      </FormRow>
      <FormRow label="보는 주소" help={rule.address === 'connection'
        ? '연결 주소 — 우리에게 직접 붙은 주소예요. 「Cloudflare 를 거쳐 왔나」 를 물을 때 써요.'
        : '방문자 주소 — 리스너가 원본 IP 헤더 · PROXY 수신으로 바꾼 뒤의 주소예요.'}>
        <Select label="보는 주소" bind:value={rule.address} options={ADDRESS} mono={false} />
      </FormRow>
      <FormRow label="동작">
        <Select label="동작" bind:value={rule.kind} options={KINDS} mono={false} />
      </FormRow>
      {#if rule.kind === 'proxy'}
        <FormRow label="풀" error={errs[i]?.action}><Select label="풀" bind:value={rule.pool} options={pools} placeholder="풀을 골라요" width="100%" /></FormRow>
        <FormRow label="WebSocket" help="켜면 Upgrade 요청을 백엔드로 넘겨요."><Switch bind:checked={rule.websocket}>켜요</Switch></FormRow>
      {:else if rule.kind === 'redirect'}
        <FormRow label="대상" for="sr-to-{i}" error={errs[i]?.action}><TextInput id="sr-to-{i}" bind:value={rule.to} invalid={errs[i]?.action !== undefined} autocomplete="off" placeholder="https://example.com/" /></FormRow>
        <FormRow label="응답 코드"><Select label="응답 코드" bind:value={rule.redirectStatus} options={REDIRECT} width="120px" /></FormRow>
      {:else}
        <FormRow label="응답 코드"><Select label="응답 코드" bind:value={rule.rejectStatus} options={REJECT} width="200px" /></FormRow>
      {/if}
      <div class="act">
        <Button variant="text" size="sm" disabled={i === 0} aria-label="규칙 {i + 1}을 위로" onclick={() => move(i, -1)}>↑ 위로</Button>
        <Button variant="text" size="sm" disabled={i === rules.length - 1} aria-label="규칙 {i + 1}을 아래로" onclick={() => move(i, 1)}>↓ 아래로</Button>
        <Button variant="text" size="sm" aria-label="규칙 {i + 1}을 지워요" onclick={() => { rules = rules.filter((_, j) => j !== i); }}>지워요</Button>
      </div>
    </fieldset>
  {/each}
  <div class="add">
    <Button variant="text" size="sm" disabled={rules.length >= MAX_RULES} onclick={() => { rules = [...rules, emptyRule()]; }}>＋ 규칙을 더해요</Button>
    {#if rules.length > MAX_RULES}<FieldMessage tone="error">규칙은 {MAX_RULES}개까지예요.</FieldMessage>
    {:else if rules.length === MAX_RULES}<FieldMessage>규칙은 {MAX_RULES}개까지예요. 같은 동작의 대역은 한 규칙에 모으거나 주소 집합으로 묶어요.</FieldMessage>{/if}
  </div>
</div>


<style>
  .rules { display: flex; flex-direction: column; gap: 12px; }
  .rule {
    border: 1px solid var(--bd); border-radius: var(--r-md); padding: 8px 12px 4px; margin: 0; min-width: 0;
    display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 16px; align-items: start;
  }
  legend { font: var(--t-cap); color: var(--tx2); padding: 0 4px; }
  .act { grid-column: 1 / -1; display: flex; gap: 4px; justify-content: flex-end; padding-bottom: 4px; }
  .add { display: flex; flex-direction: column; gap: 4px; align-items: flex-start; }
  @media (max-width: 720px) { .rule { grid-template-columns: minmax(0, 1fr); gap: 6px; } }
</style>
