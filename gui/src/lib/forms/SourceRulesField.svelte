<script lang="ts" module>
  import type { RedirectStatus, RejectStatus, SourceRuleInput } from '@web/edit';

  /** 폼의 규칙 한 줄. 저장할 때 `toSourceRules` 가 `SourceRuleInput` 으로 바꾼다. */
  export type SourceRuleRow = {
    from: string;
    kind: 'proxy' | 'redirect' | 'reject';
    pool: string | undefined;
    websocket: boolean;
    to: string;
    redirectStatus: string;
    rejectStatus: string;
  };

  export const emptyRule = (): SourceRuleRow => ({
    from: '', kind: 'reject', pool: undefined, websocket: false, to: '', redirectStatus: '302', rejectStatus: '403',
  });

  /** 폼 줄 → 저장할 규칙. 대역이 빈 줄은 버린다(`sourceRulesOf` 가 한 번 더 거른다). */
  export const toSourceRules = (rows: readonly SourceRuleRow[]): SourceRuleInput[] => rows.flatMap((r): SourceRuleInput[] => {
    const from = r.from.split(/[\s,]+/).map((x) => x.trim()).filter((x) => x !== '');
    if (from.length === 0) return [];
    if (r.kind === 'proxy') return [{ from, action: { kind: 'proxy', pool: r.pool ?? '', websocket: r.websocket } }];
    if (r.kind === 'redirect') return [{ from, action: { kind: 'redirect', to: r.to.trim(), status: Number(r.redirectStatus) as RedirectStatus } }];
    return [{ from, action: { kind: 'reject', status: Number(r.rejectStatus) as RejectStatus } }];
  });
</script>

<script lang="ts">
  /**
   * **출발지별 동작** (2026-11-02). 라우트 하나에 규칙을 위에서부터 둔다 — 출발지가 규칙의 대역에 들면 그 규칙의 동작을
   * 하고, 맞는 것이 없으면 라우트의 기본 동작이다. 대역은 CIDR · IP · `@주소집합` 을 쉼표나 공백으로 나눠 넣는다.
   *
   * 출발지는 방문자 주소다 — 리스너가 원본 IP 헤더 · PROXY 수신으로 바꾼 뒤의 주소다. 리스너의 출발지 제한은 바꾸기 전
   * 연결 주소를 본다. 그 차이를 칸 아래 도움말이 말한다.
   */
  import { Button, FormRow, Select, Switch, TextInput } from '#lib/ui';

  let { rules = $bindable([]), pools }: {
    rules: SourceRuleRow[];
    pools: { value: string }[];
  } = $props();

  const KINDS = [
    { value: 'proxy', label: '풀로 보내기' }, { value: 'redirect', label: 'redirect' }, { value: 'reject', label: 'reject' },
  ];
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
      <FormRow label="출발지" for="sr-from-{i}" help="CIDR · IP · @주소집합. 쉼표나 공백으로 여러 개를 넣어요.">
        <TextInput id="sr-from-{i}" bind:value={rule.from} autocomplete="off" placeholder="10.0.0.0/8, @office" />
      </FormRow>
      <FormRow label="동작">
        <Select label="동작" bind:value={rule.kind} options={KINDS} mono={false} />
      </FormRow>
      {#if rule.kind === 'proxy'}
        <FormRow label="풀"><Select label="풀" bind:value={rule.pool} options={pools} placeholder="풀을 골라요" width="100%" /></FormRow>
        <FormRow label="WebSocket"><Switch bind:checked={rule.websocket}>켜요</Switch></FormRow>
      {:else if rule.kind === 'redirect'}
        <FormRow label="대상" for="sr-to-{i}"><TextInput id="sr-to-{i}" bind:value={rule.to} autocomplete="off" placeholder="https://example.com/" /></FormRow>
        <FormRow label="응답 코드"><Select label="응답 코드" bind:value={rule.redirectStatus} options={REDIRECT} width="120px" /></FormRow>
      {:else}
        <FormRow label="응답 코드"><Select label="응답 코드" bind:value={rule.rejectStatus} options={REJECT} width="200px" /></FormRow>
      {/if}
      <div class="act">
        <Button variant="text" size="sm" disabled={i === 0} onclick={() => move(i, -1)}>위로</Button>
        <Button variant="text" size="sm" disabled={i === rules.length - 1} onclick={() => move(i, 1)}>아래로</Button>
        <Button variant="text" size="sm" onclick={() => { rules = rules.filter((_, j) => j !== i); }}>지워요</Button>
      </div>
    </fieldset>
  {/each}
  <div class="add"><Button variant="text" size="sm" onclick={() => { rules = [...rules, emptyRule()]; }}>＋ 규칙을 더해요</Button></div>
</div>


<style>
  .rules { display: flex; flex-direction: column; gap: 12px; }
  .rule { border: 1px solid var(--bd); border-radius: 8px; padding: 8px 12px 4px; margin: 0; min-width: 0; }
  legend { font-size: 12px; color: var(--tx2); padding: 0 4px; }
  .act { display: flex; gap: 4px; justify-content: flex-end; padding-bottom: 4px; }
</style>
