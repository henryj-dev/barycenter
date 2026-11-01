/**
 * Listeners 화면이 읽는 값 — DESIGN.md §10
 *
 * GET /api/v1/listeners 는 **head 모델**이다. 목록은 head 의 리스너만 그린다 —
 * 지금 서빙 중이거나 적용하면 그렇게 될 것만 (2026-11-01). 삭제했거나 꺼서 적용하면
 * 닫힐 소켓은 따로 행을 만들지 않는다. 그 변경은 적용 대기 화면의 영향 목록이 보여 준다.
 * 충돌 판정은 검증기의 몫이다 — 여기서 다시 재지 않는다.
 */
export type ListenerFact = {
  key: string;
  protocol: string;
  bind: string;
  port: number;
  enabled?: boolean;
  /** 출발지 제한 (2026-10-29). 없으면 누구나. */
  sourceAllow?: string[];
  /** HTTPS 의 평문 리다이렉트 (2026-10-31). 같은 바인드의 이 포트에 소켓을 하나 더 연다. */
  httpRedirect?: { port: number };
};

/** impact 의 socketsAdded. 닫힐 소켓(removed)은 목록이 안 쓴다. */
export type SocketDelta = { added: string[] };

/** stay = 서빙 중 · join = 적용하면 열림 · off = 꺼져 있어 열지 않음. */
export type ListenerMark = 'stay' | 'join' | 'off';

export type ListenerRow = {
  key: string;
  protocol: string;
  bind: string;
  port: number;
  enabled: boolean;
  socket: string;
  mark: ListenerMark;
  /** 빈 배열 = 제한 없음. 화면이 「출발지 N개만」 을 그린다. */
  sourceAllow: string[];
  /**
   * HTTPS 리스너가 함께 여는 리다이렉트 소켓 (2026-11-01). 리스너가 아니라서 따로 행을 안 만들고 이 행에 붙인다.
   * 이 소켓만 새로 열려도 행은 「적용하면 열림」 이다 — 전에는 그 소켓이 목록 어디에도 안 보였다.
   */
  redirect?: { port: number; socket: string };
};

export type ListenersView = {
  rows: ListenerRow[];
};

/** impact.socketChanges 와 같은 모양. 두 자리가 갈리면 화면이 거짓을 그린다. */
export function socketOf(l: { protocol: string; bind: string; port: number }): string {
  return `${l.protocol === 'udp' ? 'udp' : 'tcp'}://${l.bind}:${l.port}`;
}

export function viewOfListeners(
  listeners: readonly ListenerFact[],
  pending?: SocketDelta,
): ListenersView {
  const added = new Set(pending?.added ?? []);
  const redirectOf = (l: ListenerFact): { port: number; socket: string } | undefined =>
    l.protocol === 'https' && l.httpRedirect !== undefined
      ? { port: l.httpRedirect.port, socket: socketOf({ protocol: 'http', bind: l.bind, port: l.httpRedirect.port }) }
      : undefined;
  const rows: ListenerRow[] = listeners.map((l) => {
    const socket = socketOf(l);
    const redirect = redirectOf(l);
    return {
      key: l.key,
      protocol: l.protocol,
      bind: l.bind,
      port: l.port,
      enabled: l.enabled !== false,
      socket,
      mark: l.enabled === false ? 'off'
        : added.has(socket) || (redirect !== undefined && added.has(redirect.socket)) ? 'join' : 'stay',
      sourceAllow: l.sourceAllow ?? [],
      ...(redirect === undefined ? {} : { redirect }),
    };
  });
  rows.sort((a, b) => a.port - b.port || a.key.localeCompare(b.key) || a.socket.localeCompare(b.socket));
  return { rows };
}

/**
 * **리스너 상세** — `/traffic/listener/<key>` 가 그리는 줄 (2026-10-30).
 *
 * head 모델의 리스너 하나를 사람이 읽는 줄로 편다. 프로토콜마다 칸이 다르다. 여기서 안 편
 * 칸도 화면은 「전체 정의」로 그대로 보여 준다 — 모르는 칸을 숨기지 않는다.
 */
export type ListenerDetailLine = { label: string; value: string };

const outcome = (v: unknown): string | undefined => {
  if (v === 'reject') return '거절';
  if (typeof v === 'object' && v !== null && typeof (v as { pool?: unknown }).pool === 'string') {
    return `풀 ${(v as { pool: string }).pool}`;
  }
  return undefined;
};

export function detailOfListener(m: Readonly<Record<string, unknown>>): ListenerDetailLine[] {
  const lines: ListenerDetailLine[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined && value !== '') lines.push({ label, value });
  };
  const protocol = typeof m['protocol'] === 'string' ? m['protocol'] : '?';
  add('프로토콜', protocol);
  add('바인드', `${String(m['bind'])}:${String(m['port'])}`);
  add('켜짐', m['enabled'] === false ? '꺼짐 — 소켓을 안 연다' : '켜짐');
  const allow = Array.isArray(m['sourceAllow']) ? m['sourceAllow'] as string[] : [];
  add('출발지 제한', allow.length === 0 ? '없음 (누구나)' : allow.join(', '));
  const http = typeof m['http'] === 'object' && m['http'] !== null ? m['http'] as Record<string, unknown> : undefined;
  if (protocol === 'http' || protocol === 'https') {
    // ADR-VHOST — 호스트가 없으면 그 포트의 기본 리스너다(맞는 이름이 없는 요청도 받는다).
    const hosts = Array.isArray(m['hosts']) ? m['hosts'] as string[] : [];
    add('호스트', hosts.length === 0 ? '없음 — 이 포트의 기본 리스너' : hosts.join(', '));
    add('기본 동작', outcome(http?.['defaultAction']) ?? '거절');
  }
  if (protocol === 'https') {
    const tls = typeof m['tls'] === 'object' && m['tls'] !== null ? m['tls'] as Record<string, unknown> : {};
    add('TLS 정책', typeof tls['policy'] === 'string' ? tls['policy'] : undefined);
    add('기본 인증서', typeof tls['defaultCertificate'] === 'string' ? tls['defaultCertificate'] : undefined);
    add('HTTP/2', m['http2'] === true ? '켜짐' : '꺼짐');
    const rd = typeof m['httpRedirect'] === 'object' && m['httpRedirect'] !== null ? m['httpRedirect'] as { port?: unknown } : undefined;
    add('HTTP 리다이렉트', rd === undefined ? '꺼짐' : `켜짐 — :${String(rd.port)} 의 평문 요청을 HTTPS 로 301`);
  }
  if (protocol === 'tcp' || protocol === 'udp') {
    add('기본 풀', typeof m['defaultPool'] === 'string' ? m['defaultPool'] : undefined);
  }
  if (protocol === 'udp') {
    const udp = typeof m['udp'] === 'object' && m['udp'] !== null ? m['udp'] as Record<string, unknown> : {};
    add('프리셋', typeof udp['preset'] === 'string' ? udp['preset'] : undefined);
  }
  if (protocol === 'tls_passthrough') {
    add('SNI 매칭 없음', outcome(m['onUnmatchedSni']) ?? '거절');
    add('SNI 없음', outcome(m['onNoSni']) ?? '거절');
    add('preread 타임아웃', typeof m['prereadTimeoutS'] === 'number' ? `${m['prereadTimeoutS']}s` : undefined);
  }
  add('PROXY 수신', m['acceptProxyProtocol'] === undefined ? undefined : '켜짐');
  return lines;
}
