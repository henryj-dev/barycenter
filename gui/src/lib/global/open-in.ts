/**
 * 「이 지역에서 열기 ↗」 · 「리더(<이름>)에서 열기 ↗」 — 콘솔 시안 `openLbl` · `openReg` 를 한곳에서 정한다.
 *
 * 시안: 전역 모드면(지역을 골랐을 때) 상세 머리 · 읽기 구획에 「이 지역에서 열기 ↗」, 팔로워면 「리더(web-01)에서 열기 ↗」.
 * 누르면 그 GUI 의 **같은 화면**으로 간다(디자인 시스템 §13 「누르면 그 지역 GUI의 같은 화면으로 가요」) — 새 창이다.
 * 갈 주소를 모르면(지역을 안 골랐다 · 리더 주소를 모른다) undefined.
 *
 * 순수 함수만 둔다(룬 · Svelte 없음).
 */
import { LOST_MESSAGE, followerMessage, type Follower, type RegionSummary } from './scope.svelte.ts';

type ScopeLike = { mode: string; region?: RegionSummary; follower?: Follower; lost: boolean; blocked: boolean } | undefined;

/** 그 GUI 의 같은 화면 주소 — 바탕 주소 끝의 `/` 와 화면 경로의 `/` 를 하나로 잇는다. */
const join = (base: string, path: string): string => `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;

export function openIn(scope: ScopeLike, path: string): { label: string; href: string } | undefined {
  if (scope === undefined) return undefined;
  if (scope.follower !== undefined) {
    const g = scope.follower.gui;
    return g === undefined ? undefined
      : { label: `리더${scope.follower.leader === undefined ? '' : `(${scope.follower.leader})`}에서 열기 ↗`, href: join(g, path) };
  }
  if (scope.mode === 'global' && scope.region !== undefined) return { label: '이 지역에서 열기 ↗', href: join(scope.region.gui, path) };
  return undefined;
}

/** 쓸 수 없는 까닭 한 줄(시안 `roMsg`). 쓸 수 있으면 undefined. */
export function blockedMessage(scope: ScopeLike): string | undefined {
  if (scope === undefined || !scope.blocked) return undefined;
  if (scope.follower !== undefined) return followerMessage(scope.follower.leader);
  if (scope.lost) return LOST_MESSAGE;
  return '전체 합산에서는 여기서 쓰지 않아요. 지역을 골라 좁혀 보면 그 지역에 써요.';
}
