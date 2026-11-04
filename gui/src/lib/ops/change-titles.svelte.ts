/**
 * 변경 설명 캐시 — 기록 화면과 대시보드 「최근 변경」 이 같이 쓴다(`change-title.ts` 가 글을 만든다).
 *
 * 화면은 보이는 줄의 changeset 만 `want` 한다. 같은 desk 의 같은 id 는 한 번만 부른다 — 실패해도 다시 안 부른다
 * (권한 · 연락 없음 · 지워진 changeset). 그러면 `get` 이 undefined 이고 화면은 지금 글(「설정 변경」)을 쓴다.
 * 합산(전역)이면 그 줄의 지역 desk 를 넘긴다 — 요청이 그 지역으로 간다.
 */
import { SvelteMap } from 'svelte/reactivity';
import type { ResourceKind } from '@web/resources';
import { describeChange, parseChangeset, resourcesOf, stateAtBase, type ChangeTitle } from './change-title';

export type TitleSource = {
  changeset(id: string): Promise<unknown | undefined>;
  historyOf(kind: ResourceKind, key: string): Promise<unknown[] | undefined>;
};

/** 한 번에 이만큼만 보낸다 — 기록 화면이 처음 열릴 때 한꺼번에 몰리지 않게. */
const PARALLEL = 4;
/** desk 마다 번호 — 캐시 열쇠는 `<번호> <id>` 다. 캐시는 모듈에 하나(화면을 옮겨도 남는다). */
const ids = new WeakMap<TitleSource, number>();
let nextId = 0;
const cache = new SvelteMap<string, ChangeTitle | null>();
const asked = new Set<string>();
const queue: (() => Promise<void>)[] = [];
let running = 0;

const pump = (): void => {
  while (running < PARALLEL && queue.length > 0) {
    const job = queue.shift()!;
    running += 1;
    void job().finally(() => { running -= 1; pump(); });
  }
};

const keyOf = (src: TitleSource, id: string): string => {
  let n = ids.get(src);
  if (n === undefined) { n = nextId++; ids.set(src, n); }
  return `${n} ${id}`;
};

async function load(src: TitleSource, id: string): Promise<ChangeTitle | undefined> {
  const cs = parseChangeset(await src.changeset(id));
  if (cs === undefined) return undefined;
  const first = resourcesOf(cs.patch)[0];
  if (first === undefined) return undefined;
  if (first.op === 'delete') return describeChange(cs.patch, undefined);
  const history = await src.historyOf(first.kind as ResourceKind, first.key);
  return describeChange(cs.patch, history === undefined ? undefined : stateAtBase(history, id, cs));
}

/**
 * 이 changeset 의 설명을 (아직 안 불렀으면) 부른다. `ver` 는 묶음의 마지막 감사 줄 id 다 — changeset 을 막 만들었을 때
 * patch 가 비어 있다. 단계가 늘면(patch · commit) 한 번 더 부르고, 그대로면 다시 안 부른다.
 */
export function want(src: TitleSource, id: string, ver = ''): void {
  const k = keyOf(src, id);
  if (asked.has(`${k}#${ver}`)) return;
  asked.add(`${k}#${ver}`);
  queue.push(async () => {
    let t: ChangeTitle | undefined;
    try { t = await load(src, id); } catch { t = undefined; }
    // 전에 얻은 설명은 실패로 지우지 않는다.
    if (t !== undefined || !cache.has(k)) cache.set(k, t ?? null);
  });
  pump();
}

/** 받은 설명. 아직이거나 못 얻었으면 undefined. */
export function titleOf(src: TitleSource, id: string | undefined): ChangeTitle | undefined {
  if (id === undefined) return undefined;
  return cache.get(keyOf(src, id)) ?? undefined;
}

/** 줄이 화면에 들어오면 `want` 한다 — 기록 화면의 묶음 줄에 단다. */
type Want = { src: TitleSource; id: string | undefined; ver?: string };
export function wantWhenVisible(node: Element, arg: Want) {
  let cur = arg;
  const ask = (): void => { if (cur.id !== undefined) want(cur.src, cur.id, cur.ver); };
  const io = typeof IntersectionObserver === 'undefined' ? undefined : new IntersectionObserver((es) => {
    if (es.some((e) => e.isIntersecting)) { ask(); io?.unobserve(node); }
  });
  if (io === undefined) ask(); else io.observe(node);
  return {
    update(next: Want) { cur = next; if (io === undefined) ask(); else io.observe(node); },
    destroy() { io?.disconnect(); },
  };
}
