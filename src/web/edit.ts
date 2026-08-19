/**
 * GUI 가 changeset 에 얹는 패치 — DESIGN.md §5.3 · §10
 *
 * 저장(commit)과 적용(apply)은 다르다. 여기서 만드는 것은 patch 뿐이다.
 * 메서드×경로 ALLOW/DENY 는 WAF 다. 여기 없다.
 */
export type EditKind = 'backend' | 'listener' | 'pool' | 'httpRoute' | 'passthroughRoute' | 'sniBinding';

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

/** HTTP 만. HTTPS 는 tls 결박이 따로 있다. */
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

export type PutTcpListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'tcp';
    bind: string;
    port: number;
    enabled: true;
    defaultPool: string;
  };
};

/**
 * TCP 만. defaultPool 은 최상위 필드다 — http.defaultAction 이 아니다.
 * PROXY 수신은 trustedCidrs 가 없어서 안 켠다.
 */
export function putTcpListenerPatch(
  key: string,
  body: { bind: string; port: number; pool: string },
): PutTcpListenerOp[] {
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
      protocol: 'tcp',
      bind: body.bind,
      port: body.port,
      enabled: true,
      defaultPool: body.pool,
    },
  }];
}

export type UdpPreset = 'dns' | 'wireguard' | 'game_generic' | 'custom';

const UDP_PRESETS: readonly UdpPreset[] = ['dns', 'wireguard', 'game_generic', 'custom'];

export type PutUdpListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'udp';
    bind: string;
    port: number;
    enabled: true;
    defaultPool: string;
    udp: { preset: UdpPreset };
  };
};

/**
 * UDP 만. preset 이 없으면 렌더러가 custom 을 지어 낸다 — 해독기가 막는다.
 * PROXY 수신 필드가 타입에 없다. 모르는 preset 은 패치를 안 만든다.
 */
export function putUdpListenerPatch(
  key: string,
  body: { bind: string; port: number; pool: string; preset: UdpPreset },
): PutUdpListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (!UDP_PRESETS.includes(body.preset)) throw new Error('preset 이 dns|wireguard|game_generic|custom 이 아니다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'listener',
    key,
    body: {
      protocol: 'udp',
      bind: body.bind,
      port: body.port,
      enabled: true,
      defaultPool: body.pool,
      udp: { preset: body.preset },
    },
  }];
}

export type TlsVersion = '1.2' | '1.3';

export type PutTlsPolicyOp = {
  op: 'put';
  kind: 'tlsPolicy';
  key: string;
  body: { minVersion: TlsVersion };
};

/** minVersion 만. cipherPolicy 는 안 적으면 intermediate-2026. HSTS 는 안 켠다. */
export function putTlsPolicyPatch(
  key: string,
  body: { minVersion?: TlsVersion } = {},
): PutTlsPolicyOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  const minVersion = body.minVersion ?? '1.2';
  if (minVersion !== '1.2' && minVersion !== '1.3') {
    throw new Error('minVersion 이 1.2|1.3 이 아니다');
  }
  return [{ op: 'put', kind: 'tlsPolicy', key, body: { minVersion } }];
}

export type PutHttpsListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'https';
    bind: string;
    port: number;
    enabled: true;
    http: { defaultAction: { pool: string } };
    tls: { policy: string; defaultCertificate: string };
  };
};

/**
 * HTTPS. tls.policy 와 tls.defaultCertificate 가 필수다.
 * 자료 없는 인증서는 검증기가 막는다 — 여기서 자료를 지어내지 않는다.
 * http2 는 안 적는다 (기본이 켠다).
 */
export function putHttpsListenerPatch(
  key: string,
  body: { bind: string; port: number; pool: string; policy: string; certificate: string },
): PutHttpsListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (body.policy === '') throw new Error('정책이 비어 있다');
  if (body.certificate === '') throw new Error('인증서가 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'listener',
    key,
    body: {
      protocol: 'https',
      bind: body.bind,
      port: body.port,
      enabled: true,
      http: { defaultAction: { pool: body.pool } },
      tls: { policy: body.policy, defaultCertificate: body.certificate },
    },
  }];
}

export type PutCertificateOp = {
  op: 'put';
  kind: 'certificate';
  key: string;
  body: { materialRef: string; chainDigest: string; keyDigest: string };
};

/**
 * 설정에는 참조만 실린다. fullchain·privkey 자리는 없다.
 * 자료는 POST /certificates/material 로 SecretStore 에 먼저 들어간다.
 */
export function putCertificatePatch(
  key: string,
  body: { materialRef: string; chainDigest: string; keyDigest: string },
): PutCertificateOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.materialRef === '') throw new Error('자료 참조가 비어 있다');
  if (body.chainDigest === '') throw new Error('chainDigest 가 비어 있다');
  if (body.keyDigest === '') throw new Error('keyDigest 가 비어 있다');
  return [{
    op: 'put',
    kind: 'certificate',
    key,
    body: {
      materialRef: body.materialRef,
      chainDigest: body.chainDigest,
      keyDigest: body.keyDigest,
    },
  }];
}

export type PutSniBindingOp = {
  op: 'put';
  kind: 'sniBinding';
  key: string;
  body: { listener: string; hosts: string[]; certificate: string };
};

/**
 * HTTPS 호스트에 제시할 인증서. 라우트에 붙이지 않는다 — handshake 는 SNI 다.
 * override 는 안 붙인다.
 */
export function putSniBindingPatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  certificate: string;
}): PutSniBindingOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  if (input.certificate === '') throw new Error('인증서가 비어 있다');
  const hosts = input.hosts.map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) throw new Error('호스트가 비어 있다');
  return [{
    op: 'put',
    kind: 'sniBinding',
    key: input.key,
    body: { listener: input.listener, hosts, certificate: input.certificate },
  }];
}

export type PutPassthroughListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'tls_passthrough';
    bind: string;
    port: number;
    enabled: true;
    onUnmatchedSni?: { pool: string };
  };
};

/**
 * TLS 패스스루. 인증서를 제시하지 않는다 — tls 를 안 붙인다.
 * 기본 풀은 없다. 라우트가 목적지를 가른다.
 * unmatched SNI 만 풀로 보낼 수 있다. 부재·파싱 실패는 설정 대상이 아니다.
 * PROXY 수신은 trustedCidrs 가 없어서 안 켠다.
 */
export function putPassthroughListenerPatch(
  key: string,
  body: { bind: string; port: number; pool?: string },
): PutPassthroughListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  const pool = body.pool?.trim();
  const patchBody: PutPassthroughListenerOp['body'] = {
    protocol: 'tls_passthrough',
    bind: body.bind,
    port: body.port,
    enabled: true,
  };
  if (pool !== undefined && pool !== '') patchBody.onUnmatchedSni = { pool };
  return [{ op: 'put', kind: 'listener', key, body: patchBody }];
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
    action: { kind: 'proxy'; pool: string; websocket: boolean };
  };
};

/**
 * 호스트 → 풀 proxy. websocket 은 기본이 끈다 — 켜려면 명시한다.
 * redirect 는 putHttpRedirectPatch. reject 는 putHttpRejectPatch.
 */
export function putHttpRoutePatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  pool: string;
  pathPrefix?: string;
  priority?: number;
  websocket?: boolean;
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
    action: { kind: 'proxy', pool: input.pool, websocket: input.websocket === true },
  };
  if (pathPrefix !== undefined && pathPrefix !== '') body.pathPrefix = pathPrefix;
  return [{ op: 'put', kind: 'httpRoute', key: input.key, body }];
}

export type RedirectStatus = 301 | 302 | 307 | 308;

const REDIRECT_STATUSES: readonly RedirectStatus[] = [301, 302, 307, 308];

export type PutHttpRedirectOp = {
  op: 'put';
  kind: 'httpRoute';
  key: string;
  body: {
    listener: string;
    hosts: string[];
    priority: number;
    pathPrefix?: string;
    action: { kind: 'redirect'; to: string; status: RedirectStatus };
  };
};

/**
 * 호스트 → URL redirect. pool·websocket 을 안 붙인다.
 * reject 는 putHttpRejectPatch. 기본 상태는 302.
 */
export function putHttpRedirectPatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  to: string;
  status?: RedirectStatus;
  pathPrefix?: string;
  priority?: number;
}): PutHttpRedirectOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  const to = input.to.trim();
  if (to === '') throw new Error('대상이 비어 있다');
  const hosts = input.hosts.map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) throw new Error('호스트가 비어 있다');
  const status = Number(input.status ?? 302) as RedirectStatus;
  if (!REDIRECT_STATUSES.includes(status)) {
    throw new Error('status 가 301|302|307|308 이 아니다');
  }
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  const pathPrefix = input.pathPrefix?.trim();
  const body: PutHttpRedirectOp['body'] = {
    listener: input.listener,
    hosts,
    priority,
    action: { kind: 'redirect', to, status },
  };
  if (pathPrefix !== undefined && pathPrefix !== '') body.pathPrefix = pathPrefix;
  return [{ op: 'put', kind: 'httpRoute', key: input.key, body }];
}

export type RejectStatus = 403 | 404 | 444;

const REJECT_STATUSES: readonly RejectStatus[] = [403, 404, 444];

export type PutHttpRejectOp = {
  op: 'put';
  kind: 'httpRoute';
  key: string;
  body: {
    listener: string;
    hosts: string[];
    priority: number;
    pathPrefix?: string;
    action: { kind: 'reject'; status: RejectStatus };
  };
};

/**
 * 호스트 → 상태 코드. to·pool·websocket 을 안 붙인다.
 * 444 는 응답 없이 끊는다. 기본은 403.
 */
export function putHttpRejectPatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  status?: RejectStatus;
  pathPrefix?: string;
  priority?: number;
}): PutHttpRejectOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  const hosts = input.hosts.map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) throw new Error('호스트가 비어 있다');
  const status = Number(input.status ?? 403) as RejectStatus;
  if (!REJECT_STATUSES.includes(status)) {
    throw new Error('status 가 403|404|444 이 아니다');
  }
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  const pathPrefix = input.pathPrefix?.trim();
  const body: PutHttpRejectOp['body'] = {
    listener: input.listener,
    hosts,
    priority,
    action: { kind: 'reject', status },
  };
  if (pathPrefix !== undefined && pathPrefix !== '') body.pathPrefix = pathPrefix;
  return [{ op: 'put', kind: 'httpRoute', key: input.key, body }];
}

export type PutPassthroughRouteOp = {
  op: 'put';
  kind: 'passthroughRoute';
  key: string;
  body: {
    listener: string;
    snis: string[];
    priority: number;
    action: { kind: 'proxy'; pool: string };
  };
};

/**
 * SNI → TCP 풀 proxy. TLS 를 종단하지 않으므로 websocket·path·status 가 없다.
 * reject 는 putPassthroughRejectPatch. 라우트에 인증서를 안 붙인다 — handshake 는 백엔드다.
 */
export function putPassthroughRoutePatch(input: {
  key: string;
  listener: string;
  snis: readonly string[];
  pool: string;
  priority?: number;
}): PutPassthroughRouteOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  if (input.pool === '') throw new Error('풀이 비어 있다');
  const snis = input.snis.map((s) => s.trim()).filter((s) => s !== '');
  if (snis.length === 0) throw new Error('SNI 가 비어 있다');
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'passthroughRoute',
    key: input.key,
    body: {
      listener: input.listener,
      snis,
      priority,
      action: { kind: 'proxy', pool: input.pool },
    },
  }];
}

export type PutPassthroughRejectOp = {
  op: 'put';
  kind: 'passthroughRoute';
  key: string;
  body: {
    listener: string;
    snis: string[];
    priority: number;
    action: { kind: 'reject' };
  };
};

/**
 * SNI → 끊기. HTTP status 가 없다 — handshake 를 종단하지 않으므로.
 * pool·websocket·path 를 안 붙인다.
 */
export function putPassthroughRejectPatch(input: {
  key: string;
  listener: string;
  snis: readonly string[];
  priority?: number;
}): PutPassthroughRejectOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  const snis = input.snis.map((s) => s.trim()).filter((s) => s !== '');
  if (snis.length === 0) throw new Error('SNI 가 비어 있다');
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'passthroughRoute',
    key: input.key,
    body: {
      listener: input.listener,
      snis,
      priority,
      action: { kind: 'reject' },
    },
  }];
}
