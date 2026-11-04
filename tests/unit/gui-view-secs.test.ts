/**
 * 분할 상세 보기 모드 · 쓸 수 없는 설정 탭 = 콘솔 시안 `viewSecs` (2026-11-04).
 *
 * 시안은 그 리소스 설정 폼(`fieldsFor(page, v, false, 'form')`)의 구획 · 칸 전부를 라벨 + 보기 값으로 보인다.
 * 전에는 일반 요약 몇 줄을 「기본」 구획 하나로 그렸다. 재는 것:
 *   · 9종마다 구획 · 칸 · 보기 값이 시안 규칙(글 「—」 · 켜기 「켜짐/꺼짐」 · 목록 「없음」 · 출발지 「제한 없음」 · 규칙 줄)이다
 *   · 프로토콜 · 동작 · 켜짐에 따라 칸이 바뀐다(설정 폼과 같다)
 *   · API 에 없는 값은 「—」 다(가짜 값 금지)
 *   · 분할 상세와 쓸 수 없는 설정 탭이 같은 함수를 쓴다
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src');
const src = (p: string): string => readFileSync(join(GUI, p), 'utf8');
const load = async () => import('../../gui/src/lib/detail/view-secs.js');
type Secs = { t: string; f: { l: string; v: string }[] }[];
/** 구획 → { 라벨: 값 } — 보기 편하게. */
const flat = (secs: Secs): Record<string, Record<string, string>> =>
  Object.fromEntries(secs.map((s) => [s.t, Object.fromEntries(s.f.map((f) => [f.l, f.v]))]));

const model = {
  listeners: [
    {
      key: 'web', protocol: 'https', bind: '0.0.0.0', port: 443, hosts: ['a.example.com', 'b.example.com'],
      http: {
        defaultAction: { pool: 'api' }, limits: { connectTimeoutMs: 5000, readTimeoutMs: 1500, clientMaxBodyBytes: 50 * 1024 * 1024 },
        headers: { request: [{ name: 'X-Env', value: 'prod' }] }, rateLimit: { requestsPerSecond: 10, burst: 20, nodelay: true },
      },
      tls: { policy: 'modern', defaultCertificate: 'web-cert' }, httpRedirect: { port: 80 },
      sourceAllow: ['@cf', '10.0.0.0/8'], realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: ['@cf'] },
    },
    { key: 'dns', protocol: 'udp', bind: '127.0.0.1', port: 53, enabled: false, defaultPool: 'dns', udp: { preset: 'game_generic' } },
    { key: 'pt', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 8443, onUnmatchedSni: { pool: 'tcpp' }, onNoSni: 'reject' },
  ],
  addressSets: [{ key: 'cf', source: 'cloudflare', cidrs: ['173.245.48.0/20', '103.21.244.0/22'] }, { key: 'office', cidrs: [] }],
  tlsPolicies: [{ key: 'modern', minVersion: '1.2', cipherPolicy: 'modern-2026', hsts: { maxAgeSeconds: 600 } }],
  pools: [
    { key: 'api', protocolClass: 'http', algorithm: 'hash', hashKey: 'request_uri', healthCheck: { protocol: 'http', path: '/healthz', intervalS: 5 } },
    { key: 'dns', protocolClass: 'udp', algorithm: 'round_robin' },
    { key: 'tcpp', protocolClass: 'tcp', healthCheck: { mode: 'none' }, upstreamTls: { enabled: true, sni: 'x.internal', verify: false }, sendProxyProtocol: 'v1' },
  ],
  backends: [{ key: 'api-1', pool: 'api', host: '10.0.0.5', port: 8080, weight: 3 }],
  httpRoutes: [
    {
      key: 'r1', listener: 'web', hosts: ['a.example.com'], pathPrefixes: ['/api/'], priority: 100,
      action: { kind: 'proxy', pool: 'api', websocket: true, rewritePrefix: '/' },
      sourceRules: [{ from: ['10.0.0.0/8'], address: 'connection', action: { kind: 'reject', status: 403 } }, { from: ['@office'], action: { kind: 'proxy', pool: 'api' } }],
    },
    { key: 'r2', listener: 'web', hosts: ['b.example.com'], priority: 0, action: { kind: 'redirect', to: 'https://c.example.com/', status: 301 } },
  ],
  passthroughRoutes: [{ key: 'p1', listener: 'pt', snis: ['db.example.com'], priority: 5, action: { kind: 'reject' } }],
  certificates: [
    { key: 'web-cert', acme: { account: 'default', domains: ['*.example.com'] } },
    { key: 'up', material: { ref: 'x' } },
  ],
  sniBindings: [{ key: 's1', listener: 'web', hosts: [], certificate: 'web-cert' }],
};

describe('viewSecsOf — 시안 viewSecs 9종', () => {
  it('리스너(HTTPS): 시안 구획 순서 · 칸 · 보기 값', async () => {
    const { viewSecsOf } = await load();
    const secs = viewSecsOf(model, 'listener', 'web');
    expect(secs.map((s) => s.t)).toEqual(['기본', '동작', '접근 제한', '원본 IP', '타임아웃과 본문', '레이트리밋', '요청 헤더 규칙', '응답 헤더 규칙', 'priority 정책']);
    const v = flat(secs);
    expect(v['기본']).toEqual({ 이름: 'web', '바인드 주소': '0.0.0.0', 포트: '443', 활성화: '켜짐', 호스트: 'a.example.com\nb.example.com' });
    expect(v['동작']).toEqual({
      '기본 동작': '풀로 보내기', '기본 풀': 'api', 'TLS 정책': 'modern (TLS 1.2+)', '기본 인증서': 'web-cert', 'HTTP/2': '켜짐',
      'HTTP로 온 요청을 HTTPS로 보내기': '켜짐', 'HTTP 포트': '80',
    });
    expect(v['접근 제한']!['출발지 제한']).toBe('Cloudflare + 대역 1개 · @cf\n집합 cf\n10.0.0.0/8');
    expect(v['원본 IP']).toEqual({ 출처: 'HTTP 헤더', 헤더: 'CF-Connecting-IP', '신뢰 대역': 'Cloudflare만 (대역 2개) · @cf\n집합 cf' });
    expect(v['타임아웃과 본문']).toEqual({ '연결 타임아웃': '5 s', '읽기 타임아웃': '1500 ms', '쓰기 타임아웃': '—', '요청 본문 최대': '50 MB' });
    expect(v['레이트리밋']).toEqual({ 레이트리밋: '켜짐', '초당 요청': '10 req/s', burst: '20 req', nodelay: '켜짐', '동시 연결': '—' });
    expect(v['요청 헤더 규칙']).toEqual({ 규칙: 'X-Env: prod' });
    expect(v['응답 헤더 규칙']).toEqual({ 규칙: '없음' });
    expect(v['priority 정책']).toEqual({ 'priority 우선': '꺼짐' });
  });

  it('리스너(UDP · 패스스루): 프로토콜마다 동작 칸이 다르다 · UDP 는 원본 IP 가 없다', async () => {
    const { viewSecsOf } = await load();
    const udp = flat(viewSecsOf(model, 'listener', 'dns'));
    expect(Object.keys(udp)).toEqual(['기본', '동작', '접근 제한']);
    expect(udp['기본']).toEqual({ 이름: 'dns', '바인드 주소': '127.0.0.1', 포트: '53', 활성화: '꺼짐' });
    expect(udp['동작']).toEqual({ '기본 풀': 'dns', 프리셋: 'game' });
    expect(udp['접근 제한']).toEqual({ '출발지 제한': '제한 없음' });
    const pt = flat(viewSecsOf(model, 'listener', 'pt'));
    expect(pt['동작']).toEqual({ 'SNI 매칭 없음 폴백': '풀 tcpp', 'SNI 없음 폴백': '연결 거절', 'preread 타임아웃': '—' });
    expect(pt['원본 IP']).toEqual({ 출처: '없음' });
  });

  it('풀: 기본 · 헬스체크 · 더 보기 · 업스트림 TLS · 전송 — 계열과 방식에 따라', async () => {
    const { viewSecsOf } = await load();
    const api = flat(viewSecsOf(model, 'pool', 'api'));
    expect(Object.keys(api)).toEqual(['기본', '헬스체크', '헬스체크 더 보기', '업스트림 TLS', '전송']);
    expect(api['기본']).toEqual({ 이름: 'api', '프로토콜 계열': 'HTTP', 알고리즘: 'hash', 'hash 키': 'request_uri' });
    expect(api['헬스체크']).toEqual({ 방식: 'HTTP', 경로: '/healthz', 'Host 헤더': '—', '기대 상태 코드': '—', '기대 본문': '—', 주기: '5 s', 타임아웃: '—', rise: '—', fall: '—' });
    expect(api['헬스체크 더 보기']).toEqual({ 포트: '—', '프로브 주소': '—' });
    expect(api['업스트림 TLS']).toEqual({ '업스트림 TLS': '꺼짐' });
    const udp = flat(viewSecsOf(model, 'pool', 'dns'));
    expect(udp['헬스체크']).toEqual({ 정의: '검사 안 함' });
    expect(udp['기본']!['알고리즘']).toBe('round_robin');
    const tcp = flat(viewSecsOf(model, 'pool', 'tcpp'));
    expect(tcp['헬스체크']).toEqual({ 방식: '안 해요' });
    expect(tcp['헬스체크 더 보기']).toBeUndefined();
    expect(tcp['업스트림 TLS']).toEqual({ '업스트림 TLS': '켜짐', SNI: 'x.internal', '인증서 검증': '꺼짐', 'CA 번들': '—' });
    expect(tcp['전송']).toEqual({ 'PROXY 송신': '켜짐' });
  });

  it('백엔드: 드레인은 상태 API 에서 — 모르면 「—」', async () => {
    const { viewSecsOf } = await load();
    expect(flat(viewSecsOf(model, 'backend', 'api-1'))['기본']).toEqual({ 이름: 'api-1', 풀: 'api', 호스트: '10.0.0.5', 포트: '8080', 가중치: '3', 드레인: '—' });
    expect(flat(viewSecsOf(model, 'backend', 'api-1', { draining: true }))['기본']!['드레인']).toBe('켜짐');
  });

  it('주소 집합: 대역 목록 · 비면 「없음」', async () => {
    const { viewSecsOf } = await load();
    expect(flat(viewSecsOf(model, 'addressSet', 'cf'))['기본']).toEqual({ 이름: 'cf', '대역 목록': '173.245.48.0/20\n103.21.244.0/22' });
    expect(flat(viewSecsOf(model, 'addressSet', 'office'))['기본']!['대역 목록']).toBe('없음');
  });

  it('HTTP 라우트: 기본 · 동작 · 출발지별 동작(시안 규칙 줄)', async () => {
    const { viewSecsOf } = await load();
    const r1 = flat(viewSecsOf(model, 'httpRoute', 'r1'));
    expect(r1['기본']).toEqual({ 이름: 'r1', 리스너: 'web', 호스트: 'a.example.com', '경로 접두사': '/api/', 우선순위: '100' });
    expect(r1['동작']).toEqual({ 동작: '풀로 보내기', 풀: 'api', WebSocket: '켜짐', '경로 바꾸기': '/', '이 라우트의 요청 헤더': '없음' });
    expect(r1['출발지별 동작']).toEqual({ 규칙: '규칙 1 · 10.0.0.0/8 (연결 주소) → reject 403\n규칙 2 · @office → 풀 api' });
    const r2 = flat(viewSecsOf(model, 'httpRoute', 'r2'));
    expect(r2['기본']!['경로 접두사']).toBe('—');
    expect(r2['동작']).toEqual({ 동작: 'redirect', 대상: 'https://c.example.com/', '응답 코드': '301' });
    expect(r2['출발지별 동작']).toEqual({ 규칙: '없음' });
  });

  it('패스스루 라우트: 기본(SNI) · 동작 — 출발지별 동작은 없다', async () => {
    const { viewSecsOf } = await load();
    expect(flat(viewSecsOf(model, 'passthroughRoute', 'p1'))).toEqual({
      기본: { 이름: 'p1', 리스너: 'pt', SNI: 'db.example.com', 우선순위: '5' },
      동작: { 동작: '연결을 끊어요' },
    });
  });

  it('인증서: ACME 는 계정 · 자동 갱신 · 검증 방식(DNS-01 이면 공급자 준비 중) — 업로드는 자료 도메인', async () => {
    const { viewSecsOf } = await load();
    expect(flat(viewSecsOf(model, 'certificate', 'web-cert'))['기본']).toEqual({
      이름: 'web-cert', 도메인: '*.example.com', 발급자: 'ACME', 'ACME 계정': 'default', '자동 갱신': '켜짐', '검증 방식': 'DNS-01', 'DNS 공급자': '상태: 준비 중',
    });
    expect(flat(viewSecsOf(model, 'certificate', 'up'))['기본']).toEqual({ 이름: 'up', 도메인: '—', 발급자: '업로드' });
    expect(flat(viewSecsOf(model, 'certificate', 'up', { certDomains: ['up.example.com'] }))['기본']!['도메인']).toBe('up.example.com');
  });

  it('TLS 정책 · SNI 바인딩', async () => {
    const { viewSecsOf } = await load();
    expect(flat(viewSecsOf(model, 'tlsPolicy', 'modern'))).toEqual({
      기본: { 이름: 'modern', '최소 버전': 'TLS 1.2', '최대 버전': '제한 없음', 암호군: 'modern-2026' },
      HSTS: { HSTS: '켜짐', 'max-age': '600 s', '하위 도메인': '꺼짐' },
      검증: { 'SNI-Host 불일치': '허용' },
    });
    expect(flat(viewSecsOf(model, 'sniBinding', 's1'))['기본']).toEqual({ 이름: 's1', 리스너: 'web', '호스트 목록': '없음', 인증서: 'web-cert' });
  });

  it('head 에 없으면 빈 목록 · 구획 폭은 시안 sec.w', async () => {
    const { viewSecsOf, viewSecWidth } = await load();
    expect(viewSecsOf(model, 'pool', 'nope')).toEqual([]);
    expect([viewSecWidth(1), viewSecWidth(2), viewSecWidth(3), viewSecWidth(9)]).toEqual(['calc(25% - 12px)', 'calc(50% - 8px)', '100%', '100%']);
  });
});

describe('쓰는 자리 — 분할 상세 보기 모드와 쓸 수 없는 설정 탭이 같은 구획', () => {
  it('ListSplit 보기 모드가 viewSecsOf 를 그린다 — 일반 요약(「기본」 하나)이 아니다', () => {
    const s = src('lib/detail/ListSplit.svelte');
    expect(s).toContain('viewSecsOf(desk.model, kind, key, viewContextOf(desk, kind, key))');
    expect(s).toContain('<ViewSections sections={secs} />');
    expect(s).not.toContain('summaryOf');
    expect(s).toContain('<BackendReasons backend={key} />');
    expect(s).toContain('소속 백엔드 · {poolCount}');
  });

  it('쓸 수 없는 설정 탭(ReadView)도 같은 함수', () => {
    expect(src('lib/detail/Settings.svelte')).toContain('viewSecsOf(desk.model, kind, key, viewContextOf(desk, kind, key))');
    expect(src('lib/detail/SettingsFrame.svelte')).toContain('view ?? (kind === undefined ? undefined : viewSecsOf(');
    for (const f of ['CertificateSettings', 'TlsPolicySettings', 'SniBindingSettings']) expect(src(`lib/tls/${f}.svelte`)).toContain('viewSecsOf(desk.model, ');
  });
});
