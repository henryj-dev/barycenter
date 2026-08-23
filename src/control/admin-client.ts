/**
 * admin 평면 클라이언트 — **유닉스 도메인 소켓 위의 `fetch`** (검수 S-08b).
 *
 * admin 표면(`/membership` · `/acme` · `/generation`)에는 인증이 없다. 전에는 보호가
 * "루프백에만 뜬다" 하나뿐이었는데, 그건 "밖에서 못 온다" 이지 **"아무나 못 쓴다"** 가
 * 아니다 — §11.3 이 권장하는 hostNetwork 배포에서는 같은 호스트의 아무 프로세스나
 * 밸런서 슬롯을 다시 쓸 수 있었다.
 *
 * 소켓으로 옮기면 접근 통제를 OS 가 진다. 비밀이 없으므로 conf 에는 경로 리터럴만
 * 남고 `render_digest` 의 결정성이 그대로다 — 토큰을 세대에 굽는 쪽이 못 가진 성질이다.
 *
 * ── 왜 `fetch` 모양을 유지하나
 *
 * 부르는 자리가 여럿이고(`acme-runner` · `drain` · `plane` · 데몬) **그중 여럿이 테스트에서
 * `typeof fetch` 를 주입받는다.** 전송만 바꾸면서 그 주입 지점을 살려 두면 기존 테스트가
 * 그대로 계약 테스트로 남는다. 새 인터페이스를 만들었으면 그 테스트들을 전부 다시
 * 썼어야 하고, 그건 **전송을 바꾸면서 검증을 같이 바꾸는 것**이라 나쁘다.
 *
 * Node 의 전역 `fetch` 로는 유닉스 소켓에 못 간다(undici 디스패처가 필요한데 그건 공개
 * API 가 아니다). `node:http` 로 직접 만든다 — 런타임 의존성은 `pg` 하나라는 계약(§11.2)
 * 을 지킨다.
 */
import { existsSync, unlinkSync } from 'node:fs';
import { Agent, request } from 'node:http';
import { connect } from 'node:net';

/**
 * 이 소켓에 붙는 `fetch`.
 *
 * URL 의 host 는 **무시한다** — 전송을 정하는 것은 소켓 경로다. 부르는 쪽은
 * `http://admin/membership?...` 처럼 아무 호스트나 써도 되고, 그 자리에 무엇이 오든
 * 다른 곳으로 나가지 않는다. 그게 이 함수가 주는 보장이다.
 */
export function adminFetch(socketPath: string): typeof fetch {
  /**
   * **연결을 재사용하지 않는다.**
   *
   * Node 의 전역 agent 는 keep-alive 가 기본이고, 풀은 `socketPath` 로 묶인다. 그런데
   * nginx 는 놀고 있는 연결을 자기 판단으로 닫는다 — 그러면 풀에 죽은 소켓이 남고
   * 다음 호출이 `ECONNRESET` 으로 터진다. **부르는 쪽에서는 간헐 실패로 보인다.**
   *
   * 전역 `fetch`(undici)는 이 경우를 안에서 다시 걸어 준다. `http.request` 는 그렇지
   * 않으므로 여기서 원인을 없앤다.
   *
   * 대가는 호출마다 소켓 하나인데, 이 평면의 호출은 멤버십 push · 드레인 관측 · ACME
   * 적재가 전부다. 초당 수천 건이 아니다 — `health_cursor` 에서 직렬화 비용을 내고
   * 정확성을 산 것과 같은 거래다.
   */
  const agent = new Agent({ keepAlive: false });
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const body = init?.body === undefined || init.body === null
      ? undefined
      : Buffer.from(String(init.body));

    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
          agent,
          socketPath,
          method: init?.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
          headers: {
            // `Host` 는 nginx 가 server 를 고를 때 본다. admin 조각에는 server 가 하나뿐이라
            // 무엇이든 되지만, 없으면 HTTP/1.1 이 아니다.
            host: 'admin',
            ...(body === undefined ? {} : { 'content-length': String(body.length) }),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            // `Response` 를 진짜로 만든다. 흉내를 내면 `.ok` · `.text()` 의 뜻이
            // 부르는 쪽마다 미세하게 갈리고, 그 차이는 테스트가 안 잡는다.
            resolve(new Response(Buffer.concat(chunks), {
              status: res.statusCode ?? 502,
              headers: Object.entries(res.headers)
                .filter((e): e is [string, string] => typeof e[1] === 'string'),
            }));
          });
          res.on('error', reject);
        },
      );
      // **시간 제한은 부르는 쪽이 준다.** `AbortSignal.timeout` 을 이미 쓰고 있어서
      // 여기서 또 걸면 두 시계가 생기고, 어느 쪽이 끊었는지 로그로 못 가른다.
      const signal = init?.signal;
      if (signal !== null && signal !== undefined) {
        if (signal.aborted) {
          req.destroy();
          reject(new Error('admin 요청이 시작 전에 취소됐다'));
          return;
        }
        signal.addEventListener('abort', () => req.destroy(new Error('admin 요청 시간 초과')));
      }
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  };
}

/**
 * 죽은 소켓 파일을 치운다. **nginx 를 띄우기 직전에** 부른다.
 *
 * TCP 포트는 프로세스가 죽으면 커널이 거둔다. **유닉스 소켓은 파일이라 남는다.**
 * nginx 는 우아하게 끝날 때 자기 소켓을 지우지만 `docker restart`/`SIGKILL` 에는 그
 * 기회가 없고, 다음 nginx 가 그 경로에 bind 하지 못한다 — 엔진이 안 뜨면 데몬은 HUP
 * 보낼 곳이 없다. e2e 가 이걸로 10 개를 연쇄로 깼다.
 *
 * ⚠️ **무조건 지우면 안 된다.** 데몬만 재기동하는 경로에서는 nginx 가 살아서 이 소켓을
 * 듣고 있다. 그때 지우면 도는 엔진의 admin 평면을 우리가 끊는 것이고, 그건 고치려던
 * 것보다 나쁘다.
 *
 * 붙어 보고 정한다 — 누가 듣고 있으면 손대지 않고, 거절당하면 시체다. 소켓이 아닌
 * 파일도 같은 판정에 걸린다(거기에는 아무도 안 붙는다), 그리고 그 자리에 소켓이 아닌
 * 것이 있으면 nginx 는 어차피 bind 를 못 한다.
 */
export async function clearStaleSockets(paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const live = await new Promise<boolean>((resolve) => {
      const probe = connect({ path });
      // 붙었으면 산 것이다. 바로 끊는다 — 우리는 듣는 쪽이 있는지만 물었다.
      probe.on('connect', () => {
        probe.destroy();
        resolve(true);
      });
      probe.on('error', () => resolve(false));
    });
    if (live) continue;
    unlinkSync(path);
  }
}

/**
 * stream admin 과 이야기한다 — **원시 TCP** (S-08b · S2).
 *
 * stream 에는 HTTP 가 없고 두 zone 은 서로 안 보이므로(E14 · E25 · §3.4) http admin 으로
 * 대신 쓸 수 없다. `adminFetch` 와 같은 자리에 두는 이유는 하나다: **소비자가 둘이 됐다.**
 * 데몬이 슬롯을 밀고(`write`·`read`), 컨트롤 플레인이 드레인 숫자를 묻는다(`inflight`).
 * 데몬 안에 두면 컨트롤 플레인이 데몬을 import 해야 하고 그건 방향이 거꾸로다.
 *
 * `adminFetch` 가 `typeof fetch` 를 돌려주는 것과 같은 이유로 **함수를 돌려준다** —
 * 부르는 쪽이 소켓을 모르고, 테스트가 그 자리에 자기 것을 넣는다.
 */
export function adminTalk(socketPath: string, timeoutMs = 5000): (payload: string) => Promise<string> {
  return (payload: string) => new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    // `net.connect` 는 유닉스 소켓을 그대로 받는다 — http 쪽과 달리 감쌀 것이 없다.
    const s = connect({ path: socketPath });
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      reject(new Error(`stream admin 이 ${timeoutMs}ms 안에 안 답했다`));
    });
    s.on('connect', () => s.end(payload));
    s.on('data', (d: Buffer) => chunks.push(d));
    s.on('close', () => resolve(Buffer.concat(chunks).toString()));
    s.on('error', (e) => reject(e));
  });
}
