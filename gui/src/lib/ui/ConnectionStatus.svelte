<script lang="ts">
  /** 실시간 연결(SSE) 표시 — 디자인 시스템 §6. 수신 중(초록 점) · 재연결 중(깜빡이는 노랑) · 끊김(빨강 네모). */
  let { state }: { state: 'live' | 'reconnecting' | 'down' } = $props();
  const text = { live: '실시간 수신 중', reconnecting: '재연결 중', down: '끊김' } as const;
</script>

<span class="conn" data-state={state} role="status"><span class="dot" aria-hidden="true"></span>{text[state]}</span>

<style>
  .conn {
    height: 24px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px;
    border-radius: 12px; border: 1px solid var(--bd); font: 400 12px/1 var(--font); color: var(--ok); white-space: nowrap;
  }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .conn[data-state='reconnecting'] { color: var(--warn); }
  .conn[data-state='reconnecting'] .dot { animation: bc-pulse 1s infinite; }
  .conn[data-state='down'] { color: var(--danger); }
  .conn[data-state='down'] .dot { border-radius: 2px; }
</style>
