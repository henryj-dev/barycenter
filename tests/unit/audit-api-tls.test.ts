/**
 * 검수 2026-08-22 · S-05b — **제어 API 가 평문 HTTP 만 할 줄 안다**
 *
 * 이 API 는 인증서 **개인키를 요청 본문으로 받는다** (`POST /api/v1/certificates`).
 * 그리고 Bearer 토큰을 헤더로 받는다. 둘 다 평문으로 흘렀다 — 데몬이
 * `http.createServer` 하나만 만들 줄 알았기 때문이다.
 *
 * W0-a 가 기본 바인드를 루프백으로 내려 **급성 노출**은 닫았지만, 그건 "밖에서 못
 * 붙는다" 이지 "안에서 안 샌다" 가 아니다. 같은 호스트의 다른 프로세스, 사이드카,
 * 호스트 네트워크를 공유하는 컨테이너는 여전히 평문을 본다.
 *
 * ── 무엇을 정했고 무엇을 안 정했나
 *
 * **서버 TLS 는 정했다.** 개인키를 받는 엔드포인트를 평문으로 여는 것은 정책 문제가
 * 아니라 결함이다. 선택으로 두되(끄면 지금과 같다) 켤 수 있어야 한다.
 *
 * **클라이언트 인증서를 신원으로 쓸지는 안 정했다.** 그건 역할 매핑 설계가 필요하고,
 * 잘못 하면 토큰 경로와 진실이 둘이 된다. 여기서 여는 것은 **망 관문**까지다 — 붙을
 * 수 있는 자를 좁힐 뿐, 누구인지는 여전히 토큰이 답한다.
 */
import { readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { apiTlsOptions } from '../../src/api/server.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

// **내용은 안 본다.** 이 함수가 지는 책임은 옵션 조립이고, PEM 해석은 `tls` 가 한다.
const CERT = '-----BEGIN CERTIFICATE-----\ndGVzdA==\n-----END CERTIFICATE-----\n';

describe('제어 API TLS (검수 S-05b)', () => {
  it('cert 와 key 를 그대로 넘긴다', () => {
    const o = apiTlsOptions({ cert: CERT, key: KEY });
    expect(o.cert).toBe(CERT);
    expect(o.key).toBe(KEY);
  });

  it('클라이언트 CA 를 안 주면 클라이언트 인증서를 요구하지 않는다', () => {
    // 기본으로 요구하면 켜는 순간 모든 클라이언트가 막힌다. 서버 TLS 와 mTLS 는
    // 다른 결정이고, 하나를 켠다고 다른 하나가 따라오면 안 된다.
    const o = apiTlsOptions({ cert: CERT, key: KEY });
    expect(o.requestCert).toBeUndefined();
    expect(o.ca).toBeUndefined();
  });

  it('클라이언트 CA 를 주면 요구하고, 검증까지 한다', () => {
    /**
     * `requestCert` 만 켜고 `rejectUnauthorized` 를 빠뜨리면 **아무 인증서나 통과한다** —
     * 요구는 하는데 안 보는 상태다. 켰다는 착각만 주고 아무것도 안 막는다.
     */
    const o = apiTlsOptions({ cert: CERT, key: KEY, clientCa: CERT });
    expect(o.requestCert).toBe(true);
    expect(o.rejectUnauthorized).toBe(true);
    expect(o.ca).toBe(CERT);
  });

  it('TLS 1.2 밑으로는 안 내려간다', () => {
    // 렌더러 쪽 TLS 정책(W0-4)과 같은 기준이다. 제어 평면이 데이터 평면보다
    // 느슨할 이유가 없다.
    expect(apiTlsOptions({ cert: CERT, key: KEY }).minVersion).toBe('TLSv1.2');
  });

  it('반만 채운 설정은 거절한다', () => {
    // 환경변수를 하나만 넣은 배포가 조용히 평문으로 뜨면 안 된다. 그 침묵이
    // "TLS 켰다" 는 믿음과 평문 소켓을 동시에 만든다.
    expect(() => apiTlsOptions({ cert: '', key: KEY })).toThrow(/cert/);
    expect(() => apiTlsOptions({ cert: CERT, key: '' })).toThrow(/key/);
  });
});

describe('핸들러와 서버를 뗀다 (검수 S-05b)', () => {
  /**
   * `createApi` 가 `http.Server` 를 만들어 돌려주기만 해서 **핸들러를 꺼낼 자리가
   * 없었다.** https 로 세우려면 라우팅을 한 벌 더 쓰는 수밖에 없고, 그러면 두 벌이
   * 갈라진다 — `renderCapsOf` 를 한 자리로 모은 이유(B-02)와 같다.
   *
   * 구조로 잰다. 왕복 요청으로 재려면 `ApiOptions` 다섯 개(db·store·control·auth·
   * election)를 세워야 하는데, 그건 이 단언이 묻는 것과 다른 것을 재는 비용이다.
   * `audit-render-caps` 가 같은 판단을 했다.
   */
  const SRC = readFileSync(new URL('../../src/api/server.ts', import.meta.url), 'utf8');

  it('apiHandler 를 내보낸다', () => {
    expect(SRC).toMatch(/export function apiHandler\(/);
  });

  it('createApi 는 apiHandler 에 위임한다 — 라우팅이 두 벌이 되지 않는다', () => {
    const body = SRC.slice(SRC.indexOf('export function createApi('));
    const end = body.indexOf('\n}\n');
    const fn = body.slice(0, end);
    expect(fn).toContain('apiHandler(');
    // 인라인으로 다시 라우팅을 열지 않았는지 본다.
    expect(fn).not.toMatch(/url\.pathname/);
  });
});
