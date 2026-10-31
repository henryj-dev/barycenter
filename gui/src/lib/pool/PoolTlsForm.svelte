<script lang="ts">
  /**
   * 풀 설정 탭의 「백엔드로 가는 TLS」 (2026-10-31). 풀의 다른 칸은 아래 JSON 수정이 맡는다 — 이 폼은
   * `upstreamTls` 만 바꾸고 나머지(알고리즘 · 헬스체크 · hash 키)는 그대로 둔다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { Banner, Button, Form } from '#lib/ui';
  import { itemOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import { poolBodyWithUpstreamTls, upstreamTlsFormOf, upstreamTlsIssue, UPSTREAM_TLS_OFF } from '@web/upstream-tls';
  import UpstreamTlsField from '#lib/forms/UpstreamTlsField.svelte';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const pool = $derived(itemOf(desk.model, 'pool', key));
  const protocolClass = $derived(String(pool?.['protocolClass'] ?? ''));

  let tls = $state({ ...UPSTREAM_TLS_OFF });
  let loaded = $state<string | undefined>();
  let problem = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 모델이 바뀌어도 입력 중인 값을 덮지 않는다(리스너 폼과 같다).
  $effect(() => {
    if (pool === undefined || loaded === key) return;
    tls = upstreamTlsFormOf(pool);
    loaded = key;
  });

  const ready = $derived(pool !== undefined && upstreamTlsIssue(protocolClass, tls) === undefined);
  const save = (): void => {
    if (!ready || pool === undefined || desk.editing) return;
    problem = undefined;
    let body: Record<string, unknown>;
    try {
      body = poolBodyWithUpstreamTls(pool, tls);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return;
    }
    // 저장하면 상세로 간다(리스너 폼 · JSON 수정과 같다). 여기 머물면 스트림이 모델을 바꾸기 전의 값으로 다시 채워져,
    // 아래 JSON 칸이 옛 값을 들고 있다가 그 저장이 이 변경을 되돌린다(랩에서 잡았다).
    void desk.putResource('pool', key, body).then(after(resourcePath('pool', key)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#if pool !== undefined}
  <Writable>
    <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={save}>
      <UpstreamTlsField bind:value={tls} {protocolClass} />
      {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
      {#snippet actions()}
        <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '저장 중' : '저장'}</Button>
        <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
      {/snippet}
    </Form>
  </Writable>
{/if}
