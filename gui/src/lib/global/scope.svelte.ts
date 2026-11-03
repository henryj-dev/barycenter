/**
 * **이 화면이 무엇을 보는가** — 지역 인스턴스 자신, 또는 전역 인스턴스가 중계하는 지역 하나.
 *
 * 전역 모드(docs/design-global-mode.md)는 `/readyz` 의 `mode: 'global'` 로 안다(인증이 필요 없는 자리다).
 * 전역이면 지역 API 경로를 `/api/v1/regions/<지역>/…` 로 바꾼다 — 읽기도 쓰기도 그 지역으로 간다. 계정 경로(`/me`, 로그인 …)는 바꾸지 않는다(전역도 같은 계정 PG 를 쓴다).
 */
export type RegionSummary = {
  name: string; gui: string; reachable: boolean; auth?: 'rejected';
  status?: { head?: string } & Record<string, unknown>;
  regionBuild?: string | null; buildMismatch?: boolean;
  observedAt?: string; lastOkAt?: string; error?: string;
};

import { toast } from '#lib/ui';

/** 연락이 없는 지역에 쓰려 할 때의 한 줄 (시안 `roMsg`). */
export const LOST_MESSAGE = '이 지역과 연결되지 않아 지금은 쓸 수 없어요.';
/** 지역이 403 으로 쓰기를 거절했을 때 (시안). 권한은 지역이 판정한다. */
export const deniedMessage = (region: string): string => `${region}에서 쓰기 권한이 없어요. 그 지역의 관리자에게 역할을 요청해요.`;

const WRITE = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);
const pathOf = (input: string | URL | Request): string => {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  try { return new URL(raw, 'http://x').pathname; } catch { return raw; }
};

/** 바꾸면 안 되는 경로 — 계정·세션·OIDC 는 전역 자신이 답한다. */
const OWN = ['/api/v1/me', '/api/v1/session', '/api/v1/oidc', '/api/v1/invitations', '/api/v1/users',
  '/api/v1/account', '/api/v1/sso-providers', '/api/v1/regions'];

export function createScope() {
  let mode = $state<'unknown' | 'region' | 'global'>('unknown');
  let region = $state<RegionSummary | undefined>();
  /** 지역 인스턴스가 말한 자기 이름 (`BARY_REGION`). 없으면 undefined. */
  let self = $state<string | undefined>();
  /**
   * 고른 지역에 보낸 요청이 `502 region_unreachable` 을 받았다 — 전역이 그 지역에 못 닿는다(`src/global/relay.ts`).
   * 그 지역에서 성공한 응답이 오거나 지역을 다시 고르면 지운다.
   */
  let unreachable = $state(false);
  /** 쓰기를 막거나 거절당해 토스트로 알린 횟수 — 화면이 같은 실패를 두 번 알리지 않게 본다. */
  let refusals = $state(0);

  const isLost = (): boolean => mode === 'global' && region !== undefined && (!region.reachable || unreachable);
  const refuse = (title: string, body: string): void => { refusals += 1; toast.fail(title, body); };

  const detect = async (): Promise<void> => {
    try {
      const r = await fetch('/readyz');
      const body = (await r.json()) as { mode?: unknown; region?: unknown };
      mode = body.mode === 'global' ? 'global' : 'region';
      self = typeof body.region === 'string' ? body.region : undefined;
    } catch {
      mode = 'region';
    }
  };

  return {
    get mode() { return mode; },
    get region() { return region; },
    get self() { return self; },
    /**
     * 전역에서 지역을 고르기 전에만 읽기 전용이다. 고른 뒤에는 쓰기도 그 지역으로 넘긴다 — 보는 사람의 세션 그대로
     * (2026-11-01 사용자 결정, docs/design-global-mode.md §1.1). 권한은 지역이 판정한다.
     */
    get readOnly() { return mode === 'global' && region === undefined; },
    /** 전역에서 고른 지역과 지금 연락이 없다 — 지역 요약의 `reachable` 이 거짓이거나, 중계가 못 닿았다고 답했다. */
    get lost() { return isLost(); },
    get refusals() { return refusals; },
    detect,
    choose(r: RegionSummary | undefined) { region = r; unreachable = false; },
    /** 새로 받은 지역 요약(`GET /regions`)으로 고른 지역의 연락 여부를 고친다. */
    sync(list: readonly RegionSummary[]) {
      const now = region === undefined ? undefined : list.find((r) => r.name === region?.name);
      if (now === undefined) return;
      region = now;
      if (now.reachable) unreachable = false;
    },
    /**
     * desk 의 `fetch` 를 감싼다 — 전역에서 고른 지역으로 가는 요청만 본다. 지역 인스턴스면 그대로 넘긴다.
     *
     * 쓰기는 **보는 사람의 자격으로** 지역에 간다(`src/global/relay.ts`). 연락 없는 지역에는 보내지 않고 알린다.
     * 지역이 403 으로 거절하면(step-up 요구는 빼고) 지역 이름을 넣어 알린다. 응답은 그대로 돌려준다 — 오류 문구는 desk 가 쓴다.
     */
    wrap(f: typeof fetch): typeof fetch {
      return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const r0 = region;
        if (mode !== 'global' || r0 === undefined) return f(input, init);
        const prefix = `/api/v1/regions/${encodeURIComponent(r0.name)}/`;
        if (!pathOf(input).startsWith(prefix)) return f(input, init);
        const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
        const write = WRITE.has(method);
        if (write && isLost()) {
          refuse(`${r0.name}에 쓰지 못했어요`, LOST_MESSAGE);
          return new Response(JSON.stringify({ code: 'region_unreachable', region: r0.name, message: LOST_MESSAGE }),
            { status: 502, headers: { 'content-type': 'application/json' } });
        }
        const r = await f(input, init);
        if (r.ok) { unreachable = false; return r; }
        if (r.status !== 502 && r.status !== 403) return r;
        const body = await r.clone().json().catch(() => ({})) as { code?: unknown };
        if (r.status === 502 && body.code === 'region_unreachable') {
          unreachable = true;
          if (write) refuse(`${r0.name}에 쓰지 못했어요`, LOST_MESSAGE);
        } else if (r.status === 403 && write && body.code !== 'mfa_step_up_required') {
          refuse('요청이 거절됐어요 · 403', deniedMessage(r0.name));
        }
        return r;
      }) as typeof fetch;
    },
    /** 지역 API 경로를 지금 보는 곳의 경로로. 전역인데 지역을 안 골랐으면 그대로(전역이 404 로 답한다). */
    api(path: string): string {
      if (mode !== 'global' || region === undefined) return path;
      if (OWN.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))) return path;
      return path.replace(/^\/api\/v1\//, `/api/v1/regions/${encodeURIComponent(region.name)}/`);
    },
  };
}

export type Scope = ReturnType<typeof createScope>;
