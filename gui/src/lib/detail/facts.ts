/**
 * 트래픽 리소스 화면이 같이 읽는 값 (#126 3단계) — 목록 · 분할 상세 · 상세 머리 · 개요가 같은 말을 한다.
 *
 * 모두 이미 받은 값(head 모델 · 헬스 · 상태 API)에서 읽는다. 새로 묻지 않는다.
 * 모르는 것은 지어내지 않는다 — 상태 API 를 못 읽었으면 「모름」 이다.
 */
import { itemOf, relationsOf, type ResourceKind } from '@web/resources';
import type { Tone } from '#lib/ui';
import type { createDesk } from '#lib/desk.svelte.ts';

type Desk = ReturnType<typeof createDesk>;
export type Mark = { tone: Tone; icon: string; text: string };

/** 헬스 판정 넷 — 시안의 정상 · 비정상 · 확인 중 · 관측 없음. */
export type HealthKind = 'healthy' | 'unhealthy' | 'checking' | 'none';
export const HEALTH_MARK: Record<HealthKind, Mark> = {
  healthy: { tone: 'ok', icon: '●', text: '정상' },
  unhealthy: { tone: 'danger', icon: '✕', text: '비정상' },
  checking: { tone: 'info', icon: '↻', text: '확인 중' },
  none: { tone: 'neutral', icon: '○', text: '관측 없음' },
};
export const DRAIN_MARK: Mark = { tone: 'drain', icon: '⇣', text: '드레인 중' };

const obj = (v: unknown): Record<string, unknown> | undefined =>
  (typeof v === 'object' && v !== null ? v as Record<string, unknown> : undefined);

/** 이 풀을 프로버가 찌르는가. UDP 풀과 `mode: none` 은 안 찌른다 — 백엔드는 늘 관측 없음이다. */
export function poolProbed(pool: Readonly<Record<string, unknown>> | undefined): boolean {
  if (pool === undefined) return false;
  if (pool['protocolClass'] === 'udp') return false;
  return obj(pool['healthCheck'])?.['mode'] !== 'none';
}

/**
 * 헬스체크 한 줄 — 목록의 「헬스체크」 칸. 안 적었으면 풀이 정하던 기본(`probePlanOf` 와 같은 규칙)이다.
 * 인증서를 검증하지 않는 TLS 풀의 기본은 TCP 연결 검사다.
 */
export function healthCheckText(pool: Readonly<Record<string, unknown>> | undefined): string {
  if (pool === undefined) return '—';
  if (pool['protocolClass'] === 'udp') return '검사 안 함';
  const h = obj(pool['healthCheck']);
  if (h?.['mode'] === 'none') return '안 해요';
  const ut = obj(pool['upstreamTls']);
  const unverified = ut?.['enabled'] === true && ut['verify'] !== true;
  const proto = h?.['protocol'] ?? (pool['protocolClass'] === 'http' && !unverified ? 'http' : 'tcp_connect');
  const what = proto === 'http' ? `HTTP ${typeof h?.['path'] === 'string' ? h['path'] : '/'}` : 'TCP 연결';
  const every = typeof h?.['intervalS'] === 'number' ? ` · ${h['intervalS']}s` : '';
  return h === undefined ? `${what} (기본)` : `${what}${every}`;
}

/** 백엔드의 헬스 판정. `unknown` 은 찌르는 풀이면 「확인 중」, 아니면 「관측 없음」 이다. */
export function backendHealth(desk: Desk, key: string): HealthKind {
  const s = desk.health.find((h) => h.backendKey === key)?.state;
  if (s === 'healthy') return 'healthy';
  if (s === 'unhealthy') return 'unhealthy';
  const b = itemOf(desk.model, 'backend', key);
  return poolProbed(itemOf(desk.model, 'pool', String(b?.['pool'] ?? ''))) ? 'checking' : 'none';
}

export const backendDraining = (desk: Desk, key: string): boolean =>
  desk.traffic.get(key)?.reasons.includes('draining') === true;

/** ISO 시각 → 「12초 전」. 모르면 undefined. */
export function ago(iso: string | undefined, now = Date.now()): string | undefined {
  if (iso === undefined) return undefined;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return undefined;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}

/**
 * 「트래픽을 받지 않는 이유」 — 시안의 사유 목록. 상태 API 의 이유 코드와 헬스에서 읽는다.
 * 가중치 0 은 없다 — 해독기가 1 부터 받는다(nginx 가 `weight=0` 을 거절한다). 끄는 자리는 드레인이다.
 * 모르는 이유 코드는 그대로 낸다(감추면 「이유 없이 0」 으로 보인다).
 */
export function backendReasons(desk: Desk, key: string): Mark[] {
  const b = itemOf(desk.model, 'backend', key);
  if (b === undefined) return [];
  const pool = itemOf(desk.model, 'pool', String(b['pool'] ?? ''));
  const t = desk.traffic.get(key);
  const h = backendHealth(desk, key);
  const out: Mark[] = [];
  if (pool?.['protocolClass'] === 'udp') out.push({ tone: 'neutral', icon: '○', text: 'UDP 풀은 헬스체크가 없어서 관측 없음으로 나와요.' });
  else if (h === 'none') out.push({ tone: 'neutral', icon: '○', text: '풀이 헬스체크를 하지 않아요. 상태를 관측하지 않아요.' });
  if (h === 'unhealthy') out.push({ tone: 'danger', icon: '✕', text: `헬스체크가 실패했어요.${t?.detail === undefined ? '' : ` 프로버: ${t.detail}`}` });
  if (h === 'checking') out.push({ tone: 'info', icon: '↻', text: '첫 헬스체크 결과가 아직 없어요.' });
  for (const r of t?.reasons ?? []) {
    if (r === 'unhealthy') continue; // 위의 헬스 줄이 말한다.
    if (r === 'draining') out.push({ tone: 'drain', icon: '⇣', text: '드레인 중이에요. 새 연결을 받지 않아요.' });
    else if (r === 'pool_not_routed') out.push({ tone: 'warn', icon: '▲', text: '이 풀을 가리키는 리스너 · 라우트가 없어요.' });
    else if (r === 'pool_missing') out.push({ tone: 'danger', icon: '✕', text: '풀이 없어요.' });
    else out.push({ tone: 'warn', icon: '▲', text: r });
  }
  if (t === undefined) out.push({ tone: 'neutral', icon: '○', text: '상태 API 를 못 읽었어요. 트래픽을 받는지 몰라요.' });
  else if (t.receivingTraffic && !out.some((m) => m.tone === 'danger' || m.tone === 'drain' || m.tone === 'warn')) {
    out.push({ tone: 'ok', icon: '●', text: '모든 조건을 충족해요. 트래픽을 받아요.' });
  }
  return out;
}

/** 풀의 백엔드 판정 — 「정상 / 전체」. UDP 는 관측 없음 · N개. */
export function poolMark(desk: Desk, key: string): Mark {
  const row = desk.pools.rows.find((p) => p.key === key);
  const pool = itemOf(desk.model, 'pool', key);
  const total = row?.backends.length ?? 0;
  if (!poolProbed(pool)) return { ...HEALTH_MARK.none, text: `관측 없음 · ${total}개` };
  if (total === 0) return { tone: 'warn', icon: '▲', text: '백엔드 없음' };
  const ok = row?.backends.filter((b) => b.state === 'healthy' && !backendDraining(desk, b.key)).length ?? 0;
  return { tone: ok === total ? 'ok' : ok === 0 ? 'danger' : 'warn', icon: ok === total ? '●' : ok === 0 ? '✕' : '▲', text: `${ok} / ${total}` };
}

/** 상세 머리 · 분할 상세의 상태 배지 하나. 모르면 undefined. */
export function statusOf(desk: Desk, kind: ResourceKind, key: string): Mark | undefined {
  if (kind === 'listener') {
    const row = desk.listeners.rows.find((r) => r.key === key);
    if (row === undefined) return undefined;
    if (row.mark === 'off') return { tone: 'neutral', icon: '○', text: '꺼져 있어 열지 않아요' };
    return row.mark === 'join' ? { tone: 'pending', icon: '◐', text: '적용하면 열려요' } : { tone: 'ok', icon: '●', text: '서빙 중' };
  }
  if (kind === 'backend') {
    if (backendDraining(desk, key)) return DRAIN_MARK;
    return HEALTH_MARK[backendHealth(desk, key)];
  }
  if (kind === 'pool') return poolMark(desk, key);
  return undefined;
}

/** 연결된 리소스 탭의 수 — 쓰는 것 + 쓰이는 것. */
export function relationCount(desk: Desk, kind: ResourceKind, key: string): number {
  const r = relationsOf(desk.model, { kind, key });
  return r.uses.length + r.usedBy.length;
}
