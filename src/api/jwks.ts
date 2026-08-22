/**
 * JWKS — IdP 의 키 회전을 따라간다 (검수 S-06 나머지).
 *
 * RS256 은 `oidcKeyFrom` 이 열었지만 키를 **파일이나 환경변수로 한 번** 준다. 실물 IdP 는
 * 키를 돌리고, 돌리는 순간 그 배포의 로그인이 전부 막힌다 — 사람이 PEM 을 다시 받아 넣을
 * 때까지. 그건 "OIDC 를 지원한다" 는 말을 반쯤 거짓으로 만든다.
 *
 * ── 모르는 `kid` 에 다시 안 가져온다
 *
 * OIDC 진영의 통상 조언은 "모르는 `kid` 를 보면 JWKS 를 다시 당겨라" 다. 여기서는 안 한다.
 *
 *  1. **인증 안 된 공격자가 아웃바운드 요청을 유발한다.** 이 검증은 Bearer 를 확인하기
 *     *전에* 도는 자리다 — 아무나 임의 `kid` 를 담은 JWT 를 던져 우리 컨트롤 플레인이
 *     IdP 를 두드리게 만들 수 있다. 속도 제한은 표면을 좁힐 뿐 없애지 않는다.
 *  2. **`authenticate` 가 동기다.** 재조회를 넣으면 요청 경로 전체가 async 가 된다. 그
 *     대가가 1 번의 새 표면과 맞바꿀 값이 아니다.
 *
 * 대신 **주기로 당긴다.** 회전 창은 갱신 주기만큼이고, OIDC 는 IdP 가 새 키를 *쓰기 전에*
 * 공개하도록 권하므로 그 창이 실무에서 맞는다. 그리고 이 설계에는 공격자가 흔들 수 있는
 * 손잡이가 없다.
 */
import { createPublicKey, type KeyObject } from 'node:crypto';

/**
 * JWKS 문서에서 **RS256 서명 검증에 쓸 수 있는** 키만 뽑는다.
 *
 * **던지지 않는다.** 이걸 부르는 것은 갱신 타이머이고, 던지면 타이머가 죽는다 —
 * 죽은 타이머는 조용하다. 못 읽은 것은 빈 결과로 말한다.
 *
 * 항목 하나가 망가졌다고 나머지를 버리지 않는다. IdP 가 우리가 모르는 키를 하나 끼워
 * 넣었다고 전체 로그인이 막히면 그건 우리가 만드는 장애다.
 */
export function jwksKeys(doc: unknown): Map<string, KeyObject> {
  const out = new Map<string, KeyObject>();
  if (doc === null || typeof doc !== 'object') return out;
  const keys = (doc as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return out;

  for (const raw of keys) {
    if (raw === null || typeof raw !== 'object') continue;
    const jwk = raw as Record<string, unknown>;
    const kid = jwk['kid'];
    // **`kid` 가 없으면 버린다.** 어느 키인지 말할 수 없으면 고를 수도 없다.
    if (typeof kid !== 'string' || kid === '') continue;
    // RSA 서명키만. `use: "enc"` 를 서명 검증에 쓰는 것은 키 용도를 섞는 것이고,
    // `alg` 가 적혀 있으면 그것도 RS256 이어야 한다.
    if (jwk['kty'] !== 'RSA') continue;
    if (jwk['use'] !== undefined && jwk['use'] !== 'sig') continue;
    if (jwk['alg'] !== undefined && jwk['alg'] !== 'RS256') continue;
    try {
      out.set(kid, createPublicKey({ key: jwk as never, format: 'jwk' }));
    } catch {
      // 이 항목만 버린다.
    }
  }
  return out;
}

/**
 * JWKS 를 들고 있는다. `refresh()` 는 타이머가, `keyFor()` 는 검증 경로가 부른다.
 *
 * 검증 경로가 **동기**여야 하므로 둘을 나눈다 — 그게 이 클래스가 있는 이유다.
 */
export class JwksCache {
  #keys = new Map<string, KeyObject>();

  constructor(
    private readonly url: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly timeoutMs = 5000,
  ) {}

  /**
   * 한 번 당긴다.
   *
   * **못 가져오면 가진 것을 계속 쓴다.** IdP 가 잠깐 흔들렸다고 로그인이 끊기면 안 된다 —
   * 그건 우리가 만드는 장애다. 200 이 아닌 응답도 같다: 502 본문을 JWKS 로 읽으면 빈
   * 셋이 되고, 그건 멀쩡하던 키를 우리가 버리는 것이다.
   *
   * 처음부터 하나도 못 가져왔으면 캐시는 빈 채로 남고 **아무도 못 들어온다.** 빈 캐시를
   * "검사 없음" 으로 떨어뜨리는 길은 만들지 않는다.
   */
  async refresh(): Promise<{ keys: number; changed: boolean }> {
    try {
      const res = await this.fetchImpl(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) return { keys: this.#keys.size, changed: false };
      const next = jwksKeys(await res.json());
      // **빈 결과로 갈아 끼우지 않는다.** 응답은 200 인데 내용이 우리가 못 읽는 모양일
      // 때가 있고, 그때 가진 키를 버리면 회전도 아닌데 로그인이 끊긴다.
      if (next.size === 0) return { keys: this.#keys.size, changed: false };
      const changed = next.size !== this.#keys.size
        || [...next.keys()].some((k) => !this.#keys.has(k));
      this.#keys = next;
      return { keys: next.size, changed };
    } catch {
      return { keys: this.#keys.size, changed: false };
    }
  }

  /** 모르는 `kid` 는 없음이다 — 고정 키로 떨어지지 않는다. */
  keyFor(kid: string | undefined): KeyObject | undefined {
    return kid === undefined ? undefined : this.#keys.get(kid);
  }

  get size(): number {
    return this.#keys.size;
  }
}
