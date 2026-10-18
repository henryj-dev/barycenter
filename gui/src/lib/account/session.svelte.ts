/**
 * 지금 로그인한 사람 (`GET /api/v1/me`). 레이아웃이 하나 만들어 context 로 나눠 준다.
 *
 * **사람이 아닐 수 있다** — 토큰으로 붙었거나(404 not_a_person), 계정이 꺼졌거나(404
 * accounts_disabled), 로그인 전이다(401). 그때 `me` 는 undefined 다.
 */
import { accountApi, type Me } from './api';

export function createSession() {
  let me = $state<Me | undefined>();
  let checked = $state(false);

  const refresh = async (): Promise<void> => {
    const r = await accountApi.me();
    me = r.ok ? r.data : undefined;
    checked = true;
  };

  const logout = async (): Promise<{ ok: boolean; message?: string }> => {
    const r = await accountApi.logout();
    me = undefined;
    // 쿠키는 지워졌지만 서버가 철회를 확인 못 했다(503) — 그 사실을 숨기지 않는다.
    return r.ok ? { ok: true } : { ok: false, message: r.message };
  };

  return {
    get me() { return me; },
    get checked() { return checked; },
    get isAdmin() { return me?.role === 'admin'; },
    refresh,
    logout,
  };
}

export type Session = ReturnType<typeof createSession>;
