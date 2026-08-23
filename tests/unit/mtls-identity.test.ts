/**
 * S-05b 의 남은 절반 — **클라이언트 인증서를 신원으로 쓴다** (2026-08-23).
 *
 * W4-2 가 서버 TLS 는 정하고 mTLS 는 **일부러** 안 정했다:
 *
 * > 클라이언트 인증서를 **신원**으로 쓰는 것은 역할 매핑 설계가 필요하고 섞으면
 * > 권한의 진실이 둘이 된다 — `BARY_TLS_CLIENT_CA_FILE` 이 여는 것은 **망 관문**까지다.
 *
 * 그 걱정이 옳았다. 그래서 여기서 푸는 방법은 **권한의 진실을 하나로 유지하는 것**이다:
 * 인증서가 역할을 *들고 오지* 않는다. 인증서는 **이름만** 말하고, 그 이름이 이미 있는
 * 토큰 표에 있어야 principal 이 된다.
 *
 *   인증서 CN → 토큰 표의 `name` → 그 토큰의 role·scopes
 *
 * 그러면 역할표는 **여전히 한 자리**(`BARY_TOKENS`)이고, mTLS 는 "이 사람이 그 이름이
 * 맞는가" 만 답한다. 인증서에 role 을 적게 하면 CA 를 쥔 사람이 곧 admin 을 발급할 수
 * 있고, 그게 W4-2 가 피한 것이다.
 *
 * ⚠️ **TLS 층이 이미 검증한 인증서만 본다.** `rejectUnauthorized` 가 켜져 있어야
 * `socket.getPeerCertificate()` 의 값이 뜻을 갖는다 — 안 그러면 아무나 CN 을 적어 낸다.
 */
import { describe, expect, it } from 'vitest';

import { TokenAuth, principalFromClientCert } from '../../src/api/auth.js';

const auth = new TokenAuth([
  { name: 'ops', role: 'operator', hash: `sha256:${'a'.repeat(64)}` },
  { name: 'boss', role: 'admin', hash: `sha256:${'b'.repeat(64)}` },
]);

const cert = (subject: Record<string, string> | undefined, authorized = true) =>
  ({ subject, authorized } as Parameters<typeof principalFromClientCert>[0]);

describe('mTLS 신원 매핑 (S-05b 의 남은 절반)', () => {
  it('CN 이 토큰 이름과 맞으면 그 principal 이다', () => {
    const p = principalFromClientCert(cert({ CN: 'ops' }), auth);
    expect(p?.name).toBe('ops');
    expect([...(p?.scopes ?? [])].sort()).toEqual(['read', 'write']);
  });

  it('**역할은 인증서가 안 가져온다** — 토큰 표가 정본이다', () => {
    /**
     * 인증서에 `admin` 이라고 적혀 있어도 무시한다. 안 그러면 CA 를 쥔 사람이 곧
     * admin 을 발급할 수 있고, 권한의 진실이 둘이 된다.
     */
    const p = principalFromClientCert(cert({ CN: 'ops', OU: 'admin', O: 'admin' }), auth);
    expect([...(p?.scopes ?? [])].sort()).toEqual(['read', 'write']);
    expect([...(p?.scopes ?? [])]).not.toContain('admin');
  });

  it('모르는 CN 은 아무것도 아니다 — 인증서가 신원을 만들지 않는다', () => {
    expect(principalFromClientCert(cert({ CN: 'nobody' }), auth)).toBeUndefined();
  });

  it('**TLS 가 검증 안 한 인증서는 안 본다**', () => {
    // `rejectUnauthorized` 가 꺼져 있으면 아무나 CN 을 적어 낸다.
    expect(principalFromClientCert(cert({ CN: 'boss' }, false), auth)).toBeUndefined();
  });

  it('인증서가 없으면 아무것도 아니다', () => {
    expect(principalFromClientCert(cert(undefined), auth)).toBeUndefined();
    expect(principalFromClientCert(undefined, auth)).toBeUndefined();
  });

  it('CN 이 없으면 아무것도 아니다 — 다른 필드로 대신 읽지 않는다', () => {
    // O·OU 를 fallback 으로 읽으면 "어느 필드가 신원인가" 가 인증서마다 달라진다.
    expect(principalFromClientCert(cert({ O: 'ops' }), auth)).toBeUndefined();
  });

  it('빈 CN 을 거부한다', () => {
    expect(principalFromClientCert(cert({ CN: '' }), auth)).toBeUndefined();
    expect(principalFromClientCert(cert({ CN: '   ' }), auth)).toBeUndefined();
  });

  it('admin 도 같은 규칙으로 온다 — 표에 있으면 그 역할이다', () => {
    const p = principalFromClientCert(cert({ CN: 'boss' }), auth);
    expect([...(p?.scopes ?? [])]).toContain('admin');
  });
});
