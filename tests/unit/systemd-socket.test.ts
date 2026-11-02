/**
 * **systemd 가 넘겨준 API 소켓으로 받는다** (2026-11-02, 소켓 활성화). 배포마다 데몬이 1–2 초 다시 떴고, 그 사이 관리 화면
 * 요청이 502 를 받았다. 실물로 재는 것은 설치 하네스 4-c(`tests/install/run.sh`) — 재시작 중 요청 30 번이 하나도 안 실패한다.
 */
import { describe, expect, it } from 'vitest';

import { SD_LISTEN_FDS_START, takeSystemdListenFd } from '../../src/bin/systemd-socket.js';

describe('takeSystemdListenFd', () => {
  it('**내 pid 앞으로 하나를 넘겼으면 fd 3 이다** — 읽은 뒤 환경에서 지운다', () => {
    const env: NodeJS.ProcessEnv = { LISTEN_FDS: '1', LISTEN_PID: '42', LISTEN_FDNAMES: 'barycenterd.socket' };
    expect(takeSystemdListenFd(env, 42)).toBe(SD_LISTEN_FDS_START);
    expect(env['LISTEN_FDS']).toBeUndefined();
    expect(env['LISTEN_PID']).toBeUndefined();
  });

  it('없거나 남의 pid 앞이면 직접 연다 (undefined)', () => {
    expect(takeSystemdListenFd({}, 42)).toBeUndefined();
    expect(takeSystemdListenFd({ LISTEN_FDS: '1', LISTEN_PID: '7' }, 42)).toBeUndefined();
    expect(takeSystemdListenFd({ LISTEN_FDS: '0', LISTEN_PID: '42' }, 42)).toBeUndefined();
  });

  it('둘 이상이면 던진다 — 어느 것이 API 인지 모른다', () => {
    expect(() => takeSystemdListenFd({ LISTEN_FDS: '2', LISTEN_PID: '42' }, 42)).toThrow(/하나만/);
  });
});
