<script lang="ts">
  /**
   * 관리 › 계정 감사 (2026-11-21) — 로그인 · 초대 · 인증 앱 · 토큰 · SSO · 사용자 변경 기록.
   *
   * 관리자만 본다. 서버가 판정하고(403), 화면은 「관리자만 봐요」 를 보인다. 계정 기록은 지역마다 따로가 아니다 —
   * 전역과 지역이 계정 저장소를 함께 쓰므로 전역 화면에서도 같은 기록이 보인다(중계하지 않는다).
   * 최근 것부터 100줄씩 읽는다. 찾기와 묶음 거르기는 읽은 줄 안에서 한다 — 더 오래된 것은 「더 보기」.
   */
  import { getContext, onMount } from 'svelte';
  import { AUDIT_GROUPS, auditAction, auditDetailText } from '@web/account-audit-view';
  import { accountApi, type AccountAuditRow } from '#lib/account/api';
  import type { Session } from '#lib/account/session.svelte.ts';
  import { ago } from '#lib/detail/facts';
  import { Badge, Banner, Button, Card, DataTable, FieldMessage, type Column, type FilterChip } from '#lib/ui';

  const session = getContext<Session>('session');
  const PAGE = 100;

  let rows = $state<AccountAuditRow[]>([]);
  let next = $state<string | undefined>();
  let loading = $state(true);
  let more = $state(false);
  let denied = $state(false);
  let error = $state<string | undefined>();

  const load = async (append = false): Promise<void> => {
    if (append) more = true;
    const r = await accountApi.accountAudit(PAGE, append ? next : undefined);
    loading = false;
    more = false;
    if (!r.ok) {
      denied = r.status === 403;
      error = denied ? undefined : r.message;
      return;
    }
    rows = append ? [...rows, ...r.data.items] : r.data.items;
    next = r.data.next;
    error = undefined;
  };
  onMount(() => { void load(); });

  const subject = (r: AccountAuditRow): string => r.subjectName ?? (r.subjectUser === null ? '' : `(지운 사람 ${r.subjectUser.slice(0, 8)})`);
  const columns: Column<AccountAuditRow>[] = [
    { key: 'at', label: '때', width: '130px', mono: true, muted: true, hideable: false, sort: (r) => r.at, text: (r) => ago(r.at) ?? r.at },
    { key: 'actor', label: '누가', mono: true, width: '160px', sort: (r) => r.actor, text: (r) => r.actor },
    { key: 'action', label: '동작', hideable: false, sort: (r) => r.action, text: (r) => auditAction(r.action).label },
    { key: 'subject', label: '대상', mono: true, width: '150px', text: subject },
    { key: 'ip', label: 'IP', mono: true, muted: true, width: '130px', text: (r) => r.ip ?? '' },
    { key: 'detail', label: '자세히', muted: true, text: (r) => auditDetailText(r.detail) },
    { key: 'code', label: '동작 이름', mono: true, muted: true, hidden: true, text: (r) => r.action },
  ];
  const chips: FilterChip<AccountAuditRow>[] = AUDIT_GROUPS.map((g) => ({
    key: g.key, label: g.label, tone: 'neutral', match: (r) => auditAction(r.action).group === g.key,
  }));
</script>

{#snippet cell(r: AccountAuditRow, col: Column<AccountAuditRow>)}
  {#if col.key === 'action'}
    {@const a = auditAction(r.action)}
    <Badge tone={a.tone} icon={null}>{a.label}</Badge>
  {:else if col.key === 'at'}
    <span title={new Date(r.at).toLocaleString()}>{col.text?.(r) ?? ''}</span>
  {:else}{col.text?.(r) ?? ''}{/if}
{/snippet}

{#if !session.isAdmin || denied}
  <FieldMessage>관리자만 봐요.</FieldMessage>
{:else}
  <div class="aa">
    {#if error !== undefined}<Banner tone="danger" ondismiss={() => { error = undefined; }}>{error}</Banner>{/if}
    <Card title={`계정 기록 · ${rows.length}${next === undefined ? '' : '+'}`}
      sub="성공한 계정 동작만 남아요. 토큰 값, 비밀번호, 코드는 남기지 않아요." padded={false}>
      <DataTable {rows} rowKey={(r) => r.id} {columns} label="계정 감사" {cell} {chips} {loading}
        search={{ placeholder: '누가 · 동작 · 대상 · IP 로 찾기' }} minHeight="200px"
        emptyTitle="계정 기록이 없어요" emptyBody="로그인하거나 사용자를 초대하면 여기 남아요." />
      {#if next !== undefined}
        <div class="more"><Button size="sm" loading={more} onclick={() => { void load(true); }}>더 보기</Button></div>
      {/if}
    </Card>
  </div>
{/if}

<style>
  .aa { display: flex; flex-direction: column; gap: 16px; }
  .more { display: flex; justify-content: center; padding: 10px; }
</style>
