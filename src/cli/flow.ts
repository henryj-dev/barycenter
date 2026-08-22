/**
 * CLI 가 부르는 API 단계 — DESIGN.md §5.6
 *
 * `bary apply <파일>` 은 한 바퀴를 통째로 돈다. 그 단축은 남긴다. 여기 있는 것은
 * 나뉜 단계다. 한 바퀴만 있으면 plan 을 보고 멈출 수가 없고, import 한 뒤
 * pending_apply 를 적용할 명령도 없다.
 *
 * 프로세스를 여기서 죽이지 않는다. 종료 코드는 `bary.ts` 의 몫이다.
 */
export type HttpResult = { status: number; body: unknown };
export type Http = (method: string, path: string, body?: unknown) => Promise<HttpResult>;

export class CliRequestError extends Error {
  constructor(
    readonly what: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    const b = body as { code?: string; message?: string };
    super(`${what} 실패 [${status} ${b.code ?? ''}]: ${b.message ?? JSON.stringify(body)}`);
    this.name = 'CliRequestError';
  }
}

export function unwrap(r: HttpResult, what: string): unknown {
  if (r.status >= 400) throw new CliRequestError(what, r.status, r.body);
  return r.body;
}

/** `--name value`. 없거나 값이 비면 undefined. */
export function flag(argv: readonly string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  return v === undefined || v.startsWith('--') ? undefined : v;
}

/**
 * plan 이 낸 영향 (§5.4). **전부 선택이다** — 이 회차 전에 만들어진 plan 은
 * JSONB 에 새 필드가 없고, CLI 가 거기서 깨지면 옛 plan 을 적용할 수 없다.
 */
export type PlanImpact = {
  requiresReload: boolean;
  topologyEpochChange?: boolean;
  socketChanges: { added: unknown[]; removed: unknown[] };
  planes: string[];
  sessionImpact?: { protocol: string; effect: string; why: string }[];
  certificateChanges?: { key: string; change: string; notAfter?: string }[];
  routeOrderChanges?: {
    warnings: { message: string; [k: string]: unknown }[];
    [k: string]: unknown;
  };
  capabilityWarnings?: { message: string; [k: string]: unknown }[];
};

/**
 * plan 을 사람이 읽을 몇 줄로 접는다 (§5.4 · §1 "GUI·API·CLI 가 동일한 능력").
 *
 * **경고를 안 내고 커밋까지 밀면 CLI 로 일하는 사람은 그 사실을 영영 모른다.**
 * GUI 는 영향 화면에서 이걸 보여 주는데 CLI 는 소켓 개수만 찍고 있었다.
 *
 * 첫 줄은 언제나 있다. 나머지는 **있을 때만** 나온다 — 매번 나오는 줄은 안 읽게 된다.
 */
export function planSummary(impact: PlanImpact): string[] {
  const lines = [
    `소켓 +${impact.socketChanges.added.length} -${impact.socketChanges.removed.length}, `
    + `평면 [${impact.planes.join(',')}]`
    + (impact.requiresReload ? ', reload' : '')
    + (impact.topologyEpochChange === true && !impact.requiresReload ? ', 새 세대' : ''),
  ];
  for (const s of impact.sessionImpact ?? []) {
    if (s.effect === 'none') continue;
    lines.push(`세션 ${s.protocol} — ${s.effect}: ${s.why}`);
  }
  for (const c of impact.certificateChanges ?? []) {
    lines.push(`인증서 ${c.key} ${c.change}`
      + (c.notAfter === undefined ? '' : ` — ${c.notAfter.slice(0, 10)} 만료`));
  }
  for (const w of impact.routeOrderChanges?.warnings ?? []) lines.push(`라우트 — ${w.message}`);
  for (const w of impact.capabilityWarnings ?? []) lines.push(`엔진 — ${w.message}`);
  return lines;
}

export async function changesetNew(http: Http): Promise<{ id: string }> {
  const head = unwrap(await http('GET', '/api/v1/config/head'), 'head') as { revision: string };
  return unwrap(
    await http('POST', '/api/v1/changesets', { base_revision: head.revision }),
    'changeset 생성',
  ) as { id: string };
}

export async function changesetPatch(http: Http, id: string, ops: unknown[]): Promise<void> {
  unwrap(await http('PATCH', `/api/v1/changesets/${id}`, { patch: ops }), 'patch');
}

export async function changesetPlan(http: Http, id: string): Promise<{
  id: string;
  impact: { socketChanges: { added: unknown[]; removed: unknown[] }; planes: string[] };
  renderDigest: string;
}> {
  return unwrap(await http('POST', `/api/v1/changesets/${id}/plan`), 'plan') as {
    id: string;
    impact: { socketChanges: { added: unknown[]; removed: unknown[] }; planes: string[] };
    renderDigest: string;
  };
}

export async function changesetShow(http: Http, id: string): Promise<unknown> {
  return unwrap(await http('GET', `/api/v1/changesets/${id}`), 'changeset');
}

/**
 * changeset 을 버린다. 커밋된 것은 못 버린다 — 그건 롤백이다.
 * 빈 키는 호출하지 않는다.
 */
export async function changesetDiscard(http: Http, id: string): Promise<void> {
  if (id === '') throw new Error('changeset 키가 비어 있다');
  unwrap(await http('DELETE', `/api/v1/changesets/${encodeURIComponent(id)}`), 'discard');
}

/**
 * sealed → open. 옛 plan 은 무효다. 빈 키는 호출하지 않는다.
 */
export async function changesetReopen(http: Http, id: string): Promise<{ id: string; state: string }> {
  if (id === '') throw new Error('changeset 키가 비어 있다');
  return unwrap(
    await http('POST', `/api/v1/changesets/${encodeURIComponent(id)}/reopen`),
    'reopen',
  ) as { id: string; state: string };
}

/**
 * plan 이 가리키는 changeset 으로 커밋한다.
 *
 * 롤백 plan 은 changeset 이 없다. 그쪽은 `bary rollback` 이지 `commit --plan` 이 아니다.
 */
export async function commitByPlan(http: Http, planId: string): Promise<{ revision: string }> {
  const plan = unwrap(await http('GET', `/api/v1/plans/${planId}`), 'plan') as {
    changesetId: string | null;
  };
  if (plan.changesetId === null || plan.changesetId === '') {
    throw new Error('이 plan 은 changeset 이 없다 — 롤백 plan 이면 bary rollback 을 쓴다');
  }
  return unwrap(
    await http('POST', `/api/v1/changesets/${plan.changesetId}/commit`, { plan_id: planId }),
    'commit',
  ) as { revision: string };
}

/** changeset new → patch → plan → commit. apply 는 안 한다. */
export async function commitPatch(
  http: Http,
  patch: unknown[],
): Promise<{ revision: string; planId: string }> {
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

export async function applyByPlan(http: Http, planId: string): Promise<{
  phase: string;
  generation?: string;
  detail?: { failure?: string };
}> {
  return unwrap(
    await http('POST', '/api/v1/apply', { plan_id: planId }),
    'apply',
  ) as { phase: string; generation?: string; detail?: { failure?: string } };
}

/**
 * 미완 전환을 이어받는다. changeset 을 열지 않는다. apply 도 아니다.
 */
export async function recover(http: Http): Promise<{
  phase: string;
  generation?: string;
  detail?: { failure?: string };
}> {
  return unwrap(await http('POST', '/api/v1/recover'), 'recover') as {
    phase: string; generation?: string; detail?: { failure?: string };
  };
}
