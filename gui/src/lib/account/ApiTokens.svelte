<script lang="ts">
  /**
   * 내 API 토큰 — 시안의 「토큰」 표(이름 · 범위 · 마지막 사용 · 폐기)와 인라인 「＋ 토큰 만들기」 폼.
   *
   * 토큰은 **내 것**이다. 역할은 내 역할 이하로만 고르고(서버가 다시 판정한다), 내 역할이 내려가면 토큰도 같이
   * 깎인다. 만료는 반드시 있다(기본 90일, 최대 365일). 값은 만든 순간 **한 번만** 보인다 — 서버에는 해시만 있다.
   * 만들기 · 폐기는 민감 작업이라 인증 앱 확인을 다시 묻는다(`StepUpDialog`). 인증 앱이 없으면 만들 수 없다.
   */
  import { onMount } from 'svelte';
  import { ago } from '#lib/detail/facts';
  import { Badge, Button, Card, DataTable, FieldMessage, NumberInput, Select, TextInput, toast, type Column } from '#lib/ui';
  import { accountApi, type ApiToken, type Me, type Role } from './api';
  import { ROLE_LABEL, ROLE_SCOPES, TOKEN_NAME, TOKEN_NAME_HELP } from './text';

  let { me }: { me: Me } = $props();

  const RANK: Readonly<Record<Role, number>> = { auditor: 0, operator: 1, admin: 2 };
  const roles = $derived((['auditor', 'operator', 'admin'] as const)
    .filter((r) => RANK[r] <= RANK[me.role])
    .map((r) => ({ value: r, label: ROLE_SCOPES[r], hint: ROLE_LABEL[r] })));

  let tokens = $state<ApiToken[]>([]);
  let loading = $state(true);
  let error = $state<string | undefined>();
  let formOpen = $state(false);
  let name = $state('');
  let role = $state<Role>('auditor');
  let days = $state<number | string>(90);
  let tried = $state(false);
  let creating = $state(false);
  let created = $state<{ name: string; token: string } | undefined>();

  const load = async (): Promise<void> => {
    const r = await accountApi.tokens();
    if (r.ok) tokens = r.data; else error = r.message;
    loading = false;
  };
  onMount(() => { void load(); });

  const nameError = $derived(tried && !TOKEN_NAME.test(name.trim()) ? TOKEN_NAME_HELP : undefined);
  const daysNum = $derived(Number(days));
  const daysError = $derived(Number.isInteger(daysNum) && daysNum >= 1 && daysNum <= 365 ? undefined : '만료는 1–365일이에요.');

  const toggle = (): void => { formOpen = !formOpen; tried = false; error = undefined; };
  const create = async (): Promise<void> => {
    tried = true;
    if (!TOKEN_NAME.test(name.trim()) || daysError !== undefined) return;
    creating = true;
    const r = await accountApi.createToken(name.trim(), role, daysNum);
    creating = false;
    if (!r.ok) { error = r.message; return; }
    created = { name: r.data.name, token: r.data.token };
    toast.ok('토큰을 만들었어요', r.data.name);
    formOpen = false; name = ''; days = 90; tried = false; error = undefined;
    await load();
  };
  const copy = async (): Promise<void> => {
    if (created === undefined) return;
    try { await navigator.clipboard.writeText(created.token); toast.ok('토큰을 복사했어요', ''); } catch { /* 칸을 눌러 직접 복사한다 */ }
  };
  const revoke = async (t: ApiToken): Promise<void> => {
    const r = await accountApi.revokeToken(t.id);
    if (!r.ok) { error = r.message; return; }
    toast.ok('토큰을 폐기했어요', t.name);
    await load();
  };

  const expired = (t: ApiToken): boolean => new Date(t.expiresAt).getTime() <= Date.now();
  const columns: Column<ApiToken>[] = [
    { key: 'name', label: '이름', mono: true, sort: (r) => r.name },
    { key: 'role', label: '역할', mono: true, width: '200px', sort: (r) => RANK[r.role] },
    { key: 'exp', label: '만료', muted: true, width: '150px', sort: (r) => r.expiresAt },
    { key: 'last', label: '마지막 사용', muted: true, width: '130px',
      text: (r) => (r.lastUsedAt === null ? '아직 안 썼어요' : ago(r.lastUsedAt) ?? '—'), sort: (r) => r.lastUsedAt ?? '' },
    { key: 'act', label: '', align: 'right', width: '80px' },
  ];
</script>

{#snippet cell(t: ApiToken, c: Column<ApiToken>)}
  {#if c.key === 'name'}
    <span title={`${t.prefix}…`}>{t.name}</span>
  {:else if c.key === 'role'}
    <span title={ROLE_LABEL[t.role]}>{ROLE_SCOPES[t.role]}</span>
  {:else if c.key === 'exp'}
    {#if expired(t)}<Badge tone="neutral" icon="○">만료</Badge>{:else}<span title={new Date(t.expiresAt).toLocaleString()}>{new Date(t.expiresAt).toLocaleDateString()}</span>{/if}
  {:else if c.key === 'last'}
    <span title={t.lastUsedAt === null ? undefined : new Date(t.lastUsedAt).toLocaleString()}>{c.text?.(t) ?? ''}</span>
  {:else if c.key === 'act'}
    <Button size="sm" variant="danger" onclick={() => { void revoke(t); }}>폐기</Button>
  {:else}{c.text?.(t) ?? ''}{/if}
{/snippet}

<Card title="API 토큰 · {tokens.length}" sub="자동화용 API 토큰이에요. 사람 계정이 아니에요." padded={false}>
  {#snippet actions()}
    {#if me.mfa.totp}<Button size="sm" onclick={toggle}>＋ 토큰 만들기</Button>{/if}
  {/snippet}
  {#if !me.mfa.totp}
    <div class="note"><FieldMessage>토큰을 만들고 폐기하려면 인증 앱을 먼저 등록해요. 민감한 작업이라 인증 코드를 다시 물어요.</FieldMessage></div>
  {/if}
  {#if formOpen}
    <div class="form">
      <div class="line">
        <TextInput aria-label="토큰 이름" placeholder="토큰 이름" bind:value={name} width="220px" invalid={nameError !== undefined} autocomplete="off" />
        <Select label="역할" bind:value={role} options={roles} width="220px" />
        <NumberInput label="만료 일수" bind:value={days} unit="일" min="1" max="365" step="1" invalid={daysError !== undefined} />
        <Button variant="primary" loading={creating} onclick={() => { void create(); }}>만들기</Button>
        <Button onclick={toggle}>취소</Button>
      </div>
      {#if nameError !== undefined}<FieldMessage tone="error">{nameError}</FieldMessage>
      {:else if daysError !== undefined}<FieldMessage tone="error">{daysError}</FieldMessage>
      {:else}<FieldMessage>역할은 내 역할({ROLE_LABEL[me.role]}) 이하로만 골라요. 내 역할이 내려가면 토큰도 같이 내려가요. 만료는 기본 90일, 최대 365일이에요.</FieldMessage>{/if}
    </div>
  {/if}
  {#if created !== undefined}
    <div class="once">
      <b>토큰 값은 지금 한 번만 보여요. 따로 저장해요.</b>
      <div class="line">
        <TextInput value={created.token} readonly aria-label={`${created.name} 토큰 값`} onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
        <Button size="sm" onclick={() => { void copy(); }}>복사</Button>
        <Button size="sm" onclick={() => { created = undefined; }}>닫기</Button>
      </div>
    </div>
  {/if}
  {#if error !== undefined}<div class="note"><FieldMessage tone="error">{error}</FieldMessage></div>{/if}
  <DataTable rows={tokens} rowKey={(r) => r.id} {columns} {cell} {loading} label="API 토큰"
    emptyTitle="토큰이 없어요" emptyBody="「＋ 토큰 만들기」 로 자동화용 토큰을 만들어요." minHeight="0" />
</Card>

<style>
  .form, .once { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; border-bottom: 1px solid var(--bd); }
  .once { background: var(--warn-bg); font-size: 13px; }
  .line { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .once .line > :global(input) { flex: 1; min-width: 0; }
  .note { padding: 10px 16px 0; }
</style>
