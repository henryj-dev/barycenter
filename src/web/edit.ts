/**
 * GUI 가 changeset 에 얹는 패치 — DESIGN.md §5.3 · §10
 *
 * 저장(commit)과 적용(apply)은 다르다. 여기서 만드는 것은 patch 뿐이다.
 * 메서드×경로 ALLOW/DENY 는 WAF 다. 여기 없다.
 */
export type EditKind = 'backend' | 'listener' | 'pool' | 'httpRoute';

export type DeleteOp = { op: 'delete'; kind: EditKind; key: string };

export type PutBackendOp = {
  op: 'put';
  kind: 'backend';
  key: string;
  body: { pool: string; host: string; port: number; weight: number };
};

export function deletePatch(kind: EditKind, key: string): DeleteOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  return [{ op: 'delete', kind, key }];
}

export function putBackendPatch(
  key: string,
  body: { pool: string; host: string; port: number; weight?: number },
): PutBackendOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (body.host === '') throw new Error('호스트가 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  const weight = body.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 1) throw new Error('가중치가 1 이상 정수가 아니다');
  return [{ op: 'put', kind: 'backend', key, body: { pool: body.pool, host: body.host, port: body.port, weight } }];
}

export type PutHttpListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'http';
    bind: string;
    port: number;
    enabled: true;
    http: { defaultAction: { pool: string } };
  };
};

/** HTTP 만. https 는 tls 가 필수라 지금 폼이 못 채운다. */
export function putHttpListenerPatch(
  key: string,
  body: { bind: string; port: number; pool: string },
): PutHttpListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'listener',
    key,
    body: {
      protocol: 'http',
      bind: body.bind,
      port: body.port,
      enabled: true,
      http: { defaultAction: { pool: body.pool } },
    },
  }];
}

export type ProtocolClass = 'http' | 'tcp' | 'udp';

export type PutPoolOp = {
  op: 'put';
  kind: 'pool';
  key: string;
  body: { protocolClass: ProtocolClass; algorithm: 'round_robin' };
};

/**
 * 빈 풀은 검증기가 막는다. 풀만 put 하면 plan 이 실패한다.
 * 첫 백엔드를 같은 changeset 에 얹는다.
 */
export function putPoolWithBackendPatch(input: {
  pool: string;
  protocolClass: ProtocolClass;
  backend: string;
  host: string;
  port: number;
}): [PutPoolOp, ...PutBackendOp[]] {
  if (input.pool === '') throw new Error('풀 키가 비어 있다');
  if (input.protocolClass !== 'http' && input.protocolClass !== 'tcp' && input.protocolClass !== 'udp') {
    throw new Error('protocolClass 가 http|tcp|udp 가 아니다');
  }
  const backends = putBackendPatch(input.backend, {
    pool: input.pool, host: input.host, port: input.port,
  });
  return [
    {
      op: 'put',
      kind: 'pool',
      key: input.pool,
      body: { protocolClass: input.protocolClass, algorithm: 'round_robin' },
    },
    ...backends,
  ];
}

export type PutHttpRouteOp = {
  op: 'put';
  kind: 'httpRoute';
  key: string;
  body: {
    listener: string;
    hosts: string[];
    priority: number;
    pathPrefix?: string;
    action: { kind: 'proxy'; pool: string; websocket: false };
  };
};

/**
 * 호스트 → 풀 proxy. websocket 은 끈다.
 * redirect·reject 는 폼이 못 채운다.
 */
export function putHttpRoutePatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  pool: string;
  pathPrefix?: string;
  priority?: number;
}): PutHttpRouteOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  if (input.pool === '') throw new Error('풀이 비어 있다');
  const hosts = input.hosts.map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) throw new Error('호스트가 비어 있다');
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  const pathPrefix = input.pathPrefix?.trim();
  const body: PutHttpRouteOp['body'] = {
    listener: input.listener,
    hosts,
    priority,
    action: { kind: 'proxy', pool: input.pool, websocket: false },
  };
  if (pathPrefix !== undefined && pathPrefix !== '') body.pathPrefix = pathPrefix;
  return [{ op: 'put', kind: 'httpRoute', key: input.key, body }];
}
