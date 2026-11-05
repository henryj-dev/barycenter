<script lang="ts">
  /**
   * 풀 설정 탭의 「헬스체크」 (2026-11-02). 전에는 고칠 곳이 없어 JSON 을 손으로 고쳐야 했다 — web-01 의 counter 백엔드가
   * Host 없는 `GET /` 에 400 을 받아 빠졌을 때 경로 · Host 헤더를 고칠 칸이 없었다.
   *
   * 이 폼은 `healthCheck` 만 바꾸고 나머지(알고리즘 · 업스트림 TLS · hash 키)는 그대로 둔다(`poolBodyWithHealth`).
   * 위에 이 풀 백엔드들의 **지금 판정과 그 이유**를 보인다 — 무엇을 고쳐야 하는지가 거기 있다(예: 「400 다 (2xx 가 아니다)」).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { Banner, Button, Card, Disclosure, Form, FormRow, FormSection, RadioGroup, TextInput } from '#lib/ui';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import { HEALTH_DEFAULT, healthFormOf, healthIssue, poolBodyWithHealth, type HealthMode } from '@web/health-check';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const pool = $derived(itemOf(desk.model, 'pool', key));
  const protocolClass = $derived(String(pool?.['protocolClass'] ?? ''));

  let f = $state({ ...HEALTH_DEFAULT });
  let loaded = $state<string | undefined>();
  let problem = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 모델이 바뀌어도 입력 중인 값을 덮지 않는다(업스트림 TLS 폼과 같다).
  $effect(() => {
    if (pool === undefined || loaded === key) return;
    f = healthFormOf(pool);
    loaded = key;
  });

  const MODES = $derived<{ value: HealthMode; label: string; hint?: string }[]>([
    { value: 'default', label: '기본', hint: protocolClass === 'http' ? 'HTTP GET / · 2xx' : 'TCP 연결' },
    { value: 'http', label: 'HTTP' },
    { value: 'tcp', label: 'TCP 연결' },
    { value: 'none', label: '안 해요', hint: '백엔드가 늘 트래픽을 받아요' },
  ]);

  /** 이 풀 백엔드들의 지금 판정. */
  const verdicts = $derived(itemsOf(desk.model, 'backend')
    .filter((b) => b['pool'] === key)
    .map((b) => {
      const h = desk.health.find((x) => x.backendKey === b['key']) as { state?: string; detail?: string } | undefined;
      return { key: String(b['key']), addr: `${String(b['host'])}:${String(b['port'])}`, state: h?.state ?? 'unknown', detail: h?.detail };
    }));

  const issue = $derived(healthIssue(f));
  const ready = $derived(pool !== undefined && issue === undefined);
  const save = (): void => {
    if (!ready || pool === undefined || desk.editing) return;
    problem = undefined;
    let body: Record<string, unknown>;
    try {
      body = poolBodyWithHealth(pool, f);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return;
    }
    void desk.putResource('pool', key, body).then(after(resourcePath('pool', key)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#if pool !== undefined}
  <Writable>
    <Card title="헬스체크" sub="프로버가 백엔드를 어떻게 찌르나">
      {#if verdicts.length > 0}
        <ul class="now">
          {#each verdicts as v (v.key)}
            <li data-state={v.state}>
              <b>{v.key}</b> <code>{v.addr}</code> — {v.state === 'healthy' ? '정상' : v.state === 'unhealthy' ? '비정상' : '모름'}{v.detail === undefined ? '' : ` · ${v.detail}`}
            </li>
          {/each}
        </ul>
      {/if}
      <Form note="저장하면 커밋해요. 적용하면 프로버가 새 방식으로 찔러요." onsubmit={save}>
        <FormSection>
          <FormRow label="방식"><RadioGroup label="헬스체크 방식" bind:value={f.mode} options={MODES} /></FormRow>
          {#if f.mode === 'http'}
            <FormRow label="경로" for="hc-path" help="비우면 / 예요. 예: /healthz · /status">
              <TextInput id="hc-path" bind:value={f.path} autocomplete="off" placeholder="/status" />
            </FormRow>
            <FormRow label="Host 헤더" for="hc-host" help="이름으로 사이트를 고르는 백엔드는 이게 있어야 답해요. 비우면 찌르는 주소예요.">
              <TextInput id="hc-host" bind:value={f.hostHeader} autocomplete="off" placeholder="app.example.com" />
            </FormRow>
            <FormRow label="기대 상태 코드" for="hc-status" help="쉼표로 여러 개. 비우면 2xx 예요. 예: 200, 204, 301">
              <TextInput id="hc-status" bind:value={f.expectStatus} autocomplete="off" placeholder="200" />
            </FormRow>
            <FormRow label="기대 본문" for="hc-body" help="본문이 이것과 같아야 살았다고 봐요. 비우면 본문을 안 봐요.">
              <TextInput id="hc-body" bind:value={f.expectBody} autocomplete="off" placeholder="ok" />
            </FormRow>
          {/if}
          {#if f.mode === 'http' || f.mode === 'tcp'}
            <Disclosure title="더 보기" hint="별도 포트 · 주소 · 주기 · 판정 횟수">
              <FormRow label="포트" for="hc-port" help="비우면 백엔드 포트예요."><TextInput id="hc-port" bind:value={f.port} autocomplete="off" placeholder="8080" /></FormRow>
              <FormRow label="주소" for="hc-addr" help="사이드카 프로브용. 비우면 백엔드 주소예요."><TextInput id="hc-addr" bind:value={f.hostOverride} autocomplete="off" /></FormRow>
              <FormRow label="주기" for="hc-int"><TextInput id="hc-int" bind:value={f.intervalS} autocomplete="off" placeholder="2" unit="s" /></FormRow>
              <FormRow label="타임아웃" for="hc-to" help="주기보다 길 수 없어요."><TextInput id="hc-to" bind:value={f.timeoutS} autocomplete="off" placeholder="1" unit="s" /></FormRow>
              <FormRow label="rise" for="hc-rise" help="몇 번 연속 성공하면 살았다고 보나."><TextInput id="hc-rise" bind:value={f.rise} autocomplete="off" placeholder="2" /></FormRow>
              <FormRow label="fall" for="hc-fall" help="몇 번 연속 실패하면 죽었다고 보나."><TextInput id="hc-fall" bind:value={f.fall} autocomplete="off" placeholder="3" /></FormRow>
            </Disclosure>
          {/if}
        </FormSection>
        {#if issue !== undefined}<Banner tone="warn">{issue}</Banner>{/if}
        {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
        {#snippet actions()}
          <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '저장 중' : '저장'}</Button>
          <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
        {/snippet}
      </Form>
    </Card>
  </Writable>
{/if}

<style>
  .now { margin: 0 0 12px; padding-left: 18px; font-size: 13px; }
  .now li { margin: 2px 0; overflow-wrap: anywhere; }
  .now li[data-state='unhealthy'] { color: var(--danger, inherit); }
</style>
