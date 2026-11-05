/**
 * Role Change SET 검증 — heliopause `src/set.ts` 와 같은 계약.
 *
 * 재는 것: 서명(위조 · 다른 키 · HS256 거절) · typ · nonce(ID Token 혼동) · iss · aud · iat 미래 · exp · 수명 상한 · jti · sub ·
 * txn(필수 · 숫자) · events 키 · 두 배열의 모양 · 크기 상한 · 정상.
 */
import { createHmac, createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MAX_SET_BYTES, verifyRoleChange } from '../../src/accounts/idp-roles/role-change.js';

const ISS = 'https://idp.test';
const EVENT = 'https://idp.test/events/role-change';
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
const NOW = 1_800_000_000;

const b64 = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
function sign(payload: Record<string, unknown>, header: Record<string, unknown> = {}, key = privateKey): string {
  const h = b64({ alg: 'RS256', typ: 'secevent+jwt', kid: 'k1', ...header });
  const p = b64(payload);
  return `${h}.${p}.${createSign('RSA-SHA256').update(`${h}.${p}`).sign(key).toString('base64url')}`;
}
const good = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: ISS, aud: 'bary', iat: NOW - 5, exp: NOW + 300, jti: 'j-1', sub: 'u-1', txn: '1800000000123',
  events: { [EVENT]: { roles: ['barycenter-operators'], entitlements: ['barycenter.no_apply'] } }, ...over,
});
const verify = (token: string) => verifyRoleChange(token, {
  issuer: ISS, clientId: 'bary', eventKey: EVENT, keyFor: (kid) => (kid === 'k1' ? publicKey : undefined), now: () => NOW * 1000,
});

describe('Role Change SET 검증', () => {
  it('정상 — sub · jti · txn · exp · 두 배열', () => {
    expect(verify(sign(good()))).toEqual({
      ok: true,
      change: { sub: 'u-1', jti: 'j-1', txn: 1800000000123n, exp: NOW + 300, roles: ['barycenter-operators'], entitlements: ['barycenter.no_apply'] },
    });
  });

  it('**위조 SET 거절** — 다른 키 · 모르는 kid · 서명 변조 · HS256', () => {
    expect(verify(sign(good(), {}, other.privateKey))).toMatchObject({ ok: false, status: 401 });
    expect(verify(sign(good(), { kid: 'nope' }))).toMatchObject({ ok: false, status: 401 });
    const t = sign(good());
    const tampered = `${t.split('.')[0]}.${b64(good({ events: { [EVENT]: { roles: ['barycenter-admins'], entitlements: [] } } }))}.${t.split('.')[2]}`;
    expect(verify(tampered)).toMatchObject({ ok: false, status: 401 });
    const h = b64({ alg: 'HS256', typ: 'secevent+jwt', kid: 'k1' });
    const p = b64(good());
    const hs = `${h}.${p}.${createHmac('sha256', 'x').update(`${h}.${p}`).digest('base64url')}`;
    expect(verify(hs)).toMatchObject({ ok: false, status: 401 });
    expect(verify('a.b')).toMatchObject({ ok: false, status: 401 });
  });

  it('**ID Token 을 역할 변경으로 받지 않는다** — typ · nonce', () => {
    expect(verify(sign(good(), { typ: 'JWT' }))).toMatchObject({ ok: false, reason: expect.stringMatching(/typ/) });
    expect(verify(sign(good({ nonce: 'n' })))).toMatchObject({ ok: false, reason: expect.stringMatching(/nonce/) });
  });

  it('iss · aud', () => {
    expect(verify(sign(good({ iss: 'https://evil.test' })))).toMatchObject({ ok: false, status: 401 });
    expect(verify(sign(good({ aud: 'other' })))).toMatchObject({ ok: false, status: 401 });
    expect(verify(sign(good({ aud: ['other', 'bary'] })))).toMatchObject({ ok: true });
  });

  it('신선도 — iat 미래 · 만료 · 수명 상한 · iat/exp 없음', () => {
    expect(verify(sign(good({ iat: NOW + 120 })))).toMatchObject({ ok: false, reason: expect.stringMatching(/미래/) });
    expect(verify(sign(good({ exp: NOW })))).toMatchObject({ ok: false, reason: expect.stringMatching(/만료/) });
    expect(verify(sign(good({ iat: NOW - 10, exp: NOW + 3600 })))).toMatchObject({ ok: false, reason: expect.stringMatching(/수명/) });
    expect(verify(sign(good({ iat: undefined })))).toMatchObject({ ok: false, reason: expect.stringMatching(/iat/) });
  });

  it('jti · sub · **txn 은 필수**', () => {
    expect(verify(sign(good({ jti: '' })))).toMatchObject({ ok: false, reason: expect.stringMatching(/jti/) });
    expect(verify(sign(good({ sub: undefined })))).toMatchObject({ ok: false, reason: expect.stringMatching(/sub/) });
    expect(verify(sign(good({ txn: undefined })))).toMatchObject({ ok: false, reason: expect.stringMatching(/txn/) });
    expect(verify(sign(good({ txn: 12 })))).toMatchObject({ ok: false, reason: expect.stringMatching(/txn/) });
  });

  it('events 키가 설정과 다르거나 두 배열이 아니면 400', () => {
    expect(verify(sign(good({ events: { 'https://other/ev': { roles: [], entitlements: [] } } })))).toMatchObject({ ok: false, status: 400 });
    expect(verify(sign(good({ events: { [EVENT]: { roles: ['a'] } } })))).toMatchObject({ ok: false, status: 400 });
    expect(verify(sign(good({ events: { [EVENT]: { roles: [1], entitlements: [] } } })))).toMatchObject({ ok: false, status: 400 });
  });

  it('빈 배열은 「모두 철회」 로 그대로 온다', () => {
    expect(verify(sign(good({ events: { [EVENT]: { roles: [], entitlements: [] } } })))).toMatchObject({ ok: true, change: { roles: [], entitlements: [] } });
  });

  it('크기 상한을 넘으면 서명을 보기 전에 거절', () => {
    expect(verify('x'.repeat(MAX_SET_BYTES + 1))).toMatchObject({ ok: false, status: 400 });
  });
});
