/**
 * AWS Signature Version 4 — Route 53 · SES 를 SDK 없이 부르려고 직접 서명한다.
 *
 * 범위는 이 저장소가 쓰는 만큼이다: 헤더 서명(Authorization 헤더), 본문 해시는 SHA-256, 쿼리는 정렬한다.
 * S3 의 예외 규칙(경로를 한 번만 인코딩 · `x-amz-content-sha256`)은 다루지 않는다 — S3 를 부르지 않는다.
 *
 * 참고: https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_sigv-create-signed-request.html
 */
import { createHash, createHmac } from 'node:crypto';

export type AwsCredentials = { accessKeyId: string; secretAccessKey: string; sessionToken?: string };

export type SignInput = {
  method: string;
  url: string;
  /** 서명에 넣을 헤더. `host` 와 `x-amz-date` 는 여기서 더한다. */
  headers: Record<string, string>;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  now: Date;
};

const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const hmac = (key: Buffer | string, s: string): Buffer => createHmac('sha256', key).update(s, 'utf8').digest();

/** RFC 3986 인코딩 — `encodeURIComponent` 가 남기는 `!'()*` 도 인코딩한다. */
export function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `20150830T123600Z` */
export function amzDate(now: Date): string {
  return now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** 서명된 헤더를 돌려준다(원래 헤더 + host · x-amz-date · (있으면) x-amz-security-token · authorization). */
export function signV4(i: SignInput): Record<string, string> {
  const u = new URL(i.url);
  const date = amzDate(i.now);
  const day = date.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, host: u.host, 'x-amz-date': date };
  if (i.credentials.sessionToken !== undefined) headers['x-amz-security-token'] = i.credentials.sessionToken;

  const lower = new Map<string, string>();
  for (const [k, v] of Object.entries(headers)) lower.set(k.toLowerCase(), v.trim().replace(/\s+/g, ' '));
  const names = [...lower.keys()].sort();
  const canonicalHeaders = names.map((n) => `${n}:${lower.get(n)}\n`).join('');
  const signedHeaders = names.join(';');

  // 경로: 각 조각을 다시 인코딩한다(S3 가 아닌 서비스의 규칙). `URL.pathname` 은 이미 한 번 인코딩돼 있다.
  const path = u.pathname === '' ? '/' : u.pathname.split('/').map((seg) => uriEncode(decodeURIComponent(seg))).map((seg) => uriEncode(seg)).join('/');
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort(([a, av], [b, bv]) => (a < b ? -1 : a > b ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const canonical = [i.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256Hex(i.body)].join('\n');
  const scope = `${day}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonical)].join('\n');
  const kDate = hmac(`AWS4${i.credentials.secretAccessKey}`, day);
  const kSigning = hmac(hmac(hmac(kDate, i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(toSign, 'utf8').digest('hex');
  headers['authorization'] =
    `AWS4-HMAC-SHA256 Credential=${i.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
