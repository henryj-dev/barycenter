/**
 * 외부(IdP …) 응답을 **세면서** 읽는다 — `Content-Length` 는 주장일 뿐이라 선언이 넘으면 일찍 멈추고, 실제로도 넘는 순간 끊는다.
 * `Response.json()` 은 오는 대로 다 받는다 — 메모리를 상대가 정하게 두지 않는다.
 *
 * 넘으면 던진다(호출자가 자기 실패 사유로 바꾼다 — 예: IdP OTP 의 `unavailable`, discovery 의 `unavailable`).
 */
export async function readBounded(res: Response, limit: number): Promise<string> {
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
