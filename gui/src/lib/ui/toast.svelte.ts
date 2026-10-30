/**
 * 토스트 — 디자인 시스템 §7. 오른쪽 아래에 쌓인다. 5초 뒤 사라진다. 진행 토스트는 끝낼 때까지 남는다.
 *
 *   const id = toast.progress('적용 중', 'r9 를 렌더해요');
 *   toast.done(id, { tone: 'ok', title: '적용했어요', body: 'r9-e8 활성화를 확인했어요' });
 */
export type ToastTone = 'ok' | 'danger' | 'info' | 'warn';
export type ToastItem = { id: number; tone: ToastTone; title: string; body?: string; busy: boolean };

let seq = 0;
const items = $state<ToastItem[]>([]);
const LIFE_MS = 5000;

const drop = (id: number): void => {
  const i = items.findIndex((t) => t.id === id);
  if (i >= 0) items.splice(i, 1);
};
const push = (tone: ToastTone, title: string, body: string | undefined, busy: boolean): number => {
  const id = ++seq;
  items.push({ id, tone, title, ...(body === undefined ? {} : { body }), busy });
  if (!busy) setTimeout(() => drop(id), LIFE_MS);
  return id;
};

export const toast = {
  get items(): readonly ToastItem[] { return items; },
  ok: (title: string, body?: string): number => push('ok', title, body, false),
  fail: (title: string, body?: string): number => push('danger', title, body, false),
  info: (title: string, body?: string): number => push('info', title, body, false),
  progress: (title: string, body?: string): number => push('info', title, body, true),
  /** 진행 토스트를 결과로 바꾼다. 그때부터 5초 뒤 사라진다. */
  done(id: number, next: { tone: ToastTone; title: string; body?: string }): void {
    const t = items.find((x) => x.id === id);
    if (t === undefined) { push(next.tone, next.title, next.body, false); return; }
    t.tone = next.tone; t.title = next.title; t.busy = false;
    if (next.body === undefined) delete t.body; else t.body = next.body;
    setTimeout(() => drop(id), LIFE_MS);
  },
  close: drop,
};
