<script lang="ts">
  /**
   * 대역 행 편집 — 콘솔 시안 `fieldsFor` 의 `rows` 칸(`rowKind: 'src' | 'ranges'`) 그대로.
   *
   *   · 행마다 [종류(대역 · 주소 집합)] [값 또는 집합 고르기] [−]. `ranges`(주소 집합의 대역 목록)는 종류가 없다.
   *   · 틀린 행은 테두리가 빨갛고 아래에 「✕ 형식이 맞지 않아요. 예: 10.0.0.0/8」.
   *   · 「＋ 행 추가」 · 「여러 줄 붙여넣기」(한 줄에 하나 → 「행으로 변환」), 아래에 「요약: …」 / 「대역 N개」.
   *
   * 값은 **한 줄에 하나인 글**(`@이름` 은 주소 집합)로 주고받는다 — 끊기 · 검사는 그대로 `parseSourceAllow` 한 자리다
   * (CLI `--allow` 와 같다). 빈 행은 글에 빈 줄로 남고, `invalid` 가 참이 된다(시안: 「CIDR이나 IP를 입력해요.」).
   */
  import { getContext } from 'svelte';
  import { itemsOf } from '@web/resources';
  import { Button, Select, TextArea, TextInput, toast } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { sourceAllowSummary } from '#lib/detail/facts';
  import { sourceAllowLine } from './checks';

  type Row = { t: 'cidr' | 'set'; v: string };
  let { value = $bindable(''), mode = 'src', label, disabled = false, invalid = $bindable(false) }: {
    /** 한 줄에 하나. `@이름` 은 주소 집합(`src` 만). */
    value: string;
    mode?: 'src' | 'ranges';
    label: string;
    disabled?: boolean;
    /** 틀린 행이 있는가 — 부르는 쪽이 칸 오류(「잘못된 대역이 있어요. 표시된 행을 고쳐요.」)와 저장 잠금에 쓴다. */
    invalid?: boolean;
  } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  const join = (rows: readonly Row[]): string => rows.map((r) => (r.t === 'set' ? `@${r.v}` : r.v)).join('\n');

  // 처음 값으로 한 번 채운다. 그 뒤 글은 행에서만 만든다(바깥이 다시 채우면 `{#key}` 로 새로 만든다).
  // svelte-ignore state_referenced_locally
  let rows = $state<Row[]>(value.trim() === '' ? [] : value.split('\n').map((l) => l.trim()).filter((l) => l !== '').map((l) =>
    (mode === 'src' && l.startsWith('@') ? { t: 'set' as const, v: l.slice(1) } : { t: 'cidr' as const, v: l })));
  const sync = (next: Row[]): void => { rows = next; value = join(next); };

  const setNames = $derived(itemsOf(desk.model, 'addressSet').map((s) => String(s['key'])));
  const setOptions = $derived(itemsOf(desk.model, 'addressSet').map((s) => {
    const k = String(s['key']);
    return { value: k, label: `${s['source'] === 'cloudflare' ? 'Cloudflare' : k} · @${k}` };
  }));
  const KINDS = [{ value: 'cidr', label: '대역' }, { value: 'set', label: '주소 집합' }];

  /** 시안 `rowErrs('src' | 'ranges')`. */
  const errOf = (r: Row): string | undefined => {
    if (r.t === 'set') return setNames.includes(r.v) ? undefined : '목록에서 주소 집합을 선택해요.';
    const t = r.v.trim();
    if (t === '') return 'CIDR이나 IP를 입력해요.';
    if (t.startsWith('@') || /[\s,]/.test(t)) return '형식이 맞지 않아요. 예: 10.0.0.0/8';
    return sourceAllowLine(t) === undefined ? undefined : '형식이 맞지 않아요. 예: 10.0.0.0/8';
  };
  const errs = $derived(rows.map(errOf));
  $effect(() => { invalid = errs.some((e) => e !== undefined); });

  const summary = $derived(mode === 'ranges' ? `대역 ${rows.length}개`
    : `요약: ${sourceAllowSummary(desk.model, rows.filter((r) => r.v.trim() !== '').map((r) => (r.t === 'set' ? `@${r.v}` : r.v.trim()))).text}`);

  const update = (i: number, patch: Partial<Row>): void => sync(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setKind = (i: number, t: string): void => update(i, t === 'set' ? { t: 'set', v: setNames[0] ?? '' } : { t: 'cidr', v: '' });
  const add = (): void => sync([...rows, { t: 'cidr', v: '' }]);
  const remove = (i: number): void => sync(rows.filter((_, j) => j !== i));

  let pasteOpen = $state(false);
  let pasteText = $state('');
  const doPaste = (): void => {
    const lines = pasteText.split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length === 0) return;
    const add2 = lines.map((l): Row => {
      const name = l.replace(/^@/, '').toLowerCase();
      const hit = mode === 'src' ? setNames.find((n) => n.toLowerCase() === name) : undefined;
      return hit !== undefined && (l.startsWith('@') || !/[./:]/.test(l)) ? { t: 'set', v: hit } : { t: 'cidr', v: l };
    });
    sync([...rows, ...add2]);
    pasteOpen = false;
    pasteText = '';
    toast.ok(`${add2.length}개 행을 추가했어요`, '잘못된 행은 빨간색으로 표시해요.');
  };
</script>

<div class="rows" role="group" aria-label={label}>
  {#each rows as r, i (i)}
    <div class="row">
      <div class="line">
        {#if mode === 'src'}
          <Select label="종류" value={r.t} options={KINDS} width="112px" mono={false} {disabled} onchange={(v) => setKind(i, v)} />
        {/if}
        {#if r.t === 'set'}
          <span class="grow"><Select label="주소 집합" value={r.v} options={setOptions} width="100%" invalid={errs[i] !== undefined} {disabled} onchange={(v) => update(i, { v })} /></span>
        {:else}
          <span class="grow"><TextInput aria-label="값" value={r.v} invalid={errs[i] !== undefined} {disabled} placeholder="10.0.0.0/8 또는 203.0.113.5"
            oninput={(e) => update(i, { v: (e.currentTarget as HTMLInputElement).value })} /></span>
        {/if}
        {#if !disabled}<span class="del"><Button variant="icon" aria-label="행 삭제" onclick={() => remove(i)}>−</Button></span>{/if}
      </div>
      {#if errs[i] !== undefined}<div class="err">✕ {errs[i]}</div>{/if}
    </div>
  {/each}
  {#if !disabled}
    <div class="adds">
      <Button size="sm" onclick={add}>＋ 행 추가</Button>
      <Button size="sm" onclick={() => { pasteOpen = !pasteOpen; pasteText = ''; }} aria-expanded={pasteOpen}>여러 줄 붙여넣기</Button>
    </div>
    {#if pasteOpen}
      <div class="paste">
        <TextArea aria-label="붙여 넣을 줄" rows={4} bind:value={pasteText} placeholder="한 줄에 하나씩 입력해요" spellcheck="false" />
        <div class="pb">
          <Button size="sm" variant="primary" onclick={doPaste}>행으로 변환</Button>
          <Button size="sm" onclick={() => { pasteOpen = false; pasteText = ''; }}>닫기</Button>
        </div>
      </div>
    {/if}
  {/if}
  <div class="sum">{summary}</div>
</div>

<style>
  /* 값은 시안 `f.dRows` 블록의 인라인 style 그대로다. */
  .rows { display: flex; flex-direction: column; gap: 6px; }
  .row { display: flex; flex-direction: column; gap: 2px; }
  .line { display: flex; gap: 6px; align-items: center; }
  .grow { flex: 1; min-width: 0; display: flex; }
  .grow :global(> *) { flex: 1; min-width: 0; }
  .del :global(.btn) { border-color: var(--bd-strong); font-size: 15px; font-weight: 400; }
  .err { font-size: 12px; color: var(--danger); }
  .adds { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .paste { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px dashed var(--bd-strong); border-radius: var(--r-md); }
  .pb { display: flex; gap: 8px; }
  .sum { font-size: 12px; color: var(--tx2); }
</style>
