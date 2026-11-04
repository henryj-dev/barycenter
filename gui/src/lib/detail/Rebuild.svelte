<script lang="ts">
  /**
   * HTTP 라우트를 URL 로 다시 만든다 — 콘솔 시안 「URL로 다시 만들기」 드로어(`rebuild`, 500px)와 변경 확인 대화상자.
   *
   * 라우트의 리스너·호스트·경로는 그대로 두고 대상을 새 URL 로 바꾼다. 이름이 같은 풀과
   * `<이름>-1` 백엔드를 만들거나 덮는다 — 펴는 규칙은 빠른 프록시와 같다(`proxyFromUrlPatch`).
   * URL 은 대상만 정한다 — 풀 · 경로 바꾸기 · `Host` 헤더. 출발지 규칙 · 우선순위 · WebSocket · 다른 요청 헤더는
   * `keep` 으로 넘겨 그대로 둔다 (2026-11-04).
   *
   * 드로어(시안 `extSecs('외부 주소')`): URL · 풀어 쓴 결과(빌더가 낸 patch 에서 읽는다 — 화면이 규칙을 다시 짓지 않는다) ·
   * 예시 요청(맞은 경로 접두사를 URL 경로로 갈아 새 대상에 붙인다). 끝의 `/` 가 경로 접두사와 URL 경로에서 다르면 경로가 붙거나
   * 겹친다 — patch 빌더가 거절하는 것을 칸 아래에서 먼저 말한다. URL 칸은 `urlCheck`(해요체)로 먼저 본다.
   * 「확인」 을 누르면 시안 `askRebuild` 의 대화상자가 「풀과 백엔드, 라우트가 아래처럼 바뀌어요.」 를 말하고, 「위 영향을
   * 확인했어요」 를 눌러야 「다시 만들기」 가 열린다. 대상 풀을 다른 라우트도 쓰면 함께 바뀐다고 말한다.
   *
   * 시안과 다른 곳: 시안의 「경로 그대로 전달」 토글과 「고급」(인증서 검증 · CA 번들 · 헬스체크 방식)은 다시 만들기 빌더에 없는
   * 설정이라 두지 않는다. 대화상자에는 시안 줄 외에 이미 있던 사실 — 덮어쓰는 풀 · 백엔드, URL 값으로 바뀌는 지금 설정 — 을 더 말한다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { proxyFromUrlPatch, type HeaderRuleInput, type ProxyFromUrlOp, type SourceRuleInput } from '@web/edit';
  import { RESOURCES, itemOf, itemsOf, resourcePath, type ResourceKind } from '@web/resources';
  import { ConfirmDialog, FormRow, FormSection, TextInput, type ConfirmLine } from '#lib/ui';
  import { exampleRequest, matchPrefix, rewritePath, slashMismatch } from '#lib/forms/rewrite';
  import { urlCheck } from '#lib/forms/url-check';
  import { after } from '#lib/after';
  import CreateForm from '#lib/forms/CreateForm.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const route = $derived(itemOf(desk.model, 'httpRoute', key));
  let url = $state('');
  let asking = $state(false);
  let exPath = $state('');
  const act = $derived((typeof route?.['action'] === 'object' && route['action'] !== null ? route['action'] : {}) as Record<string, unknown>);
  const input = $derived(route === undefined ? undefined : {
    name: key,
    url: url.trim(),
    listener: String(route['listener']),
    hosts: Array.isArray(route['hosts']) ? route['hosts'] as string[] : [],
    ...(typeof route['pathPrefix'] === 'string' ? { pathPrefix: route['pathPrefix'] } : {}),
    // 경로가 여럿인 라우트도 그대로 둔다 (2026-11-02) — 빠뜨리면 다시 만들 때 `/` 하나가 된다.
    ...(Array.isArray(route['pathPrefixes']) ? { pathPrefixes: route['pathPrefixes'] as string[] } : {}),
    // 대상이 아닌 설정은 그대로 둔다 — 빠뜨리면 다시 만들 때 사라진다 (2026-11-04).
    keep: {
      ...(typeof route['priority'] === 'number' ? { priority: route['priority'] } : {}),
      ...(Array.isArray(route['sourceRules']) ? { sourceRules: route['sourceRules'] as SourceRuleInput[] } : {}),
      ...(act['kind'] === 'proxy' && typeof act['websocket'] === 'boolean' ? { websocket: act['websocket'] } : {}),
      ...(Array.isArray(act['requestHeaders']) ? { requestHeaders: act['requestHeaders'] as HeaderRuleInput[] } : {}),
    },
  });
  /** URL 칸의 오류(해요체). 비어 있으면 아직 말하지 않는다 — 미리보기 자리가 안내한다. */
  const urlErr = $derived(url.trim() === '' ? undefined : urlCheck(url));
  const preview = $derived.by((): { ops: ProxyFromUrlOp[]; error?: string } => {
    if (input === undefined || input.url === '') return { ops: [], error: '새 URL을 넣으면 만들 리소스가 여기 보여요.' };
    if (urlErr !== undefined) return { ops: [], error: urlErr };
    if (slashErr !== undefined) return { ops: [], error: slashErr };
    try {
      return { ops: proxyFromUrlPatch(input) };
    } catch {
      // 빌더의 말은 CLI 용 해라체다 — 위에서 못 거른 것만 여기 온다.
      return { ops: [], error: '이 URL로는 다시 만들 수 없어요. URL과 라우트의 경로를 확인해요.' };
    }
  });
  /** 시안 「풀어 쓴 결과」 — 빌더가 낸 patch 를 읽는다. */
  const resolved = $derived.by((): { label: string; value: string; mono?: boolean }[] => {
    const pool = preview.ops.find((o) => o.kind === 'pool');
    const be = preview.ops.find((o) => o.kind === 'backend');
    const rt = preview.ops.find((o) => o.kind === 'httpRoute');
    if (pool === undefined || be === undefined || rt === undefined) return [];
    const tls = (pool.body as { upstreamTls?: { enabled: boolean; sni?: string } }).upstreamTls;
    const b = be.body as { host: string; port: number };
    const a = (rt.body as { action: { requestHeaders?: HeaderRuleInput[]; rewritePrefix?: string } }).action;
    const hostHdr = a.requestHeaders?.find((h) => h.name === 'Host')?.value ?? '';
    return [
      { label: '풀', value: `${pool.key} (HTTP, 업스트림 TLS ${tls?.enabled === true ? '켬' : '끔'})`, mono: true },
      { label: '백엔드', value: `${b.host.includes(':') ? `[${b.host}]` : b.host}:${b.port}`, mono: true },
      { label: 'SNI', value: tls?.enabled !== true ? '없음 (TLS를 쓰지 않아요)' : tls.sni ?? '없음 (IP 주소)', mono: tls?.sni !== undefined },
      { label: 'Host 헤더', value: `${hostHdr} (이 라우트에만)`, mono: true },
      { label: '경로', value: a.rewritePrefix === undefined ? '접두사를 바꾸지 않아요' : `맞은 접두사 ${paths.join(', ')} → ${a.rewritePrefix} 로 바꿔 보내요` },
    ];
  });
  /** 대상 풀(`<이름>`)을 이미 쓰는 다른 라우트 — 다시 만들면 그 라우트들의 대상도 바뀐다. */
  const sharing = $derived(itemsOf(desk.model, 'httpRoute').filter((r) => {
    if (r['key'] === key) return false;
    const a = r['action'] as { pool?: unknown } | undefined;
    const rules = Array.isArray(r['sourceRules']) ? r['sourceRules'] as { action?: { pool?: unknown } }[] : [];
    return a?.pool === key || rules.some((x) => x.action?.pool === key);
  }).length);
  const label = (kind: string): string => (RESOURCES as Record<string, { label: string } | undefined>)[kind]?.label ?? kind;
  const isProxy = $derived(act['kind'] === 'proxy');
  const paths = $derived(input === undefined ? ['/'] : input.pathPrefixes ?? [input.pathPrefix ?? '/']);
  /** URL 을 읽을 수 있으면 출처(`https://host[:port]`)와 경로. 못 읽으면 `undefined` — 오류는 URL 칸이 말한다. */
  const target = $derived.by((): { origin: string; path: string } | undefined => {
    if (urlCheck(url) !== undefined) return undefined;
    try {
      const u = new URL(url.trim());
      return u.protocol === 'http:' || u.protocol === 'https:' ? { origin: u.origin, path: u.pathname === '' ? '/' : u.pathname } : undefined;
    } catch { return undefined; }
  });
  const slashErr = $derived(target !== undefined && paths.some((p) => slashMismatch(p, target.path))
    ? '끝의 /가 URL 경로와 같아야 해요. 다르면 경로가 붙거나 겹쳐요.' : undefined);
  const req = $derived(exPath.trim() === '' ? exampleRequest(paths) : exPath.trim());
  const hit = $derived(matchPrefix(paths, req));
  // `/` → `/` 는 바꾸지 않는다(patch 빌더와 같다).
  const outUrl = $derived(target === undefined || hit === undefined ? undefined
    : target.origin + (rewritePath(hit, target.path === '/' && paths.every((p) => p === '/') ? '' : target.path, req) ?? ''));
  /** 다시 만들면 URL 값으로 바뀌는 지금 설정 — 대상에 딸린 것뿐이다. 다른 설정은 `keep` 으로 그대로 간다. */
  const replaced = $derived.by((): string[] => {
    if (route === undefined) return [];
    const host = Array.isArray(act['requestHeaders'])
      ? (act['requestHeaders'] as HeaderRuleInput[]).find((h) => h.name.trim().toLowerCase() === 'host') : undefined;
    return [
      ...(host !== undefined ? [`Host 헤더 ${host.value}`] : []),
      ...(typeof act['rewritePrefix'] === 'string' ? [`경로 바꾸기 ${act['rewritePrefix']}`] : []),
    ];
  });

  /** 이 라우트 자신은 대상만 바뀐다. 다른 것은 있으면 덮고, 없으면 만든다. */
  const fate = (o: { kind: string; key: string }): 'self' | 'over' | 'new' =>
    (o.kind === 'httpRoute' && o.key === key ? 'self'
      : (o.kind === 'pool' || o.kind === 'backend') && itemOf(desk.model, o.kind as ResourceKind, o.key) !== undefined ? 'over' : 'new');
  /** 드로어의 「확인」 — 대화상자를 연다. 오류가 있으면 열지 않는다. */
  const ready = $derived(isProxy && preview.error === undefined && !desk.editing);
  /** 시안 `askRebuild` 의 줄 — 풀 · 라우트가 어떻게 바뀌나, 함께 쓰는 라우트. 그 뒤에 덮어쓰는 것 · URL 값으로 바뀌는 지금 설정. */
  const lines = $derived.by((): ConfirmLine[] => {
    const pool = preview.ops.find((o) => o.kind === 'pool');
    const be = preview.ops.find((o) => o.kind === 'backend');
    const rt = preview.ops.find((o) => o.kind === 'httpRoute');
    if (pool === undefined || be === undefined || rt === undefined) return [];
    const tls = (pool.body as { upstreamTls?: { enabled: boolean } }).upstreamTls?.enabled === true;
    const b = be.body as { host: string; port: number };
    const a = (rt.body as { action: { requestHeaders?: HeaderRuleInput[]; rewritePrefix?: string } }).action;
    const hostHdr = a.requestHeaders?.find((h) => h.name === 'Host')?.value ?? '';
    const out: ConfirmLine[] = [
      { tone: 'info', icon: '↻', text: `풀 ${pool.key}: ${b.host.includes(':') ? `[${b.host}]` : b.host}:${b.port} · 업스트림 TLS ${tls ? '켬' : '끔'}` },
      { tone: 'info', icon: '↻', text: `라우트 ${key}: ${a.rewritePrefix === undefined ? '경로를 그대로 보내요' : `경로 ${paths.join(', ')} → ${a.rewritePrefix}`} · Host 헤더 ${hostHdr}` },
    ];
    if (sharing > 0) out.push({ tone: 'warn', icon: '▲', text: `이 풀을 라우트 ${sharing + 1}개가 함께 써요. 모두 바뀌어요.` });
    for (const o of preview.ops) if (fate(o) === 'over') out.push({ tone: 'warn', icon: '▲', text: `${label(o.kind)} ${o.key}: 이미 있어요 — 덮어요` });
    if (replaced.length > 0) out.push({ tone: 'warn', icon: '▲', text: `URL 값으로 바뀌어요: ${replaced.join(' · ')}` });
    return out;
  });
  const confirm = (): void => {
    if (input === undefined || desk.editing) return;
    void desk.proxyFromUrl(input).then((ok) => { asking = false; after(resourcePath('httpRoute', key))(ok); });
  };
</script>

{#if route !== undefined && !isProxy}
  <p class="empty">이 라우트는 풀로 보내지 않아요. URL로 다시 만들기는 풀로 보내는 라우트에만 있어요. <a href={resourcePath('httpRoute', key)}>라우트로 돌아가요</a>.</p>
{:else if route !== undefined && input !== undefined}
  <CreateForm {ready} submitLabel="확인" onsubmit={() => { asking = true; }}>
    <FormSection title="외부 주소">
      <FormRow label="URL" for="rb-url" error={urlErr ?? slashErr} help="예: https://api.example.com/v1/ · http와 https만 쓸 수 있어요. 포트를 생략하면 443(https)이나 80(http)이에요.">
        <TextInput id="rb-url" bind:value={url} invalid={(urlErr ?? slashErr) !== undefined} autocomplete="off" />
      </FormRow>
      <FormRow label="풀어 쓴 결과" help={resolved.length > 0 ? '도메인의 IP는 컨트롤 플레인이 갱신할 때 바뀌어요. IP가 자주 바뀌면 반영이 늦을 수 있어요.' : undefined}>
        <div class="res">
          {#each resolved as r (r.label)}<div class="ri"><span class="k">{r.label}</span><span class="v">{r.value}</span></div>{/each}
          {#if resolved.length === 0}<div class="none">URL을 입력하면 만들어질 리소스를 보여 줘요.</div>{/if}
        </div>
      </FormRow>
      <FormRow label="예시 요청" for="rb-ex">
        <div class="pv">
          <div class="pvq"><span class="get">GET</span><TextInput id="rb-ex" aria-label="예시 요청 경로" value={req} autocomplete="off" oninput={(e) => { exPath = e.currentTarget.value; }} /></div>
          <div class="out" class:miss={target !== undefined && outUrl === undefined} aria-label="백엔드로 가는 URL">→ {outUrl ?? '—'}</div>
        </div>
        {#if target !== undefined}
          <div class="ph" class:warn={outUrl === undefined}>{outUrl === undefined ? '이 경로는 접두사와 맞지 않아요. 라우트에 걸리지 않아요.' : `접두사 ${hit}를 ${target.path}로 바꿔 보내요.`}</div>
        {/if}
      </FormRow>
    </FormSection>
  </CreateForm>
  <ConfirmDialog bind:open={asking} title="URL로 다시 만들기" sub="풀과 백엔드, 라우트가 아래처럼 바뀌어요." {lines}
    confirmLabel="다시 만들기" requireCheck busy={desk.editing} onconfirm={confirm} />
{/if}

<style>
  .empty { color: var(--tx2); font: var(--t-small); }
  /* 시안 `resolved` 상자 · `preview` 줄 인라인 style 그대로. */
  .res { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); }
  .ri { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px; font-size: 12px; }
  .k { color: var(--tx3); }
  .v { font-family: var(--mono); word-break: break-all; }
  .none { font-size: 12px; color: var(--tx3); }
  .pv { display: flex; flex-direction: column; gap: 6px; }
  .pvq { display: flex; align-items: center; gap: 6px; }
  .pvq :global(input) { flex: 1; min-width: 0; }
  .get { font-family: var(--mono); font-size: 12px; color: var(--tx3); }
  .out { font-family: var(--mono); font-size: 13px; color: var(--tx); word-break: break-all; }
  .out.miss { color: var(--warn); }
  .ph { margin-top: 4px; font-size: 12px; color: var(--tx3); }
  .ph.warn { color: var(--warn); }
</style>
