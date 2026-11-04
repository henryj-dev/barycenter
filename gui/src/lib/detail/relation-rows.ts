/**
 * 「연결된 리소스」 탭의 줄 — 콘솔 시안 `relRows`(`{ k, n, note }`)를 모든 리소스에 한곳에서 만든다.
 *
 * 탭(`RelationRows`)이 그리는 줄과 탭 이름 옆의 수(`ResourceFrame`)가 이 함수 하나를 쓴다 — 그래서 수가 줄 수와 같다.
 * 풀의 「소속 백엔드 · N」 표는 줄이 아니라 아래 표다(시안 `subTabD`) — 수에 넣지 않는다.
 *
 *   · 리스너 · 풀 · 백엔드 · 주소 집합: `relationsOf` 의 쓰는 것 + 쓰이는 것, 설명은 시안 말(「기본 풀」 · 「이 리스너에 연결」 …).
 *     풀 · 백엔드는 「헬스체크 · 풀 설정」 줄을, 백엔드는 「이 풀을 쓰는 리스너」 줄을 더한다.
 *   · 인증서 · TLS 정책 · SNI 바인딩: 시안 `relExtra` 문구(「기본 인증서」 · 「호스트 N개」 · 「TLS 정책으로 사용」 …).
 *   · 라우트: 시안 `relExtra('routes')` — 리스너 · 풀 · (출발지 규칙의 풀) · 평가 순서. 이름은 링크가 아니다(있던 모양).
 *
 * 순수 함수만 둔다(룬 · Svelte 없음).
 */
import { RESOURCES, itemOf, relationsOf, resourcePath, type Edge, type ResourceKind } from '@web/resources';
import type { createDesk } from '#lib/desk.svelte.ts';
import { routeFactsOf } from '#lib/route/route-facts';
import { sniHosts } from '#lib/tls/tls-view.ts';
import { hcText } from './facts';

type Desk = ReturnType<typeof createDesk>;

/** 한 줄 — 종류(100px, 흐림) · 이름(고정폭, 있으면 링크) · 설명(흐림). `missing` 이면 이름 뒤에 「— head 에 없어요」. */
export type RelRow = { k: string; n: string; note: string; href?: string; missing?: boolean };

/** 시안의 종류 이름 — 라우트는 HTTP · 패스스루를 가리지 않고 「라우트」 다. */
const KIND: Record<ResourceKind, string> = {
  listener: '리스너', httpRoute: '라우트', passthroughRoute: '라우트', pool: '풀', backend: '백엔드', addressSet: '주소 집합',
  certificate: '인증서', tlsPolicy: 'TLS 정책', sniBinding: 'SNI 바인딩',
};

function trafficRows(desk: Desk, kind: 'listener' | 'pool' | 'backend' | 'addressSet', key: string): RelRow[] {
  /** 이것이 쓰는 것의 설명 — 참조한 자리(시안: 「기본 풀」 · 「기본 인증서」 · 「소속 풀」). */
  const usesNote = (via: string): string => ({
    '기본 동작': '기본 풀', '기본 풀': '기본 풀', 'SNI 매칭 없음': 'SNI 매칭 없음 폴백', 'SNI 없음': 'SNI 없음 폴백',
    'PROXY 수신': '신뢰 대역', '원본 IP 헤더': '신뢰 대역', '풀': '소속 풀',
  }[via] ?? via);
  /** 이것을 쓰는 것의 설명 — 시안: 「이 리스너에 연결」 · 「기본 풀로 사용」 · 「이 풀로 전달」 · 「출발지 제한에 사용」. */
  const usedNote = (via: string, from: ResourceKind): string => {
    if (kind === 'listener') return from === 'sniBinding' ? '이 리스너의 SNI 바인딩' : '이 리스너에 연결';
    if (kind === 'pool') {
      return ({ '기본 동작': '기본 풀로 사용', '기본 풀': '기본 풀로 사용', 'SNI 매칭 없음': 'SNI 폴백으로 사용', 'SNI 없음': 'SNI 폴백으로 사용',
        '프록시': '이 풀로 전달', '출발지 규칙': '출발지 규칙으로 전달' } as Record<string, string>)[via] ?? via;
    }
    if (kind === 'addressSet') return via === '출발지 제한' ? '출발지 제한에 사용' : via === '출발지 규칙' ? '출발지 규칙에 사용' : '신뢰 대역에 사용';
    return via;
  };
  const rel = relationsOf(desk.model, { kind, key });
  const out: RelRow[] = [];
  const seen = new Set<string>();
  const push = (r: RelRow): void => { const id = `${r.k}/${r.n}/${r.note}`; if (!seen.has(id)) { seen.add(id); out.push(r); } };
  for (const e of rel.uses) {
    push({ k: KIND[e.to.kind], n: e.to.key, note: usesNote(e.via), ...(e.missing ? { missing: true } : { href: resourcePath(e.to.kind, e.to.key) }) });
  }
  for (const e of rel.usedBy) {
    if (kind === 'pool' && e.from.kind === 'backend') continue; // 아래 「소속 백엔드」 표가 말한다(시안).
    push({ k: KIND[e.from.kind], n: e.from.key, note: usedNote(e.via, e.from.kind), href: resourcePath(e.from.kind, e.from.key) });
  }
  if (kind === 'backend') {
    const pool = String(itemOf(desk.model, 'backend', key)?.['pool'] ?? '');
    for (const e of relationsOf(desk.model, { kind: 'pool', key: pool }).usedBy.filter((x) => x.from.kind === 'listener')) {
      push({ k: '리스너', n: e.from.key, note: '이 풀을 쓰는 리스너', href: resourcePath('listener', e.from.key) });
    }
    const p = itemOf(desk.model, 'pool', pool);
    if (p !== undefined) push({ k: '헬스체크', n: hcText(p), note: '풀 설정' });
  }
  if (kind === 'pool') {
    const p = itemOf(desk.model, 'pool', key);
    if (p !== undefined) push({ k: '헬스체크', n: hcText(p), note: '풀 설정' });
  }
  return out;
}

function tlsRows(desk: Desk, kind: 'certificate' | 'tlsPolicy' | 'sniBinding', key: string): RelRow[] {
  const rel = relationsOf(desk.model, { kind, key });
  const usedNote = (e: Edge): string => {
    if (kind === 'tlsPolicy') return 'TLS 정책으로 사용';
    if (e.from.kind === 'sniBinding') {
      const s = itemOf(desk.model, 'sniBinding', e.from.key);
      return `호스트 ${s === undefined ? 0 : sniHosts(s).length}개`;
    }
    return e.via;
  };
  const usesNote = (e: Edge): string =>
    (e.to.kind === 'listener' ? '이 바인딩이 속한 리스너' : e.to.kind === 'certificate' ? '호스트에 연결한 인증서' : e.via);
  return [
    ...rel.uses.map((e): RelRow => ({
      k: RESOURCES[e.to.kind].label, n: e.to.key, note: usesNote(e), ...(e.missing ? { missing: true } : { href: resourcePath(e.to.kind, e.to.key) }),
    })),
    ...rel.usedBy.map((e): RelRow => ({ k: RESOURCES[e.from.kind].label, n: e.from.key, note: usedNote(e), href: resourcePath(e.from.kind, e.from.key) })),
  ];
}

function routeRows(desk: Desk, kind: 'httpRoute' | 'passthroughRoute', key: string): RelRow[] {
  const f = routeFactsOf(desk, kind, key);
  if (f === undefined) return [];
  const missing = new Set(relationsOf(desk.model, { kind, key }).uses.filter((u) => u.missing).map((u) => `${u.to.kind}/${u.to.key}`));
  const item = itemOf(desk.model, kind, key);
  const rules = Array.isArray(item?.['sourceRules']) ? item['sourceRules'] as { action?: { kind?: unknown; pool?: unknown } }[] : [];
  const proxy = f.act.kind === 'proxy';
  return [
    { k: '리스너', n: f.listener, note: '이 라우트가 속한 리스너', missing: missing.has(`listener/${f.listener}`) },
    { k: '풀', n: proxy ? f.act.pool ?? '—' : '—', note: '트래픽을 보낼 풀', missing: proxy && missing.has(`pool/${f.act.pool ?? ''}`) },
    ...rules.flatMap((r, i): RelRow[] => (r.action?.kind === 'proxy' && typeof r.action.pool === 'string'
      ? [{ k: '풀', n: r.action.pool, note: `출발지 규칙 ${i + 1}이 보낼 풀`, missing: missing.has(`pool/${r.action.pool}`) }] : [])),
    { k: '평가 순서', n: `#${f.ord ?? '—'}`, note: `${f.priority} 우선순위 기준` },
  ];
}

/** 그 리소스의 「연결된 리소스」 줄. 탭과 탭 수가 이것을 같이 쓴다. */
export function relationRows(desk: Desk, kind: ResourceKind, key: string): RelRow[] {
  switch (kind) {
    case 'listener': case 'pool': case 'backend': case 'addressSet': return trafficRows(desk, kind, key);
    case 'certificate': case 'tlsPolicy': case 'sniBinding': return tlsRows(desk, kind, key);
    case 'httpRoute': case 'passthroughRoute': return routeRows(desk, kind, key);
  }
}
