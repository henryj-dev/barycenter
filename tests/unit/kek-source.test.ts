/**
 * `resolveKek` — KEK 를 어디서 받나 (§4.8.2).
 *
 * 이 이음매의 값은 **키가 `$PREFIX/env` 에 파일로 안 남는 것**이다. 그래서 실패 모양이
 * 특히 나쁘다: 조용히 잘못된 키로 뜨면 그 배포는 *"암호화된 줄 알았다"* 가 되고,
 * 그 사실은 인증서를 못 여는 날에야 드러난다.
 *
 * 설계가 정한 규칙 넷(§4.8.2)을 그대로 잰다.
 */
import { describe, expect, it } from 'vitest';

import { resolveKek } from '../../src/dp/kek-source.js';
import { KEK_BYTES } from '../../src/dp/secrets-pg.js';

/** 32 바이트. **키처럼 안 생긴 값을 쓴다** — 픽스처가 진짜 키로 읽히면 안 된다. */
const KEY = Buffer.from('이건-키가-아니라-시험용-32바이트!!').subarray(0, KEK_BYTES);
const B64 = KEY.toString('base64');

/** 명령을 실제로 안 띄운다 — 계약만 잰다. */
const says = (stdout: string, stderr = '') => async () => ({ stdout, stderr });
const dies = (stderr: string, message = 'exit 1') => async () => {
  throw Object.assign(new Error(message), { stderr });
};

describe('KEK 출처', () => {
  it('값을 그대로 주면 그 값이다 — 지금까지의 길', async () => {
    const kek = await resolveKek({ BARY_SECRET_KEK: B64 });
    expect(kek.equals(KEY)).toBe(true);
  });

  it('명령의 stdout 을 KEK 로 쓴다 — 개행은 다듬는다', async () => {
    const kek = await resolveKek(
      { BARY_SECRET_KEK_CMD: 'aws kms decrypt …' }, { run: says(`${B64}\n`) });
    expect(kek.equals(KEY)).toBe(true);
  });

  /**
   * **① 둘을 같이 주면 안 뜬다.** 한 비밀에 출처가 둘이면 어느 쪽이 이기는지가 곧
   * 사고다. 골라서 이기게 하는 것보다 거절하는 것이 낫다.
   */
  it('**둘 다 주면 거절한다** — 한 비밀의 출처는 하나다', async () => {
    await expect(resolveKek(
      { BARY_SECRET_KEK: B64, BARY_SECRET_KEK_CMD: 'echo x' },
      { run: says(B64) },
    )).rejects.toThrow(/둘 다 줬다/);
  });

  /** **② 실패하면 안 뜬다.** 지어내면 "암호화된 줄 알았다" 가 돌아온다. */
  it('명령이 죽으면 던진다', async () => {
    await expect(resolveKek(
      { BARY_SECRET_KEK_CMD: 'false' }, { run: dies('AccessDenied') },
    )).rejects.toThrow(/실패했다/);
  });

  it('명령이 빈 것을 내면 던진다 — 빈 KEK 로 뜨지 않는다', async () => {
    await expect(resolveKek(
      { BARY_SECRET_KEK_CMD: 'true' }, { run: says('  \n') },
    )).rejects.toThrow(/빈 것을 냈다/);
  });

  it('32 바이트가 아니면 던진다 — 판정은 readKek 한 자리다', async () => {
    await expect(resolveKek(
      { BARY_SECRET_KEK_CMD: 'x' }, { run: says('짧다') },
    )).rejects.toThrow(new RegExp(`${KEK_BYTES} 바이트`));
  });

  it('아무것도 안 주면 던진다', async () => {
    await expect(resolveKek({})).rejects.toThrow(/비었다/);
  });

  /**
   * **④ stdout 은 비밀이다.** 실패한 명령도 부분 출력에 비밀을 담을 수 있다.
   * 진단은 stderr 에 있고 비밀은 저쪽에 있다 — 오류 메세지가 그 선을 지켜야 한다.
   */
  it('**오류에 stdout 을 안 싣는다** — stderr 만 싣는다', async () => {
    const secret = 'SECRET-스러운-값-절대-로그에-없어야-한다';
    const err = await resolveKek(
      { BARY_SECRET_KEK_CMD: 'x' },
      { run: async () => { throw Object.assign(new Error('exit 1'), { stdout: secret, stderr: 'AccessDenied' }); } },
    ).catch((e: Error) => e);
    expect(String(err)).not.toContain(secret);
    expect(String(err)).toContain('AccessDenied');
  });

  /**
   * **명령 문자열 자체도 비밀이다.**
   *
   * 처음엔 stderr 가 비었을 때 `err.message` 를 실었다. 그건 execFile 이 만든 것이라
   * `Command failed: /bin/sh -c <명령>` 을 통째로 담는다 — 그래서
   * `BARY_SECRET_KEK_CMD='printf %s <키>'` 처럼 둔 배포에서 **키가 로그로 나갔다.**
   * CodeQL 의 `js/clear-text-logging` 이 짚었고 실물로 재현했다 (2026-09-01).
   *
   * 앞선 회차의 재현물은 **stdout 만** 봤다. 그래서 이 경로가 초록으로 남아 있었다 —
   * 비밀이 새는 길은 하나가 아니다.
   */
  it('**오류에 명령 문자열을 안 싣는다** — 명령에 키가 들어 있을 수 있다', async () => {
    // **base64 처럼 생긴 값을 안 쓴다.** gitleaks 의 `generic-api-key` 가 문다 —
    // #33 에서 같은 실수를 하고 고쳤는데 또 했다. 여기서 재는 것은 "이 문자열이 오류에
    // 실리느냐" 이지 그 값이 키로 쓸모 있느냐가 아니다.
    const secret = '이것은-명령에-박힌-값-오류에-실리면-안-된다';
    const err = await resolveKek(
      // stderr 가 **비어 있다** — 그때 무엇을 싣느냐가 이 케이스다.
      { BARY_SECRET_KEK_CMD: `printf %s ${secret}; exit 1` },
    ).catch((e: Error) => e);
    expect(String(err)).not.toContain(secret);
    expect(String(err)).not.toContain('/bin/sh');
    // 그래도 어떻게 죽었는지는 말해야 한다 — 안 그러면 진단이 사라진다.
    expect(String(err)).toMatch(/종료 코드 1/);
  });

  it('성공했지만 값이 틀렸을 때도 그 값을 안 싣는다', async () => {
    const secret = '이것은-키가-아닌-무언가-길이도-틀렸다';
    const err = await resolveKek(
      { BARY_SECRET_KEK_CMD: 'x' }, { run: says(secret) },
    ).catch((e: Error) => e);
    expect(String(err)).not.toContain(secret);
  });

  /** 상한은 **조용하지 않다** — 값이 이상하면 그렇게 말하고 죽는다. */
  it('시간 상한 값이 이상하면 던진다', async () => {
    await expect(resolveKek(
      { BARY_SECRET_KEK_CMD: 'x', BARY_SECRET_KEK_CMD_TIMEOUT_MS: '0' }, { run: says(B64) },
    )).rejects.toThrow(/TIMEOUT_MS/);
    await expect(resolveKek(
      { BARY_SECRET_KEK_CMD: 'x', BARY_SECRET_KEK_CMD_TIMEOUT_MS: '이건 숫자가 아니다' },
      { run: says(B64) },
    )).rejects.toThrow(/TIMEOUT_MS/);
  });

  it('시간 상한을 명령에 그대로 넘긴다', async () => {
    let seen = 0;
    await resolveKek(
      { BARY_SECRET_KEK_CMD: 'x', BARY_SECRET_KEK_CMD_TIMEOUT_MS: '30000' },
      { run: async (_cmd, ms) => { seen = ms; return { stdout: B64, stderr: '' }; } },
    );
    expect(seen).toBe(30_000);
  });

  /**
   * **실제로 셸을 띄운다.** 위의 케이스들은 러너를 갈아 끼워 계약만 쟀다 — 그러면
   * `/bin/sh -c` 배선 자체가 깨져도 전부 초록이다. 이음매의 요점이 거기이므로 한 번은
   * 진짜로 돌린다.
   */
  it('기본 러너가 진짜로 명령을 돌린다', async () => {
    const kek = await resolveKek({ BARY_SECRET_KEK_CMD: `printf %s ${B64}` });
    expect(kek.equals(KEY)).toBe(true);
  });

  it('진짜 명령이 죽으면 stderr 를 싣는다', async () => {
    const err = await resolveKek(
      { BARY_SECRET_KEK_CMD: 'echo AccessDenied >&2; exit 7' },
    ).catch((e: Error) => e);
    expect(String(err)).toContain('AccessDenied');
  });

  /** **③ 기동에 한 번만 부른다.** 자료마다 부르면 실패 표면이 통째로 넓어진다. */
  it('한 번 부른다', async () => {
    let calls = 0;
    await resolveKek(
      { BARY_SECRET_KEK_CMD: 'x' },
      { run: async () => { calls += 1; return { stdout: B64, stderr: '' }; } },
    );
    expect(calls).toBe(1);
  });
});
