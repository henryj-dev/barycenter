/**
 * DP 쪽 `FsEffects` 를 **한 자리에서** 만든다 (DESIGN.md §3.1 · §6.5)
 *
 * `barycenterd`(로컬 드라이버)와 `bary-dp-agent`(원격 창구)가 **같은 부작용**을 써야
 * 한다. 둘이 각자 만들면 한쪽만 고치는 날이 오고, 그 차이는 "원격 배포에서만 reload
 * 가 안 걸린다" 처럼 나중에 드러난다 — 이 저장소가 `parseListenerOptions` 를 한 자리로
 * 모은 것과 같은 판단이다.
 *
 * ── 여기 있는 넷이 왜 이렇게 생겼는가
 *
 *   `pushMembership`   **쓰고 나서 되읽어 대조한다.** `nginx -t` 는 Lua 를 하나도
 *                      검증하지 않으므로(E64) admin 조각이 깨져 있어도 게시 전 검사와
 *                      활성화 판정을 그대로 통과한다. 되읽기가 그 경로가 살아 있다는
 *                      유일한 증거다.
 *   `reload`           **실패는 진짜 실패다.** 여기서 삼키면 활성화 판정이 타임아웃까지
 *                      늘어진다.
 *   `probeAccepting`   세대에 **구워진 리터럴**을 읽는다 (§6.3-4). 이게 활성화의 양성
 *                      신호다.
 *   `configTest`       게시 전 `nginx -t`. 없으면 manifest 대조만 하고 넘어간다 —
 *                      **못 본 것과 실패한 것은 다르므로** 막지는 않되 그만큼 늦게 발견한다.
 */
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { adminFetch, adminTalk } from '../control/admin-client.js';
import { encodeSlots, resolveSlots } from '../control/membership.js';
import { FsEffects } from './effects-fs.js';

const run = promisify(execFile);

export type EffectsBootOptions = {
  prefix: string;
  adminSocket: string;
  streamAdminSocket: string;
  /** 없으면 `process.env` 를 본다. 테스트가 갈아 끼운다. */
  env?: NodeJS.ProcessEnv;
};

/** http 평면 admin 에 적재하고 되읽는다. **유닉스 소켓이다** (검수 S-08b). */
async function pushHttp(socket: string, epoch: string, body: string): Promise<string> {
  const call = adminFetch(socket);
  const write = await call(`http://admin/membership?epoch=${encodeURIComponent(epoch)}`, {
    method: 'POST', body, signal: AbortSignal.timeout(5000),
  });
  if (!write.ok) throw new Error(`멤버십 적재 실패 (http ${write.status}): ${await write.text()}`);
  const read = await call(
    `http://admin/membership/read?epoch=${encodeURIComponent(epoch)}`,
    { signal: AbortSignal.timeout(5000) });
  return (await read.text()).trim();
}

/**
 * stream 평면에 슬롯을 밀고 **되읽는다.**
 *
 * 전송은 `adminTalk` 이 진다 — 드레인의 `inflight` 창구와 같은 소켓·같은 문법이라
 * 클라이언트를 둘로 두면 한쪽만 고치는 날이 온다.
 */
async function pushStream(socket: string, epoch: string, body: string): Promise<string> {
  const talk = adminTalk(socket);
  const wrote = await talk(`${epoch} write\n${body}\n\n`);
  if (!wrote.startsWith('staged ')) throw new Error(`stream 멤버십 적재 실패: ${wrote.trim()}`);
  return (await talk(`${epoch} read\n`)).trim();
}

export function bootEffects(opts: EffectsBootOptions): FsEffects {
  const { prefix, adminSocket, streamAdminSocket } = opts;
  const env = opts.env ?? process.env;

  const pushMembership = async (
    plane: 'http' | 'stream', epoch: string, slots: Record<string, string[]>,
  ): Promise<void> => {
    const want = encodeSlots(await resolveSlots(slots));
    const got = plane === 'http'
      ? await pushHttp(adminSocket, epoch, want)
      : await pushStream(streamAdminSocket, epoch, want);
    if (got !== want) {
      throw new Error(
        `멤버십 적재를 되읽었더니 다르다 (${plane}, epoch ${epoch}).\n`
        + `  보낸 것: ${JSON.stringify(want)}\n  읽은 것: ${JSON.stringify(got)}`);
    }
  };

  return new FsEffects({
    prefix,
    pushMembership,
    reload: async () => {
      const cmd = env['BARY_RELOAD_CMD'];
      if (cmd !== undefined) {
        await run('/bin/sh', ['-c', cmd]);
        return;
      }
      const pid = readFileSync(`${prefix}/logs/nginx.pid`, 'utf8').trim();
      process.kill(Number(pid), 'SIGHUP');
    },
    probeAccepting: async () => {
      try {
        const r = await adminFetch(adminSocket)('http://admin/generation', {
          signal: AbortSignal.timeout(2000),
        });
        return r.ok ? (await r.text()).trim() : undefined;
      } catch {
        return undefined;
      }
    },
    ...(env['BARY_CONFIGTEST_CMD'] === undefined ? {} : {
      configTest: async (generation: string): Promise<boolean> => {
        try {
          await run('/bin/sh', ['-c',
            (env['BARY_CONFIGTEST_CMD'] ?? '').replace(/\{generation\}/g, generation)]);
          return true;
        } catch {
          return false;
        }
      },
    }),
  });
}
