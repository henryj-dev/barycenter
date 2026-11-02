/**
 * **systemd 가 넘겨준 리슨 소켓** (2026-11-02, 소켓 활성화).
 *
 * 배포마다 `barycenterd` 가 1–2 초 다시 떴고, 그 사이 관리 화면 요청이 502 를 받았다(엔진은 그대로다). `barycenterd.socket` 이
 * API 포트를 들고 있으면, 재시작하는 동안 들어온 연결은 거절되지 않고 커널 대기열에서 기다린다 — 새 프로세스가 받는다.
 *
 * 계약(sd_listen_fds): `LISTEN_PID` 가 내 pid 이고 `LISTEN_FDS` 가 개수다. fd 는 3 부터다. 우리는 하나만 받는다 — API 소켓.
 * 둘 이상이면 어느 것이 무엇인지 모르므로 던진다(유닛을 잘못 쓴 것이다). 읽은 뒤에는 환경에서 지운다 — 자식 프로세스가
 * 자기 것으로 오해하지 않게.
 *
 * 없으면 `undefined` 다 — 지금처럼 `BARY_LISTEN` 을 직접 연다(OpenRC · 도커 · 손으로 띄운 경우).
 */
export const SD_LISTEN_FDS_START = 3;

export function takeSystemdListenFd(env: NodeJS.ProcessEnv, pid: number): number | undefined {
  const fds = env['LISTEN_FDS'];
  const owner = env['LISTEN_PID'];
  if (fds === undefined || owner === undefined) return undefined;
  delete env['LISTEN_FDS'];
  delete env['LISTEN_PID'];
  delete env['LISTEN_FDNAMES'];
  if (owner !== String(pid)) return undefined;
  const n = Number(fds);
  if (!Number.isInteger(n) || n < 1) return undefined;
  if (n > 1) throw new Error(`systemd 가 리슨 소켓 ${n} 개를 넘겼다 — barycenterd.socket 에는 API 소켓 하나만 둔다`);
  return SD_LISTEN_FDS_START;
}
