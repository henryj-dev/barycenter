/**
 * 감사 기록을 **변경 하나 = 한 묶음** 으로 접는다 — 기록 화면과 대시보드 「최근 변경」 이 같이 쓴다.
 *
 * `GET /api/v1/audit` 는 줄마다 id · 시각 · 주체 · 동작 · 대상 · 리비전만 준다(before/after 본문은 안 준다).
 * 그래서 묶는 실은 둘이다.
 *   - `changeset.create → patch → plan → commit` 은 대상이 같은 changeset id 다.
 *   - `apply` 의 대상은 plan id 라 changeset 과 이어지지 않는다. 대신 리비전이 commit 의 리비전과 같다.
 * 감사는 성공한 단계만 남긴다(실패하면 기록 전에 던진다). 그래서 단계는 언제나 「성공」 이고,
 * 「실패」 는 이 기록으로 말할 수 없다.
 *
 * **자동 적용** — 트래픽이 안 바뀌는 커밋(서버가 커밋 응답에서 바로 올린다)과 ACME 게시(`acme-publish`)는
 * 커밋한 주체의 이름으로 `apply` 가 남고, 그 줄에 `trigger: 'auto'` 가 붙는다. 시각으로 추정하지 않는다 —
 * 스크립트가 커밋 직후 바로 적용하면 사람이 누른 적용도 몇 초 안에 온다(quickstart 에서 실측).
 */

/**
 * `@web/audit-view` 의 `AuditRow` 와 같은 모양이다. 별칭(`@web` · `#lib`)을 안 쓴다 — 단위 시험이 이 파일을 바로 읽고,
 * 저장소 루트 `tsc` 는 GUI 별칭을 모른다. 모양이 갈리면 `AuditLog.svelte` 에서 타입 오류가 난다.
 */
export type AuditRow = {
  id: string; at: string | undefined; principal: string; action: string; subject: string | undefined; revision: string | undefined;
  trigger?: 'auto';
};
/** 결과 배지의 톤 — `#lib/ui` 의 `Tone` 중 여기서 쓰는 것만. */
export type ResultTone = 'ok' | 'pending' | 'neutral';

export type AuditStep = AuditRow & { name: string; note?: string };

export type ChangeGroup = {
  key: string;
  /** 묶음의 마지막 단계 시각 — 목록은 이 순서다. */
  at: string | undefined;
  who: string;
  title: string;
  target: string;
  revision: string | undefined;
  /** 변경(changeset · 롤백)인가. 대시보드 「최근 변경」 은 이것만 보인다. */
  change: boolean;
  steps: AuditStep[];
  /** 아직 안 온 단계 — 커밋했지만 적용 기록이 없을 때 「apply · 아직」 을 보인다. */
  waiting?: string;
  result: { tone: ResultTone; text: string } | undefined;
  auto: boolean;
};

const STEP: Record<string, string> = {
  'changeset.create': 'changeset create', 'changeset.patch': 'patch', 'changeset.plan': 'plan',
  'changeset.commit': 'commit', 'changeset.discard': 'discard', 'changeset.reopen': 'reopen',
  apply: 'apply', 'apply.membership': 'apply · 멤버십', 'apply.retry_plan': 'plan · 다시 시도',
  'apply.rerender_plan': 'plan · 다시 렌더', rollback: 'rollback',
};

/** 변경이 아닌 줄의 제목. 모르는 동작은 그대로 낸다 — 감추면 무슨 일이 있었는지 모른다. */
const TITLE: Record<string, string> = {
  apply: '적용', 'apply.membership': '멤버십 적용', 'apply.retry_plan': '적용 다시 시도', 'apply.rerender_plan': '다시 렌더',
  recover: '미완 전환 이어받기', 'backend.drain': '백엔드 드레인', 'backend.undrain': '드레인 풀기',
  'cluster.follow': '리더를 따라 적용', 'operation.cancel': '전환 취소', 'generations.sweep': '옛 세대 정리',
  'generations.sweep.failed': '옛 세대 정리 실패', 'health.reproject.failed': '헬스 다시 투영 실패',
  'membership.slots.reclaimed': '멤버십 슬롯 회수', 'acme.account.created': 'ACME 계정 만들기',
  'session.login': '로그인', 'session.logout': '로그아웃', 'session.logout_all': '모든 세션 로그아웃',
  'session.step_up': '다시 인증',
};

const APPLY = new Set(['apply', 'apply.membership', 'apply.retry_plan', 'apply.rerender_plan']);
/** 그 리비전을 트래픽에 건 감사 줄 — 전체 적용과 멤버십만의 적용. (다시 시도 · 다시 렌더는 plan 을 새로 낼 뿐이다.) */
const TRAFFIC_APPLY = new Set(['apply', 'apply.membership']);
const ms = (s: string | undefined): number => (s === undefined ? NaN : new Date(s).getTime());
const revNum = (r: string | undefined): number => (r === undefined ? NaN : Number(r));

type Draft = { key: string; kind: 'changeset' | 'rollback' | 'apply' | 'single'; rows: AuditRow[] };

/**
 * @param pending 지금 적용 대기인 리비전들(`status.pendingApply`). 커밋했는데 적용 기록이 없을 때 「적용 대기」 와
 *   「기록 없음」 을 가른다.
 */
export function groupAudit(rows: readonly AuditRow[], pending: readonly string[] = []): ChangeGroup[] {
  const asc = [...rows].sort((a, b) => Number(a.id) - Number(b.id));
  const drafts: Draft[] = [];
  const byChangeset = new Map<string, Draft>();
  const byRevision = new Map<string, Draft>();
  for (const r of asc) {
    if (r.action.startsWith('changeset.') && r.subject !== undefined) {
      let d = byChangeset.get(r.subject);
      if (d === undefined) { d = { key: `cs:${r.subject}`, kind: 'changeset', rows: [] }; byChangeset.set(r.subject, d); drafts.push(d); }
      d.rows.push(r);
      if (r.action === 'changeset.commit' && r.revision !== undefined) byRevision.set(r.revision, d);
    } else if (r.action === 'rollback') {
      const d: Draft = { key: `rb:${r.id}`, kind: 'rollback', rows: [r] };
      drafts.push(d);
      if (r.revision !== undefined) byRevision.set(r.revision, d);
    } else if (APPLY.has(r.action) && r.revision !== undefined) {
      let d = byRevision.get(r.revision);
      if (d === undefined) { d = { key: `ap:${r.id}`, kind: 'apply', rows: [] }; byRevision.set(r.revision, d); drafts.push(d); }
      d.rows.push(r);
    } else {
      drafts.push({ key: `a:${r.id}`, kind: 'single', rows: [r] });
    }
  }

  // 적용은 언제나 head 를 건다 — 뒤 리비전이 적용됐으면 앞 리비전도 그때 나갔다.
  // 멤버십만 바뀐 리비전(백엔드 더하기 · 빼기)은 `apply.membership` 으로 적용된다 — 그것도 그 리비전의 적용이다.
  const applied = asc.filter((r) => TRAFFIC_APPLY.has(r.action) && r.revision !== undefined).map((r) => revNum(r.revision));
  const pend = new Set(pending);

  return drafts.map((d): ChangeGroup => {
    const last = d.rows[d.rows.length - 1]!;
    const first = d.rows[0]!;
    const commit = d.rows.find((r) => r.action === 'changeset.commit' || r.action === 'rollback');
    const apply = d.rows.find((r) => TRAFFIC_APPLY.has(r.action));
    const auto = apply?.trigger === 'auto';
    const steps = d.rows.map((r): AuditStep => ({
      ...r, name: STEP[r.action] ?? r.action, ...(auto && r === apply ? { note: '자동 적용' } : {}),
    }));
    const revision = commit?.revision ?? last.revision;
    const who = [...new Set(d.rows.map((r) => r.principal))].join(', ');
    const change = d.kind === 'changeset' || d.kind === 'rollback';

    let result: ChangeGroup['result'];
    let waiting: string | undefined;
    if (change) {
      const discarded = d.rows.some((r) => r.action === 'changeset.discard');
      if (apply !== undefined) result = { tone: 'ok', text: auto ? '적용됨 · 자동 적용' : '적용됨' };
      else if (commit === undefined) result = { tone: 'neutral', text: discarded ? '버림' : '커밋 안 함' };
      else {
        const later = applied.filter((n) => n > revNum(revision));
        if (later.length > 0) result = { tone: 'ok', text: `적용됨 · r${Math.min(...later)} 와 함께` };
        else if (revision !== undefined && pend.has(revision)) { result = { tone: 'pending', text: '적용 대기' }; waiting = '아직 적용하지 않았어요'; }
        else result = { tone: 'neutral', text: '적용 기록 없음' };
      }
    } else if (d.kind === 'apply') {
      result = { tone: 'ok', text: '적용됨' };
    }

    const title = d.kind === 'changeset' ? '설정 변경'
      : d.kind === 'rollback' ? `롤백 · r${first.subject ?? '?'} 내용으로`
      : TITLE[first.action] ?? first.action;
    const target = d.kind === 'changeset' ? `changeset ${first.subject ?? ''}`
      : d.kind === 'rollback' ? '' : first.subject ?? '';
    return { key: d.key, at: last.at, who, title, target, revision, change, steps, ...(waiting === undefined ? {} : { waiting }), result, auto };
  }).sort((a, b) => (ms(b.at) || 0) - (ms(a.at) || 0));
}

/**
 * `14:02:11` — 숫자로 직접 적는다. `toLocaleTimeString('ko-KR')` 는 브라우저에 따라 「16시 9분 41초」 로 나와
 * 표의 시각 칸이 두 줄이 됐다(운영 실측).
 */
const hms = (t: Date): string => [t.getHours(), t.getMinutes(), t.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');

/** 시안의 시각 — 「오늘 14:20:33」 · 「어제 18:20:09」 · 그 전은 날짜. */
export function whenText(iso: string | undefined, now = new Date()): string {
  if (iso === undefined) return '—';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return iso;
  const clock = hms(t);
  const day = (d: Date): string => d.toDateString();
  if (day(t) === day(now)) return `오늘 ${clock}`;
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (day(t) === day(y)) return `어제 ${clock}`;
  return `${t.getMonth() + 1}월 ${t.getDate()}일 ${clock}`;
}

/** 시각만 — 단계 줄 · 최근 변경. */
export const clockText = (iso: string | undefined): string => {
  if (iso === undefined) return '—';
  const t = new Date(iso);
  return Number.isNaN(t.getTime()) ? iso : hms(t);
};
