/**
 * 검수 2026-08-22 · S-08b 후속 — **유닉스 소켓은 죽어도 파일이 남는다**
 *
 * admin 표면을 TCP 에서 유닉스 소켓으로 옮기면서 **새 실패 모양을 하나 들여왔다.**
 * e2e 가 잡았다: `docker restart` 뒤 재기동이 통째로 실패했고, 재기동에 기대는 테스트
 * 10 개가 연쇄로 깨졌다.
 *
 * TCP 포트는 프로세스가 죽으면 커널이 거둔다. **유닉스 소켓은 파일이라 남는다.**
 * nginx 는 우아하게 끝날 때 자기 소켓을 지우지만 `docker restart`/`SIGKILL` 에는 그
 * 기회가 없고, 다음 nginx 가 그 경로에 bind 하지 못한다 — 엔진이 안 뜨면 데몬은
 * HUP 보낼 곳이 없다.
 *
 * ── 왜 그냥 지우면 안 되나
 *
 * 데몬만 재기동하는 경로가 따로 있다(컨테이너는 그대로, `exec node barycenterd.js`).
 * 그때 nginx 는 **살아서 그 소켓을 듣고 있다.** 무조건 지우면 도는 엔진의 admin 평면을
 * 우리가 끊는 것이고, 그건 고치려던 것보다 나쁘다.
 *
 * **붙어 보고 정한다.** 누가 듣고 있으면 손대지 않고, 거절당하면 시체다.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { clearStaleSockets } from '../../src/control/admin-client.js';

const dir = mkdtempSync(join(tmpdir(), 'bary-sock-'));
const opened: import('node:net').Server[] = [];

afterEach(() => {
  for (const s of opened.splice(0)) s.close();
});

describe('죽은 소켓 파일을 치운다 (검수 S-08b 후속)', () => {
  it('아무도 안 듣는 소켓 파일은 지운다', async () => {
    // 진짜 소켓을 만들고 닫으면 파일이 남는다 — `docker restart` 뒤의 상태 그대로다.
    const path = join(dir, 'dead.sock');
    await new Promise<void>((resolve) => {
      const s = createServer();
      s.listen(path, () => s.close(() => resolve()));
    });
    // 닫으면서 지워졌을 수 있으니 확실히 남겨 둔다.
    if (!existsSync(path)) writeFileSync(path, '');

    await clearStaleSockets([path]);
    expect(existsSync(path)).toBe(false);
  });

  it('누가 듣고 있으면 손대지 않는다', async () => {
    /**
     * 여기가 요점이다. 데몬만 재기동하는 경로에서는 nginx 가 살아서 이 소켓을 듣는다.
     * 무조건 지우면 도는 엔진의 admin 평면을 우리가 끊는다.
     */
    const path = join(dir, 'live.sock');
    const server = createServer((c) => c.end());
    opened.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));

    await clearStaleSockets([path]);
    expect(existsSync(path)).toBe(true);
  });

  it('없는 경로는 그냥 지난다', async () => {
    await expect(clearStaleSockets([join(dir, 'nope.sock')])).resolves.toBeUndefined();
  });

  it('소켓이 아닌 파일도 살아 있지 않으면 치운다', async () => {
    // 소켓 자리에 소켓이 아닌 것이 있으면 nginx 는 어차피 bind 를 못 한다.
    // "붙어 보고 거절당했다" 는 판정이 그 경우도 덮는다.
    const path = join(dir, 'junk.sock');
    writeFileSync(path, 'not a socket');
    await clearStaleSockets([path]);
    expect(existsSync(path)).toBe(false);
  });
});
