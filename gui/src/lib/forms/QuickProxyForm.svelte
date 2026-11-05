<script lang="ts">
  /**
   * 빠른 프록시 만들기 — 콘솔 시안 `fieldsFor('quick', v, true, 'drawer')` 의 번호 붙은 구획과 「만들 리소스」 상자.
   *   1. 대상 종류 · 2. 리스너 · 3. 호스트 (선택) / 호스트와 경로 · 4. 외부 주소 · 5. 인증서와 TLS 정책(새 HTTPS) · 6. 출발지 제한 (선택)
   * 펴는 규칙은 CLI `bary proxy create` 와 같은 `proxyFromUrlPatch` 다. 저장은 커밋까지다.
   *
   * 실제 동작이 시안과 다른 곳:
   *   · 대상 종류의 「내 서버들 (백엔드 목록)」 은 이 만들기 길(`proxyFromUrlPatch`)에 없다 — 고를 수 없게 두고 까닭을 말한다.
   *   · 인증서는 「기존 인증서 선택」 만 있다(업로드 · ACME 발급은 인증서 화면에서 한다).
   *   · 「같은 결과를 만드는 명령」 은 CLI 가 받는 꼴만 낸다 — 새 HTTPS 리스너는 CLI 플래그가 없어서 안 낸다.
   */
  import { getContext } from 'svelte';
  import { parseSourceAllow, proxyFromUrlPatch, type ProxyFromUrlInput } from '@web/edit';
  import { urlCheck } from '#lib/forms/url-check';
  import { Button, FormRow, FormSection, RadioGroup, Select, TextInput, toast } from '#lib/ui';
  import { itemOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import SourceAllowSection from './SourceAllowSection.svelte';
  import { KEY_ERROR, bindHelp, keyError, portError, words } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const httpListeners = $derived(desk.listeners.rows.filter((l) => (l.protocol === 'http' || l.protocol === 'https')).map((l) => ({ value: l.key })));
  const certs = $derived(desk.certs.rows.filter((c) => c.hasMaterial).map((c) => ({ value: c.key })));
  /** 시안 「modern (TLS 1.2+)」. */
  const policies = $derived(desk.policies.map((p) => {
    const min = itemOf(desk.model, 'tlsPolicy', p)?.['minVersion'];
    return { value: p, label: typeof min === 'string' ? `${p} (${min.replace(/^TLSv?/, 'TLS ')}+)` : p };
  }));

  let name = $state('');
  let url = $state('');
  let target = $state<'new' | 'existing'>('new');
  let protocol = $state<'http' | 'https'>('http');
  let bind = $state('127.0.0.1');
  let port = $state('80');
  let listener = $state<string | undefined>();
  let hosts = $state('');
  let path = $state('/');
  let policy = $state<string | undefined>();
  let certificate = $state<string | undefined>();
  let allow = $state('');
  let allowBad = $state(false);
  let problem = $state<string | undefined>();
  /** URL 칸은 `urlCheck`(해요체)로 먼저 본다 — 빌더의 해라체 오류를 화면 문구로 쓰지 않는다. */
  const urlErr = $derived(url.trim() === '' ? undefined : urlCheck(url));
  const hostOn = $derived(hosts.trim() !== '');
  const existing = $derived(target === 'existing');
  const newHttps = $derived(!existing && protocol === 'https');

  const input = $derived.by((): ProxyFromUrlInput => {
    const hostList = words(hosts);
    return {
      name: name.trim(),
      url: url.trim(),
      ...(!existing
        ? {
            listen: { bind: bind.trim(), port: Number(port) },
            protocol,
            ...(protocol === 'https' ? { tls: { policy: policy ?? '', certificate: certificate ?? '' } } : {}),
          }
        : { listener: listener ?? '' }),
      ...(hostList.length > 0 ? { hosts: hostList } : {}),
      ...(hostList.length > 0 && path.trim() !== '' && path.trim() !== '/' ? { pathPrefix: path.trim() } : {}),
    };
  });
  /** 시안 「풀어 쓴 결과」 · 「만들 리소스」 — 저장 전에 무엇이 생기는지. 틀린 입력이면 빈 목록. */
  const ops = $derived.by((): { kind: string; key: string }[] => {
    if (name.trim() === '' || url.trim() === '' || urlErr !== undefined) return [];
    try {
      const sa = !existing ? parseSourceAllow(allow) : undefined;
      return proxyFromUrlPatch({ ...input, ...(sa === undefined ? {} : { sourceAllow: sa }) }).map((o) => ({ kind: o.kind, key: o.key }));
    } catch {
      return [];
    }
  });
  const KIND: Record<string, string> = { listener: '리스너', pool: '풀', backend: '백엔드', httpRoute: '라우트' };
  /** 시안 「같은 결과를 만드는 명령」 — CLI `bary proxy create` 가 받는 꼴. */
  const cmd = $derived.by((): string | undefined => {
    if (ops.length === 0 || newHttps) return undefined;
    const sa = !existing ? parseSourceAllowSafe(allow) : undefined;
    return [
      'bary proxy create', `--name ${name.trim()}`, `--url ${url.trim()}`,
      existing ? `--listener ${listener ?? ''}` : `--listen ${bind.trim()}:${port.trim()}`,
      ...(hostOn ? [`--host ${words(hosts).join(',')}`] : []),
      ...(input.pathPrefix !== undefined ? [`--path-prefix ${input.pathPrefix}`] : []),
      ...(sa !== undefined && sa.length > 0 ? [`--allow ${sa.join(',')}`] : []),
    ].join(' ');
  });
  function parseSourceAllowSafe(t: string): string[] | undefined { try { return parseSourceAllow(t); } catch { return undefined; } }
  const copy = (): void => {
    if (cmd === undefined) return;
    void navigator.clipboard?.writeText(cmd).catch(() => undefined);
    toast.ok('명령을 복사했어요', '터미널에 붙여 넣어요.');
  };

  const ready = $derived(ops.length > 0 && keyError(name) === undefined && !allowBad && (existing ? listener !== undefined : portError(port) === undefined)
    && (!existing || hostOn) && (!newHttps || (policy !== undefined && certificate !== undefined)));
  const save = (): void => {
    problem = undefined;
    try {
      const sa = !existing ? parseSourceAllow(allow) : undefined;
      void desk.proxyFromUrl({ ...input, ...(sa === undefined ? {} : { sourceAllow: sa }) }).then(after(!existing ? resourcePath('listener', name.trim()) : resourcePath('httpRoute', name.trim())));
    } catch {
      problem = '이 입력으로는 만들 수 없어요. 대상 URL · 호스트 · 경로 · 출발지 칸을 확인해요.';
    }
  };
  $effect(() => { port = protocol === 'https' ? '443' : '80'; });
  /** 시안 `T()` — 보이는 구획에 차례로 번호를 단다. */
  const n = $derived({ host: 3, ext: 4, cert: 5, src: newHttps ? 6 : 5 });
</script>

<CreateForm {ready} {problem} onsubmit={save} cancelHref="/traffic/listener">
  <FormSection title="1. 대상 종류">
    <FormRow label="대상" help="백엔드 목록으로 만들기는 이 길에 없어요. 풀 · 백엔드 · 리스너를 따로 만들어요.">
      <RadioGroup label="대상" value="external" direction="column"
        options={[{ value: 'servers', label: '내 서버들 (백엔드 목록)', disabled: true }, { value: 'external', label: '외부 주소 (URL)' }]} />
    </FormRow>
  </FormSection>

  <FormSection title="2. 리스너">
    <FormRow label="리스너" help={existing ? '기존 리스너에는 라우트만 붙여요. 호스트가 필요해요.' : undefined}>
      <RadioGroup label="리스너" bind:value={target} direction="column"
        options={[{ value: 'new', label: '새 리스너' }, { value: 'existing', label: '기존 리스너', disabled: httpListeners.length === 0 }]} />
    </FormRow>
    {#if existing}
      <FormRow label="이름"><Select label="이름" bind:value={listener} options={httpListeners} placeholder="리스너를 골라요" width="100%" /></FormRow>
    {:else}
      <FormRow label="프로토콜">
        <Select label="프로토콜" bind:value={protocol} options={[{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }]} mono={false} width="100%" />
      </FormRow>
      <FormRow label="바인드 주소" for="qp-bind" error={bind.trim() === '' ? '주소를 입력해요.' : undefined} warn={bind.trim() === '0.0.0.0'} help={bindHelp(bind)}><TextInput id="qp-bind" bind:value={bind} /></FormRow>
      <FormRow label="포트" for="qp-port" error={port.trim() === '' || portError(port) !== undefined ? '포트는 1–65535 사이여야 해요.' : undefined}>
        <TextInput id="qp-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" />
      </FormRow>
    {/if}
  </FormSection>

  <FormSection title={`${n.host}. ${hostOn ? '호스트와 경로' : '호스트 (선택)'}`}>
    <FormRow label="호스트" for="qp-hosts" error={existing && !hostOn ? '기존 리스너에는 호스트가 필요해요.' : undefined}
      help={existing ? '호스트를 입력해요. 기존 리스너에는 라우트가 필요해요.' : '비우면 라우트를 만들지 않아요. 입력하면 라우트를 하나 만들어요.'}>
      <TextInput id="qp-hosts" bind:value={hosts} autocomplete="off" />
    </FormRow>
    {#if hostOn}
      <FormRow label="경로 접두사" for="qp-path" help="이 접두사로 시작하는 요청과 맞아요. *는 쓰지 않아요.">
        <TextInput id="qp-path" bind:value={path} autocomplete="off" />
      </FormRow>
    {/if}
  </FormSection>

  <FormSection title={`${n.ext}. 외부 주소`}>
    <FormRow label="이름" for="qp-name" error={name.trim() !== '' && keyError(name) !== undefined ? KEY_ERROR : undefined} help={existing ? '풀은 이름, 백엔드는 이름-1, 라우트는 이름이에요.' : '풀은 이름, 백엔드는 이름-1, 리스너와 라우트는 같은 이름이에요.'}>
      <TextInput id="qp-name" bind:value={name} invalid={keyError(name) !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="URL" for="qp-url" error={urlErr} help="예: https://api.example.com/v1/ · http와 https만 쓸 수 있어요. 포트를 생략하면 443(https)이나 80(http)이에요.">
      <TextInput id="qp-url" bind:value={url} autocomplete="off" />
    </FormRow>
    <FormRow label="풀어 쓴 결과">
      <div class="res">
        {#each ops as o (o.kind + o.key)}<div class="ri"><span>{KIND[o.kind] ?? o.kind}</span><span class="mono">{o.key}</span></div>{/each}
        {#if ops.length === 0}<div class="empty">URL을 입력하면 만들어질 리소스를 보여 줘요.</div>{/if}
      </div>
    </FormRow>
  </FormSection>

  {#if newHttps}
    <FormSection title={`${n.cert}. 인증서와 TLS 정책`}>
      <FormRow label="인증서" help={certs.length === 0 ? '자료가 있는 인증서가 없어요. 인증서를 먼저 넣어요.' : undefined}>
        <Select label="인증서" bind:value={certificate} options={certs} placeholder="인증서를 골라요" width="100%" disabled={certs.length === 0} />
      </FormRow>
      <FormRow label="TLS 정책" help="HTTPS 리스너에는 TLS 정책과 기본 인증서가 모두 필요해요.">
        <Select label="TLS 정책" bind:value={policy} options={policies} placeholder="정책을 골라요" width="100%" disabled={policies.length === 0} />
      </FormRow>
    </FormSection>
  {/if}

  {#if !existing}<SourceAllowSection bind:value={allow} bind:invalid={allowBad} {port} http title={`${n.src}. 출발지 제한 (선택)`} />{/if}

  <div class="sum">
    <div class="st">만들 리소스</div>
    {#each ops as o (o.kind + o.key)}<div class="op"><span class="plus">＋</span><span>{KIND[o.kind] ?? o.kind} <span class="mono">{o.key}</span></span></div>{/each}
    <div class="note">한 번에 커밋하고 적용 대기로 보내요.</div>
    {#if cmd !== undefined}
      <div class="st cmdt">같은 결과를 만드는 명령</div>
      <div class="cmd"><code>{cmd}</code><Button size="sm" onclick={copy}>복사</Button></div>
    {/if}
  </div>
</CreateForm>

<style>
  /* 값은 시안 `f.dRes` · `quickSumD` 블록의 인라인 style 그대로다. */
  .res { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); }
  .ri { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px; font-size: 12px; }
  .ri span:first-child { color: var(--tx3); }
  .mono { font-family: var(--mono); word-break: break-all; }
  .empty { font-size: 12px; color: var(--tx3); }
  .sum { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); font-size: 13px; }
  .st { font-size: 12px; font-weight: 600; color: var(--tx2); }
  .cmdt { margin-top: 4px; }
  .op { display: flex; gap: 8px; }
  .plus { color: var(--ok); }
  .note { font-size: 12px; color: var(--tx3); }
  .cmd { display: flex; gap: 8px; align-items: flex-start; }
  .cmd code {
    flex: 1; min-width: 0; font-family: var(--mono); font-size: 12px; line-height: 18px; word-break: break-all;
    padding: 6px 8px; background: var(--bg-input); border: 1px solid var(--bd); border-radius: var(--r-sm);
  }
</style>
