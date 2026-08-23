/**
 * CLI 리소스 쓰기 — DESIGN.md §5.6
 *
 * HTTP·TCP·UDP·HTTPS·패스스루 리스너 create·delete. apply 는 안 한다.
 * 패스스루는 tls 를 안 붙인다. unmatched SNI 풀은 선택이다.
 */
import {
  deletePatch,
  putHttpListenerPatch, putHttpsListenerPatch, putPassthroughListenerPatch,
  putTcpListenerPatch, putUdpListenerPatch, type UdpPreset,
  listenerOptionFields, type ListenerOptions,
} from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, commitPatch, type Http } from './flow.js';

/**
 * CLI 플래그 → 리스너 옵션 (제안 6·7·8, 2026-08-23).
 *
 * `bary changeset patch <파일.json>` 으로도 넣을 수 있었지만, 그건 API 를 얇게 감싼
 * 것이다. 이 CLI 가 `--pool` 같은 플래그를 가진 이유는 **사람이 JSON 을 손으로 쓰지
 * 않게** 하기 위해서이고, 새 옵션만 raw JSON 으로 남기면 그 계약이 반쪽이 된다.
 *
 * ── 파싱이 계약이다
 *
 * 플래그는 문자열로 온다. 여기서 틀리면 **사용자가 적은 것과 저장되는 것이 달라지고**,
 * 그 차이는 트래픽이 물리는 날에만 드러난다. 그래서 단위를 추측하지 않는다 —
 * `--read-timeout 120` 은 초인지 밀리초인지 모르므로 거부한다.
 */
export type ListenerOptionFlags = {
  connectTimeout?: string;
  readTimeout?: string;
  sendTimeout?: string;
  maxBody?: string;
  header?: string[];
  rate?: string;
  burst?: string;
  nodelay?: boolean;
  maxConn?: string;
};

/** `50m` · `512k` · `1500`. **모르는 단위는 거부한다** — 조용히 바이트로 읽지 않는다. */
function sizeBytes(v: string): number {
  const m = /^(\d+)([km]?)$/.exec(v.trim());
  if (m === null) throw new Error(`크기가 아니다: ${JSON.stringify(v)} — 예: 50m · 512k · 1500`);
  const n = Number(m[1]);
  if (m[2] === 'm') return n * 1024 * 1024;
  if (m[2] === 'k') return n * 1024;
  return n;
}

/**
 * `120s` · `1500ms`. **단위가 없으면 거부한다.**
 *
 * nginx 는 맨 숫자를 초로 읽지만 우리 모델은 ms 로 든다. 둘 중 하나를 골라 추측하면
 * 60 배 틀린 값이 조용히 저장된다.
 */
function durationMs(v: string): number {
  const m = /^(\d+)(ms|s)$/.exec(v.trim());
  if (m === null) throw new Error(`시간이 아니다: ${JSON.stringify(v)} — 단위를 적는다 (예: 120s · 1500ms)`);
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

/** `10r/s` 와 맨 `10` 을 둘 다 받는다 — `r/s` 는 nginx 표기이지 사용자의 것이 아니다. */
function ratePerSecond(v: string): number {
  const m = /^(\d+)(?:r\/s)?$/.exec(v.trim());
  if (m === null) throw new Error(`초당 요청 수가 아니다: ${JSON.stringify(v)} — 예: 10 · 10r/s`);
  return Number(m[1]);
}

/**
 * `req:이름:값` · `res:이름:값`.
 *
 * **첫 두 개만 가른다** — 값에 콜론이 있는 것이 정상이다 (`https://a/b`).
 */
function headerRule(spec: string): { dir: 'request' | 'response'; name: string; value: string } {
  const first = spec.indexOf(':');
  const second = spec.indexOf(':', first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`헤더가 아니다: ${JSON.stringify(spec)} — req:이름:값 또는 res:이름:값`);
  }
  const dir = spec.slice(0, first);
  if (dir !== 'req' && dir !== 'res') {
    throw new Error(`방향이 req 나 res 가 아니다: ${JSON.stringify(dir)}`);
  }
  return {
    dir: dir === 'req' ? 'request' : 'response',
    name: spec.slice(first + 1, second),
    value: spec.slice(second + 1),
  };
}

export function parseListenerOptions(f: ListenerOptionFlags): ListenerOptions {
  const limits = {
    ...(f.connectTimeout === undefined ? {} : { connectTimeoutMs: durationMs(f.connectTimeout) }),
    ...(f.readTimeout === undefined ? {} : { readTimeoutMs: durationMs(f.readTimeout) }),
    ...(f.sendTimeout === undefined ? {} : { sendTimeoutMs: durationMs(f.sendTimeout) }),
    ...(f.maxBody === undefined ? {} : { clientMaxBodyBytes: sizeBytes(f.maxBody) }),
  };
  const rateLimit = {
    ...(f.rate === undefined ? {} : { requestsPerSecond: ratePerSecond(f.rate) }),
    ...(f.burst === undefined ? {} : { burst: Number(f.burst) }),
    ...(f.nodelay === undefined ? {} : { nodelay: f.nodelay }),
    ...(f.maxConn === undefined ? {} : { maxConnections: Number(f.maxConn) }),
  };
  const request: { name: string; value: string }[] = [];
  const response: { name: string; value: string }[] = [];
  for (const spec of f.header ?? []) {
    const r = headerRule(spec);
    (r.dir === 'request' ? request : response).push({ name: r.name, value: r.value });
  }
  const headers = {
    ...(request.length === 0 ? {} : { request }),
    ...(response.length === 0 ? {} : { response }),
  };

  // **`listenerOptionFields` 와 같은 규칙을 지난다** — 빈 것을 버리고, `burst` 만 있는
  // 조합을 막는 곳이 한 자리여야 한다. 여기서 따로 판정하면 GUI 와 갈린다.
  return listenerOptionFields({
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(Object.keys(rateLimit).length === 0 ? {} : { rateLimit }),
  });
}

export type ListenerCreateInput = {
  name: string;
  protocol: string;
  bind: string;
  port: number;
  pool?: string;
  preset?: string;
  policy?: string;
  certificate?: string;
  /** 제안 6·7·8. http·https 에만 붙는다 — 모델이 그 자리를 거기에만 준다. */
  options?: ListenerOptions;
};

const udpPreset = (v: string | undefined): UdpPreset | undefined =>
  (v === 'dns' || v === 'wireguard' || v === 'game_generic' || v === 'custom' ? v : undefined);

export function listenerCreatePatch(
  input: ListenerCreateInput,
): ReturnType<typeof putHttpListenerPatch>
  | ReturnType<typeof putTcpListenerPatch>
  | ReturnType<typeof putUdpListenerPatch>
  | ReturnType<typeof putHttpsListenerPatch>
  | ReturnType<typeof putPassthroughListenerPatch>
  | undefined {
  if (input.protocol === 'http') {
    if (input.pool === undefined || input.pool === '') return undefined;
    return putHttpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
      // 제안 6·7·8. `undefined` 면 `listenerOptionFields` 가 아무것도 안 만든다.
      ...(input.options ?? {}),
    });
  }
  if (input.protocol === 'tcp') {
    if (input.pool === undefined || input.pool === '') return undefined;
    return putTcpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
    });
  }
  if (input.protocol === 'udp') {
    const preset = udpPreset(input.preset);
    if (preset === undefined || input.pool === undefined || input.pool === '') return undefined;
    return putUdpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
      preset,
    });
  }
  if (input.protocol === 'https') {
    if (input.policy === undefined || input.policy === ''
      || input.certificate === undefined || input.certificate === ''
      || input.pool === undefined || input.pool === '') {
      return undefined;
    }
    return putHttpsListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
      policy: input.policy,
      certificate: input.certificate,
      ...(input.options ?? {}),
    });
  }
  if (input.protocol === 'tls_passthrough') {
    return putPassthroughListenerPatch(
      input.name,
      input.pool === undefined || input.pool === ''
        ? { bind: input.bind, port: input.port }
        : { bind: input.bind, port: input.port, pool: input.pool },
    );
  }
  return undefined;
}

export async function listenerCreate(
  http: Http,
  input: ListenerCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = listenerCreatePatch(input);
  if (patch === undefined) {
    throw new Error('http·tcp·udp·https·tls_passthrough 만 연다. https 는 --policy 와 --certificate 가 필요하다');
  }
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

export function listenerDeletePatch(key: string): ReturnType<typeof deletePatch> | undefined {
  if (key === '') return undefined;
  return deletePatch('listener', key);
}

export async function listenerDelete(
  http: Http,
  key: string,
): Promise<{ revision: string; planId: string }> {
  const patch = listenerDeletePatch(key);
  if (patch === undefined) throw new Error('리스너 키가 비어 있다');
  return commitPatch(http, patch);
}
