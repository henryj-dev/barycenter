/**
 * 목록 칸 — 시안 콘솔의 `cells(page, r)` 과 `cellMap` 규칙 그대로.
 *
 * 시안은 칸 하나를 세 가지로만 그린다.
 *   · `m(t)` — 고정폭(`--mono`) · 기본색(`--tx`). 이름 · 주소 · 포트 · 숫자 · 리비전.
 *   · `x(t)` — 보통 글꼴(`--font`) · 흐린색(`--tx2`). 사람 말 · 요약 · 「켜짐」 「꺼짐」.
 *   · `b(tone, icon, t)` — 배지(아이콘 + 글, 그 톤의 전경 · 배경).
 * 값이 비면(`''` · null · undefined) 「—」 로 그린다(시안 `cellMap`). 칸은 **링크가 아니다** — 평문이다.
 * `title` 을 주면 마우스를 올렸을 때 보인다(시안: 경로가 여럿이면 전부, 가려진 라우트면 까닭).
 *
 * 쓰는 법 — 열에 `value` 를 준다:
 * ```ts
 * const columns: Column<Row>[] = [
 *   { key: 'name', label: '이름', value: (r) => m(r.name) },
 *   { key: 'proto', label: '프로토콜', value: (r) => x(r.proto) },
 *   { key: 'health', label: '헬스', value: (r) => (r.ok ? b('ok', '●', '정상') : b('danger', '✕', '비정상')) },
 * ];
 * ```
 */
// `.js` 로 적는다 — 루트 시험(tsc · vitest)이 이 파일을 직접 읽는다. 타입만이라 빌드에는 남지 않는다.
import type { Tone } from './tone.js';

export type Cell =
  | { kind: 'mono'; t: string; title?: string }
  | { kind: 'text'; t: string; title?: string }
  | { kind: 'badge'; t: string; tone: Tone; icon: string; title?: string };

const text = (t: unknown): string => (t === '' || t === null || t === undefined ? '—' : String(t));

/** 고정폭 · 기본색 칸. */
export const m = (t: unknown, title?: string): Cell => ({ kind: 'mono', t: text(t), ...(title === undefined ? {} : { title }) });
/** 보통 글꼴 · 흐린색 칸. */
export const x = (t: unknown, title?: string): Cell => ({ kind: 'text', t: text(t), ...(title === undefined ? {} : { title }) });
/** 배지 칸 — 시안 인자 순서(톤, 아이콘, 글) 그대로. 아이콘이 비면 시안처럼 「·」. */
export const b = (tone: Tone, icon: string, t: unknown, title?: string): Cell =>
  ({ kind: 'badge', tone, icon: icon === '' ? '·' : icon, t: text(t), ...(title === undefined ? {} : { title }) });
/** 값이 없는 칸 — 시안의 `x('—')`. */
export const dash: Cell = { kind: 'text', t: '—' };

/** 칸을 그릴 값 — 시안 `cellMap` 의 `{ t, ff, fg }`. 배지는 `Badge` 가 그린다. */
export const cellStyle = (c: Cell): { font: string; color: string } =>
  c.kind === 'mono' ? { font: 'var(--mono)', color: 'var(--tx)' } : { font: 'var(--font)', color: 'var(--tx2)' };

/** 정렬 · 검색에 쓰는 평문. */
export const cellText = (c: Cell): string => (c.t === '—' ? '' : c.t);
