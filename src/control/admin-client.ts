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
import { request } from 'node:http';

/**
 * 이 소켓에 붙는 `fetch`.
 *
 * URL 의 host 는 **무시한다** — 전송을 정하는 것은 소켓 경로다. 부르는 쪽은
 * `http://admin/membership?...` 처럼 아무 호스트나 써도 되고, 그 자리에 무엇이 오든
 * 다른 곳으로 나가지 않는다. 그게 이 함수가 주는 보장이다.
 */
export function adminFetch(socketPath: string): typeof fetch {
  return async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input.toString());
    const body = init?.body === undefined || init.body === null
      ? undefined
      : Buffer.from(String(init.body));

    return new Promise<Response>((resolve, reject) => {
      const req = request(
        {
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
