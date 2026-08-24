/**
 * 최소 인증 — API 토큰 + 스코프 (DESIGN.md §5.1)
 *
 * *"인증: API 토큰(스코프) + OIDC(사람). RBAC. **v0.1 부터 최소 형태로 존재한다**"*
 *
 * **최소가 무슨 뜻인지 정한다.** 해시 토큰은 그대로다. 사람이 들고 온 Bearer 가
 * JWT 이면 서명·iss·aud·exp·sub 를 검증하고 기존 역할에 얹는다. 스코프가 없으면 403,
 * 토큰이 없거나 검증이 실패하면 401. 비교는 타이밍 세이프다.
 *
 * 토큰은 **해시로 보관한다.** 설정 파일에 평문을 두면 그 파일이 곧 비밀이 되고, 감사
 * 로그·에러 메시지·코어 덤프로 새는 경로가 늘어난다.
 */
import {
  createHash, createHmac, createPublicKey, createVerify, timingSafeEqual, type KeyObject,
} from 'node:crypto';

/**
 * v0.1 의 스코프 셋 + v1.0 `admin`.
 *
 * `apply` 를 `write` 에서 떼어 놓는다. 설정을 **고치는 것**과 그것을 **실제 트래픽에
 * 거는 것**은 다른 권한이다. `admin` 은 복구처럼 운영 면의 쓰기 — 역할 표가 이걸 연다.
 */
export type Scope = 'read' | 'write' | 'apply' | 'admin';

export const ALL_SCOPES: readonly Scope[] = ['read', 'write', 'apply', 'admin'];

/** v1.0 역할. 스코프를 직접 적지 않아도 된다. */
export type Role = 'auditor' | 'operator' | 'admin';

/**
 * 역할 → 스코프. **모르는 역할은 던진다.**
 *
 * 전에는 `auditor`/`operator` 만 분기하고 **나머지 전부를 admin 으로 떨궜다.** 타입이
 * `Role` 이니 그래도 된다고 생각했는데, 이 함수는 **설정 파일에서 온 값**도 받는다 —
 * `BARY_TOKENS` 를 캐스팅으로만 읽고 있었기 때문이다. `"role":"operater"` 오타 하나가
 * 전권 토큰이 됐고 기동 로그에도 안 보였다 (검수 S-03).
 *
 * fail closed 로 뒤집는다. 전권은 **명시적으로 `admin` 이라고 적었을 때만** 나온다.
 */
export function scopesOfRole(role: Role): Scope[] {
  if (role === 'auditor') return ['read'];
  if (role === 'operator') return ['read', 'write'];
  if (role === 'admin') return ['read', 'write', 'apply', 'admin'];
  throw new Error(
    `아는 역할이 아니다: ${JSON.stringify(role)} — auditor | operator | admin`,
  );
}

/**
 * `BARY_TOKENS` 를 해독한다. **캐스팅하지 않는다.**
 *
 * 이 저장소는 모델 경계에 이미 같은 규칙을 세워 뒀다 (`src/model/decode.ts`):
 * *모르는 값은 거부한다 · 모르는 키도 거부한다 · 강제 변환하지 않는다.* 설정 파일이
 * 그 규칙 밖에 있을 이유가 없다 — 오히려 **권한을 정하는 값**이라 더 엄해야 한다.
 *
 * `scopes: "read"` 를 받아 주면 `new Set("read")` 가 글자 단위로 쪼개져 아무 스코프도
 * 아닌 것이 되고, 증상은 "토큰은 맞는데 403" 이다.
 */
export function parseTokenSpecs(input: unknown): TokenSpec[] {
  if (!Array.isArray(input)) throw new Error('토큰 명세는 배열이어야 한다');
  if (input.length === 0) throw new Error('토큰 명세가 비어 있다 — 아무도 못 들어온다');

  return input.map((raw, i): TokenSpec => {
    const at = `토큰[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${at} 는 객체여야 한다`);
    }
    const obj = raw as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (!['name', 'hash', 'scopes', 'role'].includes(k)) {
        throw new Error(`${at} 에 모르는 필드 '${k}' — 오타이거나 지원하지 않는 설정이다`);
      }
    }

    const name = obj['name'];
    if (typeof name !== 'string' || name === '') {
      throw new Error(`${at}.name 은 비어 있지 않은 문자열이어야 한다`);
    }
    const hash = obj['hash'];
    if (typeof hash !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(hash)) {
      throw new Error(`${at}.hash 는 'sha256:<64 hex>' 여야 한다 (${name})`);
    }

    const role = obj['role'];
    if (role !== undefined && !isRole(role)) {
      throw new Error(`${at}.role 이 아는 역할이 아니다: ${JSON.stringify(role)} (${name})`);
    }

    const rawScopes = obj['scopes'];
    let scopes: Scope[] | undefined;
    if (rawScopes !== undefined) {
      if (!Array.isArray(rawScopes)) {
        throw new Error(`${at}.scopes 는 배열이어야 한다 (${name})`);
      }
      for (const s of rawScopes) {
        if (!(ALL_SCOPES as readonly unknown[]).includes(s)) {
          throw new Error(`${at}.scopes 에 모르는 스코프: ${JSON.stringify(s)} (${name})`);
        }
      }
      scopes = rawScopes as Scope[];
    }

    // **아무 권한도 없는 토큰은 실수다.** 조용히 받아 두면 "토큰은 맞는데 403" 을
    // 디버깅하게 된다.
    if (role === undefined && (scopes === undefined || scopes.length === 0)) {
      throw new Error(`${at} 에 scopes 도 role 도 없다 — 이 토큰은 아무것도 못 한다 (${name})`);
    }

    return {
      name, hash,
      ...(scopes === undefined ? {} : { scopes }),
      ...(role === undefined ? {} : { role }),
    };
  });
}

export type Principal = {
  name: string;
  scopes: ReadonlySet<Scope>;
  role?: Role;
};

export type TokenSpec = {
  name: string;
  /** `sha256:<hex>` — 평문 토큰의 SHA-256. */
  hash: string;
  scopes?: Scope[];
  role?: Role;
};

export function scopesOf(spec: TokenSpec): Scope[] {
  if (spec.role !== undefined) return scopesOfRole(spec.role);
  return spec.scopes ?? [];
}

export const hashToken = (token: string): string =>
  `sha256:${createHash('sha256').update(token, 'utf8').digest('hex')}`;

export type OidcSettings = {
  issuer: string;
  audience: string;
  /** HS256 비밀 또는 RS256 공개키. 문자열에서 만들려면 `oidcKeyFrom`. */
  key: string | KeyObject;
  /**
   * 어느 클레임이 역할인가. **안 정하면 `role`.**
   *
   * 최상위 `role` 은 IdP 마다 뜻이 다르고, 사용자가 프로필로 넣을 수 있는 자리와
   * 충돌하기 쉽다. 그래서 대부분의 IdP 가 네임스페이스 클레임을 권한다
   * (`https://example.com/role`). 어느 쪽인지는 배포가 안다.
   *
   * **정하면 그 클레임만 본다.** `role` 로 떨어지면 고친 것이 아니라 경로를 하나
   * 더 늘린 것이 된다 — 사용자가 넣을 수 있는 자리가 그대로 남는다.
   */
  roleClaim?: string;
  /**
   * 이 로그인 시도에 묶는 값 (OIDC Core 3.1.2.1 · 검수 S-06 나머지).
   *
   * 주면 `id_token` 이 **같은 값을 담고 있어야** 한다. 없으면 다른 데서 얻은 멀쩡한
   * 토큰 하나가 어느 세션에나 들어맞는다.
   *
   * 안 주면 안 따진다 — nonce 를 안 보낸 시작 흐름을 막으면 안 된다.
   */
  nonce?: string;
  /**
   * `kid` → 공개키 (검수 S-06 나머지 · JWKS).
   *
   * 주면 **이쪽만 본다.** 모르는 `kid` 를 고정 키(`key`)로 떨어뜨리면, 회전을 켠 배포가
   * 실제로는 안 켠 상태로 돌면서 옛 키로 서명한 토큰을 계속 받는다.
   *
   * 동기다. 이 검증은 요청 경로에 있고, 여기서 다시 당기면 **인증 안 된 요청이 우리
   * 아웃바운드를 흔드는 손잡이**가 된다. 당기는 것은 타이머의 몫이다.
   */
  keys?: (kid: string | undefined) => string | KeyObject | undefined;
  now?: () => number;
};

/**
 * 설정 문자열에서 검증 키를 만든다 (검수 S-06).
 *
 * `verifyJwtSig` 는 RS256 을 구현해 뒀는데 `key` 가 `KeyObject` 일 때만 탄다. 그런데
 * 기동 코드는 환경변수 문자열을 그대로 넣고 있었다 — **문자열이면 RS256 은 무조건
 * false 다.** 구현은 있고 도달할 수 없었다.
 *
 * 그 상태의 OIDC 는 HMAC 비밀을 나눠 갖는 구성에서만 동작하는데, id_token 에 그런
 * 구성을 내주는 IdP 는 거의 없다. Auth0·Okta·Entra·Google·Keycloak 전부 RS256 이다.
 *
 * PEM 인지로 가른다. 접두사를 보고 판별하므로 HS256 비밀을 쓰던 배포는 그대로다 —
 * `-----BEGIN` 으로 시작하는 HMAC 비밀은 없다.
 */
export function oidcKeyFrom(raw: string): string | KeyObject {
  if (!raw.startsWith('-----BEGIN')) return raw;
  return createPublicKey(raw);
}

const b64urlDecode = (s: string): Buffer => {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
};

const isRole = (v: unknown): v is Role =>
  v === 'auditor' || v === 'operator' || v === 'admin';

function verifyJwtSig(
  alg: string | undefined, input: string, sigB64: string, key: string | KeyObject,
): boolean {
  const sig = b64urlDecode(sigB64);
  /**
   * **알고리즘은 키가 정한다. 토큰은 그것과 맞기만 하면 된다** (검수 2026-08-24 SCAN-3).
   *
   * 전에는 `if (alg === 'HS256')` · `if (alg === 'RS256')` 로 **토큰 헤더가 분기를
   * 골랐다.** 헤더는 서명 밖이라 공격자가 쓴다 — JWT 알고리즘 혼동(algorithm
   * confusion)이 바로 그 모양이고, 이 저장소가 `oidcKeyFrom` 을 만든 이유(구현은
   * 있는데 안 타던 RS256)와 같은 가족의 문제다.
   *
   * 실제로 뚫리지는 않았다: 각 분기가 키 종류를 다시 봤기 때문이다. 그래서 이것은
   * **동작 변경이 아니라 같은 판정을 옳은 순서로 다시 쓴 것**이다 — 진리표가 같다.
   * 그래도 다시 쓰는 이유는, 방어가 「두 분기가 각자 키 종류를 확인한다」에 매달려
   * 있으면 분기가 하나 늘 때 그 확인이 빠질 자리가 하나 늘기 때문이다. 이 저장소가
   * 목록으로 관리하다 물린 자리(N1 · N3 · N4-b)와 같은 종류다.
   */
  const expected = typeof key === 'string' ? 'HS256' : 'RS256';
  if (alg !== expected) return false;
  if (typeof key === 'string') {
    const mac = createHmac('sha256', key).update(input).digest();
    return mac.length === sig.length && timingSafeEqual(mac, sig);
  }
  try {
    return createVerify('RSA-SHA256').update(input).verify(key, sig);
  } catch {
    return false;
  }
}

/** OpenID Connect Core — 서명 · iss · aud · exp · sub. 실패하면 없음 (401). */
export function principalFromIdToken(token: string, oidc: OidcSettings): Principal | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const headerB64 = parts[0] ?? '';
  const payloadB64 = parts[1] ?? '';
  const sigB64 = parts[2] ?? '';
  let header: { alg?: string; kid?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString()) as { alg?: string; kid?: string };
    payload = JSON.parse(b64urlDecode(payloadB64).toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  // JWKS 를 켰으면 `kid` 로 고른다. 못 고르면 거절 — 고정 키로 안 떨어진다.
  const key = oidc.keys === undefined ? oidc.key : oidc.keys(header.kid);
  if (key === undefined) return undefined;
  if (!verifyJwtSig(header.alg, `${headerB64}.${payloadB64}`, sigB64, key)) return undefined;
  const now = oidc.now?.() ?? Math.floor(Date.now() / 1000);
  if (payload['iss'] !== oidc.issuer) return undefined;
  const aud = payload['aud'];
  const audOk = aud === oidc.audience
    || (Array.isArray(aud) && aud.includes(oidc.audience));
  if (!audOk) return undefined;
  /**
   * **청중이 여럿이면 `azp` 를 본다** (검수 S-07).
   *
   * 전에는 "우리 이름이 배열에 있으면 통과" 였다. 같은 IdP 의 다른 클라이언트에
   * 발급된 토큰이 우리를 청중에 얹고 있으면 그대로 지난다 — 그 클라이언트가 우리
   * 컨트롤 플레인을 부를 자격을 얻는다.
   *
   * OIDC Core 가 이 경우를 위해 `azp`(authorized party)를 두고, 청중이 여럿이면
   * 반드시 있어야 한다고 못박는다. 단일 청중에서는 요구하지 않는다 — 요구하면
   * `azp` 를 안 넣는 멀쩡한 IdP 가 전부 막힌다.
   */
  if (Array.isArray(aud) && aud.length > 1 && payload['azp'] !== oidc.audience) return undefined;
  const exp = payload['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) return undefined;
  const sub = payload['sub'];
  if (typeof sub !== 'string' || sub === '') return undefined;
  // **기대하면 반드시 있어야 한다.** 토큰에 nonce 가 없을 때 통과시키면, 검사를 켠
  // 배포가 nonce 를 안 돌려주는 IdP 앞에서 조용히 검사 없는 상태로 돌아간다.
  if (oidc.nonce !== undefined && payload['nonce'] !== oidc.nonce) return undefined;
  // 정했으면 그 클레임만. 안 정했으면 `role`. 떨어지지 않는다 — 위 주석 참조.
  const role = payload[oidc.roleClaim ?? 'role'];
  if (!isRole(role)) return undefined;
  return { name: sub, scopes: new Set(scopesOfRole(role)), role };
}

export class TokenAuth {
  readonly #byHash = new Map<string, Principal>();
  readonly #oidc: OidcSettings | undefined;

  constructor(specs: readonly TokenSpec[], oidc?: OidcSettings) {
    this.#oidc = oidc;
    for (const s of specs) {
      if (!/^sha256:[0-9a-f]{64}$/.test(s.hash)) {
        throw new Error(`토큰 해시 모양이 아니다 (${s.name}): sha256:<64 hex> 여야 한다`);
      }
      this.#byHash.set(s.hash, {
        name: s.name,
        scopes: new Set(scopesOf(s)),
        ...(s.role === undefined ? {} : { role: s.role }),
      });
    }
  }

  /**
   * `Authorization: Bearer <token>` 을 principal 로.
   *
   * 해시 토큰을 먼저 본다. 아니면 OIDC ID Token. **비교는 타이밍 세이프다.**
   */
  authenticate(header: string | undefined): Principal | undefined {
    if (header === undefined) return undefined;
    const m = /^Bearer\s+(\S+)$/.exec(header.trim());
    if (m === null) return undefined;
    const token = m[1] ?? '';
    const want = Buffer.from(hashToken(token), 'utf8');
    let found: Principal | undefined;
    for (const [hash, principal] of this.#byHash) {
      const got = Buffer.from(hash, 'utf8');
      if (got.length === want.length && timingSafeEqual(got, want)) found = principal;
    }
    if (found !== undefined) return found;
    if (this.#oidc === undefined) return undefined;
    return principalFromIdToken(token, this.#oidc);
  }

  /**
   * 이름으로 principal 을 찾는다 (mTLS 신원 매핑, S-05b).
   *
   * **역할표는 여전히 한 자리다.** 인증서는 "이 사람이 그 이름이 맞는가" 만 답하고,
   * 그 이름이 여기 있어야 principal 이 된다 — 인증서가 역할을 들고 오면 CA 를 쥔
   * 사람이 곧 admin 을 발급할 수 있고, 그게 W4-2 가 피한 것이다.
   */
  byName(name: string): Principal | undefined {
    for (const p of this.#byHash.values()) {
      if (p.name === name) return p;
    }
    return undefined;
  }

  get size(): number {
    return this.#byHash.size;
  }
}

export const can = (p: Principal, scope: Scope): boolean => p.scopes.has(scope);

/**
 * 클라이언트 인증서 → principal (S-05b 의 남은 절반, 2026-08-23).
 *
 * W4-2 는 mTLS 를 **망 관문까지만** 열고 신원 매핑은 일부러 안 했다:
 *
 * > 클라이언트 인증서를 **신원**으로 쓰는 것은 역할 매핑 설계가 필요하고 섞으면
 * > 권한의 진실이 둘이 된다.
 *
 * 그 걱정이 옳았고, 여기서 푸는 방법은 **진실을 하나로 유지하는 것**이다:
 *
 *     인증서 CN → 토큰 표의 `name` → 그 토큰의 role·scopes
 *
 * 인증서는 이름만 말한다. 역할은 안 들고 온다 — `OU=admin` 이라고 적혀 있어도 무시한다.
 *
 * ── 두 가지를 반드시 지킨다
 *
 * ① **TLS 층이 이미 검증한 것만 본다.** `rejectUnauthorized` 가 켜져 있어야
 *    `getPeerCertificate()` 의 CN 이 뜻을 갖는다 — 안 그러면 아무나 적어 낸다.
 *    `apiTlsOptions` 는 `clientCa` 가 있을 때 둘을 함께 켠다.
 * ② **CN 만 본다.** `O`·`OU` 를 fallback 으로 읽으면 "어느 필드가 신원인가" 가
 *    인증서마다 달라지고, 그 모호함은 발급 정책이 느슨한 CA 에서 곧 사고가 된다.
 */
export type PeerCertificate = {
  subject?: Record<string, string> | undefined;
  /** TLS 층이 체인을 검증했는가. */
  authorized: boolean;
};

export function principalFromClientCert(
  cert: PeerCertificate | undefined,
  auth: TokenAuth,
): Principal | undefined {
  if (cert === undefined || !cert.authorized) return undefined;
  const cn = cert.subject?.['CN'];
  if (typeof cn !== 'string') return undefined;
  const name = cn.trim();
  if (name === '') return undefined;
  return auth.byName(name);
}
