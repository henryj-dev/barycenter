#!/usr/bin/env node
/**
 * `bary` — 컨트롤 플레인 CLI (DESIGN.md §5.6)
 *
 * **v0.4 의 전체 CLI 가 아니다.** 리스너 create 와 round_robin·hash 풀 create 가 있다. 대화형 편집은 없다.
 * export/import 와 나뉜 changeset 단계는 있다. `apply <파일>` 은 단축이다.
 *
 *   bary listener create --name --protocol http|tcp|udp|https|tls_passthrough --bind --port [--pool] [--preset] [--policy] [--certificate]
 *   bary pool create --name --protocol-class http|tcp|udp --backend --host --port [--algorithm round_robin|hash] [--hash-key]
 *   bary changeset new|patch|plan|show
 *   bary commit --plan <id>
 *   bary apply --plan <id>
 *   bary apply <파일.json>      한 바퀴 단축
 *   bary plan  <파일.json>      커밋하지 않고 영향만 본다
 *   bary export / import
 *   bary rollback / cancel / audit / status / head / get
 *
 * 환경변수: `BARY_URL`(기본 http://127.0.0.1:8088) · `BARY_TOKEN`
 *
 * **매니페스트는 patch 배열 그대로다.** 별도 문법을 만들지 않았다 — API 가 받는 모양과
 * 다른 모양을 CLI 가 들고 있으면 그 둘이 갈라지는 것은 시간 문제고, 갈라지면 어느
 * 쪽이 계약인지 아무도 모른다(6차 검수가 문서와 코드에서 겪은 것과 같은 병이다).
 */
import { readFileSync } from 'node:fs';

import { listenerCreate } from '../cli/listener.js';
import { poolCreate } from '../cli/pool.js';
import {
  applyByPlan,
  changesetNew,
  changesetPatch,
  changesetPlan,
  changesetShow,
  commitByPlan,
  flag,
  unwrap,
} from '../cli/flow.js';

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
  try {
    return unwrap(r, what);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}

const usage = (): never => {
  console.error(`bary — barycenter CLI

  bary status                    4-way 상태 · 미완 전환 · 미적용 커밋
  bary head                      전역 리비전
  bary get <무엇>                listeners | pools | backends | routes | model | rendered
  bary listener create           --name --protocol http|tcp|udp|https|tls_passthrough --bind --port [--pool] [--preset] [--policy] [--certificate]. commit 까지. apply 는 아니다
  bary pool create               --name --protocol-class http|tcp|udp --backend --host --port [--algorithm round_robin|hash] [--hash-key]. 첫 백엔드와 같이. apply 는 아니다
  bary changeset new             changeset 을 연다
  bary changeset patch <id> <파일.json>
  bary changeset plan <id>       영향만 본다 (커밋하지 않는다)
  bary changeset show <id>
  bary plan <파일.json>          changeset+patch+plan 단축
  bary commit --plan <id>        plan 이 가리키는 changeset 을 커밋
  bary apply --plan <id>         이미 커밋된 plan 을 nginx 에
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

function die(e: unknown): never {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [cmd, arg, arg2] = argv;
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
    case 'listener': {
      const sub = arg ?? usage();
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const protocol = flag(argv, '--protocol') ?? usage();
      const bind = flag(argv, '--bind') ?? usage();
      const portRaw = flag(argv, '--port') ?? usage();
      const pool = flag(argv, '--pool');
      if (protocol !== 'tls_passthrough' && (pool === undefined || pool === '')) usage();
      const preset = flag(argv, '--preset');
      const policy = flag(argv, '--policy');
      const certificate = flag(argv, '--certificate');
      try {
        const out = await listenerCreate(call, {
          name, protocol, bind, port: Number(portRaw),
          ...(pool === undefined ? {} : { pool }),
          ...(preset === undefined ? {} : { preset }),
          ...(policy === undefined ? {} : { policy }),
          ...(certificate === undefined ? {} : { certificate }),
        });
        console.error(`listener ${name} committed r${out.revision}`);
        show(out);
      } catch (e) {
        die(e);
      }
      return;
    }
    case 'pool': {
      const sub = arg ?? usage();
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const protocolClass = flag(argv, '--protocol-class') ?? usage();
      const backend = flag(argv, '--backend') ?? usage();
      const host = flag(argv, '--host') ?? usage();
      const portRaw = flag(argv, '--port') ?? usage();
      const algorithm = flag(argv, '--algorithm');
      const hashKey = flag(argv, '--hash-key');
      try {
        const out = await poolCreate(call, {
          name, protocolClass, backend, host, port: Number(portRaw),
          ...(algorithm === undefined ? {} : { algorithm }),
          ...(hashKey === undefined ? {} : { hashKey }),
        });
        console.error(`pool ${name} committed r${out.revision}`);
        show(out);
      } catch (e) {
        die(e);
      }
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
      const mode = flag(argv, '--mode') ?? 'merge';
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
    case 'changeset': {
      const sub = arg ?? usage();
      try {
        if (sub === 'new') {
          show(await changesetNew(call));
          return;
        }
        if (sub === 'show') {
          show(await changesetShow(call, arg2 ?? usage()));
          return;
        }
        if (sub === 'patch') {
          await changesetPatch(call, arg2 ?? usage(), readPatch(argv[3] ?? usage()));
          return;
        }
        if (sub === 'plan') {
          const plan = await changesetPlan(call, arg2 ?? usage());
          show({ id: plan.id, impact: plan.impact, renderDigest: plan.renderDigest });
          return;
        }
      } catch (e) {
        die(e);
      }
      return usage();
    }
    case 'commit': {
      const planId = flag(argv, '--plan') ?? usage();
      try {
        const committed = await commitByPlan(call, planId);
        console.error(`committed r${committed.revision}`);
        show(committed);
      } catch (e) {
        die(e);
      }
      return;
    }
    case 'apply': {
      const planId = flag(argv, '--plan');
      if (planId !== undefined) {
        try {
          const op = await applyByPlan(call, planId);
          show(op);
          if (op.phase !== 'activated') {
            console.error(`활성화되지 않았다: ${op.phase}${
              op.detail?.failure === undefined ? '' : ` — ${op.detail.failure}`}`);
            process.exit(1);
          }
        } catch (e) {
          die(e);
        }
        return;
      }
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
