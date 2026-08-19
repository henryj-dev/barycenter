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
