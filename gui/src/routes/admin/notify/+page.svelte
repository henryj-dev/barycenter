<script lang="ts">
  /**
   * 관리 › 알림 (036, 2026-11-20) — 운영자에게 알릴 통로 · 공통 값 · 보낸 기록.
   *
   * 저장하면 곧바로 쓰인다(설정 리비전이 아니다 — 커밋 · 적용이 없다). 다른 노드는 30초 안에 따라온다.
   * 비밀(웹훅 서명 비밀 · Slack 웹훅 URL)은 넣기만 한다 — 다시 보이지 않는다. 비밀을 바꾸거나 통로를 지울 때는
   * MFA 를 다시 물을 수 있다. 권한은 서버가 판정한다(관리자만) — 403 이면 「관리자만 봐요」 를 보인다.
   *
   * 지역마다 따로다. 전역 화면은 이 설정을 중계하지 않는다(비밀이 전역을 지나지 않게) — 지역 GUI 로 보낸다.
   */
  import { getContext, onMount } from 'svelte';
  import { ago } from '#lib/detail/facts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ChannelDrawer from '#lib/notify/ChannelDrawer.svelte';
  import {
    EVENT_LABEL, KIND_LABEL, notifyApi, OUTCOME, SEVERITY_LABEL,
    type Channel, type ChannelBody, type Delivery, type Knobs, type NotifyView,
  } from '#lib/notify/api';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import {
    Badge, Banner, Button, Card, ConfirmDialog, DataTable, FieldMessage, FormRow, FormSection, NumberInput, toast,
    type Column, type MenuItem,
  } from '#lib/ui';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const token = (): string => desk?.token ?? '';
  const global = $derived(scope?.mode === 'global');
  const blocked = $derived(scope?.blocked === true);

  let view = $state<NotifyView | undefined>();
  let loading = $state(true);
  let denied = $state(false);
  let error = $state<string | undefined>();
  let drawer = $state<{ channel?: Channel } | undefined>();
  let saving = $state(false);
  let drawerError = $state<string | undefined>();
  let deleting = $state<Channel | undefined>();
  let testing = $state<string | undefined>();
  let knobs = $state<Knobs | undefined>();
  let knobsSaving = $state(false);
  let log = $state<Delivery[]>([]);
  let logNext = $state<string | undefined>();
  let logLoading = $state(false);

  const load = async (): Promise<void> => {
    const r = await notifyApi.view(token());
    loading = false;
    if (!r.ok) {
      denied = r.status === 403;
      error = denied ? undefined : r.message;
      return;
    }
    view = r.data;
    knobs = r.data.settings === undefined ? undefined : { ...r.data.settings };
    error = undefined;
  };
  const loadLog = async (more = false): Promise<void> => {
    logLoading = true;
    const r = await notifyApi.deliveries(token(), { limit: 50, ...(more && logNext !== undefined ? { before: logNext } : {}) });
    logLoading = false;
    if (!r.ok) return;
    log = more ? [...log, ...r.data.items] : r.data.items;
    logNext = r.data.next;
  };
  onMount(() => { if (!global) void Promise.all([load(), loadLog()]); else loading = false; });

  const save = async (name: string, body: ChannelBody): Promise<void> => {
    saving = true;
    const r = await notifyApi.putChannel(token(), name, body);
    saving = false;
    if (!r.ok) { drawerError = r.message; return; }
    toast.ok(drawer?.channel === undefined ? '알림 통로를 만들었어요' : '알림 통로를 저장했어요', name);
    drawer = undefined;
    drawerError = undefined;
    await load();
  };
  const setEnabled = async (c: Channel, enabled: boolean): Promise<void> => {
    const r = await notifyApi.putChannel(token(), c.name, {
      kind: c.kind, enabled, minSeverity: c.settings.minSeverity,
      ...(c.settings.url === undefined ? {} : { url: c.settings.url }),
      ...(c.settings.to === undefined ? {} : { to: c.settings.to }),
      ...(c.settings.kinds === undefined ? {} : { kinds: c.settings.kinds }),
    });
    if (!r.ok) { error = r.message; return; }
    toast.ok(enabled ? '알림 통로를 켰어요' : '알림 통로를 껐어요', c.name);
    await load();
  };
  const remove = async (c: Channel): Promise<void> => {
    const r = await notifyApi.deleteChannel(token(), c.name);
    deleting = undefined;
    if (!r.ok) { error = r.message; return; }
    toast.ok('알림 통로를 지웠어요', c.name);
    await load();
  };
  const test = async (c: Channel): Promise<void> => {
    testing = c.name;
    const r = await notifyApi.test(token(), c.name);
    testing = undefined;
    if (!r.ok) { toast.fail('시험 전송을 못 했어요', r.message); return; }
    if (r.data.outcome === 'sent') toast.ok('시험 알림을 보냈어요', `${c.name} — 받았는지 확인해요.`);
    else toast.fail(`시험 전송이 실패했어요 (${OUTCOME[r.data.outcome]?.label ?? r.data.outcome})`, r.data.detail ?? '');
    await loadLog();
  };
  const saveKnobs = async (): Promise<void> => {
    if (knobs === undefined) return;
    knobsSaving = true;
    const r = await notifyApi.putKnobs(token(), knobs);
    knobsSaving = false;
    if (!r.ok) { toast.fail('공통 값을 저장하지 못했어요', r.message); return; }
    toast.ok('공통 값을 저장했어요');
    await load();
  };

  const knobError = (k: keyof Knobs): string | undefined => {
    const r = view?.ranges[k];
    const v = knobs?.[k];
    if (r === undefined || v === undefined) return undefined;
    return Number.isInteger(v) && v >= r.min && v <= r.max ? undefined : `${r.min}~${r.max} 사이의 정수예요.`;
  };
  const knobsChanged = $derived(view?.settings !== undefined && knobs !== undefined
    && (Object.keys(knobs) as (keyof Knobs)[]).some((k) => knobs![k] !== view!.settings![k]));
  const knobsValid = $derived(knobs !== undefined && (['repeatS', 'certDays', 'intervalS', 'queue'] as const).every((k) => knobError(k) === undefined));

  const problemOf = (c: Channel): string | undefined => view?.status.problems.find((p) => p.channel === c.name)?.problem;
  const target = (c: Channel): string => c.kind === 'webhook' ? (c.settings.url ?? '—')
    : c.kind === 'mail' ? (c.settings.to ?? []).join(', ') : (c.secretSet ? 'Slack 웹훅(비밀)' : '웹훅 URL 없음');
  const kindsText = (c: Channel): string => c.settings.kinds === undefined ? '전부'
    : c.settings.kinds.map((k) => EVENT_LABEL[k] ?? k).join(', ');

  const channelCols: Column<Channel>[] = [
    { key: 'name', label: '이름', mono: true, hideable: false, sort: (c) => c.name, text: (c) => c.name },
    { key: 'kind', label: '종류', width: '90px', text: (c) => KIND_LABEL[c.kind] },
    { key: 'state', label: '상태', width: '130px', hideable: false },
    { key: 'target', label: '대상', mono: true, muted: true, text: target },
    { key: 'kinds', label: '받을 사건', text: kindsText },
    { key: 'severity', label: '심각도', width: '100px', text: (c) => SEVERITY_LABEL[c.settings.minSeverity] },
    { key: 'updated', label: '고친 때', width: '120px', mono: true, muted: true, hidden: true, text: (c) => `${ago(c.updatedAt) ?? '—'} · ${c.updatedBy}` },
    { key: 'act', label: '', align: 'right', width: '120px', hideable: false },
  ];
  const channelMenu = (c: Channel): MenuItem[] => blocked ? [] : [
    { label: '고치기…', onselect: () => { drawerError = undefined; drawer = { channel: c }; } },
    { label: c.enabled ? '끄기' : '켜기', onselect: () => { void setEnabled(c, !c.enabled); } },
    { label: '지우기…', danger: true, onselect: () => { deleting = c; } },
  ];
  const logCols: Column<Delivery>[] = [
    { key: 'at', label: '때', width: '130px', mono: true, muted: true, hideable: false, text: (d) => ago(d.at) ?? d.at },
    { key: 'channel', label: '통로', mono: true, width: '140px', text: (d) => d.channel ?? '— (허브)' },
    { key: 'kind', label: '사건', text: (d) => EVENT_LABEL[d.kind] ?? d.kind },
    { key: 'outcome', label: '결과', width: '120px', hideable: false },
    { key: 'detail', label: '사유', muted: true, text: (d) => d.detail ?? '' },
    { key: 'key', label: '사건 키', mono: true, muted: true, hidden: true, text: (d) => d.key },
    { key: 'node', label: '노드', mono: true, muted: true, hidden: true, width: '100px', text: (d) => d.node },
  ];

  usePageActions(() => (view !== undefined && !blocked && !global ? head : undefined));
</script>

{#snippet head()}<Button variant="primary" onclick={() => { drawerError = undefined; drawer = {}; }}>＋ 통로 만들기</Button>{/snippet}

{#snippet channelCell(c: Channel, col: Column<Channel>)}
  {#if col.key === 'state'}
    {#if !c.enabled}<Badge tone="neutral" icon="○">꺼짐</Badge>
    {:else if problemOf(c) !== undefined}<Badge tone="warn" icon="▲" title={problemOf(c)}>못 보냄</Badge>
    {:else}<Badge tone="ok" icon="●">켜짐</Badge>{/if}
  {:else if col.key === 'act'}
    <Button size="xs" disabled={blocked} loading={testing === c.name} onclick={() => { void test(c); }}>시험 전송</Button>
  {:else}{col.text?.(c) ?? ''}{/if}
{/snippet}

{#snippet logCell(d: Delivery, col: Column<Delivery>)}
  {#if col.key === 'outcome'}
    <Badge tone={OUTCOME[d.outcome]?.tone ?? 'neutral'} icon={null}>{OUTCOME[d.outcome]?.label ?? d.outcome}</Badge>{#if d.test} <Badge tone="info" icon={null}>시험</Badge>{/if}
  {:else if col.key === 'at'}
    <span title={new Date(d.at).toLocaleString()}>{col.text?.(d) ?? ''}</span>
  {:else}{col.text?.(d) ?? ''}{/if}
{/snippet}

{#if global}
  <Banner tone="info">알림은 지역마다 따로 정해요. 비밀이 전역을 지나지 않게, 지역 GUI 에서 고쳐요. <a href="/regions">지역 고르기</a></Banner>
{:else if denied}
  <FieldMessage>관리자만 봐요.</FieldMessage>
{:else}
  <div class="nt">
    {#if error !== undefined}<Banner tone="danger" ondismiss={() => { error = undefined; }}>{error}</Banner>{/if}
    <WriteNote />
    {#if view !== undefined && !view.seeded}
      <Banner tone="warn">알림 설정이 아직 없어요. 데몬이 처음 뜰 때 만들어요 — 데몬을 다시 띄운 뒤 다시 열어요.</Banner>
    {/if}
    {#if view?.seededFrom === 'env'}
      <FieldMessage>처음 값은 환경 변수(BARY_NOTIFY_*)에서 왔어요. 지금은 여기 값이 정본이에요 — 환경 변수를 바꿔도 반영되지 않아요.</FieldMessage>
    {/if}

    <Card title={`통로 · ${view?.channels.length ?? 0}`} sub="켜진 통로로 사건을 보내요. 같은 사건은 재알림 간격 안에 다시 보내지 않아요." padded={false}>
      <DataTable rows={view?.channels ?? []} rowKey={(c) => c.name} columns={channelCols} label="알림 통로" cell={channelCell}
        rowMenu={channelMenu} {loading} minHeight="120px"
        emptyTitle="알림 통로가 없어요" emptyBody="웹훅 · Slack · 메일 통로를 만들면 적용 실패 · 인증서 만료 같은 사건을 알려요." />
    </Card>

    {#if knobs !== undefined && view !== undefined}
      <Card title="공통 값" sub="모든 통로에 같아요.">
        <FormSection>
          <FormRow label="재알림 간격" error={knobError('repeatS')} help="같은 사건을 다시 보내기 전에 기다리는 시간이에요.">
            <NumberInput bind:value={knobs.repeatS} unit="초" label="재알림 간격" width="110px" disabled={blocked} />
          </FormRow>
          <FormRow label="만료 임박 기준" error={knobError('certDays')} help="인증서 만료가 이 날 수 안이면 알려요.">
            <NumberInput bind:value={knobs.certDays} unit="일" label="만료 임박 기준" disabled={blocked} />
          </FormRow>
          <FormRow label="상태 보기 주기" error={knobError('intervalS')} help="끝나지 않은 전환 · 지역 연락 끊김은 이 주기의 2배를 기다려요.">
            <NumberInput bind:value={knobs.intervalS} unit="초" label="상태 보기 주기" disabled={blocked} />
          </FormRow>
          <FormRow label="큐 상한" error={knobError('queue')} help="보내기를 기다리는 사건의 상한이에요. 넘으면 가장 오래된 것을 버려요.">
            <NumberInput bind:value={knobs.queue} unit="개" label="큐 상한" disabled={blocked} />
          </FormRow>
        </FormSection>
        <div class="foot">
          <span class="hint">{knobsChanged ? '저장하면 곧바로 써요.' : '바뀐 것이 없어요.'}</span>
          <Button disabled={!knobsChanged || blocked} onclick={() => { knobs = view?.settings === undefined ? undefined : { ...view.settings }; }}>되돌리기</Button>
          <Button variant="primary" disabled={!knobsChanged || !knobsValid || blocked} loading={knobsSaving} onclick={() => { void saveKnobs(); }}>저장</Button>
        </div>
      </Card>
    {/if}

    <Card title="보낸 기록" sub="보낸 결과 · 시험 전송 · 큐에서 버린 것이에요. 30일 동안 남아요. 되풀이로 거른 것은 남기지 않아요." padded={false}>
      <DataTable rows={log} rowKey={(d) => d.id} columns={logCols} label="보낸 기록" cell={logCell} loading={logLoading && log.length === 0}
        search={{ placeholder: '통로 · 사건 · 사유로 찾기' }} minHeight="160px"
        emptyTitle="보낸 기록이 없어요" emptyBody="통로를 만들고 「시험 전송」 을 누르면 여기 남아요." />
      {#if logNext !== undefined}<div class="more"><Button size="sm" loading={logLoading} onclick={() => { void loadLog(true); }}>더 보기</Button></div>{/if}
    </Card>
  </div>
{/if}

{#if drawer !== undefined && view !== undefined}
  <ChannelDrawer channel={drawer.channel} kinds={view.kinds} mailAvailable={view.status.mailAvailable} busy={saving} error={drawerError}
    onsave={(n, b) => { void save(n, b); }} onclose={() => { drawer = undefined; }} />
{/if}

{#if deleting !== undefined}
  <ConfirmDialog open title={`알림 통로 지우기: ${deleting.name}`} sub="지우면 이 통로로 더 보내지 않아요. 넣어 둔 비밀도 지워요."
    lines={[{ tone: 'warn', icon: '▲', text: '되돌릴 수 없어요. 다시 쓰려면 비밀을 다시 넣어 새로 만들어요.' }]}
    confirmLabel="지우기" requireName={deleting.name}
    oncancel={() => { deleting = undefined; }} onconfirm={() => { const c = deleting; if (c !== undefined) void remove(c); }} />
{/if}

<style>
  .nt { display: flex; flex-direction: column; gap: 16px; }
  .foot { display: flex; gap: 8px; align-items: center; justify-content: flex-end; margin-top: 12px; }
  .hint { margin-right: auto; font: var(--t-cap); color: var(--tx2); }
  .more { display: flex; justify-content: center; padding: 10px; }
</style>
