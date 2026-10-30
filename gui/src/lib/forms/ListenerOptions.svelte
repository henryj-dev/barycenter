<script lang="ts">
  /**
   * 리스너 옵션 — 제안 6·7·8 (2026-08-23), 시안 구획: 타임아웃과 본문 · 레이트리밋 · 헤더 규칙 · priority 정책.
   *
   * **HTTP 와 HTTPS 폼이 이 하나를 함께 쓴다.** 두 벌로 두면 한쪽만 고치는 날이 오고,
   * 그때 "HTTPS 에서는 레이트리밋이 안 걸린다" 가 된다.
   *
   * 기본은 **접혀 있다**(「고급 옵션」). 리스너를 여는 사람 대부분은 이것을 안 건드린다.
   *
   * 값은 문자열 그대로 올린다 — 단위 해석(`50m` → 바이트, `120s` → ms)은
   * `parseListenerOptions` 한 자리다. 여기서 또 바꾸면 GUI 와 CLI 가 갈린다.
   */
  import type { ListenerOptionFlags } from '@web/edit';
  import { Disclosure, FormRow, FormSection, KeyValueEditor, Switch, TextInput, type KvRow } from '#lib/ui';

  let { value = $bindable() }: { value: ListenerOptionFlags } = $props();

  let f = $state({ connectTimeout: '', readTimeout: '', sendTimeout: '', maxBody: '', rate: '', burst: '', maxConn: '' });
  let rateOn = $state(false);
  let nodelay = $state(false);
  let strictPriority = $state(false);
  /** 헤더 행. 이름이 빈 행은 버린다 — 여기서 지우게 강요하지 않는다. */
  let headers = $state<KvRow[]>([]);
  const DIRS = [{ value: 'req', label: '요청' }, { value: 'res', label: '응답' }] as const;

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
    const specs = headers.filter((r) => r.name.trim() !== '').map((r) => `${r.op ?? 'req'}:${r.name.trim()}:${r.value}`);
    value.header = specs.length === 0 ? undefined : specs;
  });
</script>

<Disclosure title="고급 옵션" hint="타임아웃 · 본문 크기 · 헤더 · 레이트리밋 · priority">
  <FormSection title="타임아웃과 본문" hint="단위를 적어요">
    <FormRow label="연결 타임아웃" for="lo-ct" help="예: 5s · 1500ms">
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
      <FormRow label="초당 요청" for="lo-rate" required><TextInput id="lo-rate" bind:value={f.rate} placeholder="10r/s" width="160px" /></FormRow>
      <FormRow label="burst" for="lo-burst" help="초당 요청 없이 burst 만 넣으면 저장하지 못해요.">
        <TextInput id="lo-burst" bind:value={f.burst} placeholder="20" width="160px" />
      </FormRow>
      <FormRow label="nodelay" help="켜면 burst 요청을 지연 없이 처리해요."><Switch bind:checked={nodelay}>켜요</Switch></FormRow>
      <FormRow label="동시 연결" for="lo-mc"><TextInput id="lo-mc" bind:value={f.maxConn} placeholder="100" width="160px" /></FormRow>
    {/if}
  </FormSection>

  <FormSection title="헤더 규칙">
    <FormRow label="규칙" help="요청 헤더는 백엔드로 보내기 전에, 응답 헤더는 클라이언트로 보내기 전에 걸어요.">
      <KeyValueEditor bind:rows={headers} ops={DIRS} namePlaceholder="X-Tenant" addLabel="＋ 헤더를 더해요" />
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
</Disclosure>
