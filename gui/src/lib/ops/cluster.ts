/** 클러스터 화면 둘(목록 · 노드)이 같이 쓰는 모양과 판정 (`GET /api/v1/cluster/nodes`, ADR-CLUSTER). */
import type { Tone } from '#lib/ui';

export type ClusterNode = {
  name: string; url?: string; role: 'leader' | 'follower'; state: string; behind: boolean;
  activeGeneration?: string; lastError?: string; lastSeen: string; stale: boolean;
};
export type ClusterBody = { enabled: boolean; self?: string; leader?: { name: string; since: string } | null; nodes: ClusterNode[] };
/** `GET /api/v1/cluster/nodes/<노드>/history` 한 줄. */
export type NodeRecord = { at: string; revision?: string; generation?: string; phase?: string };

/**
 * 노드 상태 한 줄 — 시안의 말(맞음 · 따라가는 중 · 뒤처짐 · 실패 · 연락 없음).
 * 보고가 끊긴 것을 먼저 본다. 끊기면 마지막 상태는 믿을 수 없다 — 그래서 「모름」 의 중립색이다.
 */
export const nodeState = (n: ClusterNode): { tone: Tone; text: string } => {
  if (n.stale) return { tone: 'neutral', text: '연락 없음' };
  if (n.state === 'failed' || (n.lastError !== undefined && n.lastError !== '')) return { tone: 'danger', text: '실패' };
  if (n.behind) return { tone: 'warn', text: '뒤처짐' };
  if (n.state === 'in_sync') return { tone: 'ok', text: '맞음' };
  if (n.state === 'following') return { tone: 'info', text: '따라가는 중' };
  if (n.state === 'standalone') return { tone: 'neutral', text: '단독' };
  return { tone: 'info', text: n.state };
};

/** 「마지막 신호」 — 방금 · N초 전 · N분 전 · 그 뒤는 시각. */
export const seenText = (iso: string, now = Date.now()): string => {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return '방금';
  if (s < 60) return `${s}초 전`;
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  return new Date(iso).toLocaleString();
};
