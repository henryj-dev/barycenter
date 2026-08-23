#!/usr/bin/env node
/**
 * `bary` — 컨트롤 플레인 CLI (DESIGN.md §5.6)
 *
 * **v0.4 의 전체 CLI 가 아니다.** 리스너·풀·라우트·백엔드·TLS 쓰기가 있다. 대화형 편집은 없다.
 * export/import 와 나뉜 changeset 단계는 있다. `apply <파일>` 은 단축이다.
 *
 *   bary listener create|delete
 *   bary pool create|delete
 *   bary route create|delete
 *   bary backend create|delete
 *   bary tls-policy create|delete
 *   bary certificate create|delete
 *   bary sni-binding create|delete
 *   bary changeset new|patch|plan|show|discard|reopen
 *   bary commit --plan <id>
 *   bary apply --plan <id>
 *   bary apply <파일.json>      한 바퀴 단축
 *   bary plan  <파일.json>      커밋하지 않고 영향만 본다
 *   bary export / import
 *   bary rollback / cancel / audit / status / head
 *   bary get listeners|pools|backends|backends/status|routes|certificates|tls-policies|sni-bindings|sockets|health|model|rendered|metrics
 *   bary recover
 *
 * 환경변수: `BARY_URL`(기본 http://127.0.0.1:8088) · `BARY_TOKEN`
 *
 * **매니페스트는 patch 배열 그대로다.** 별도 문법을 만들지 않았다 — API 가 받는 모양과
 * 다른 모양을 CLI 가 들고 있으면 그 둘이 갈라지는 것은 시간 문제고, 갈라지면 어느
 * 쪽이 계약인지 아무도 모른다(6차 검수가 문서와 코드에서 겪은 것과 같은 병이다).
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { backupNow, restoreNow } from '../cli/backup.js';

import {
  backendDelete, backendDrain, backendDrainStatus, backendPut, backendUndrain,
} from '../cli/backend.js';
import { getResource } from '../cli/get.js';
import { listenerCreate, listenerDelete, parseListenerOptions } from '../cli/listener.js';
import { poolCreate, poolDelete } from '../cli/pool.js';
import { routeCreate, routeDelete } from '../cli/route.js';
import {
  certificateCreate, certificateDelete, sniBindingCreate, sniBindingDelete,
  tlsPolicyCreate, tlsPolicyDelete,
} from '../cli/tls.js';
import {
  applyByPlan,
  changesetDiscard,
  changesetNew,
  changesetPatch,
  changesetPlan,
  planSummary,
  changesetReopen,
  changesetShow,
  commitByPlan,
  flag,
  flagAll,
  has,
  recover,
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
  bary get <무엇>                listeners | pools | backends | backends/status | routes | certificates | tls-policies | sni-bindings | sockets | health | model | rendered | metrics
                                 backends/status 는 왜 트래픽을 안 받는지까지 낸다
                                 sockets 는 배포가 열어야 할 (전송·주소·포트) 를 낸다 (§11.3)
                                 pools/<id>/backends | backends/<id>/status | operations/<id> | plans/<id>
                                 acme/orders | acme/orders/<id> | acme/orders/<id>/challenges | acme/challenges/<id>
                                 모르는 이름은 안 부른다
  bary listener create           --name --protocol http|tcp|udp|https|tls_passthrough --bind --port [--pool] [--preset] [--policy] [--certificate]. commit 까지. apply 는 아니다
                                 tls_passthrough 는 폴백 둘을 받는다:
                                   --pool <풀>            유효한 SNI 인데 매칭이 없다
                                   --no-sni-pool <풀>     TLS 인데 SNI 가 없다 (S9)
                                 파싱 실패(비-TLS·malformed)는 설정 대상이 아니다 — 언제나 끊는다
                                 http·https 는 옵션도 받는다 (제안 6·7·8):
                                   --connect-timeout 5s   --read-timeout 120s   --send-timeout 90s
                                   --max-body 50m         (0 은 무제한)
                                   --header req:X-A:1     --header res:X-B:2    (여러 번)
                                   --strict-priority      priority 가 매치 클래스를 이기게 한다 (S10)
                                                          겹치는 호스트를 앵커 정규식으로 내린다 — 128개 상한
                                   --rate 10r/s  --burst 20  --nodelay  --max-conn 100
  bary listener delete           --name
  bary pool create               --name --protocol-class http|tcp|udp --backend --host --port [--algorithm round_robin|least_conn|hash|source_ip_hash] [--hash-key]. 첫 백엔드와 같이. apply 는 아니다
                                 백엔드로 TLS 를 쓰려면 (§4.3):
                                   --upstream-tls         켠다 (http 는 proxy_pass https://, tcp 는 proxy_ssl on)
                                   --upstream-sni <이름>  안 주면 업스트림 주소가 SNI 가 된다
                                   --upstream-ca <인증서> 신뢰 번들로 쓸 인증서 키
                                   --upstream-verify      --upstream-ca 가 있어야 한다
                                 udp 와 패스스루가 가리키는 풀에는 못 켠다
  bary pool delete               --name
  bary route create              --name --listener --host|--sni --pool|--to|--reject [--status] [--path-prefix] [--websocket]. apply 는 아니다
  bary route delete              --name --host|--sni. HTTP 와 패스스루를 가른다
  bary backend create            --name --pool --host --port [--weight]. apply 는 아니다
  bary backend delete            --name
  bary backend drain             --name [--deadline 초]. 새 트래픽을 끊는다. apply 가 아니다
  bary backend undrain           --name. 드레인을 푼다. deadline 이 지나면 저절로도 풀린다
  bary backend drain-status      --name. 관측이 없으면 숫자를 안 싣는다
  bary tls-policy create         --name [--min-version 1.2|1.3]. HSTS 안 켬
  bary tls-policy delete         --name
  bary certificate create        --name --fullchain <파일> --privkey <파일>. 패치에 개인키 없음
  bary certificate delete        --name
  bary sni-binding create        --name --listener --host --certificate. override 없음
  bary sni-binding delete        --name
  bary changeset new             changeset 을 연다
  bary changeset patch <id> <파일.json>
  bary changeset plan <id>       영향만 본다 (커밋하지 않는다)
  bary changeset show <id>
  bary changeset discard <id>    연 것·봉인한 것을 버린다. 커밋된 것은 롤백이다
  bary changeset reopen <id>     sealed → open. 옛 plan 은 무효
  bary plan <파일.json>          changeset+patch+plan 단축
  bary commit --plan <id>        plan 이 가리키는 changeset 을 커밋
  bary apply --plan <id>         이미 커밋된 plan 을 nginx 에
  bary apply <파일.json>         changeset → plan → commit → apply 한 바퀴
  bary export                    spec-only 매니페스트 (stdout)
  bary import <파일.json>        단일 changeset 으로 커밋. --mode replace 는 없는 키를 지운다
  bary backup [파일.json]        GET /backup. 시크릿 바이트 없음
  bary restore <파일.json>       POST /restore. admin 스코프. apply 는 아니다
  bary rollback <리비전>          그 시점 내용으로 **새 리비전**을 만들고 적용한다
  bary cancel <오퍼레이션>        진행 중인 전환을 포기한다 (활성화된 것은 못 되돌린다)
  bary recover                   미완 전환을 이어받는다. changeset 을 안 연다
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
      try {
        show(await getResource(call, what));
      } catch (e) {
        die(e);
      }
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
    case 'recover': {
      try {
        show(await recover(call));
      } catch (e) {
        die(e);
      }
      return;
    }
    case 'audit': {
      const n = arg ?? '30';
      show(must(await call('GET', `/api/v1/audit?limit=${encodeURIComponent(n)}`), 'audit'));
      return;
    }
    case 'listener': {
      const sub = arg ?? usage();
      if (sub === 'delete') {
        const name = flag(argv, '--name') ?? usage();
        try {
          const out = await listenerDelete(call, name);
          console.error(`listener ${name} deleted r${out.revision}`);
          show(out);
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const protocol = flag(argv, '--protocol') ?? usage();
      const bind = flag(argv, '--bind') ?? usage();
      const portRaw = flag(argv, '--port') ?? usage();
      const pool = flag(argv, '--pool');
      if (protocol !== 'tls_passthrough' && (pool === undefined || pool === '')) usage();
      const preset = flag(argv, '--preset');
      // S9 — **패스스루에만.** TLS 는 맞는데 SNI 가 없을 때의 폴백이다. 파싱 실패는
      // 여전히 설정 대상이 아니다(그 통은 갈려 있다).
      const noSniPool = flag(argv, '--no-sni-pool');
      const policy = flag(argv, '--policy');
      const certificate = flag(argv, '--certificate');
      // 제안 6·7·8 — http·https 에만 뜻이 있다. 파싱은 `parseListenerOptions` 한 자리다.
      const headerSpecs = flagAll(argv, '--header');
      const options = parseListenerOptions({
        ...(flag(argv, '--connect-timeout') === undefined ? {} : { connectTimeout: flag(argv, '--connect-timeout')! }),
        ...(flag(argv, '--read-timeout') === undefined ? {} : { readTimeout: flag(argv, '--read-timeout')! }),
        ...(flag(argv, '--send-timeout') === undefined ? {} : { sendTimeout: flag(argv, '--send-timeout')! }),
        ...(flag(argv, '--max-body') === undefined ? {} : { maxBody: flag(argv, '--max-body')! }),
        ...(headerSpecs.length === 0 ? {} : { header: headerSpecs }),
        ...(flag(argv, '--rate') === undefined ? {} : { rate: flag(argv, '--rate')! }),
        ...(flag(argv, '--burst') === undefined ? {} : { burst: flag(argv, '--burst')! }),
        ...(has(argv, '--nodelay') ? { nodelay: true } : {}),
        ...(flag(argv, '--max-conn') === undefined ? {} : { maxConn: flag(argv, '--max-conn')! }),
        // S10 — 전역 숫자 priority. **강등 수에 상한이 있다** (§7.5-4).
        ...(has(argv, '--strict-priority') ? { strictPriority: true } : {}),
      });
      try {
        const out = await listenerCreate(call, {
          name, protocol, bind, port: Number(portRaw),
          ...(pool === undefined ? {} : { pool }),
          ...(preset === undefined ? {} : { preset }),
          ...(noSniPool === undefined ? {} : { noSniPool }),
          ...(policy === undefined ? {} : { policy }),
          ...(certificate === undefined ? {} : { certificate }),
          ...(Object.keys(options).length === 0 ? {} : { options }),
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
      if (sub === 'delete') {
        const name = flag(argv, '--name') ?? usage();
        try {
          const out = await poolDelete(call, name);
          console.error(`pool ${name} deleted r${out.revision}`);
          show(out);
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const protocolClass = flag(argv, '--protocol-class') ?? usage();
      const backend = flag(argv, '--backend') ?? usage();
      const host = flag(argv, '--host') ?? usage();
      const portRaw = flag(argv, '--port') ?? usage();
      const algorithm = flag(argv, '--algorithm');
      /**
       * 백엔드로 가는 TLS (§4.3). **`--upstream-verify` 는 `--upstream-ca` 가 있어야
       * 한다** — 신뢰 번들 없이는 검증이 안 걸린다. `upstreamTlsField` 가 그 짝을
       * 강제하고, 여기서 또 판정하면 GUI 와 갈린다.
       */
      const upstreamTls = has(argv, '--upstream-tls')
        ? {
          enabled: true,
          ...(flag(argv, '--upstream-sni') === undefined
            ? {} : { sni: flag(argv, '--upstream-sni')! }),
          ...(has(argv, '--upstream-verify') ? { verify: true } : {}),
          ...(flag(argv, '--upstream-ca') === undefined
            ? {} : { caBundle: flag(argv, '--upstream-ca')! }),
        }
        : undefined;
      const hashKey = flag(argv, '--hash-key');
      try {
        const out = await poolCreate(call, {
          name, protocolClass, backend, host, port: Number(portRaw),
          ...(algorithm === undefined ? {} : { algorithm }),
          ...(hashKey === undefined ? {} : { hashKey }),
          ...(upstreamTls === undefined ? {} : { upstreamTls }),
        });
        console.error(`pool ${name} committed r${out.revision}`);
        show(out);
      } catch (e) {
        die(e);
      }
      return;
    }
    case 'route': {
      const sub = arg ?? usage();
      if (sub === 'delete') {
        const name = flag(argv, '--name') ?? usage();
        try {
          const out = await routeDelete(call, {
            name,
            ...(argv.includes('--host') ? { host: true } : {}),
            ...(argv.includes('--sni') ? { sni: true } : {}),
          });
          console.error(`route ${name} deleted r${out.revision}`);
          show(out);
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const listener = flag(argv, '--listener') ?? usage();
      const hosts = flag(argv, '--host');
      const snis = flag(argv, '--sni');
      if ((hosts === undefined || hosts === '') && (snis === undefined || snis === '')) usage();
      const pool = flag(argv, '--pool');
      const to = flag(argv, '--to');
      const reject = argv.includes('--reject');
      const websocket = argv.includes('--websocket');
      if (!reject && (pool === undefined || pool === '') && (to === undefined || to === '')) usage();
      const status = flag(argv, '--status');
      const pathPrefix = flag(argv, '--path-prefix');
      try {
        const out = await routeCreate(call, {
          name, listener,
          ...(hosts === undefined ? {} : { hosts }),
          ...(snis === undefined ? {} : { snis }),
          ...(pool === undefined ? {} : { pool }),
          ...(to === undefined ? {} : { to }),
          ...(status === undefined ? {} : { status }),
          ...(reject ? { reject: true } : {}),
          ...(websocket ? { websocket: true } : {}),
          ...(pathPrefix === undefined ? {} : { pathPrefix }),
        });
        console.error(`route ${name} committed r${out.revision}`);
        show(out);
      } catch (e) {
        die(e);
      }
      return;
    }
    case 'backend': {
      const sub = arg ?? usage();
      if (sub === 'delete') {
        const name = flag(argv, '--name') ?? usage();
        try {
          const out = await backendDelete(call, name);
          console.error(`backend ${name} deleted r${out.revision}`);
          show(out);
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub === 'drain') {
        const name = flag(argv, '--name') ?? usage();
        const deadlineRaw = flag(argv, '--deadline');
        try {
          show(await backendDrain(call, name,
            deadlineRaw === undefined ? undefined : Number(deadlineRaw)));
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub === 'undrain') {
        const name = flag(argv, '--name') ?? usage();
        try {
          show(await backendUndrain(call, name));
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub === 'drain-status') {
        const name = flag(argv, '--name') ?? usage();
        try {
          show(await backendDrainStatus(call, name));
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const pool = flag(argv, '--pool') ?? usage();
      const host = flag(argv, '--host') ?? usage();
      const portRaw = flag(argv, '--port') ?? usage();
      const weightRaw = flag(argv, '--weight');
      try {
        const out = await backendPut(call, {
          name, pool, host, port: Number(portRaw),
          ...(weightRaw === undefined ? {} : { weight: Number(weightRaw) }),
        });
        console.error(`backend ${name} committed r${out.revision}`);
        show(out);
      } catch (e) {
        die(e);
      }
      return;
    }
    case 'tls-policy': {
      const sub = arg ?? usage();
      if (sub === 'delete') {
        const name = flag(argv, '--name') ?? usage();
        try {
          const out = await tlsPolicyDelete(call, name);
          console.error(`tls-policy ${name} deleted r${out.revision}`);
          show(out);
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const minVersion = flag(argv, '--min-version');
      try {
        const out = await tlsPolicyCreate(call, minVersion === undefined
          ? { name }
          : { name, minVersion });
        console.error(`tls-policy ${name} committed r${out.revision}`);
        show(out);
      } catch (e) {
        die(e);
      }
      return;
    }
    case 'certificate': {
      const sub = arg ?? usage();
      if (sub === 'delete') {
        const name = flag(argv, '--name') ?? usage();
        try {
          const out = await certificateDelete(call, name);
          console.error(`certificate ${name} deleted r${out.revision}`);
          show(out);
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const chainPath = flag(argv, '--fullchain') ?? usage();
      const keyPath = flag(argv, '--privkey') ?? usage();
      try {
        const out = await certificateCreate(call, {
          name,
          fullchain: readFileSync(chainPath, 'utf8'),
          privkey: readFileSync(keyPath, 'utf8'),
        });
        console.error(`certificate ${name} committed r${out.revision}`);
        show(out);
      } catch (e) {
        die(e);
      }
      return;
    }
    case 'sni-binding': {
      const sub = arg ?? usage();
      if (sub === 'delete') {
        const name = flag(argv, '--name') ?? usage();
        try {
          const out = await sniBindingDelete(call, name);
          console.error(`sni-binding ${name} deleted r${out.revision}`);
          show(out);
        } catch (e) {
          die(e);
        }
        return;
      }
      if (sub !== 'create') usage();
      const name = flag(argv, '--name') ?? usage();
      const listener = flag(argv, '--listener') ?? usage();
      const hosts = flag(argv, '--host') ?? usage();
      const certificate = flag(argv, '--certificate') ?? usage();
      try {
        const out = await sniBindingCreate(call, { name, listener, hosts, certificate });
        console.error(`sni-binding ${name} committed r${out.revision}`);
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
    case 'backup': {
      const bundle = await backupNow(call);
      if (arg !== undefined) writeFileSync(arg, JSON.stringify(bundle, null, 2));
      show(bundle);
      return;
    }
    case 'restore': {
      const path = arg ?? usage();
      const bundle = JSON.parse(readFileSync(path, 'utf8')) as { revision?: string; manifest?: unknown };
      if (bundle.manifest === undefined) {
        console.error('백업 파일에 manifest 가 없다');
        process.exit(2);
      }
      show(await restoreNow(call, { revision: bundle.revision ?? '', manifest: bundle.manifest }));
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
        if (sub === 'discard') {
          await changesetDiscard(call, arg2 ?? usage());
          console.error(`changeset ${arg2} discarded`);
          return;
        }
        if (sub === 'reopen') {
          show(await changesetReopen(call, arg2 ?? usage()));
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
      // **경고를 커밋 앞에서 낸다.** 뒤에 내면 이미 되돌릴 수 없는 것을 읽게 된다.
      for (const line of planSummary(plan.impact)) console.error(`plan ${plan.id} — ${line}`);
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
