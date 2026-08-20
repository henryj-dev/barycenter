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
import { createHash, createHmac, createVerify, timingSafeEqual, type KeyObject } from 'node:crypto';

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

export function scopesOfRole(role: Role): Scope[] {
  if (role === 'auditor') return ['read'];
  if (role === 'operator') return ['read', 'write'];
  return ['read', 'write', 'apply', 'admin'];
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
  /** HS256 비밀 또는 RS256 공개키. */
  key: string | KeyObject;
  now?: () => number;
};

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
  if (alg === 'HS256') {
    if (typeof key !== 'string') return false;
    const mac = createHmac('sha256', key).update(input).digest();
    return mac.length === sig.length && timingSafeEqual(mac, sig);
  }
  if (alg === 'RS256') {
    if (typeof key === 'string') return false;
    try {
      return createVerify('RSA-SHA256').update(input).verify(key, sig);
    } catch {
      return false;
    }
  }
  return false;
}

/** OpenID Connect Core — 서명 · iss · aud · exp · sub. 실패하면 없음 (401). */
export function principalFromIdToken(token: string, oidc: OidcSettings): Principal | undefined {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  const headerB64 = parts[0] ?? '';
  const payloadB64 = parts[1] ?? '';
  const sigB64 = parts[2] ?? '';
  let header: { alg?: string };
  let payload: Record<string, unknown>;
  try {
    header = JSON.parse(b64urlDecode(headerB64).toString()) as { alg?: string };
    payload = JSON.parse(b64urlDecode(payloadB64).toString()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  if (!verifyJwtSig(header.alg, `${headerB64}.${payloadB64}`, sigB64, oidc.key)) return undefined;
  const now = oidc.now?.() ?? Math.floor(Date.now() / 1000);
  if (payload['iss'] !== oidc.issuer) return undefined;
  const aud = payload['aud'];
  const audOk = aud === oidc.audience
    || (Array.isArray(aud) && aud.includes(oidc.audience));
  if (!audOk) return undefined;
  const exp = payload['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= now) return undefined;
  const sub = payload['sub'];
  if (typeof sub !== 'string' || sub === '') return undefined;
  const role = payload['role'];
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

  get size(): number {
    return this.#byHash.size;
  }
}

export const can = (p: Principal, scope: Scope): boolean => p.scopes.has(scope);
