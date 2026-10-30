<script lang="ts">
  /**
   * 만들기 폼의 틀 (#126) — 시안의 만들기 드로어 아래 줄과 같다: 「만들기」 · 「취소」 ·
   * 「만들면 커밋하고 적용 대기로 보내요.」
   *
   * 연결 전이면 폼을 그리지 않는다. 전역 모드면 `Writable` 이 지역 GUI 링크로 바꾼다.
   * 저장 중(`desk.editing`)이면 버튼이 스피너다. 서버가 거절한 말은 셸의 오류 배너가 보인다.
   * 여기 `problem` 은 폼이 보내기 전에 잡은 것만이다.
   */
  import { getContext, type Snippet } from 'svelte';
  import { Banner, Button, Form } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { ready, problem, submitLabel = '만들기', cancelHref, onsubmit, children }: {
    /** 필수 칸이 다 맞는가. 아니면 「만들기」 가 잠긴다. */
    ready: boolean;
    problem?: string;
    submitLabel?: string;
    /** 「취소」 가 가는 곳 — 대개 목록. */
    cancelHref?: string;
    onsubmit: () => void;
    children: Snippet;
  } = $props();

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
</script>

{#if !desk.live}
  <p class="wait">연결하면 여기서 만들어요.</p>
{:else}
  <Writable>
    <Form note="만들면 커밋하고 적용 대기로 보내요." onsubmit={() => { if (ready && !desk.editing) onsubmit(); }}>
      {@render children()}
      {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
      {#snippet actions()}
        <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '만드는 중' : submitLabel}</Button>
        {#if cancelHref !== undefined}<Button href={cancelHref}>취소</Button>{/if}
      {/snippet}
    </Form>
  </Writable>
{/if}

<style>
  .wait { color: var(--tx2); font: var(--t-body); }
</style>
