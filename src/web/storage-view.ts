/**
 * 저장소 상태 화면의 말 (2026-11-20). `GET /api/v1/system/storage` 몸통을 줄로 바꾼다.
 *
 * 모르는 것은 「—」 · 「아직 안 돌았어요」 로 쓴다. 0 건으로 채우지 않는다 — 청소는 리더만 돌고, 팔로워에는 결과가 없다.
 */
import { bytesText, countText } from './traffic-view.js';

export type StorageKind = 'postgres' | 'mysql' | 'mariadb' | 'sqlite';
export type StorageSweep =
  | { at: string; ok: true; removed: number; kept?: number; failed?: number; byTable?: Record<string, number> }
  | { at: string; ok: false; error: string };

export type StorageBodyView = {
  available: true;
  isLeader: boolean;
  configDb: { kind: StorageKind; version: string | null };
  accountsDb: { kind: StorageKind } | null;
  secrets: { backend: 'fs' | 'pg'; encrypted: boolean; kekConfigured: boolean };
  retention: { intervalMs: number; tables: { table: string; days: number | null }[]; last: StorageSweep | null };
  generations: { keep: number; count: number; bytes: number; last: StorageSweep | null };
  secretGc: { enabled: boolean; keepPerName: number; minAgeMs: number; intervalMs: number; last: StorageSweep | null };
} | { available: false };

export const DB_KIND_LABEL: Readonly<Record<StorageKind, string>> = {
  postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite',
};

/** 표 이름 → 사람이 읽는 말. 모르는 표는 이름 그대로다. */
export const TABLE_LABEL: Readonly<Record<string, string>> = {
  health_events: '헬스 변화 기록',
  audit: '감사 로그',
  plans: '만료된 계획',
  changesets: '버린 변경 묶음',
  operations: '끝난 적용 기록',
  config_revisions: '옛 리비전',
  notify_deliveries: '알림 보낸 기록',
};

export const dbText = (kind: StorageKind, version?: string | null): string =>
  `${DB_KIND_LABEL[kind] ?? kind}${version ? ` ${version}` : ''}`;

export const daysText = (days: number | null): string => (days === null ? '지우지 않아요' : `${days}일 남겨요`);

/** 주기 — 「1시간마다」 · 「30분마다」. */
export function everyText(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min >= 60 && min % 60 === 0) return `${min / 60}시간마다`;
  return `${min}분마다`;
}

export const secretText = (s: { backend: 'fs' | 'pg'; encrypted: boolean; kekConfigured: boolean }): string =>
  s.backend === 'pg'
    ? `DB(봉투 암호화) · KEK ${s.kekConfigured ? '있음' : '없음'}`
    : '파일(평문, 0400)';

/**
 * 마지막 청소 한 줄. `leader` 가 아니면 이 노드는 청소를 안 돈다 — 그것을 말한다.
 * 결과가 없으면 「아직 안 돌았어요」 다(방금 뜬 리더).
 */
export function sweepText(last: StorageSweep | null, leader: boolean): { tone: 'ok' | 'warn' | 'danger' | 'neutral'; text: string } {
  if (last === null) {
    return leader
      ? { tone: 'neutral', text: '아직 안 돌았어요.' }
      : { tone: 'neutral', text: '청소는 리더만 해요. 이 노드는 결과가 없어요.' };
  }
  if (!last.ok) return { tone: 'danger', text: `실패했어요: ${last.error}` };
  const nFailed = last.failed ?? 0;
  const failed = nFailed > 0 ? ` · 못 지운 것 ${countText(nFailed)}개` : '';
  const kept = last.kept === undefined ? '' : ` · 남긴 것 ${countText(last.kept)}개`;
  return {
    tone: nFailed > 0 ? 'warn' : 'ok',
    text: `지운 것 ${countText(last.removed)}개${kept}${failed}`,
  };
}

export const generationsText = (g: { count: number; bytes: number; keep: number }): string =>
  `${countText(g.count)}개 · ${bytesText(g.bytes)} · 최근 ${g.keep}개를 남겨요`;
