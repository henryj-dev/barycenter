/**
 * 로컬 TOTP — `mfa_totp` 의 봉인된 비밀로 검증한다. `AccountService.#secondFactor` 에 있던 로직을 옮겼다(뜻 불변).
 *
 * **같은 시간창을 두 번 받지 않는다.** 맞으면 `last_step` 을 조건부로 올리고, 이긴 쪽만 통과한다 — 같은 창의
 * 코드가 동시에 두 번 와도 한쪽만 이긴다. 등록이 없으면(행 없음) 틀린 코드와 같다 — 전과 같다.
 */
import type { Sealer } from '../sealer/provider.js';
import { verifyTotp } from '../totp.js';
import type { MfaProvider, MfaResult } from './provider.js';

const WRONG: MfaResult = { ok: false, reason: 'wrong-code', detail: '인증 앱의 코드가 맞지 않는다' };

export function localTotp(o: { sealer: Sealer; now: () => number }): MfaProvider {
  return {
    method: 'totp',
    async verify({ userId, code, db }): Promise<MfaResult> {
      const t = (await db.query(`SELECT secret_sealed, last_step FROM mfa_totp WHERE user_id=$1`, [userId])).rows[0];
      if (t === undefined || t['secret_sealed'] === null || t['secret_sealed'] === undefined) return WRONG;
      // 봉인을 못 열면(무결성 · 키 없음 · 봉인 서버 장애) 틀린 코드가 아니라 「물을 수 없다」 — 닫힌다.
      const opened = await o.sealer.open(String(t['secret_sealed']), `totp:${userId}`);
      if (!opened.ok) return { ok: false, reason: 'unavailable', detail: `인증 앱 비밀을 열지 못했다 (${opened.reason})` };
      const step = verifyTotp(opened.plain, code, o.now(), Number(t['last_step']));
      if (step === undefined) return WRONG;
      const won = (await db.query(`UPDATE mfa_totp SET last_step=$2 WHERE user_id=$1 AND last_step < $2`, [userId, step])).rowCount;
      return won === 1 ? { ok: true } : WRONG;
    },
  };
}
