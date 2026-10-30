/** 클러스터 화면 둘(목록 · 노드)이 같이 쓰는 모양과 판정 (`GET /api/v1/cluster/nodes`, ADR-CLUSTER). */
import type { Tone } from '#lib/ui';

export type ClusterNode = {
  name: string; url?: string; role: 'leader' | 'follower'; state: string; behind: boolean;
  activeGeneration?: string; lastError?: string; lastSeen: string; stale: boolean;
};
export type ClusterBody = { enabled: boolean; self?: string; leader?: { name: string; since: string } | null; nodes: ClusterNode[] };

/** 노드 상태 한 줄 — 보고가 끊긴 것을 먼저 본다. 끊기면 마지막 상태는 믿을 수 없다. */
export const nodeState = (n: ClusterNode): { tone: Tone; text: string } => {
  if (n.stale) return { tone: 'danger', text: '보고 끊김' };
  if (n.lastError !== undefined && n.lastError !== '') return { tone: 'danger', text: n.state };
  if (n.behind) return { tone: 'warn', text: `${n.state} · 뒤처짐` };
  return n.state === 'in_sync' ? { tone: 'ok', text: '따라가는 중' } : { tone: 'info', text: n.state };
};
