/**
 * ACME 클라이언트의 **순수한 부분** (RFC 8555 · RFC 7638 · RFC 2986)
 *
 * S18 이 실물 CA(Pebble)로 전체 경로를 재지만 그건 도커가 필요하고 느리다. 여기서는
 * 도커 없이 도는 것들을 못 박는다 — 그리고 이것들은 **틀려도 조용한** 종류다.
 *
 * ── 왜 이 셋이 특히 위험한가 ────────────────────────────────────────────
 *
 *   · **ES256 서명 인코딩** — Node 의 기본은 DER 이고 JWS 는 raw R‖S 를 요구한다.
 *     틀리면 CA 가 `malformed` 라고만 답한다. 왜인지는 안 말해 준다.
 *   · **JWK thumbprint** — 필드 순서와 공백이 결과를 바꾼다. 틀리면 챌린지가 **항상**
 *     실패하는데, 증상은 "검증 실패" 라 자기 코드를 안 의심하게 된다.
 *   · **CSR DER** — 한 바이트만 틀려도 CA 가 거절한다. 여기서는 `openssl` 에게 판정을
 *     맡긴다. 내가 만든 것을 내가 파싱해서 확인하면 같은 오해를 두 번 하는 것이다.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createPublicKey, createSign, createVerify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCsr, integer, newEcKey, oid, seq } from '../../src/acme/der.js';
import {
  b64url, dns01Value, keyAuthorization, publicJwk, thumbprint,
} from '../../src/acme/client.js';

function opensslAvailable(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const hasOpenssl = opensslAvailable();

let dir = '';
beforeAll(() => {
  if (hasOpenssl) dir = mkdtempSync(join(tmpdir(), 'bary-acme-'));
});
afterAll(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

describe('base64url', () => {
  it('패딩과 `+/` 가 없다 — JWS 는 그걸 못 받는다', () => {
    const out = b64url(Buffer.from([0xfb, 0xff, 0xfe, 0x00]));
    expect(out).not.toContain('=');
    expect(out).not.toContain('+');
    expect(out).not.toContain('/');
    expect(out).toBe('-__-AA');
  });
});

describe('DER 인코딩', () => {
  it('OID 를 base-128 로 쓴다 — `2.5.29.17`(SAN) 은 알려진 값이 있다', () => {
    expect(oid('2.5.29.17').toString('hex')).toBe('0603551d11');
    // 128 을 넘는 성분은 여러 바이트로 갈린다. 이걸 한 바이트로 쓰면 조용히 다른 OID 가 된다.
    expect(oid('1.2.840.113549').toString('hex')).toBe('06062a864886f70d');
  });

  it('**최상위 비트가 1 인 정수 앞에 0x00 을 붙인다** — 안 붙이면 음수가 된다', () => {
    expect(integer(Buffer.from([0x80])).toString('hex')).toBe('02020080');
    expect(integer(Buffer.from([0x7f])).toString('hex')).toBe('02017f');
  });

  it('긴 길이를 다단계로 쓴다', () => {
    const body = Buffer.alloc(200);
    expect(seq(body).subarray(0, 3).toString('hex')).toBe('3081c8');
  });
});

describe.runIf(hasOpenssl)('CSR — 판정은 openssl 이 한다', () => {
  const parse = (pem: string): string => {
    const path = join(dir, `t-${Math.abs(pem.length)}.csr`);
    writeFileSync(path, pem);
    return execFileSync('openssl', ['req', '-in', path, '-noout', '-text']).toString();
  };

  it('**openssl 이 자기 서명을 검증한다** — 한 바이트만 틀려도 여기서 죽는다', () => {
    const key = newEcKey();
    const path = join(dir, 'verify.csr');
    writeFileSync(path, createCsr(['a.test'], key).pem);
    const r = spawnSync('openssl', ['req', '-in', path, '-noout', '-verify'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`.toLowerCase()).toContain('verify ok');
  });

  it('SAN 이 전부 들어간다 — 와일드카드도', () => {
    const text = parse(createCsr(['a.test', '*.b.test', 'c.d.test'], newEcKey()).pem);
    expect(text).toContain('DNS:a.test');
    expect(text).toContain('DNS:*.b.test');
    expect(text).toContain('DNS:c.d.test');
  });

  it('**subject 를 비워 둔다** — CN 64자 제한에 걸리지 않기 위해서다', () => {
    const text = parse(createCsr(['a.test'], newEcKey()).pem);
    expect(text).toMatch(/Subject:\s*\n/);
  });

  it('원하면 CN 을 넣는다', () => {
    const text = parse(createCsr(['a.test'], newEcKey(), { includeCommonName: true }).pem);
    expect(text).toMatch(/CN\s*=\s*a\.test/);
  });

  it('도메인이 없으면 던진다 — 빈 CSR 은 CA 가 어차피 거절한다', () => {
    expect(() => createCsr([], newEcKey())).toThrow();
  });
});

describe('JWS 서명 인코딩 — CA 가 malformed 라고만 답하는 자리', () => {
  it('**ES256 서명은 raw R‖S 64 바이트다** — Node 기본값인 DER 이면 안 된다', () => {
    const key = newEcKey();
    const s = createSign('sha256');
    s.update('x');
    s.end();
    const raw = s.sign({ key, dsaEncoding: 'ieee-p1363' });
    expect(raw.length).toBe(64);

    // 대조군: 기본값은 DER 이라 길이가 다르고 앞이 0x30 이다.
    const s2 = createSign('sha256');
    s2.update('x');
    s2.end();
    const der = s2.sign(key);
    expect(der[0]).toBe(0x30);
    expect(der.length).not.toBe(64);
  });

  it('서명이 실제로 검증된다', () => {
    const key = newEcKey();
    const s = createSign('sha256');
    s.update('payload');
    s.end();
    const sig = s.sign({ key, dsaEncoding: 'ieee-p1363' });
    const v = createVerify('sha256');
    v.update('payload');
    v.end();
    expect(v.verify({ key: createPublicKey(key), dsaEncoding: 'ieee-p1363' }, sig)).toBe(true);
  });
});

describe('JWK thumbprint (RFC 7638)', () => {
  it('공개 JWK 에 개인 성분이 없다 — 서명 헤더로 나가는 값이다', () => {
    const jwk = publicJwk(newEcKey());
    expect(Object.keys(jwk).sort()).toEqual(['crv', 'kty', 'x', 'y']);
    expect(JSON.stringify(jwk)).not.toContain('"d"');
  });

  it('SHA-256 을 base64url 로 — 43 자다', () => {
    expect(thumbprint(newEcKey())).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('같은 키는 같은 값, 다른 키는 다른 값', () => {
    const a = newEcKey();
    expect(thumbprint(a)).toBe(thumbprint(a));
    expect(thumbprint(a)).not.toBe(thumbprint(newEcKey()));
  });

  it('key authorization 은 `token.thumbprint` 다', () => {
    const key = newEcKey();
    expect(keyAuthorization('tok', key)).toBe(`tok.${thumbprint(key)}`);
  });

  it('**dns-01 은 key authorization 의 SHA-256** — http-01 처럼 그대로 쓰면 안 된다', () => {
    const key = newEcKey();
    const value = dns01Value('tok', key);
    expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // 그대로 쓰는 실수를 막는다. 둘은 다른 값이고, 섞으면 챌린지가 항상 실패한다.
    expect(value).not.toBe(keyAuthorization('tok', key));
  });
});
