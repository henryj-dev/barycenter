/**
 * **이 화면이 무엇을 보는가** — 지역 인스턴스 자신, 또는 전역 인스턴스가 중계하는 지역 하나.
 *
 * 전역 모드(docs/design-global-mode.md)는 `/readyz` 의 `mode: 'global'` 로 안다(인증이 필요 없는 자리다).
 * 전역이면 읽기 경로를 `/api/v1/regions/<지역>/…` 로 바꾸고, **쓰기를 그리지 않는다** — 설정 쓰기는 그 지역의
 * GUI 에서 한다. 계정 경로(`/me`, 로그인 …)는 바꾸지 않는다(전역도 같은 계정 PG 를 쓴다).
 */
export type RegionSummary = {
  name: string; gui: string; reachable: boolean; auth?: 'rejected';
  status?: { head?: string } & Record<string, unknown>;
  regionBuild?: string | null; buildMismatch?: boolean;
  observedAt?: string; lastOkAt?: string; error?: string;
};

/** 바꾸면 안 되는 경로 — 계정·세션·OIDC 는 전역 자신이 답한다. */
const OWN = ['/api/v1/me', '/api/v1/session', '/api/v1/oidc', '/api/v1/invitations', '/api/v1/users',
  '/api/v1/account', '/api/v1/sso-providers', '/api/v1/regions'];

export function createScope() {
  let mode = $state<'unknown' | 'region' | 'global'>('unknown');
  let region = $state<RegionSummary | undefined>();
  /** 지역 인스턴스가 말한 자기 이름 (`BARY_REGION`). 없으면 undefined. */
  let self = $state<string | undefined>();

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
    /** 전역에서 지역을 고르기 전이거나 고른 뒤 — 어느 쪽이든 설정은 읽기만. */
    get readOnly() { return mode === 'global'; },
    detect,
    choose(r: RegionSummary | undefined) { region = r; },
    /** 지역 API 경로를 지금 보는 곳의 경로로. 전역인데 지역을 안 골랐으면 그대로(전역이 404 로 답한다). */
    api(path: string): string {
      if (mode !== 'global' || region === undefined) return path;
      if (OWN.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))) return path;
      return path.replace(/^\/api\/v1\//, `/api/v1/regions/${encodeURIComponent(region.name)}/`);
    },
  };
}

export type Scope = ReturnType<typeof createScope>;
