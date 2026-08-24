/**
 * 소켓 예약과 겹침 검증 — DESIGN.md §4.5
 *
 * 엔진 근거 (tests/engine):
 *   E12 — TCP 와 UDP 는 같은 포트 번호를 공존시킬 수 있다.
 *   §4.5 — http / https / tls_passthrough 는 전부 transport=tcp 다. 그래서 http 컨텍스트 443 과
 *          stream 컨텍스트 443 이 충돌하는데, 프로토콜 enum 만 비교하면 이 충돌을 놓친다.
 *
 * 단순 유일 제약으로는 부족하다 — 와일드카드 대 특정 주소는 "동등"이 아니라 "겹침"이다.
 * PostgreSQL 의 일반 CHECK 는 다른 행을 참조할 수 없으므로(§4.0), 이 판정은 커밋 트랜잭션
 * 안에서 advisory lock 과 함께 도는 검증기의 몫이다.
 */
import { ipVersion } from './ip.js';
import { err, ok, type Result } from './result.js';
import type { ListenerProtocol } from '../model/provisional.js';

export type Transport = 'tcp' | 'udp';

/**
 * `BARY_LISTEN` 같은 `<host>:<port>` 를 쪼갠다 (검수 G7).
 *
 * ── 왜 `split(':')` 이 안 되나
 *
 * 데몬이 이랬다:
 *
 *   const [host, port] = env('BARY_LISTEN', '127.0.0.1:8088').split(':');
 *
 * **IPv6 를 표현할 수 없다.** `[::1]:8088` 을 콜론으로 쪼개면 host 가 `[` 가 되고
 * port 가 `` 가 된다 — `Number('')` 은 `0` 이라 **무작위 포트가 열린다.** 그리고
 * `127.0.0.1:abc` 는 `NaN` 인데, `listen(NaN)` 도 무작위 포트다.
 *
 * 둘 다 **기동이 성공한 것처럼 보이고** 그 뒤로 아무도 못 붙는다. 이 저장소가
 * 반복해서 잡는 *"경계에 해독기가 없다"* 이고, 실패가 조용한 쪽이라 더 나쁘다.
 *
 * `URL` 을 쓴다 — 대괄호 문법을 그것이 이미 안다. 직접 파싱하면 그 규칙을 두 벌로
 * 두는 셈이고, 이 저장소가 `upstreamName`(D18)에서 그것으로 물렸다.
 */
export function parseListen(spec: string): { host: string; port: number } {
  let url: URL;
  try {
    // 스킴이 필요하다. `http` 는 임의이고 여기서 쓰는 것은 호스트·포트뿐이다.
    url = new URL(`http://${spec}`);
  } catch {
    throw new Error(
      `듣는 주소 모양이 아니다: ${JSON.stringify(spec)} — <host>:<port> 나 [<ipv6>]:<port>`,
    );
  }
  // **포트가 없으면 던진다.** `URL` 은 없는 포트를 빈 문자열로 주는데, 그것을
  // `Number` 에 넣으면 `0` 이 되고 `listen(0)` 은 무작위 포트다.
  if (url.port === '') {
    throw new Error(`듣는 주소에 포트가 없다: ${JSON.stringify(spec)}`);
  }
  if (url.hostname === '') {
    throw new Error(`듣는 주소에 호스트가 없다: ${JSON.stringify(spec)}`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`포트가 1~65535 가 아니다: ${JSON.stringify(spec)}`);
  }
  // `URL` 이 IPv6 를 `[::1]` 로 돌려준다 — 대괄호를 벗겨 `listen()` 이 받는 모양으로.
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname;
  return { host, port };
}

export type BindAddress = {
  family: 'v4' | 'v6';
  addr: string;
  wildcard: boolean;
};

export type SocketReservation = {
  key: string;
  protocol: ListenerProtocol;
  bind: string;
  port: number;
};

export type SocketConflict = { a: string; b: string; reason: string };

/**
 * 이 프로토콜이 **점유하는 전송 전부**. §4.5
 *
 * ── 왜 하나가 아니라 집합인가 (S20)
 *
 * v0 의 프로토콜은 전부 전송이 하나다 — L7 은 TCP, `udp` 는 UDP. 그래서 오래
 * `transportOf(): Transport` 였고, 그것으로 http:443 ↔ stream:443 충돌이 드러났다.
 *
 * **그 모양이 h3 의 선결 조건에 걸린다.** S20 이 실측했다:
 *
 *   S20.udp_occupancy  `listen 443 quic` 은 같은 포트를 **UDP 로도** 점유한다
 *   S20.udp_conflict   그 UDP 와 `stream { listen 443 udp; }` 가 겹치면
 *                      **한쪽이 조용히 진다** — 엔진도 `nginx -t` 도 아무 말을 안 한다
 *
 * 운영자는 설정한 것이 사라진 이유를 알 수 없다. 그래서 §12.0 이 h3 를 모델에서 뺐고,
 * 그 판정의 근거가 *"§4.5 가 그 겹침을 표현하지 못한다"* 였다.
 *
 * **이제 표현한다.** 프로토콜 하나가 전송 여럿을 점유할 수 있고, 겹침은 전송이 **하나라도
 * 겹치면** 성립한다. h3 를 여는 날 이 함수에 `udp` 를 더하는 것 하나로 그 겹침이 잡힌다 —
 * 검증기·렌더·모델 어디도 다시 안 만진다.
 *
 * 지금은 어느 프로토콜도 둘을 안 낸다. **그게 맞다** — 없는 것을 있는 척하지 않는다.
 * 바뀐 것은 *"표현할 수 있는가"* 이고, 그것이 §12.0 이 막아 둔 바로 그 문이다.
 */
export function transportsOf(protocol: ListenerProtocol): readonly Transport[] {
  return protocol === 'udp' ? UDP_ONLY : TCP_ONLY;
}

const TCP_ONLY: readonly Transport[] = Object.freeze(['tcp']);
const UDP_ONLY: readonly Transport[] = Object.freeze(['udp']);

/**
 * 옛 이름. **집합의 첫 원소**를 준다.
 *
 * 전송이 하나인 동안은 같은 답이다. 둘이 되는 순간 이 함수는 **거짓말을 시작하므로**,
 * 그때는 부르는 쪽을 `transportsOf` 로 옮겨야 한다 — 아래 `sharesTransport` 처럼.
 */
export function transportOf(protocol: ListenerProtocol): Transport {
  return transportsOf(protocol)[0]!;
}

/**
 * 두 전송 집합이 **하나라도** 겹치는가.
 *
 * 프로토콜이 아니라 집합을 받는 이유는 **잴 수 있게** 하기 위해서다. 지금 모델의
 * 프로토콜은 전부 전송이 하나라, 프로토콜만 받으면 "둘을 내는 프로토콜이 왔을 때"
 * 를 재현물이 만들 수가 없다 — 그러면 이 규칙은 h3 가 들어오는 날까지 안 지켜진다.
 */
export function transportSetsOverlap(
  a: readonly Transport[], b: readonly Transport[],
): boolean {
  return b.some((t) => a.includes(t));
}

/** 두 프로토콜이 전송을 **하나라도** 공유하는가. */
export function sharesTransport(a: ListenerProtocol, b: ListenerProtocol): boolean {
  return transportSetsOverlap(transportsOf(a), transportsOf(b));
}

const V4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function normalizeBind(input: string): Result<BindAddress> {
  if (input.length === 0) return err('invalid_bind_address', '바인드 주소가 비어 있다');

  // IPv4-mapped IPv6 는 v4 로 접는다. 접지 않으면 같은 소켓을 다른 것으로 본다.
  const mapped = V4_MAPPED.exec(input);
  const candidate = mapped ? mapped[1]! : input;

  const version = ipVersion(candidate);
  if (version === 4) {
    return ok({ family: 'v4', addr: candidate, wildcard: candidate === '0.0.0.0' });
  }
  if (version === 6) {
    // WHATWG URL 파서가 압축·소문자 정규형을 준다.
    let canonical: string;
    try {
      canonical = new URL(`http://[${candidate}]`).hostname.slice(1, -1);
    } catch {
      return err('invalid_bind_address', `IPv6 주소를 정규화할 수 없다: ${input}`);
    }
    return ok({ family: 'v6', addr: canonical, wildcard: canonical === '::' });
  }
  return err('invalid_bind_address', `IP 주소가 아니다: ${JSON.stringify(input)}`);
}

/**
 * 이 바인드가 **루프백뿐인가** (검수 S-05a).
 *
 * 제어 API 에는 아직 TLS 가 없고, 그 API 로 개인키와 Bearer 토큰이 지나간다. 루프백
 * 밖에 묶는 것은 정당한 선택일 수 있지만(컨테이너에서는 필요하다) **조용히 일어나면
 * 안 되는** 선택이다.
 *
 * 와일드카드(`0.0.0.0` · `::`)는 루프백을 **포함하지만** 루프백뿐이 아니다 — 거짓이다.
 * 주소로 해석되지 않는 값도 거짓이다: 모르는 것을 안전하다고 하지 않는다.
 */
export function isLoopbackBind(input: string): boolean {
  const parsed = normalizeBind(input);
  if (!parsed.ok) return false;
  const { family, addr, wildcard } = parsed.value;
  if (wildcard) return false;
  return family === 'v4' ? addr.startsWith('127.') : addr === '::1';
}

/**
 * 두 예약이 같은 소켓을 두고 다투는가.
 *
 * **address family 를 넘는 겹침은 없다.** nginx 의 `ipv6only` 기본값은 `on` 이라
 * `[::]:p` 와 `0.0.0.0:p` 는 공존한다 — E30 으로 실측했다. v2 는 기본값을 `off` 로
 * 보고 이 둘을 충돌로 판정했고, 테스트가 그 오류를 고정하고 있었다.
 *
 * 렌더러는 이 가정을 숨기지 않기 위해 `[::]:port ipv6only=on` 을 명시적으로 낸다.
 */
export function socketsOverlap(a: SocketReservation, b: SocketReservation): boolean {
  if (a.key === b.key) return false;
  if (a.port !== b.port) return false;
  // **전송이 하나라도 겹치면 다툰다** (S20). 한 프로토콜이 둘을 점유할 수 있으므로
  // 등호 비교로는 못 잡는다 — `listen 443 quic` 의 UDP 와 `stream udp:443` 이 정확히
  // 그 경우이고, 엔진은 그때 조용히 한쪽을 버린다.
  if (!sharesTransport(a.protocol, b.protocol)) return false;

  const na = normalizeBind(a.bind);
  const nb = normalizeBind(b.bind);
  if (!na.ok || !nb.ok) return false; // 주소 자체의 오류는 별도 검증이 잡는다

  const x = na.value;
  const y = nb.value;

  if (x.family !== y.family) return false;      // ipv6only=on — family 를 넘지 않는다
  if (x.wildcard || y.wildcard) return true;    // 같은 family 안의 와일드카드는 전부 덮는다
  return x.addr === y.addr;
}

/** 결과는 입력 순서와 무관하게 결정적이다 — plan diff 가 흔들리면 안 된다. */
export function findSocketConflicts(reservations: SocketReservation[]): SocketConflict[] {
  const sorted = [...reservations].sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  const out: SocketConflict[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (socketsOverlap(a, b)) {
        out.push({
          a: a.key,
          b: b.key,
          reason: `${transportOf(a.protocol)}/${a.port} 에서 ${a.bind} 와 ${b.bind} 가 겹친다`,
        });
      }
    }
  }
  return out;
}
