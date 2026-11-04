<script lang="ts" module>
  /**
   * 모델의 `http` 프로필 → 폼 문자열. 설정 탭이 head 값으로 칸을 채울 때 쓴다.
   * 단위는 `parseListenerOptions` 가 다시 읽는 꼴로 쓴다(`120s` · `1500ms` · `50m` · `512k`) — 왕복해도 값이 같다.
   */
  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);
  const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const ms = (v: unknown): string => { const n = num(v); return n === undefined ? '' : n % 1000 === 0 ? `${n / 1000}s` : `${n}ms`; };
  const bytes = (v: unknown): string => {
    const n = num(v);
    if (n === undefined) return '';
    if (n !== 0 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)}m`;
    if (n !== 0 && n % 1024 === 0) return `${n / 1024}k`;
    return String(n);
  };
  const str = (v: unknown): string => (num(v) === undefined ? '' : String(v));
  const rowsOf = (v: unknown): { name: string; value: string }[] =>
    (Array.isArray(v) ? v : []).map((r) => obj(r) ?? {}).map((r) => ({ name: String(r['name'] ?? ''), value: String(r['value'] ?? '') }));

  export function optionStateOf(http: unknown): {
    f: { connectTimeout: string; readTimeout: string; sendTimeout: string; maxBody: string; rate: string; burst: string; maxConn: string };
    rateOn: boolean; nodelay: boolean; strictPriority: boolean;
    request: { name: string; value: string }[]; response: { name: string; value: string }[];
  } {
    const h = obj(http) ?? {};
    const l = obj(h['limits']) ?? {};
    const r = obj(h['rateLimit']);
    const hd = obj(h['headers']) ?? {};
    return {
      f: {
        connectTimeout: ms(l['connectTimeoutMs']), readTimeout: ms(l['readTimeoutMs']), sendTimeout: ms(l['sendTimeoutMs']),
        maxBody: bytes(l['clientMaxBodyBytes']),
        rate: str(r?.['requestsPerSecond']), burst: str(r?.['burst']), maxConn: str(r?.['maxConnections']),
      },
      rateOn: r !== undefined, nodelay: r?.['nodelay'] === true, strictPriority: h['strictPriority'] === true,
      request: rowsOf(hd['request']), response: rowsOf(hd['response']),
    };
  }
</script>

<script lang="ts">
  /**
   * 리스너 옵션 — 제안 6·7·8 (2026-08-23), 시안 구획: 타임아웃과 본문 · 레이트리밋 · 요청 헤더 규칙 · 응답 헤더 규칙 · priority 정책.
   *
   * **HTTP 와 HTTPS 폼, 만들기와 설정 탭이 이 하나를 함께 쓴다.** 두 벌로 두면 한쪽만 고치는 날이 오고,
   * 그때 "HTTPS 에서는 레이트리밋이 안 걸린다" 가 된다.
   *
   * 만들기에서는 **접혀 있다**(「고급 옵션」) — 리스너를 여는 사람 대부분은 이것을 안 건드린다. 설정 탭은 `seed` 로
   * head 값을 채우고 펼쳐 둔다(`folded={false}`).
   *
   * 값은 문자열 그대로 올린다 — 단위 해석(`50m` → 바이트, `120s` → ms)은
   * `parseListenerOptions` 한 자리다. 여기서 또 바꾸면 GUI 와 CLI 가 갈린다.
   *
   * 예약 헤더는 해독기(`RESERVED_REQUEST_HEADERS` · `RESERVED_RESPONSE_HEADERS`)가 막는다. 여기서는 같은 이름을 미리 짚는다.
   */
  import type { ListenerOptionFlags } from '@web/edit';
  import { Disclosure, FormRow, FormSection, KeyValueEditor, Switch, TextInput, type KvRow } from '#lib/ui';

  let { value = $bindable(), seed, folded = true, ok = $bindable(true) }: {
    value: ListenerOptionFlags;
    /** 예약 헤더가 없으면 참 — 폼이 저장 버튼을 잠근다. */
    ok?: boolean;
    /** 설정 탭 — head 의 `http` 프로필. 처음 한 번만 읽는다(입력 중인 값을 덮지 않는다). */
    seed?: unknown;
    folded?: boolean;
  } = $props();

  // svelte-ignore state_referenced_locally
  const init = optionStateOf(seed);
  let f = $state(init.f);
  let rateOn = $state(init.rateOn);
  let nodelay = $state(init.nodelay);
  let strictPriority = $state(init.strictPriority);
  /** 헤더 행. 이름이 빈 행은 버린다 — 여기서 지우게 강요하지 않는다. */
  let request = $state<KvRow[]>(init.request);
  let response = $state<KvRow[]>(init.response);

  const RESERVED_REQUEST = ['x-forwarded-for', 'x-forwarded-proto', 'upgrade', 'connection'];
  const reservedIn = (rows: KvRow[], names: string[]): string | undefined =>
    rows.find((r) => names.includes(r.name.trim().toLowerCase()))?.name.trim();
  const requestBad = $derived(reservedIn(request, RESERVED_REQUEST));
  const responseBad = $derived(reservedIn(response, ['strict-transport-security']));

  $effect(() => { ok = requestBad === undefined && responseBad === undefined; });

  const opt = (s: string): string | undefined => (s.trim() === '' ? undefined : s.trim());
  $effect(() => {
    value.connectTimeout = opt(f.connectTimeout);
    value.readTimeout = opt(f.readTimeout);
    value.sendTimeout = opt(f.sendTimeout);
    value.maxBody = opt(f.maxBody);
    // 레이트리밋을 끄면 그 칸들은 안 보낸다 — 숨긴 칸의 값이 몰래 실리지 않게.
    value.rate = rateOn ? opt(f.rate) : undefined;
    value.burst = rateOn ? opt(f.burst) : undefined;
    value.maxConn = rateOn ? opt(f.maxConn) : undefined;
    value.nodelay = rateOn && nodelay ? true : undefined;
    value.strictPriority = strictPriority ? true : undefined;
    const specs = [
      ...request.filter((r) => r.name.trim() !== '').map((r) => `req:${r.name.trim()}:${r.value}`),
      ...response.filter((r) => r.name.trim() !== '').map((r) => `res:${r.name.trim()}:${r.value}`),
    ];
    value.header = specs.length === 0 ? undefined : specs;
  });
</script>

{#snippet sections()}
  <FormSection title="타임아웃과 본문" hint="단위를 적어요">
    <FormRow label="연결 타임아웃" for="lo-ct" help="예: 5s · 1500ms. 비우면 nginx 기본값이에요.">
      <TextInput id="lo-ct" bind:value={f.connectTimeout} placeholder="5s" width="160px" />
    </FormRow>
    <FormRow label="읽기 타임아웃" for="lo-rt"><TextInput id="lo-rt" bind:value={f.readTimeout} placeholder="120s" width="160px" /></FormRow>
    <FormRow label="쓰기 타임아웃" for="lo-st"><TextInput id="lo-st" bind:value={f.sendTimeout} placeholder="90s" width="160px" /></FormRow>
    <FormRow label="요청 본문 최대" for="lo-mb" help="예: 50m · 512k · 바이트 수. 0 이면 무제한이에요.">
      <TextInput id="lo-mb" bind:value={f.maxBody} placeholder="50m" width="160px" />
    </FormRow>
  </FormSection>

  <FormSection title="레이트리밋">
    <FormRow label="레이트리밋" help="동작이 redirect 나 reject 인 라우트에는 걸리지 않아요.">
      <Switch bind:checked={rateOn}>켜요</Switch>
    </FormRow>
    {#if rateOn}
      <FormRow label="초당 요청" for="lo-rate" help="초당 요청이나 동시 연결 중 하나는 넣어요."><TextInput id="lo-rate" bind:value={f.rate} placeholder="10r/s" width="160px" /></FormRow>
      <FormRow label="burst" for="lo-burst" help="초당 요청 없이 burst 만 넣으면 저장하지 못해요.">
        <TextInput id="lo-burst" bind:value={f.burst} placeholder="20" width="160px" />
      </FormRow>
      <FormRow label="nodelay" help="켜면 burst 요청을 지연 없이 처리해요."><Switch bind:checked={nodelay}>켜요</Switch></FormRow>
      <FormRow label="동시 연결" for="lo-mc"><TextInput id="lo-mc" bind:value={f.maxConn} placeholder="100" width="160px" /></FormRow>
    {/if}
  </FormSection>

  <FormSection title="요청 헤더 규칙">
    <FormRow label="규칙" error={requestBad === undefined ? undefined : `${requestBad} 는 쓸 수 없어요.`}
      help="백엔드로 보내기 전에 요청에 걸어요. X-Forwarded-For, X-Forwarded-Proto, Upgrade, Connection은 쓸 수 없어요.">
      <KeyValueEditor bind:rows={request} ops={[]} namePlaceholder="X-Tenant" addLabel="＋ 헤더를 더해요" />
    </FormRow>
  </FormSection>

  <FormSection title="응답 헤더 규칙">
    <FormRow label="규칙" error={responseBad === undefined ? undefined : `${responseBad} 는 TLS 정책에서만 정해요.`}
      help="클라이언트로 보내기 전에 응답에 걸어요. Strict-Transport-Security는 TLS 정책에서만 정해요.">
      <KeyValueEditor bind:rows={response} ops={[]} namePlaceholder="X-Frame-Options" addLabel="＋ 헤더를 더해요" />
    </FormRow>
  </FormSection>

  <FormSection title="priority 정책">
    <FormRow
      label="priority 우선"
      help="켜면 라우트 priority 를 매치 클래스보다 앞세워요(S10). 겨루는 호스트를 정규식으로 내려 순서를 지켜요. 강등마다 요청당 비용이 붙어서(250개에서 +9.8%) 상한은 128개예요."
    >
      <Switch bind:checked={strictPriority}>켜요</Switch>
    </FormRow>
  </FormSection>
{/snippet}

{#if folded}
  <Disclosure title="고급 옵션" hint="타임아웃 · 본문 크기 · 헤더 · 레이트리밋 · priority">{@render sections()}</Disclosure>
{:else}
  {@render sections()}
{/if}
