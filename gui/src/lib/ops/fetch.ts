/**
 * 운영 화면이 desk 밖에서 따로 묻는 것 — 지역 요약(`GET /api/v1/regions`)과, 지역 · 리비전을 골라 보는 읽기.
 *
 * desk 는 「지금 보는 곳의 head」 만 든다. 렌더된 설정의 리비전 선택 · 전역의 지역 선택 · 지역별 표는 그 밖이다.
 * 그래서 여기서 읽기(GET)만 한다. 쓰기는 언제나 desk 를 거친다.
 */
import type { RegionSummary } from '#lib/global/scope.svelte.ts';

/** 세션 쿠키가 있으면 그것으로, 수동 토큰이 있으면 Bearer 로 — 지역 화면(`/regions`)과 같다. */
const headersOf = (token: string): Record<string, string> =>
  (token === '' ? {} : { authorization: `Bearer ${token}` });

/** 못 읽으면 undefined — 「비었다」 와 다르다. */
export const getJson = async (path: string, token: string): Promise<unknown> => {
  try {
    const r = await fetch(path, { credentials: 'same-origin', headers: headersOf(token) });
    return r.ok ? await r.json() : undefined;
  } catch {
    return undefined;
  }
};

/** 전역의 지역 요약. 지역마다 `status` 를 그대로 싣는다(`GlobalRelay.summary`). */
export const loadRegions = async (token: string): Promise<RegionSummary[] | undefined> => {
  const body = await getJson('/api/v1/regions', token) as { regions?: RegionSummary[] } | undefined;
  return body?.regions;
};

/** 지역 API 경로 — 전역이면 `/api/v1/regions/<지역>/…`, 아니면 그대로. */
export const regionPath = (region: string | undefined, path: string): string =>
  (region === undefined ? path : path.replace(/^\/api\/v1\//, `/api/v1/regions/${encodeURIComponent(region)}/`));
