/**
 * 최소 DER 인코더와 PKCS#10 CSR (RFC 2986)
 *
 * ── 왜 직접 쓰는가 ───────────────────────────────────────────────────────
 *
 * ACME 는 finalize 에 **CSR** 을 요구한다(RFC 8555 §7.4). Node 에는 CSR 을 만드는 API 가
 * 없다 — `X509Certificate` 는 읽기만 한다. 방법은 셋이었다.
 *
 *   · npm 패키지  → §11.2 가 정한 "런타임 의존성은 `pg` 뿐" 을 깬다
 *   · `openssl` 셸아웃 → 컨트롤 플레인에 바이너리 의존이 생긴다. 엔진과 달리 이건
 *     **CP 호스트**에 필요한 것이라, 컨테이너 이미지 계약이 바뀐다
 *   · 직접 인코딩 → ASN.1 을 조금 알아야 하지만 **필요한 범위가 아주 좁다**
 *
 * 마지막을 골랐다. CSR 하나에 필요한 것은 SEQUENCE·INTEGER·BIT STRING·OID·SAN 확장뿐이고,
 * 키 타입도 우리가 정한다(P-256). 넓은 ASN.1 라이브러리가 아니라 **이 한 장을 만드는
 * 코드**다.
 *
 * ── 무엇을 안 하는가 ────────────────────────────────────────────────────
 *
 * 파서가 없다. 읽는 쪽은 `X509Certificate` 가 한다. 인코더도 **길이 < 2^24** 만 다룬다 —
 * CSR 은 그보다 훨씬 작고, 넓게 만들면 안 쓰는 경로가 검증 없이 남는다.
 */
import { createPublicKey, createSign, generateKeyPairSync, type KeyObject } from 'node:crypto';

/** ASN.1 태그. 쓰는 것만 적는다. */
const TAG = {
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8: 0x0c,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/**
 * DER 길이. **정의 길이만** 쓴다 — 부정 길이(0x80)는 DER 에서 금지다.
 */
function len(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  if (n <= 0xff) return Buffer.from([0x81, n]);
  if (n <= 0xffff) return Buffer.from([0x82, n >> 8, n & 0xff]);
  if (n <= 0xffffff) return Buffer.from([0x83, n >> 16, (n >> 8) & 0xff, n & 0xff]);
  throw new Error(`DER 길이가 너무 크다: ${n} — 이 인코더는 CSR 크기만 다룬다`);
}

const tlv = (tag: number, body: Buffer): Buffer =>
  Buffer.concat([Buffer.from([tag]), len(body.length), body]);

export const seq = (...parts: Buffer[]): Buffer => tlv(TAG.SEQUENCE, Buffer.concat(parts));
export const set = (...parts: Buffer[]): Buffer => tlv(TAG.SET, Buffer.concat(parts));
export const utf8 = (s: string): Buffer => tlv(TAG.UTF8, Buffer.from(s, 'utf8'));
export const nullValue = (): Buffer => Buffer.from([TAG.NULL, 0x00]);

/** 정수. **최상위 비트가 1 이면 0x00 을 앞에 붙인다** — 안 그러면 음수가 된다. */
export function integer(value: number | Buffer): Buffer {
  let body = typeof value === 'number' ? Buffer.from([value]) : value;
  if (body.length === 0) body = Buffer.from([0]);
  if ((body[0]! & 0x80) !== 0) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(TAG.INTEGER, body);
}

/** `1.2.840.10045.2.1` 같은 점 표기를 DER OID 로. */
export function oid(dotted: string): Buffer {
  const parts = dotted.split('.').map(Number);
  if (parts.length < 2 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
    throw new Error(`OID 가 아니다: ${dotted}`);
  }
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (const part of parts.slice(2)) {
    // base-128, 마지막 바이트만 최상위 비트가 0.
    const chunks: number[] = [];
    let v = part;
    do {
      chunks.unshift(v & 0x7f);
      v >>>= 7;
    } while (v > 0);
    for (let i = 0; i < chunks.length - 1; i += 1) chunks[i]! |= 0x80;
    out.push(...chunks);
  }
  return tlv(TAG.OID, Buffer.from(out));
}

/** BIT STRING. 앞에 "쓰지 않는 비트 수" 바이트가 붙는다 — 우리 용도는 언제나 0 이다. */
export const bitString = (body: Buffer): Buffer =>
  tlv(TAG.BIT_STRING, Buffer.concat([Buffer.from([0]), body]));

export const octetString = (body: Buffer): Buffer => tlv(TAG.OCTET_STRING, body);

/** 문맥 특정 태그 `[n]`. constructed 로 만든다. */
export const context = (n: number, body: Buffer): Buffer => tlv(0xa0 | n, body);

// ── OID 상수 ─────────────────────────────────────────────────────────────
const OID_CN = '2.5.4.3';
const OID_EXT_REQUEST = '1.2.840.113549.1.9.14';
const OID_SAN = '2.5.29.17';
const OID_ECDSA_SHA256 = '1.2.840.10045.4.3.2';

/**
 * SAN 확장 값. dNSName 은 `[2]` **primitive** 다.
 *
 * `context()` 는 constructed 를 만들므로 여기서는 못 쓴다 — 이걸 틀리면 CA 가 SAN 을
 * 아예 못 읽는다. 실제로 openssl 이 "unable to load" 로 답한다.
 */
function generalNames(domains: readonly string[]): Buffer {
  const names = domains.map((d) => tlv(0x82, Buffer.from(d, 'utf8')));
  return seq(...names);
}

export type Csr = { der: Buffer; pem: string };

/**
 * P-256 키로 CSR 하나를 만든다.
 *
 * **subject 는 비워 둔다** (`domains[0]` 을 CN 에 넣는 것도 지원한다). 현대 CA 는 SAN 만
 * 보고 CN 을 무시하며, Let's Encrypt 는 CN 이 64 자를 넘으면 거절한다 — 도메인이 길면
 * 그 자체로 실패 원인이 된다.
 */
export function createCsr(domains: readonly string[], key: KeyObject, opts: {
  includeCommonName?: boolean;
} = {}): Csr {
  if (domains.length === 0) throw new Error('CSR 에 도메인이 하나도 없다');

  const subject = opts.includeCommonName === true
    ? seq(set(seq(oid(OID_CN), utf8(domains[0]!))))
    : seq();

  // SubjectPublicKeyInfo 는 Node 가 이미 DER 로 준다. 다시 만들지 않는다.
  // **공개키에서 뽑는다** — 개인키 객체에 `spki` 를 물으면 던진다.
  const spki = createPublicKey(key).export({ type: 'spki', format: 'der' });

  // attributes: [0] { extensionRequest { SAN } }
  const attributes = context(0, seq(
    oid(OID_EXT_REQUEST),
    set(seq(seq(oid(OID_SAN), octetString(generalNames(domains))))),
  ));

  const info = seq(integer(0), subject, spki, attributes);

  const signer = createSign('sha256');
  signer.update(info);
  signer.end();
  const signature = signer.sign(key);

  const der = seq(info, seq(oid(OID_ECDSA_SHA256)), bitString(signature));
  const b64 = der.toString('base64').replace(/(.{64})/g, '$1\n');
  return {
    der,
    pem: `-----BEGIN CERTIFICATE REQUEST-----\n${b64}${b64.endsWith('\n') ? '' : '\n'}-----END CERTIFICATE REQUEST-----\n`,
  };
}

/** ACME 계정·인증서용 P-256 키. */
export function newEcKey(): KeyObject {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey;
}
