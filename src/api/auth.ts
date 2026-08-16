/**
 * 최소 인증 — API 토큰 + 스코프 (DESIGN.md §5.1)
 *
 * *"인증: API 토큰(스코프) + OIDC(사람). RBAC. **v0.1 부터 최소 형태로 존재한다**"*
 *
 * **최소가 무슨 뜻인지 정한다.** v0.1 은 토큰만이다. OIDC 도 역할 테이블도 없다. 대신
 * *있는 것은 진짜로 동작한다* — 스코프가 없으면 403 이고, 토큰이 없으면 401 이고,
 * 비교는 타이밍 세이프다. "나중에 붙일 자리" 로 열어 두지 않는다. 열어 두면 그 상태로
 * 나간다.
 *
 * 토큰은 **해시로 보관한다.** 설정 파일에 평문을 두면 그 파일이 곧 비밀이 되고, 감사
 * 로그·에러 메시지·코어 덤프로 새는 경로가 늘어난다.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * v0.1 의 스코프 셋.
 *
 * `apply` 를 `write` 에서 떼어 놓는다. 설정을 **고치는 것**과 그것을 **실제 트래픽에
 * 거는 것**은 다른 권한이다 — CI 는 앞의 것만 있으면 되고, 그래야 파이프라인이 뚫려도
 * 프로덕션이 즉시 바뀌지는 않는다.
 */
export type Scope = 'read' | 'write' | 'apply';

export const ALL_SCOPES: readonly Scope[] = ['read', 'write', 'apply'];

export type Principal = {
  name: string;
  scopes: ReadonlySet<Scope>;
};

export type TokenSpec = {
  name: string;
  /** `sha256:<hex>` — 평문 토큰의 SHA-256. */
  hash: string;
  scopes: Scope[];
};

export const hashToken = (token: string): string =>
  `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;

export class TokenAuth {
  readonly #byHash = new Map<string, Principal>();

  constructor(specs: readonly TokenSpec[]) {
    for (const s of specs) {
      if (!/^sha256:[0-9a-f]{64}$/.test(s.hash)) {
        throw new Error(`토큰 해시 모양이 아니다 (${s.name}): sha256:<64 hex> 여야 한다`);
      }
      this.#byHash.set(s.hash, { name: s.name, scopes: new Set(s.scopes) });
    }
  }

  /**
   * `Authorization: Bearer <token>` 을 principal 로.
   *
   * **비교는 타이밍 세이프다.** 해시를 키로 쓰는 Map 조회는 그 자체로 내용 의존 시간을
   * 노출할 수 있으므로, 후보를 전부 훑으면서 상수 시간 비교를 한다. 토큰 수가 수십 개
   * 수준이라 감당할 수 있는 비용이고, 여기서 아끼면 아낄 이유가 없는 것을 아끼는 셈이다.
   */
  authenticate(header: string | undefined): Principal | undefined {
    if (header === undefined) return undefined;
    const m = /^Bearer\s+(\S+)$/.exec(header.trim());
    if (m === null) return undefined;
    const want = Buffer.from(hashToken(m[1] ?? ''), 'utf8');
    let found: Principal | undefined;
    for (const [hash, principal] of this.#byHash) {
      const got = Buffer.from(hash, 'utf8');
      // 길이가 같음이 보장된다 (둘 다 `sha256:` + 64 hex).
      if (got.length === want.length && timingSafeEqual(got, want)) found = principal;
    }
    return found;
  }

  get size(): number {
    return this.#byHash.size;
  }
}

export const can = (p: Principal, scope: Scope): boolean => p.scopes.has(scope);
