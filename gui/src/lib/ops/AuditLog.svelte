<script lang="ts">
  /** 감사 기록 — 누가 · 언제 · 무엇을 (`/api/v1/audit`). 검색은 주체 · 동작 · 대상 · 리비전을 본다. */
  import { getContext } from 'svelte';
  import type { AuditRow } from '@web/audit-view';
  import { DataTable, type Column } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const columns: Column<AuditRow>[] = [
    { key: 'at', label: '시각', mono: true, muted: true, width: '240px', text: (r) => (r.at === undefined ? '—' : new Date(r.at).toLocaleString()), sort: (r) => r.at ?? '' },
    { key: 'principal', label: '주체', mono: true, text: (r) => r.principal, sort: (r) => r.principal },
    { key: 'action', label: '동작', text: (r) => r.action, sort: (r) => r.action },
    { key: 'subject', label: '대상', mono: true, text: (r) => r.subject ?? '—', sort: (r) => r.subject ?? '' },
    { key: 'revision', label: '리비전', mono: true, width: '100px', text: (r) => (r.revision === undefined ? '' : `r${r.revision}`), sort: (r) => Number(r.revision ?? 0) },
  ];
  const match = (r: AuditRow, q: string): boolean =>
    [r.principal, r.action, r.subject ?? '', r.revision ?? ''].some((s) => s.toLowerCase().includes(q.toLowerCase()));
</script>

<DataTable
  rows={desk.audit.rows} rowKey={(r) => r.id} {columns} label="감사 기록" loading={!desk.live}
  search={{ placeholder: '주체 · 동작 · 대상 검색', match }} pageSize={50}
  emptyTitle="기록이 없어요"
/>
