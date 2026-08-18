#!/usr/bin/env node
/**
 * `bary` — 컨트롤 플레인 CLI (DESIGN.md §5.6)
 *
 * **v0.4 의 전체 CLI 가 아니다.** 리소스별 하위 명령과 대화형 편집은 아직 없다.
 * export/import 는 있다 — 안정 키 매니페스트, 단일 changeset, 두 번 넣어도 같다.
 *
 *   bary status
 *   bary head
 *   bary get <listeners|pools|backends|routes|model|rendered>
 *   bary apply <파일.json>      매니페스트 한 장을 changeset 한 바퀴로 밀어 넣는다
 *   bary plan  <파일.json>      커밋하지 않고 영향만 본다
 *   bary export                 spec-only 매니페스트를 stdout 에
 *   bary import <파일.json>     단일 changeset 으로 커밋 (nginx 적용은 apply)
 *   bary rollback <리비전>      그 시점 내용으로 새 리비전을 만들고 적용한다
 *   bary cancel <오퍼레이션>   진행 중인 전환을 포기한다
 *   bary audit [n]
 *
 * 환경변수: `BARY_URL`(기본 http://127.0.0.1:8088) · `BARY_TOKEN`
 *
 * **매니페스트는 patch 배열 그대로다.** 별도 문법을 만들지 않았다 — API 가 받는 모양과
 * 다른 모양을 CLI 가 들고 있으면 그 둘이 갈라지는 것은 시간 문제고, 갈라지면 어느
 * 쪽이 계약인지 아무도 모른다(6차 검수가 문서와 코드에서 겪은 것과 같은 병이다).
 */
import { readFileSync } from 'node:fs';

const URL_BASE = process.env['BARY_URL'] ?? 'http://127.0.0.1:8088';
const TOKEN = process.env['BARY_TOKEN'] ?? '';

type Res = { status: number; body: unknown };

async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${URL_BASE}${path}`, {
    method,
    headers: {
      ...(TOKEN === '' ? {} : { authorization: `Bearer ${TOKEN}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

const show = (v: unknown): void => {
  console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
};

/** 실패는 **조용히 넘기지 않는다.** 종료 코드와 본문을 함께 낸다. */
function must(r: Res, what: string): unknown {
  if (r.status >= 400) {
    const b = r.body as { code?: string; message?: string };
    console.error(`${what} 실패 [${r.status} ${b.code ?? ''}]: ${b.message ?? JSON.stringify(r.body)}`);
    process.exit(1);
  }
  return r.body;
}

const usage = (): never => {
  console.error(`bary — barycenter CLI

  bary status                    4-way 상태 · 미완 전환 · 미적용 커밋
  bary head                      전역 리비전
  bary get <무엇>                listeners | pools | backends | routes | model | rendered
  bary plan <파일.json>          커밋하지 않고 영향만 본다
  bary apply <파일.json>         changeset → plan → commit → apply 한 바퀴
  bary export                    spec-only 매니페스트 (stdout)
  bary import <파일.json>        단일 changeset 으로 커밋. --mode replace 는 없는 키를 지운다
  bary rollback <리비전>          그 시점 내용으로 **새 리비전**을 만들고 적용한다
  bary cancel <오퍼레이션>        진행 중인 전환을 포기한다 (활성화된 것은 못 되돌린다)
  bary audit [개수]

환경변수: BARY_URL (기본 ${URL_BASE}) · BARY_TOKEN`);
  process.exit(2);
};

/** 파일 한 장을 patch 배열로 읽는다. */
function readPatch(path: string): unknown[] {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const ops = Array.isArray(parsed)
    ? parsed
    : (parsed as { patch?: unknown }).patch;
  if (!Array.isArray(ops)) {
    console.error(`${path} 은 patch 배열이거나 {"patch":[...]} 여야 한다`);
    process.exit(2);
  }
  return ops;
}

/** changeset 을 열고 patch 를 얹고 plan 까지. 커밋은 호출자가 정한다. */
async function upToPlan(path: string): Promise<{ csId: string; plan: any }> {
  const head = must(await call('GET', '/api/v1/config/head'), 'head') as { revision: string };
  const cs = must(
    await call('POST', '/api/v1/changesets', { base_revision: head.revision }),
    'changeset 생성',
  ) as { id: string };
  must(await call('PATCH', `/api/v1/changesets/${cs.id}`, { patch: readPatch(path) }), 'patch');
  const plan = must(await call('POST', `/api/v1/changesets/${cs.id}/plan`), 'plan');
  return { csId: cs.id, plan };
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case 'status':
      show(must(await call('GET', '/api/v1/status'), 'status'));
      return;
    case 'head':
      show(must(await call('GET', '/api/v1/config/head'), 'head'));
      return;
    case 'get': {
      const what = arg ?? usage();
      const path = what === 'model' || what === 'rendered'
        ? `/api/v1/config/${what}` : `/api/v1/${what}`;
      show(must(await call('GET', path), what));
      return;
    }
    case 'rollback': {
      const to = arg ?? usage();
      const rolled = must(
        await call('POST', '/api/v1/rollback', { to_revision: to }), 'rollback',
      ) as { revision: string; planId: string; rollbackOf: string };
      // **head 는 앞으로 간다.** 되돌리는 것이 아니라 그 시점 내용으로 새 리비전을 만든다.
      console.error(`r${rolled.rollbackOf} 의 내용으로 r${rolled.revision} 을 만들었다`);
      const op = must(await call('POST', '/api/v1/apply', { plan_id: rolled.planId }), 'apply') as {
        phase: string; detail?: { failure?: string };
      };
      show(op);
      if (op.phase !== 'activated') {
        console.error(`활성화되지 않았다: ${op.phase}${
          op.detail?.failure === undefined ? '' : ` — ${op.detail.failure}`}`);
        process.exit(1);
      }
      return;
    }
    case 'cancel': {
      show(must(await call('POST', `/api/v1/operations/${encodeURIComponent(arg ?? usage())}/cancel`),
        'cancel'));
      return;
    }
    case 'audit': {
      const n = arg ?? '30';
      show(must(await call('GET', `/api/v1/audit?limit=${encodeURIComponent(n)}`), 'audit'));
      return;
    }
    case 'plan': {
      const { plan } = await upToPlan(arg ?? usage());
      // **영향을 먼저 보여 준다.** 전체 모델을 쏟으면 정작 봐야 할 것이 묻힌다.
      show({ id: plan.id, impact: plan.impact, renderDigest: plan.renderDigest });
      return;
    }
    case 'export':
      show(must(await call('GET', '/api/v1/config/export'), 'export'));
      return;
    case 'import': {
      const path = arg ?? usage();
      const mode = process.argv.includes('--mode')
        ? process.argv[process.argv.indexOf('--mode') + 1]
        : 'merge';
      if (mode !== 'merge' && mode !== 'replace') {
        console.error('--mode 는 merge 또는 replace 다');
        process.exit(2);
      }
      const doc: unknown = JSON.parse(readFileSync(path, 'utf8'));
      const body = mode === 'replace' ? { manifest: doc, mode } : doc;
      const out = must(await call('POST', '/api/v1/config/import', body), 'import') as {
        unchanged: boolean; revision: string;
      };
      if (out.unchanged) {
        console.error(`이미 같다 (r${out.revision})`);
      } else {
        console.error(`imported r${out.revision}`);
      }
      show(out);
      return;
    }
    case 'apply': {
      const { csId, plan } = await upToPlan(arg ?? usage());
      console.error(`plan ${plan.id} — 소켓 +${plan.impact.socketChanges.added.length} `
        + `-${plan.impact.socketChanges.removed.length}, 평면 [${plan.impact.planes.join(',')}]`);
      const committed = must(
        await call('POST', `/api/v1/changesets/${csId}/commit`, { plan_id: plan.id }),
        'commit',
      ) as { revision: string };
      console.error(`committed r${committed.revision}`);
      const op = must(await call('POST', '/api/v1/apply', { plan_id: plan.id }), 'apply') as {
        phase: string; generation: string; detail?: { failure?: string };
      };
      show(op);
      // **활성화가 아니면 0 으로 끝내지 않는다.** 스크립트가 성공으로 읽으면 안 된다.
      if (op.phase !== 'activated') {
        console.error(`활성화되지 않았다: ${op.phase}${
          op.detail?.failure === undefined ? '' : ` — ${op.detail.failure}`}`);
        process.exit(1);
      }
      return;
    }
    default:
      usage();
  }
}

main().catch((e: unknown) => {
  console.error(String(e));
  process.exit(1);
});
