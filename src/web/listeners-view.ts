/**
 * Listeners 화면이 읽는 값 — DESIGN.md §10
 *
 * GET /api/v1/listeners 는 **head 모델**이다. 커밋됐지만 아직 적용되지 않은
 * plan 이 있으면, 그 목록은 이미 미래다. 엔진에 아직 있는 소켓은 impact 의
 * removed 로만 보인다. 충돌 판정은 검증기의 몫이다 — 여기서 다시 재지 않는다.
 */
export type ListenerFact = {
  key: string;
  protocol: string;
  bind: string;
  port: number;
  enabled?: boolean;
  /** 출발지 제한 (2026-10-29). 없으면 누구나. */
  sourceAllow?: string[];
};

export type SocketDelta = { added: string[]; removed: string[] };

export type ListenerMark = 'stay' | 'join' | 'leave';

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
  const current = new Set(listeners.map(socketOf));
  const rows: ListenerRow[] = listeners.map((l) => {
    const socket = socketOf(l);
    return {
      key: l.key,
      protocol: l.protocol,
      bind: l.bind,
      port: l.port,
      enabled: l.enabled !== false,
      socket,
      mark: added.has(socket) ? 'join' : 'stay',
      sourceAllow: l.sourceAllow ?? [],
    };
  });
  for (const socket of pending?.removed ?? []) {
    if (current.has(socket)) continue;
    const parsed = parseSocket(socket);
    rows.push({
      key: parsed.key,
      protocol: parsed.protocol,
      bind: parsed.bind,
      port: parsed.port,
      enabled: true,
      socket,
      mark: 'leave',
      sourceAllow: [],
    });
  }
  rows.sort((a, b) => a.port - b.port || a.key.localeCompare(b.key) || a.socket.localeCompare(b.socket));
  return { rows };
}

function parseSocket(socket: string): {
  key: string; protocol: string; bind: string; port: number;
} {
  const protocol = socket.startsWith('udp://') ? 'udp' : 'tcp';
  const rest = socket.replace(/^(tcp|udp):\/\//, '');
  const cut = rest.lastIndexOf(':');
  if (cut < 0) return { key: socket, protocol, bind: rest, port: 0 };
  const bind = rest.slice(0, cut);
  const port = Number(rest.slice(cut + 1));
  return {
    key: socket,
    protocol,
    bind,
    port: Number.isFinite(port) ? port : 0,
  };
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
    add('기본 동작', outcome(http?.['defaultAction']) ?? '거절');
  }
  if (protocol === 'https') {
    const tls = typeof m['tls'] === 'object' && m['tls'] !== null ? m['tls'] as Record<string, unknown> : {};
    add('TLS 정책', typeof tls['policy'] === 'string' ? tls['policy'] : undefined);
    add('기본 인증서', typeof tls['defaultCertificate'] === 'string' ? tls['defaultCertificate'] : undefined);
    add('HTTP/2', m['http2'] === true ? '켜짐' : '꺼짐');
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
