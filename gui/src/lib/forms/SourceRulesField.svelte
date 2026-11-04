<script lang="ts" module>
  import { fromTokens, sourceRuleErrors, type SetCidrs } from './source-rules';
  import { ruleInputsOf, type RuleRow } from './route-edit';

  /** 라우트 하나의 규칙 수 상한 — 해독기와 같다(`decodeSourceRules`, 렌더가 규칙마다 `error_page` 코드 하나). */
  export const MAX_RULES = 20;

  /** 폼의 규칙 한 줄. 저장할 때 `toSourceRules` 가 `SourceRuleInput` 으로 바꾼다. 모양은 `route-edit.ts` 한 자리다. */
  export type SourceRuleRow = RuleRow;
  /** 경로별 묶음의 줄 — 규칙 줄에 경로가 붙는다(시안 `withPath`). */
  export type PathRuleRow = RuleRow & { paths: string };

  /** 새 규칙 — 시안 `addRule`: 풀로 보내기 · 첫 풀 · 403. */
  export const emptyRule = (pool?: string): SourceRuleRow => ({
    from: '', address: 'visitor', kind: 'proxy', pool, websocket: false, to: '', redirectStatus: '301', rejectStatus: '403',
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

<script lang="ts" generics="R extends SourceRuleRow">
  /**
   * **출발지별 동작** (2026-11-02) — 콘솔 시안 `fieldsFor` 의 `rules` 칸 그대로. 규칙 하나가 카드 하나다:
   * 머리(「규칙 n」 · ↑ · ↓ · −), 출발지, 도움말, 한 줄(보는 주소 · 동작 · 풀 + WebSocket · 응답 코드 · 이동할 URL),
   * 보는 주소 도움말, 오류(✕). 위에서부터 보고 처음 맞는 규칙의 동작을 한다 — 맞는 것이 없으면 라우트의 기본 동작이다.
   *
   * `withPath` 면 경로별 묶음의 줄이다(시안 `withPath`) — 카드 이름이 「줄 n」, 출발지 위에 경로 칸이 있고, 출발지를 비우면
   * 그 경로의 기본 동작이다. 그때 줄 오류는 부르는 쪽이 `errors` 로 준다(묶음 규칙은 그 폼이 안다).
   *
   * 시안과 다른 곳: reject 응답 코드는 403 · 404 · 444 다(렌더가 받는 값, 444 는 응답 없이 끊는다). 위 · 아래 끝의 버튼은
   * 시안처럼 흐리게 두되 누를 수 없다.
   */
  import { getContext } from 'svelte';
  import { itemsOf } from '@web/resources';
  import { Button, FieldMessage, Select, TextInput } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { setCidrsOf } from './source-rules';

  let { rules = $bindable([]), pools, withPath = false, errors, make }: {
    rules: R[];
    pools: { value: string }[];
    withPath?: boolean;
    /** 줄마다 오류 — 주면 이것을 쓴다(경로별 묶음). 없으면 출발지 규칙의 오류(`ruleRowErrors`)다. */
    errors?: readonly (string | undefined)[];
    /** 새 줄 — 없으면 `emptyRule(첫 풀)`. */
    make?: (pool: string | undefined) => R;
  } = $props();

  // `@집합` 을 펼쳐 가려짐을 본다 — GUI 가 이미 읽은 주소 집합이다(`desk.model.addressSets`).
  const desk = getContext<ReturnType<typeof createDesk> | undefined>('desk');
  const sets = $derived(setCidrsOf(desk === undefined ? [] : itemsOf(desk.model, 'addressSet')));
  const errs = $derived(errors ?? ruleRowErrors(rules, sets).map((e) => e.from ?? e.action));
  const max = $derived(withPath ? 40 : MAX_RULES);
  const word = $derived(withPath ? '줄' : '규칙');

  const KINDS = [
    { value: 'proxy', label: '풀로 보내기' }, { value: 'redirect', label: 'redirect' }, { value: 'reject', label: 'reject' },
  ];
  const ADDRESS = [{ value: 'visitor', label: '방문자 주소' }, { value: 'connection', label: '연결 주소' }];
  const REDIRECT = ['301', '302', '307', '308'].map((v) => ({ value: v }));
  const REJECT = ['403', '404', '444'].map((v) => ({ value: v }));

  const move = (i: number, d: -1 | 1): void => {
    const j = i + d;
    if (j < 0 || j >= rules.length) return;
    const next = [...rules];
    [next[i], next[j]] = [next[j]!, next[i]!];
    rules = next;
  };
  const add = (): void => {
    const pool = pools[0]?.value;
    rules = [...rules, make !== undefined ? make(pool) : emptyRule(pool) as R];
  };
</script>

<div class="rules">
  {#each rules as rule, i (i)}
    {@const err = errs[i]}
    <div class="card">
      <div class="hd">
        <span class="no">{word} {i + 1}</span>
        <span class="sq"><Button size="sm" dim disabled={i === 0} aria-label="{word} {i + 1}을 위로" onclick={() => move(i, -1)}>↑</Button></span>
        <span class="sq"><Button size="sm" dim disabled={i === rules.length - 1} aria-label="{word} {i + 1}을 아래로" onclick={() => move(i, 1)}>↓</Button></span>
        <span class="sq del"><Button size="sm" aria-label="{word} {i + 1}을 지우기" onclick={() => { rules = rules.filter((_, j) => j !== i); }}>−</Button></span>
      </div>
      {#if withPath}
        <TextInput aria-label="경로" value={(rule as unknown as PathRuleRow).paths} invalid={err !== undefined} autocomplete="off" placeholder="/count.js, /count"
          oninput={(e) => { (rule as unknown as PathRuleRow).paths = e.currentTarget.value; }} />
      {/if}
      <TextInput aria-label="출발지" bind:value={rule.from} invalid={err !== undefined} autocomplete="off"
        placeholder={withPath ? '비우면 그 밖의 모든 출발지' : '10.0.0.0/8, @office'} />
      <div class="hp">CIDR · IP · @주소집합. 쉼표나 공백으로 여러 개를 넣어요.</div>
      <div class="line">
        <Select label="보는 주소" bind:value={rule.address} options={ADDRESS} mono={false} width="120px" />
        <Select label="동작" bind:value={rule.kind} options={KINDS} mono={false} width="120px"
          onchange={(k) => { if (k === 'redirect') rule.redirectStatus = '301'; else if (k === 'reject') rule.rejectStatus = '403'; }} />
        {#if rule.kind === 'proxy'}
          <span class="pool">
            <Select label="풀" bind:value={rule.pool} options={pools} placeholder="풀을 골라요" width="auto" />
            <span class="ws"><Button role="switch" aria-checked={rule.websocket} onclick={() => { rule.websocket = !rule.websocket; }}>{rule.websocket ? 'WebSocket 켜짐' : 'WebSocket 꺼짐'}</Button></span>
          </span>
        {:else if rule.kind === 'redirect'}
          <Select label="응답 코드" bind:value={rule.redirectStatus} options={REDIRECT} width="76px" />
          <span class="url"><TextInput aria-label="이동할 URL" bind:value={rule.to} autocomplete="off" placeholder="https://example.com/" /></span>
        {:else}
          <Select label="응답 코드" bind:value={rule.rejectStatus} options={REJECT} width="76px" />
        {/if}
      </div>
      <div class="hp">{rule.address === 'connection'
        ? '연결 주소 — 우리에게 직접 붙은 주소예요. Cloudflare 를 거쳐 왔나를 물을 때 써요.'
        : '방문자 주소 — 리스너가 원본 IP 헤더 · PROXY 수신으로 바꾼 뒤의 주소예요.'}</div>
      {#if err !== undefined}<div class="er" role="alert">✕ {err}</div>{/if}
    </div>
  {/each}
  <div><Button size="sm" disabled={rules.length >= max} onclick={add}>＋ {word}을 더해요</Button></div>
  {#if !withPath && rules.length >= MAX_RULES}
    <FieldMessage tone={rules.length > MAX_RULES ? 'error' : 'help'}>규칙은 {MAX_RULES}개까지예요. 같은 동작의 대역은 한 규칙에 모으거나 주소 집합으로 묶어요.</FieldMessage>
  {/if}
</div>

<style>
  /* 값은 콘솔 시안 `fieldsFor` 의 `rules` 칸(`dRules`) 인라인 style 그대로다. */
  .rules { display: flex; flex-direction: column; gap: 8px; }
  .card { display: flex; flex-direction: column; gap: 6px; padding: 10px; border: 1px solid var(--bd); border-radius: var(--r-md); background: var(--bg-hover); }
  .hd { display: flex; align-items: center; gap: 6px; }
  .no { flex: 1; font-size: 12px; font-weight: 600; color: var(--tx2); }
  .sq :global(.btn) { width: 28px; padding: 0; color: var(--tx2); font-size: 13px; }
  .sq.del :global(.btn) { font-size: 15px; }
  .hp { font-size: 11px; color: var(--tx3); }
  .line { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .pool { display: inline-flex; gap: 6px; align-items: center; }
  .ws :global(.btn) { padding: 0 10px; color: var(--tx2); font-size: 12px; font-weight: 400; }
  .url { flex: 1; min-width: 0; }
  .url :global(input) { width: 100%; }
  .er { font-size: 12px; color: var(--danger); }
</style>
