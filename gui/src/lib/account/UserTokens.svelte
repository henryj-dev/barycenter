<script lang="ts">
  /**
   * 관리자 — 한 사람의 API 토큰을 보고 폐기한다. **대신 만들지는 않는다**(서버에 그런 경로가 없다 — 토큰은 그 사람의
   * 것이고 값은 그 사람에게만 한 번 보인다). 폐기는 민감 작업이라 인증 앱 확인을 다시 묻는다.
   */
  import { ago } from '#lib/detail/facts';
  import { Badge, Button, Card, DataTable, FieldMessage, toast, type Column } from '#lib/ui';
  import { accountApi, type ApiToken, type UserRow } from './api';
  import { ROLE_LABEL, ROLE_SCOPES } from './text';

  let { user, onclose, onchanged }: { user: UserRow; onclose: () => void; onchanged: () => Promise<void> } = $props();

  let tokens = $state<ApiToken[]>([]);
  let loading = $state(true);
  let error = $state<string | undefined>();

  const load = async (): Promise<void> => {
    loading = true;
    const r = await accountApi.userTokens(user.id);
    if (r.ok) { tokens = r.data; error = undefined; } else error = r.message;
    loading = false;
  };
  $effect(() => { void user.id; void load(); });

  const revoke = async (t: ApiToken): Promise<void> => {
    const r = await accountApi.revokeUserToken(user.id, t.id);
    if (!r.ok) { error = r.message; return; }
    toast.ok(`${user.username}의 토큰을 폐기했어요`, t.name);
    await load();
    await onchanged();
  };

  const expired = (t: ApiToken): boolean => new Date(t.expiresAt).getTime() <= Date.now();
  const columns: Column<ApiToken>[] = [
    { key: 'name', label: '이름', mono: true, sort: (r) => r.name },
    { key: 'prefix', label: '앞부분', mono: true, muted: true, hideable: true, width: '220px', text: (r) => `${r.prefix}…` },
    { key: 'role', label: '역할', mono: true, width: '200px', text: (r) => ROLE_SCOPES[r.role] },
    { key: 'exp', label: '만료', muted: true, width: '130px', sort: (r) => r.expiresAt },
    { key: 'last', label: '마지막 사용', muted: true, width: '130px',
      text: (r) => (r.lastUsedAt === null ? '아직 안 썼어요' : ago(r.lastUsedAt) ?? '—'), sort: (r) => r.lastUsedAt ?? '' },
    { key: 'act', label: '', align: 'right', width: '80px' },
  ];
</script>

{#snippet cell(t: ApiToken, c: Column<ApiToken>)}
  {#if c.key === 'role'}
    <span title={ROLE_LABEL[t.role]}>{c.text?.(t) ?? ''}</span>
  {:else if c.key === 'exp'}
    {#if expired(t)}<Badge tone="neutral" icon="○">만료</Badge>{:else}<span title={new Date(t.expiresAt).toLocaleString()}>{new Date(t.expiresAt).toLocaleDateString()}</span>{/if}
  {:else if c.key === 'act'}
    <Button size="sm" variant="danger" onclick={() => { void revoke(t); }}>폐기</Button>
  {:else}{c.text?.(t) ?? ''}{/if}
{/snippet}

<Card title="{user.username}의 API 토큰 · {tokens.length}" sub="그 사람이 만든 토큰이에요. 관리자는 폐기만 해요. 정지하면 모두 폐기되고, 다시 활성해도 돌아오지 않아요." padded={false}>
  {#snippet actions()}<Button size="sm" onclick={onclose}>닫기</Button>{/snippet}
  {#if error !== undefined}<div class="note"><FieldMessage tone="error">{error}</FieldMessage></div>{/if}
  <DataTable rows={tokens} rowKey={(r) => r.id} {columns} {cell} {loading} label="{user.username}의 API 토큰"
    emptyTitle="토큰이 없어요" minHeight="0" />
</Card>

<style>
  .note { padding: 10px 16px 0; }
</style>
