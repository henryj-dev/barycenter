<script lang="ts">
  /**
   * 백업 · 복원 (2026-11-21) — 운영 › 백업·복원.
   *
   * - 내보내기: 리비전 하나의 spec-only 매니페스트를 파일로 받는다(`GET /config/export`).
   * - 백업 받기: head 의 매니페스트 + 리비전(`GET /backup`). 시크릿 바이트는 없다 — 인증서 자료는 참조만 간다.
   * - 가져오기: 파일을 올려 **먼저 미리 본다**(`POST /config/import` 의 `preview`). merge 는 파일에 있는 것만 맞추고,
   *   replace 는 파일에 없는 리소스를 지운다. 커밋은 미리 본 head 에서만 한다(`base_revision`) — 그 사이 head 가 움직이면 다시 미리 본다.
   * - 복원(admin): 늘 replace 다. 미리 본 뒤 「복원」 을 넣어야 열린다. step-up 을 묻는다.
   *
   * 가져오기와 복원은 **커밋만** 한다. 트래픽은 적용 대기 화면에서 적용해야 바뀐다.
   * **전역에서는 쓰지 않는다** — 지역 하나의 전체 설정이 전역 한 곳에 모이지 않게 한다(`LOCAL_ONLY_PATHS`). 「이 지역에서 열기 ↗」 를 보인다.
   */
  import { getContext } from 'svelte';
  import {
    changeLines, changeSummary, downloadName, impactLines, parseUpload,
    type ImportPreview, type PreviewLine, type UploadedConfig,
  } from '@web/backup-view';
  import { Badge, Button, Card, ConfirmDialog, FieldMessage, RadioGroup, Select, toast } from '#lib/ui';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import { openIn } from '#lib/global/open-in';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { Session } from '#lib/account/session.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const session = getContext<Session | undefined>('session');
  const global = $derived(scope?.mode === 'global');
  const here = $derived(scope === undefined ? undefined : openIn(scope, '/ops/backup'));
  const blocked = $derived(scope?.blocked === true);
  const admin = $derived(session?.isAdmin === true);

  /** 한 번에 보일 바뀌는 줄. 넘으면 「외 N」 으로 접는다. */
  const SHOW = 40;

  // ── 내보내기 · 백업 받기 ────────────────────────────────────────────────
  let revs = $state<{ value: string; label: string }[]>([]);
  let rev = $state<string | undefined>();
  $effect(() => {
    void desk.head;
    if (global || !desk.live) return;
    void desk.revisions().then((r) => {
      const rows = (r ?? []) as { revision: string; createdAt?: string }[];
      revs = rows.map((x, i) => ({ value: x.revision, label: i === 0 ? `r${x.revision} (head)` : `r${x.revision}` }));
      if (rev === undefined || !rows.some((x) => x.revision === rev)) rev = rows[0]?.revision;
    });
  });

  const save = (name: string, doc: unknown): void => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  let exporting = $state(false);
  const doExport = async (): Promise<void> => {
    exporting = true;
    try {
      const doc = await desk.exportConfig(rev);
      if (doc === undefined) { toast.fail('내보내기를 못 했어요', '연결을 확인하고 다시 해요.'); return; }
      save(downloadName('export', rev ?? 'head', scope?.region?.name), doc);
    } finally { exporting = false; }
  };
  let backing = $state(false);
  const doBackup = async (): Promise<void> => {
    backing = true;
    try {
      const b = await desk.backupBundle();
      if (b === undefined) { toast.fail('백업을 못 받았어요', '연결을 확인하고 다시 해요.'); return; }
      save(downloadName('backup', b.revision, scope?.region?.name), b);
    } finally { backing = false; }
  };

  // ── 가져오기 · 복원 (같은 틀, 다른 모드) ─────────────────────────────────
  type Flow = {
    file?: UploadedConfig; fileName?: string; fileError?: string;
    preview?: ImportPreview; previewError?: string; busy: boolean; confirm: boolean;
  };
  const fresh = (): Flow => ({ busy: false, confirm: false });
  let imp = $state<Flow>(fresh());
  let res = $state<Flow>(fresh());
  let mode = $state<'merge' | 'replace'>('merge');

  const pick = async (flow: Flow, ev: Event): Promise<void> => {
    const input = ev.currentTarget as HTMLInputElement;
    const f = input.files?.[0];
    flow.preview = undefined; flow.previewError = undefined; flow.file = undefined; flow.fileError = undefined;
    if (f === undefined) return;
    flow.fileName = f.name;
    const parsed = parseUpload(await f.text());
    if ('error' in parsed) flow.fileError = parsed.error;
    else flow.file = parsed;
  };
  const preview = async (flow: Flow, m: 'merge' | 'replace'): Promise<void> => {
    if (flow.file === undefined) return;
    flow.busy = true;
    flow.preview = undefined; flow.previewError = undefined;
    try {
      const r = await desk.importPreview(flow.file.manifest, m);
      if (r.ok) flow.preview = r.body as unknown as ImportPreview;
      else flow.previewError = r.message;
    } finally { flow.busy = false; }
  };
  const commit = async (flow: Flow, m: 'merge' | 'replace', restore: boolean): Promise<void> => {
    if (flow.file === undefined || flow.preview === undefined) return;
    flow.busy = true;
    try {
      const ok = await desk.importCommit(flow.file.manifest, m, flow.preview.revision, restore);
      flow.confirm = false;
      if (ok) {
        toast.ok(restore ? '복원을 커밋했어요' : '가져오기를 커밋했어요', '적용 대기 화면에서 영향을 보고 적용해요.');
        Object.assign(flow, fresh());
      } else {
        // head 가 움직였으면 미리 본 것이 낡았다 — 지우고 다시 보게 한다.
        flow.previewError = desk.error ?? '커밋을 못 했어요.';
        flow.preview = undefined;
      }
    } finally { flow.busy = false; }
  };

  const linesOf = (p: ImportPreview | undefined): { changes: PreviewLine[]; more: number; impact: PreviewLine[] } => {
    if (p === undefined) return { changes: [], more: 0, impact: [] };
    const all = changeLines(p.changes);
    return { changes: all.slice(0, SHOW), more: Math.max(0, all.length - SHOW), impact: impactLines(p) };
  };
  const impView = $derived(linesOf(imp.preview));
  const resView = $derived(linesOf(res.preview));
  const removes = (p: ImportPreview | undefined): number => p?.changes.filter((c) => c.change === 'removed').length ?? 0;
  const confirmLines = (p: ImportPreview | undefined): PreviewLine[] => p === undefined ? [] : [
    { tone: 'info', icon: 'ⓘ', text: `head r${p.revision} 에 ${changeSummary(p.changes)} 를 커밋해요.` },
    ...(removes(p) > 0 ? [{ tone: 'danger' as const, icon: '▲', text: `리소스 ${removes(p)}개를 지워요. 지운 것은 롤백으로만 되돌려요.` }] : []),
    { tone: 'warn', icon: '▲', text: '트래픽은 바로 바뀌지 않아요. 적용 대기 화면에서 적용해야 바뀌어요.' },
  ];
  const MODES = [
    { value: 'merge' as const, label: '합치기 — 파일에 있는 것만 맞춰요' },
    { value: 'replace' as const, label: '바꾸기 — 파일에 없는 리소스는 지워요' },
  ];
</script>

{#snippet previewBlock(flow: Flow, view: { changes: PreviewLine[]; more: number; impact: PreviewLine[] })}
  {#if flow.previewError !== undefined}
    <FieldMessage tone="error">{flow.previewError}</FieldMessage>
  {:else if flow.preview !== undefined}
    {#if flow.preview.unchanged}
      <FieldMessage tone="ok">지금 head(r{flow.preview.revision})와 같아요. 커밋할 것이 없어요.</FieldMessage>
    {:else}
      <p class="sum"><b>미리 본 head r{flow.preview.revision}</b> · {changeSummary(flow.preview.changes)}</p>
      <ul class="lines">
        {#each view.changes as l, i (i)}<li><span style:color="var(--{l.tone})">{l.icon}</span> <code>{l.text}</code></li>{/each}
        {#if view.more > 0}<li class="more">외 {view.more}개</li>{/if}
      </ul>
      {#if view.impact.length > 0}
        <ul class="lines impact">
          {#each view.impact as l, i (i)}<li><span style:color="var(--{l.tone})">{l.icon}</span> {l.text}</li>{/each}
        </ul>
      {/if}
    {/if}
  {/if}
{/snippet}

{#snippet fileRow(flow: Flow, id: string)}
  <div class="file">
    <input {id} type="file" accept="application/json,.json" onchange={(e) => void pick(flow, e)} />
    {#if flow.file !== undefined}
      <span class="meta">리소스 {flow.file.resources}개{#if flow.file.fromRevision !== undefined} · 백업한 리비전 r{flow.file.fromRevision}{/if}</span>
    {/if}
  </div>
  {#if flow.fileError !== undefined}<FieldMessage tone="error">{flow.fileError}</FieldMessage>{/if}
{/snippet}

{#if global}
  <Card title="지역에서 해요">
    <p class="note">
      백업 · 복원은 지역 하나의 전체 설정을 다뤄요. 전역 화면은 이 설정을 모으지 않아요.
      {#if here !== undefined}<a href={here.href} target="_blank" rel="noopener">{here.label}</a>{:else}<a href="/regions">지역 고르기</a>{/if}
    </p>
  </Card>
{:else}
  <div class="grid">
    <Card title="내보내기" sub="리비전 하나의 설정을 JSON 파일로 받아요. 시크릿 값은 없어요.">
      <div class="row">
        <Select bind:value={rev} options={revs} label="리비전" width="220px" />
        <Button onclick={() => void doExport()} loading={exporting} disabled={rev === undefined}>내려받기</Button>
      </div>
    </Card>

    <Card title="백업 받기" sub="head 의 설정과 리비전 번호를 파일 하나로 받아요. 인증서 개인키는 들어가지 않아요 — 참조만 들어가요.">
      <div class="row">
        <Button onclick={() => void doBackup()} loading={backing}>백업 받기</Button>
        {#if desk.head !== undefined}<span class="meta">지금 head r{desk.head}</span>{/if}
      </div>
    </Card>

    <Card title="가져오기" sub="파일의 설정을 커밋해요. 먼저 미리 보고, 그다음 커밋해요.">
      {#if blocked}
        <WriteNote />
      {:else}
        {@render fileRow(imp, 'bk-import')}
        <div class="mode">
          <RadioGroup bind:value={mode} options={MODES} label="가져오는 방법" direction="column" onchange={() => { imp.preview = undefined; }} />
          {#if mode === 'replace'}<FieldMessage tone="warn">▲ 파일에 없는 리소스를 지워요. 일부만 담은 파일이면 「합치기」 를 써요.</FieldMessage>{/if}
        </div>
        <div class="row">
          <Button onclick={() => void preview(imp, mode)} loading={imp.busy && imp.preview === undefined} disabled={imp.file === undefined}>미리 보기</Button>
          {#if imp.preview !== undefined && !imp.preview.unchanged}
            <Button variant={mode === 'replace' ? 'danger' : 'primary'} onclick={() => { imp.confirm = true; }}>커밋…</Button>
          {/if}
        </div>
        {@render previewBlock(imp, impView)}
      {/if}
    </Card>

    <Card title="복원" sub="백업 파일로 설정 전체를 되돌려요. 백업에 없는 리소스는 지워요. 관리자만 해요.">
      {#if !admin}
        <p class="note">관리자만 복원해요. <Badge tone="neutral" icon={null}>admin</Badge></p>
      {:else if blocked}
        <WriteNote />
      {:else}
        {@render fileRow(res, 'bk-restore')}
        <div class="row">
          <Button onclick={() => void preview(res, 'replace')} loading={res.busy && res.preview === undefined} disabled={res.file === undefined}>미리 보기</Button>
          {#if res.preview !== undefined && !res.preview.unchanged}
            <Button variant="danger" onclick={() => { res.confirm = true; }}>복원…</Button>
          {/if}
        </div>
        {@render previewBlock(res, resView)}
      {/if}
    </Card>
  </div>

  {#if imp.confirm && imp.preview !== undefined}
    <ConfirmDialog open title={mode === 'replace' ? '가져오기(바꾸기): 파일에 없는 리소스를 지워요' : '가져오기(합치기): 파일의 설정을 커밋해요'}
      sub={imp.fileName} lines={confirmLines(imp.preview)} danger={mode === 'replace'}
      requireCheck={removes(imp.preview) > 0} confirmLabel="커밋" busy={imp.busy}
      oncancel={() => { imp.confirm = false; }} onconfirm={() => void commit(imp, mode, false)} />
  {/if}
  {#if res.confirm && res.preview !== undefined}
    <ConfirmDialog open title="복원: 설정 전체를 백업으로 되돌려요" sub={res.fileName}
      lines={confirmLines(res.preview)} requireName="복원" nameLabel="복원하려면 똑같이 넣어요:"
      confirmLabel="복원" busy={res.busy}
      oncancel={() => { res.confirm = false; }} onconfirm={() => void commit(res, 'replace', true)} />
  {/if}
{/if}

<style>
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(340px, 1fr)); gap: 16px; align-items: start; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-top: 8px; }
  .mode { margin-top: 12px; display: flex; flex-direction: column; gap: 6px; }
  .file { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .meta { font: var(--t-small); color: var(--tx2); }
  .note { margin: 0; font: var(--t-small); color: var(--tx2); }
  .note a { color: var(--accent); margin-left: 6px; }
  .sum { margin: 12px 0 6px; font: var(--t-small); }
  .lines { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font: var(--t-small); max-height: 320px; overflow: auto; }
  .lines.impact { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--bd); }
  .lines code { font: var(--t-mono); }
  .more { color: var(--tx2); }
</style>
