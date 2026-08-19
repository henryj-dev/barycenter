/**
 * Status 화면이 읽는 값 — DESIGN.md §5.2 · §10
 *
 * 스냅샷이 이미 든 것을 접는다. `/status` 를 다시 폴링하지 않는다.
 * 스탠바이가 리더처럼 보이면 apply 가 왜 503 인지 모른다.
 * nativeDns 선택형은 그리지 않는다 — 엔진이 설정할 수 없다.
 */
export type StatusFact = {
  head?: string;
  engine?: unknown;
  driver?: unknown;
  leader?: unknown;
  published?: unknown;
  unfinished?: unknown;
  pendingApply?: { planId: string; revision: string }[];
};

export type StatusView = {
  head: string | undefined;
  leader: { isLeader: boolean; holder: string; reason: string | undefined };
  engine: { probed: boolean; label: string };
  driver: { loaded: boolean; name: string | undefined };
  published: { kind: string; generation: string | undefined };
  unfinished: boolean;
  pending: { planId: string; revision: string }[];
};

const rec = (v: unknown): Record<string, unknown> =>
  (v !== null && typeof v === 'object' ? v as Record<string, unknown> : {});

const text = (v: unknown): string | undefined =>
  (typeof v === 'string' && v !== '' ? v : undefined);

export function viewOfStatus(snap: StatusFact): StatusView {
  const leader = rec(snap.leader);
  const engine = rec(snap.engine);
  const driver = rec(snap.driver);
  const published = rec(snap.published);
  const record = rec(published['record']);
  const probed = engine['probed'] === true;
  const flavor = text(engine['flavor']);
  const version = text(engine['version']);
  const pending = (snap.pendingApply ?? []).map((p) => ({
    planId: p.planId, revision: p.revision,
  }));
  return {
    head: text(snap.head),
    leader: {
      isLeader: leader['isLeader'] === true,
      holder: text(leader['holder']) ?? '—',
      reason: text(leader['reason']),
    },
    engine: {
      probed,
      label: probed
        ? [flavor, version].filter(Boolean).join(' ') || '프로브됨'
        : (text(engine['reason']) ?? '엔진을 못 물었다'),
    },
    driver: {
      loaded: driver['loaded'] === true,
      name: text(driver['name']),
    },
    published: {
      kind: text(published['kind']) ?? 'none',
      generation: text(record['generation']) ?? text(published['generation']),
    },
    unfinished: snap.unfinished !== undefined && snap.unfinished !== null,
    pending,
  };
}
