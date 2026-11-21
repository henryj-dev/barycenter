<script lang="ts">
  /**
   * 「저장소」 — DB 종류 · 시크릿 저장소 · 보존 정책 · 마지막 청소 (`GET /api/v1/system/storage`, 2026-11-20).
   *
   * 비밀은 안 온다 — 종류 · 판 · 일수 · 건수뿐이다. 청소는 리더만 돌아 팔로워에는 결과가 없고, 그것을 0 건으로 쓰지 않는다.
   */
  import {
    daysText, dbText, everyText, generationsText, secretText, sweepText, TABLE_LABEL, type StorageBodyView,
  } from '@web/storage-view';
  import { DescriptionList, FieldMessage, Skeleton } from '#lib/ui';
  import { whenText } from './audit';

  let { body, loading = false, title = '저장소' }: { body: StorageBodyView | undefined; loading?: boolean; title?: string } = $props();

  type Item = { label: string; value: string; mono?: boolean; tone?: 'ok' | 'warn' | 'danger' };
  const toneOf = (t: 'ok' | 'warn' | 'danger' | 'neutral'): Item['tone'] => (t === 'neutral' ? undefined : t);
  const lastItem = (label: string, last: Parameters<typeof sweepText>[0], leader: boolean): Item => {
    const s = sweepText(last, leader);
    return { label, value: last === null ? s.text : `${whenText(last.at)} · ${s.text}`, tone: toneOf(s.tone) };
  };

  const dbItems = $derived.by<Item[]>(() => {
    if (body === undefined || !body.available) return [];
    return [
      { label: '설정 DB', value: dbText(body.configDb.kind, body.configDb.version), mono: true },
      { label: '계정 DB', value: body.accountsDb === null ? '사람 계정이 꺼져 있어요.' : dbText(body.accountsDb.kind), mono: body.accountsDb !== null },
      { label: '시크릿 저장소', value: secretText(body.secrets) },
    ];
  });
  const retentionItems = $derived.by<Item[]>(() => {
    if (body === undefined || !body.available) return [];
    return [
      ...body.retention.tables.map((t) => ({ label: TABLE_LABEL[t.table] ?? t.table, value: daysText(t.days) })),
      { label: '주기', value: everyText(body.retention.intervalMs) },
      lastItem('마지막 청소', body.retention.last, body.isLeader),
    ];
  });
  const cleanupItems = $derived.by<Item[]>(() => {
    if (body === undefined || !body.available) return [];
    return [
      { label: '세대 디렉토리', value: generationsText(body.generations) },
      lastItem('세대 청소', body.generations.last, body.isLeader),
      body.secretGc.enabled
        ? { label: '시크릿 청소', value: `${everyText(body.secretGc.intervalMs)} · 이름마다 ${body.secretGc.keepPerName}개 남겨요` }
        : { label: '시크릿 청소', value: 'ACME 가 꺼져 있어 돌지 않아요.' },
      ...(body.secretGc.enabled ? [lastItem('마지막 시크릿 청소', body.secretGc.last, body.isLeader)] : []),
    ];
  });
</script>

<section class="panel" aria-label={title}>
  <div class="ph">{title}</div>
  <div class="pad">
    {#if loading}
      <Skeleton height="120px" label="저장소 상태를 읽는 중" />
    {:else if body === undefined}
      <FieldMessage tone="error">저장소 상태를 못 읽었어요.</FieldMessage>
    {:else if !body.available}
      <FieldMessage>이 인스턴스는 저장소 상태를 내지 않아요.</FieldMessage>
    {:else}
      <div class="grid">
        <div><div class="sh">DB</div><DescriptionList items={dbItems} labelWidth="120px" /></div>
        <div><div class="sh">보존</div><DescriptionList items={retentionItems} labelWidth="120px" /></div>
        <div><div class="sh">정리</div><DescriptionList items={cleanupItems} labelWidth="120px" /></div>
      </div>
    {/if}
  </div>
</section>

<style>
  .panel { display: flex; flex-direction: column; background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; }
  .ph { padding: 10px 16px; border-bottom: 1px solid var(--bd); font-weight: 600; font-size: 14px; }
  .pad { padding: 12px 16px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px 24px; }
  .sh { font-size: 12px; color: var(--tx3); font-weight: 600; margin-bottom: 8px; }
</style>
