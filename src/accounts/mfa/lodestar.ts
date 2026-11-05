/**
 * IdP OTP — lodestar(KeyStone) `POST {base}/api/totp/verify`. heliopause `src/otp.ts` 와 같은 계약이다.
 *
 * **비밀은 IdP 에만 있다.** 여기는 6자리를 보내 판정만 받는다. 들고 있는 것은 그 호출 하나에 쓰는 서비스 토큰이다.
 * 재사용 방지(IdP 가 마지막 창을 기억한다)와 시도 제한(IdP 가 사람마다 센다)은 IdP 가 한다 — 여기서 다시 만들지 않는다.
 *
 * 답의 뜻:
 *   200 + `{"ok":true}`  통과. 200 이라도 본문이 그렇지 않으면 **실패**(프록시의 200 오류 페이지로 열리지 않게)
 *   401 + `{"ok":false}` 틀린 코드 · 401(그 본문 없음) 서비스 토큰 거절
 *   403 계정 비활성 · 404 등록 없음 · 429 시도 제한 · 그 밖 전부 unavailable
 *
 * **던지지 않는다.** 네트워크 · 읽기 · 해석 실패는 모두 `unavailable` 이다 — 호출자가 그것을 「틀린 코드」로
 * 읽고 다른 길로 넘어가는 일이 없게(닫힘).
 */
import type { MfaProvider, MfaResult } from './provider.js';

/** 판정 본문은 `{"ok":true}` 다. 이만큼이면 넉넉하고, 더 오면 읽지 않는다(메모리를 상대가 정하지 않게). */
export const MAX_OTP_RESPONSE_BYTES = 64 * 1024;
const TIMEOUT_MS = 8_000;

export type LodestarOtpOptions = {
  /** IdP 주소 — `https://idp.example`. https 가 아니면 보내지 않는다. */
  baseUrl: string;
  /** `/api/totp/verify` 에 쓰는 서비스 토큰. 파일에서 읽어 넘긴다(로그 · 감사에 남기지 않는다). */
  serviceToken: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export function lodestarOtp(o: LodestarOtpOptions): MfaProvider {
  return {
    method: 'idp_otp',
    verify: ({ subject, code }) => verifyLodestarOtp(o, subject, code),
  };
}

export async function verifyLodestarOtp(o: LodestarOtpOptions, subject: string | undefined, code: string): Promise<MfaResult> {
  try {
    return await ask(o, subject, code);
  } catch (e) {
    // 아래 `ask` 는 스스로 던지지 않게 썼다. 그래도 빠져나온 것은 닫는다.
    return { ok: false, reason: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
  }
}

async function ask(o: LodestarOtpOptions, subject: string | undefined, code: string): Promise<MfaResult> {
  if (!o.baseUrl.startsWith('https://')) {
    return { ok: false, reason: 'unavailable', detail: `평문으로는 일회용 코드를 보내지 않는다 (${o.baseUrl})` };
  }
  if (subject === undefined || subject === '') {
    return { ok: false, reason: 'not-enrolled', detail: '이 계정에 IdP 연결(subject)이 없다' };
  }
  // 요청 전에 거른다 — 모양이 틀린 코드로 IdP 의 시도 제한을 깎지 않는다. 공백은 IdP 도 지우지만 여기서 지워 보낸다.
  const c = code.replace(/\s/g, '');
  if (!/^[0-9]{6,8}$/.test(c)) {
    return { ok: false, reason: 'wrong-code', detail: '일회용 코드는 6자리 숫자다' };
  }

  let res: Response;
  try {
    res = await (o.fetch ?? fetch)(`${o.baseUrl.replace(/\/+$/, '')}/api/totp/verify`, {
      method: 'POST',
      headers: { authorization: `Bearer ${o.serviceToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ userId: subject, code: c }),
      redirect: 'error',
      signal: AbortSignal.timeout(o.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (e) {
    return { ok: false, reason: 'unavailable', detail: `IdP 에 닿지 못했다: ${e instanceof Error ? e.message : String(e)}` };
  }

  let text: string;
  try {
    text = await readBounded(res, MAX_OTP_RESPONSE_BYTES);
  } catch (e) {
    return { ok: false, reason: 'unavailable', detail: `IdP 의 답을 읽지 못했다: ${e instanceof Error ? e.message : String(e)}` };
  }
  const okField = (): unknown => {
    try {
      return (JSON.parse(text) as { ok?: unknown } | null)?.ok;
    } catch {
      return undefined;
    }
  };

  if (res.status === 200) {
    if (okField() === true) return { ok: true };
    return { ok: false, reason: 'unavailable', detail: 'IdP 가 200 으로 답했지만 판정이 없다' };
  }
  if (res.status === 401) {
    // 두 가지 401 — 틀린 코드는 핸들러가 `{"ok":false}` 를 붙이고, 서비스 토큰 거절은 그 앞의 가드가 본문 없이 낸다.
    return okField() === false
      ? { ok: false, reason: 'wrong-code', detail: '코드가 맞지 않거나 이미 썼다' }
      : { ok: false, reason: 'service-token', detail: 'IdP 가 이 서비스 토큰을 거절했다' };
  }
  if (res.status === 403) return { ok: false, reason: 'account-inactive', detail: 'IdP 에서 이 계정이 활성이 아니다' };
  if (res.status === 404) return { ok: false, reason: 'not-enrolled', detail: 'IdP 에 이 계정의 OTP 가 없다' };
  if (res.status === 429) return { ok: false, reason: 'rate-limited', detail: 'IdP 가 이 계정의 시도를 제한했다' };
  return { ok: false, reason: 'unavailable', detail: `IdP 가 ${res.status} 로 답했다` };
}

/**
 * 세면서 읽는다 — `Content-Length` 는 주장일 뿐이라 선언이 넘으면 일찍 멈추고, 실제로도 넘는 순간 끊는다.
 * 넘으면 던진다(호출자가 `unavailable` 로 바꾼다).
 */
async function readBounded(res: Response, limit: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    void res.body?.cancel().catch(() => undefined);
    throw new Error(`답이 ${limit}바이트를 넘는다`);
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      throw new Error(`답이 ${limit}바이트를 넘는다`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}
