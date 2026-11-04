/**
 * 보기 구획 — 콘솔 시안 `viewSecs`(분할 상세 보기 모드 `viewModeD` · 쓸 수 없는 설정 탭 `tSetView`).
 *
 * 시안은 그 리소스 설정 폼(`fieldsFor(page, v, false, 'form')`)의 구획 · 칸을 **전부** 보인다. 칸마다 라벨과 보기 값(`view`)이다:
 *   · 글 칸     값 + 단위, 비면 「—」
 *   · 선택 칸   선택지 이름, 없으면 「—」
 *   · 켜기 칸   「켜짐」 · 「꺼짐」
 *   · 목록 칸   줄마다 하나, 비면 「없음」
 *   · 행 칸     줄마다 한 행(헤더는 `이름: 값`, 출발지는 요약 한 줄 + 행), 비면 「없음」(출발지는 「제한 없음」)
 *   · 규칙 칸   「규칙 N · 출발지 → 동작」, 비면 「없음」
 *   · 예시 요청(preview) 칸은 뺀다(시안 `dPrev !== 'flex'`).
 * 구획 · 칸 · 조건(프로토콜 · 동작 · 켜짐에 따라 보이는 칸)은 설정 폼과 같다. 값은 head 모델에서 읽는다 — 모르면 「—」 다.
 *
 * `@web` 별칭 없이 상대 경로로 가져온다 — 루트 vitest 가 이 파일을 그대로 읽는다(`tests/unit/gui-view-secs.test.ts`).
 */
import { itemOf, type ModelLike, type ResourceKind } from '../../../../src/web/resources.js';
import { healthFormOf } from '../../../../src/web/health-check.js';
import { upstreamTlsFormOf } from '../../../../src/web/upstream-tls.js';
import { ALGOS } from '../pool/pool-fields';
import { httpRouteStateOf, passthroughStateOf, ruleRowsOf, type RuleRow } from '../forms/route-edit';
import { CIPHERS, MAX_VERSIONS, MISMATCH, VERSIONS, policyForm } from '../tls/policy-edit';
import { challengeOf } from '../tls/cert-edit';

/** 보기 칸 하나 — 시안 `{ l, v, ff }`. `mono` 면 고정폭(시안 `ff: var(--mono)`). */
export type ViewField = { l: string; v: string; mono?: boolean };
/** 보기 구획 하나 — 시안 `{ t, f }`. */
export type ViewSection = { t: string; f: ViewField[] };

/** 모델 밖에서 읽어야 하는 사실 — 부르는 쪽(desk)이 준다. 안 주면 「—」. */
export type ViewContext = {
  /** 백엔드 드레인 — 상태 API(`desk.traffic`). 설정이 아니라 실제 동작이다. */
  draining?: boolean;
  /** 인증서의 자료 도메인(SAN) — ACME 의도에 도메인이 없을 때(업로드) 쓴다. */
  certDomains?: readonly string[];
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');

const DASH = '—';
/** 시안 글 칸 — 값 + 단위, 비면 「—」. */
const text = (l: string, v: unknown, o: { unit?: string; mono?: boolean } = {}): ViewField => {
  const s = str(v).trim();
  return { l, v: s === '' ? DASH : s + (o.unit === undefined ? '' : ` ${o.unit}`), mono: o.mono !== false };
};
/** 시안 선택 칸 — 선택지 이름, 없으면 「—」. */
const select = (l: string, v: string, opts: readonly { value: string; label?: string }[] = [], mono = true): ViewField =>
  ({ l, v: v === '' ? DASH : opts.find((o) => o.value === v)?.label ?? v, mono });
/** 시안 켜기 칸. */
const toggle = (l: string, on: boolean | undefined): ViewField => ({ l, v: on === undefined ? DASH : on ? '켜짐' : '꺼짐', mono: true });
/** 시안 목록 · 행 칸 — 줄마다 하나, 비면 「없음」. */
const lines = (l: string, rows: readonly string[], empty = '없음'): ViewField => ({ l, v: rows.length === 0 ? empty : rows.join('\n'), mono: true });

/**
 * 출발지 제한 한 줄 — 시안 `srcSummary(rows)` 그대로.
 *   · 없으면 「제한 없음」
 *   · 집합 하나뿐이면 「Cloudflare만 (대역 15개) · @cloudflare」 — 대역 수는 그 집합을 **펼친 실제 수**다
 *   · 집합만 여럿이면 「Cloudflare + office · @cloudflare @office」
 *   · 대역이 섞이면 「Cloudflare + 대역 2개 · @cloudflare」, 대역만이면 「대역 2개」
 * 집합의 이름은 시안 `label || name` — 모델에 label 이 없어서 Cloudflare 출처는 「Cloudflare」, 나머지는 이름 그대로다.
 * head 에 없는 집합은 대역 0 개로 센다(검증기가 막는다 — 여기서 지어내지 않는다).
 */
export function sourceAllowSummary(model: ModelLike, allow: readonly string[]): { text: string; ranges: number; on: boolean } {
  if (allow.length === 0) return { text: '제한 없음', ranges: 0, on: false };
  const sets = [...new Set(allow.filter((s) => s.startsWith('@')).map((s) => s.slice(1)))];
  const direct = allow.filter((s) => !s.startsWith('@') && s.trim() !== '').length;
  const info = (n: string): Record<string, unknown> | undefined => itemOf(model, 'addressSet', n);
  const label = (n: string): string => (info(n)?.['source'] === 'cloudflare' ? 'Cloudflare' : n);
  const count = (n: string): number => { const c = info(n)?.['cidrs']; return Array.isArray(c) ? c.length : 0; };
  const ranges = direct + sets.reduce((a, n) => a + count(n), 0);
  const t = direct === 0 && sets.length === 1 ? `${label(sets[0]!)}만 (대역 ${count(sets[0]!)}개)`
    : direct === 0 ? sets.map(label).join(' + ')
      : [...sets.map(label), `대역 ${direct}개`].join(' + ');
  return { text: t + (sets.length > 0 ? ` · ${sets.map((n) => `@${n}`).join(' ')}` : ''), ranges, on: true };
}

/** 시안 출발지 행 칸(`rowKind: 'src'`) — 요약 한 줄 + 행마다 한 줄(집합은 「집합 이름」), 비면 「제한 없음」. */
const sourceRows = (model: ModelLike, l: string, allow: readonly string[]): ViewField => ({
  l, mono: true,
  v: allow.length === 0 ? '제한 없음'
    : [sourceAllowSummary(model, allow).text, ...allow.map((s) => (s.startsWith('@') ? `집합 ${s.slice(1)}` : s))].join('\n'),
});

/** 시안 헤더 행 칸(`kvq` · `kvs`) — 「이름: 값」 줄. */
const headerRows = (l: string, rows: unknown): ViewField =>
  lines(l, (Array.isArray(rows) ? rows : []).map((r) => obj(r) ?? {}).map((r) => `${str(r['name'])}: ${str(r['value'])}`));

/** 시안 `actLabel` — 「풀 api · WebSocket」 · 「redirect 301 → URL」 · 「reject 403」. */
const actLabel = (r: Pick<RuleRow, 'kind' | 'pool' | 'websocket' | 'to' | 'redirectStatus' | 'rejectStatus'>): string =>
  (r.kind === 'proxy' ? `풀 ${r.pool ?? DASH}${r.websocket ? ' · WebSocket' : ''}`
    : r.kind === 'redirect' ? `redirect ${r.redirectStatus} → ${r.to}` : `reject ${r.rejectStatus}`);

/** 시안 규칙 칸 — 「규칙 1 · 10.0.0.0/8 (연결 주소) → 풀 api」. */
const ruleLines = (l: string, rules: unknown): ViewField =>
  lines(l, ruleRowsOf(rules).rows.map((r, i) => `규칙 ${i + 1} · ${r.from || '그 밖의 출발지'}${r.address === 'connection' ? ' (연결 주소)' : ''} → ${actLabel(r)}`));

/** ms → 「30 s」 · 「1500 ms」. 안 적었으면 「—」(nginx 기본값 — GUI 는 모른다). */
const msText = (l: string, v: unknown): ViewField => {
  const n = num(v);
  return { l, v: n === undefined ? DASH : n % 1000 === 0 ? `${n / 1000} s` : `${n} ms`, mono: true };
};
/** 바이트 → 「50 MB」 · 「512 KB」 · 「0 B」(0 은 무제한). */
const bytesText = (l: string, v: unknown): ViewField => {
  const n = num(v);
  if (n === undefined) return { l, v: DASH, mono: true };
  const mb = 1024 * 1024;
  return { l, v: n !== 0 && n % mb === 0 ? `${n / mb} MB` : n !== 0 && n % 1024 === 0 ? `${n / 1024} KB` : `${n} B`, mono: true };
};

const UDP_PRESETS = [{ value: 'dns', label: 'dns' }, { value: 'wireguard', label: 'wireguard' }, { value: 'game_generic', label: 'game' }, { value: 'custom', label: 'custom' }];

function listenerSecs(model: ModelLike, key: string, m: Obj): ViewSection[] {
  const p = str(m['protocol']);
  const http = p === 'http' || p === 'https';
  const secs: ViewSection[] = [];
  secs.push({ t: '기본', f: [
    text('이름', key), text('바인드 주소', m['bind']), text('포트', m['port']), toggle('활성화', m['enabled'] !== false),
    ...(http ? [lines('호스트', strs(m['hosts']))] : []),
  ] });
  const tls = obj(m['tls']);
  if (http) {
    const h = obj(m['http']) ?? {};
    const pool = str(obj(h['defaultAction'])?.['pool']);
    const d: ViewField[] = [{ l: '기본 동작', v: pool === '' ? '거절' : '풀로 보내기' }];
    if (pool !== '') d.push(text('기본 풀', pool));
    if (p === 'https') {
      const pol = str(tls?.['policy']);
      const min = str(itemOf(model, 'tlsPolicy', pol)?.['minVersion']);
      d.push({ l: 'TLS 정책', v: pol === '' ? DASH : min === '' ? pol : `${pol} (TLS ${min}+)`, mono: true });
      d.push(text('기본 인증서', tls?.['defaultCertificate']));
      d.push(toggle('HTTP/2', m['http2'] !== false));
      const rd = obj(m['httpRedirect']);
      d.push(toggle('HTTP로 온 요청을 HTTPS로 보내기', rd !== undefined));
      if (rd !== undefined) d.push(text('HTTP 포트', rd['port'] ?? 80));
    }
    secs.push({ t: '동작', f: d });
    const lim = obj(h['limits']) ?? {};
    secs.push({ t: '타임아웃과 본문', f: [
      msText('연결 타임아웃', lim['connectTimeoutMs']), msText('읽기 타임아웃', lim['readTimeoutMs']),
      msText('쓰기 타임아웃', lim['sendTimeoutMs']), bytesText('요청 본문 최대', lim['clientMaxBodyBytes']),
    ] });
    const hd = obj(h['headers']) ?? {};
    secs.push({ t: '요청 헤더 규칙', f: [headerRows('규칙', hd['request'])] });
    secs.push({ t: '응답 헤더 규칙', f: [headerRows('규칙', hd['response'])] });
    const rl = obj(h['rateLimit']);
    secs.push({ t: '레이트리밋', f: [toggle('레이트리밋', rl !== undefined), ...(rl === undefined ? [] : [
      text('초당 요청', rl['requestsPerSecond'], { unit: 'req/s' }), text('burst', rl['burst'], { unit: 'req' }),
      toggle('nodelay', rl['nodelay'] === true), text('동시 연결', rl['maxConnections'], { unit: '개' }),
    ])] });
    secs.push({ t: 'priority 정책', f: [toggle('priority 우선', h['strictPriority'] === true)] });
  } else if (p === 'tcp') {
    secs.push({ t: '동작', f: [text('기본 풀', m['defaultPool'])] });
  } else if (p === 'udp') {
    secs.push({ t: '동작', f: [text('기본 풀', m['defaultPool']), select('프리셋', str(obj(m['udp'])?.['preset']), UDP_PRESETS, false)] });
  } else if (p === 'tls_passthrough') {
    // 모델은 폴백마다 풀을 따로 둔다(시안의 「기본 풀」 한 칸 대신) — 설정 폼과 같다.
    const fb = (v: unknown): string => { const pool = str(obj(v)?.['pool']); return pool === '' ? '연결 거절' : `풀 ${pool}`; };
    secs.push({ t: '동작', f: [
      { l: 'SNI 매칭 없음 폴백', v: fb(m['onUnmatchedSni']) }, { l: 'SNI 없음 폴백', v: fb(m['onNoSni']) },
      text('preread 타임아웃', m['prereadTimeoutS'], { unit: 's' }),
    ] });
  }
  if (p !== 'udp') {
    const rh = obj(m['realIpFromHeader']);
    const pp = obj(m['acceptProxyProtocol']);
    const src = rh !== undefined && http ? 'header' : pp !== undefined ? 'proxy' : 'none';
    const f: ViewField[] = [{ l: '출처', v: src === 'header' ? 'HTTP 헤더' : src === 'proxy' ? 'PROXY protocol' : '없음', mono: true }];
    if (src === 'header') f.push(text('헤더', rh?.['header']));
    if (src !== 'none') f.push(sourceRows(model, '신뢰 대역', strs((src === 'header' ? rh : pp)?.['trustedCidrs'])));
    secs.push({ t: '원본 IP', f });
  }
  secs.push({ t: '접근 제한', f: [sourceRows(model, '출발지 제한', strs(m['sourceAllow']))] });
  const ord = ['기본', '동작', '접근 제한', '원본 IP', '타임아웃과 본문', '레이트리밋', '요청 헤더 규칙', '응답 헤더 규칙', 'priority 정책'];
  return secs.sort((a, b) => ord.indexOf(a.t) - ord.indexOf(b.t));
}

function poolSecs(key: string, p: Obj): ViewSection[] {
  const cls = str(p['protocolClass']);
  const algo = str(p['algorithm']) || 'round_robin';
  const secs: ViewSection[] = [{ t: '기본', f: [
    text('이름', key), { l: '프로토콜 계열', v: cls === '' ? DASH : cls.toUpperCase() }, select('알고리즘', algo, ALGOS),
    ...(algo === 'hash' ? [text('hash 키', p['hashKey'])] : []),
  ] }];
  if (cls === 'udp') {
    secs.push({ t: '헬스체크', f: [{ l: '정의', v: '검사 안 함', mono: true }] });
  } else {
    const h = healthFormOf(p);
    const modes = [
      { value: 'default', label: cls === 'http' ? '기본 (HTTP GET / · 2xx)' : '기본 (TCP 연결)' },
      { value: 'http', label: 'HTTP' }, { value: 'tcp', label: 'TCP 연결' }, { value: 'none', label: '안 해요' },
    ];
    const f: ViewField[] = [select('방식', h.mode, modes, false)];
    if (h.mode === 'http') f.push(text('경로', h.path), text('Host 헤더', h.hostHeader), text('기대 상태 코드', h.expectStatus), text('기대 본문', h.expectBody));
    if (h.mode !== 'none') f.push(text('주기', h.intervalS, { unit: 's' }), text('타임아웃', h.timeoutS, { unit: 's' }), text('rise', h.rise), text('fall', h.fall));
    secs.push({ t: '헬스체크', f });
    if (h.mode !== 'none') secs.push({ t: '헬스체크 더 보기', f: [text('포트', h.port), text('프로브 주소', h.hostOverride)] });
  }
  const t = upstreamTlsFormOf(p);
  secs.push({ t: '업스트림 TLS', f: [toggle('업스트림 TLS', t.on), ...(t.on ? [text('SNI', t.sni), toggle('인증서 검증', t.verify), text('CA 번들', t.caBundle)] : [])] });
  secs.push({ t: '전송', f: [toggle('PROXY 송신', p['sendProxyProtocol'] === 'v1')] });
  return secs;
}

function httpRouteSecs(key: string, r: Obj): ViewSection[] {
  const { state: s } = httpRouteStateOf(r);
  const d: ViewField[] = [select('동작', s.action, [{ value: 'proxy', label: '풀로 보내기' }, { value: 'redirect', label: 'redirect' }, { value: 'reject', label: 'reject' }], false)];
  if (s.action === 'proxy') d.push(text('풀', s.pool), toggle('WebSocket', s.websocket));
  if (s.action === 'redirect') d.push(text('대상', s.to));
  if (s.action !== 'proxy') d.push(text('응답 코드', s.action === 'redirect' ? s.redirectStatus : s.rejectStatus));
  if (s.action === 'proxy') d.push(text('경로 바꾸기', s.rewritePrefix), lines('이 라우트의 요청 헤더', s.headers.map((h) => `${h.name}: ${h.value}`)));
  return [
    { t: '기본', f: [text('이름', key), text('리스너', s.listener), text('호스트', s.hosts), text('경로 접두사', s.pathPrefix), text('우선순위', s.priority)] },
    { t: '동작', f: d },
    { t: '출발지별 동작', f: [ruleLines('규칙', r['sourceRules'])] },
  ];
}

function passthroughSecs(key: string, r: Obj): ViewSection[] {
  const s = passthroughStateOf(r);
  return [
    { t: '기본', f: [text('이름', key), text('리스너', s.listener), text('SNI', s.snis), text('우선순위', s.priority)] },
    { t: '동작', f: [select('동작', s.action, [{ value: 'proxy', label: '풀로 보내기' }, { value: 'reject', label: '연결을 끊어요' }], false), ...(s.action === 'proxy' ? [text('풀', s.pool)] : [])] },
  ];
}

function certSecs(key: string, c: Obj, ctx: ViewContext): ViewSection[] {
  const acme = obj(c['acme']);
  const domains = acme !== undefined && Array.isArray(acme['domains']) ? strs(acme['domains']) : [...(ctx.certDomains ?? [])];
  const f: ViewField[] = [text('이름', key), text('도메인', domains.join(', ')), { l: '발급자', v: acme === undefined ? '업로드' : 'ACME' }];
  if (acme !== undefined) {
    const ch = challengeOf(domains);
    f.push({ l: 'ACME 계정', v: str(acme['account']) || DASH }, toggle('자동 갱신', true), text('검증 방식', ch));
    if (ch === 'DNS-01') f.push({ l: 'DNS 공급자', v: '상태: 준비 중', mono: true });
  }
  return [{ t: '기본', f }];
}

function policySecs(key: string, p: Obj): ViewSection[] {
  const f = policyForm(p);
  return [
    { t: '기본', f: [text('이름', key), select('최소 버전', f.min, VERSIONS, false), select('최대 버전', f.max, MAX_VERSIONS, false), select('암호군', f.cipher, CIPHERS)] },
    { t: 'HSTS', f: [toggle('HSTS', f.hsts), ...(f.hsts ? [text('max-age', f.maxAge, { unit: 's' }), toggle('하위 도메인', f.subdomains)] : [])] },
    { t: '검증', f: [select('SNI-Host 불일치', f.mismatch, MISMATCH, false)] },
  ];
}

/**
 * 리소스 하나의 보기 구획 — 시안 `viewSecs`. head 에 없으면 빈 목록이다.
 * 리스너는 프로토콜, 풀은 계열 · 헬스체크 방식, 라우트는 동작에 따라 칸이 바뀐다(설정 폼과 같다).
 */
export function viewSecsOf(model: ModelLike, kind: ResourceKind, key: string, ctx: ViewContext = {}): ViewSection[] {
  const item = itemOf(model, kind, key) as Obj | undefined;
  if (item === undefined) return [];
  switch (kind) {
    case 'listener': return listenerSecs(model, key, item);
    case 'pool': return poolSecs(key, item);
    case 'backend': return [{ t: '기본', f: [
      text('이름', key), text('풀', item['pool']), text('호스트', item['host']), text('포트', item['port']),
      text('가중치', item['weight'] ?? 1), toggle('드레인', ctx.draining),
    ] }];
    case 'addressSet': return [{ t: '기본', f: [text('이름', key), lines('대역 목록', strs(item['cidrs']))] }];
    case 'httpRoute': return httpRouteSecs(key, item);
    case 'passthroughRoute': return passthroughSecs(key, item);
    case 'certificate': return certSecs(key, item, ctx);
    case 'tlsPolicy': return policySecs(key, item);
    case 'sniBinding': return [{ t: '기본', f: [
      text('이름', key), text('리스너', item['listener']), lines('호스트 목록', strs(item['hosts'])), text('인증서', item['certificate']),
    ] }];
  }
}

/** 시안 `sec.w` — 칸이 셋 이상이면 한 줄, 둘이면 반, 하나면 사분의 일. */
export const viewSecWidth = (n: number): string => (n >= 3 ? '100%' : n === 2 ? 'calc(50% - 8px)' : 'calc(25% - 12px)');
