/**
 * **전체 합산의 데이터 원본** — 지역마다 desk 하나 (2026-11-04, docs/design-global-mode.md §2.5).
 *
 * 지역 하나를 보는 범위(`createScope(fixed)`)에 desk(`createDesk`)를 그대로 붙인다. 그래서 파싱 · SSE · 재연결 · 쓰기 ·
 * step-up · 연락 없음 · 403 · 팔로워 안전망이 좁혀 보기와 **같은 코드**다 — 합산을 위해 두 벌을 두지 않는다.
 * 지역마다 실시간은 그 지역의 SSE 하나(전역의 공유 상류 `/api/v1/regions/<이름>/events`, §2.3.1)다. 폴링하지 않는다.
 *
 * **게으르게 붙는다:** 합산 화면이 열려 있는 동안만(`acquire` 한 쪽이 하나라도 있으면) 붙고, 마지막 화면이 떠나면
 * 잠깐(`RELEASE_DELAY_MS`) 뒤 스트림을 닫는다 — 목록에서 목록으로 옮길 때 다시 붙지 않게.
 * 못 닿은 지역 · 인증 거절된 지역에는 붙지 않는다. 데이터도 없다 — 목록이 「빠졌어요」 로 알린다.
 *
 * 셸(`routes/+layout.svelte`)이 하나 만들어 `setContext('regions', …)` 로 둔다. 화면은 `useAggregate()` 로 쓴다.
 */
import { untrack } from 'svelte';
import { createDesk } from '#lib/desk.svelte.ts';
import { createScope, type RegionSummary, type Scope } from './scope.svelte.ts';
import { regionStateOf, type RegionState } from './aggregate.ts';

type Desk = ReturnType<typeof createDesk>;

/** 합산의 지역 하나. 값은 모두 반응형이다(읽을 때마다 지금 값). */
export type RegionEntry = {
  readonly name: string;
  readonly summary: RegionSummary;
  /** 이 지역에 묶인 범위 — `setContext('scope', …)` 로 넘기면 그 아래 컴포넌트가 이 지역을 본다(`InRegion.svelte`). */
  readonly scope: Scope;
  /** 이 지역의 desk — 읽기도 쓰기도 이 지역으로 간다. */
  readonly desk: Desk;
  readonly state: RegionState;
  /** 이 지역에 지금 쓸 수 있다 — 붙어 있고, 연락이 있고, 리더다. 아니면 행의 수정 · 삭제 · 드레인을 안 보인다. */
  readonly writable: boolean;
};

/** 마지막 합산 화면이 떠난 뒤 스트림을 닫기까지(ms). 전역 상류의 유예(10초, §2.3.1)보다 짧다. */
export const RELEASE_DELAY_MS = 2_000;

export function createRegionDesks(opts: { token: () => string }) {
  type Slot = { name: string; scope: Scope; desk: Desk; connected: boolean };
  let slots = $state.raw<Slot[]>([]);
  /** 합산 화면 수 — 반응형이다(사이드바가 `active` 를 본다). 읽고 쓰는 자리는 `untrack` 으로 감싸 부른 쪽 `$effect` 가 따라가지 않게 한다. */
  let users = $state(0);
  let closeTimer: ReturnType<typeof setTimeout> | undefined;

  const usable = (s: Slot): boolean => { const r = s.scope.region; return r !== undefined && r.reachable && r.auth === undefined; };
  const open = (s: Slot): void => {
    if (s.connected || !usable(s)) return;
    s.connected = true;
    s.desk.token = opts.token();
    // **기다리지 않는다.** `connect` 는 스트림이 끊길 때까지 끝나지 않는다.
    void s.desk.connect();
  };
  const shut = (s: Slot): void => { if (s.connected) { s.connected = false; s.desk.disconnect(); } };

  /**
   * 팔로워면 그 지역의 범위가 읽기 전용이다 — 셸이 좁혀 보기에서 하는 판정(`standby`)과 같다. 상태 스냅샷을 받은 뒤에만 본다.
   * 리더 이름은 묻지 않는다(합산에서는 행의 쓰기를 숨길 뿐이다). 503 `not_leader` 안전망은 scope.wrap 이 그대로 한다.
   */
  $effect(() => {
    for (const s of slots) {
      const standby = s.desk.live && s.desk.head !== undefined && !s.desk.status.leader.isLeader;
      const was = untrack(() => s.scope.follower) !== undefined;
      if (standby !== was) s.scope.follow(standby ? {} : undefined);
    }
  });

  const entryOf = (s: Slot): RegionEntry => ({
    name: s.name,
    get summary() { return s.scope.region!; },
    scope: s.scope,
    desk: s.desk,
    get state() {
      const r = s.scope.region!;
      return regionStateOf({ reachable: r.reachable, auth: r.auth, lost: s.scope.lost, live: s.desk.live, head: s.desk.head, error: s.desk.error });
    },
    get writable() { return this.state === 'ok' && !s.scope.blocked; },
  });
  const entries = $derived(slots.map(entryOf));

  return {
    /** 지역마다 한 줄 — `/api/v1/regions` 요약의 순서 그대로. 못 닿은 지역도 든다(state 로 가른다). */
    get entries(): readonly RegionEntry[] { return entries; },
    /** 이름으로 찾는다. 모르는 지역이면 undefined. */
    get(name: string): RegionEntry | undefined { return entries.find((e) => e.name === name); },
    /** 지금 합산 화면이 열려 있다(스트림이 붙어 있거나 붙는 중). */
    get active(): boolean { return users > 0; },
    /**
     * 새 지역 요약(셸의 `GET /api/v1/regions`)을 받는다. 새 지역은 desk 를 만들고, 사라진 지역은 닫는다.
     * 연락이 돌아온 지역은 합산 화면이 열려 있으면 바로 붙는다. 연락이 끊긴 지역은 desk 의 재연결 고리가 그대로 돈다
     * (닿으면 다시 붙는다) — 그동안 그 지역의 상태는 `lost` 다.
     */
    sync(list: readonly RegionSummary[]): void {
      const keep: Slot[] = [];
      for (const r of list) {
        const had = slots.find((s) => s.name === r.name);
        if (had !== undefined) { had.scope.sync([r]); keep.push(had); continue; }
        const scope = createScope(r);
        keep.push({ name: r.name, scope, desk: createDesk(scope), connected: false });
      }
      for (const s of slots) if (!keep.includes(s)) shut(s);
      slots = keep;
      if (untrack(() => users) > 0) for (const s of keep) open(s);
    },
    /**
     * 합산 화면이 열린다 — 붙을 수 있는 지역마다 붙는다. 돌려준 함수를 부르면 놓는다(`$effect` 의 정리 함수로 쓴다).
     * 마지막 화면이 놓으면 `RELEASE_DELAY_MS` 뒤에 모두 닫는다. 그 사이에 다시 잡으면 닫지 않는다.
     */
    acquire(): () => void {
      untrack(() => {
        users += 1;
        if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; }
        for (const s of slots) open(s);
      });
      let released = false;
      return () => untrack(() => {
        if (released) return;
        released = true;
        users -= 1;
        if (users > 0) return;
        closeTimer = setTimeout(() => {
          closeTimer = undefined;
          if (untrack(() => users) === 0) for (const s of untrack(() => slots)) shut(s);
        }, RELEASE_DELAY_MS);
      });
    },
    /** 모두 닫는다(로그아웃 · 연결 끊기). 다시 잡으면 다시 붙는다. */
    closeAll(): void {
      if (closeTimer !== undefined) { clearTimeout(closeTimer); closeTimer = undefined; }
      for (const s of untrack(() => slots)) shut(s);
    },
  };
}

export type RegionDesks = ReturnType<typeof createRegionDesks>;
