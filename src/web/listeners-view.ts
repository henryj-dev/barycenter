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
