/**
 * KEK 를 **어디서 받나** (§4.8.2).
 *
 * §4.8.1 의 표가 KEK 를 *"env(`BARY_SECRET_KEK`) 또는 KMS"* 라 적고 뒤쪽을 비워 뒀다.
 * 여기가 그 자리다 — 그리고 **벤더 SDK 가 아니라 이음매**로 채운다:
 *
 *     BARY_SECRET_KEK        값을 그대로 준다
 *     BARY_SECRET_KEK_CMD    명령을 돌려 그 stdout 을 KEK 로 쓴다
 *
 * 한 줄이면 무엇이든 붙는다 — `aws kms decrypt`, `vault read`, `gcloud kms decrypt`,
 * `systemd-creds cat`, TPM 을 읽는 스크립트. SDK 를 하나 들이면 그 벤더를 안 쓰는
 * 배포도 그 코드와 공급망을 진다. `BARY_RELOAD_CMD`·`BARY_CONFIGTEST_CMD` 와 같은 모양이다.
 *
 * 얻는 것: `BARY_SECRET_KEK` 이면 키가 `$PREFIX/env`(0640)에 **파일로 남는다.**
 * `_CMD` 면 기동 때 한 번 가져와 **메모리에만** 있다.
 *
 * **계정 KEK(`BARY_ACCOUNTS_KEK` · `_FILE` · `_CMD`)도 같은 코드를 지난다** — `resolveKeyFrom` 에 출처 규칙
 * (`KeySource`: 이름 · 값 읽는 규칙 · 오류 문구)만 바꿔 끼운다. 인증서 KEK 의 이름 · 판정 · 문구는 그대로다.
 */
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';

import { KEK_BYTES, readKek } from './secrets-pg.js';

const execFileAsync = promisify(execFile);

/** 명령을 돌리는 창구. **테스트가 갈아 끼운다** — 셸을 띄우지 않고 계약만 잰다. */
export type KekRunner = (cmd: string, timeoutMs: number) => Promise<{ stdout: string; stderr: string }>;

/**
 * 기본 상한 10 초. **조용한 상한을 안 만든다** — `BARY_SECRET_KEK_CMD_TIMEOUT_MS` 로
 * 늘릴 수 있다. 상한 자체가 필요한 이유는, KMS 가 안 답하는 날 기동이 영원히 매달리면
 * 그건 「안 뜬다」가 아니라 **「떴는지 모른다」**이고 그 둘을 섞지 않는 것이 이 저장소의
 * 규칙이기 때문이다 (§6.2).
 */
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * **출력에 상한을 건다.** KEK 는 base64 로 44 자다. 명령이 폭주해 기가바이트를 뱉으면
 * 그것을 다 모으는 것 자체가 사고다.
 */
const MAX_OUTPUT = 64 * 1024;

const defaultRunner: KekRunner = async (cmd, timeoutMs) => {
  const r = await execFileAsync('/bin/sh', ['-c', cmd], {
    timeout: timeoutMs,
    maxBuffer: MAX_OUTPUT,
    encoding: 'utf8',
  });
  return { stdout: r.stdout, stderr: r.stderr };
};

/**
 * 키 하나의 **출처 규칙** — 무엇을 어떤 이름으로 받고, 값을 어떻게 키로 읽는가.
 *
 * 인증서 저장소 KEK(`BARY_SECRET_KEK`)와 계정 KEK(`BARY_ACCOUNTS_KEK`)가 **같은 코드**를 지난다 —
 * 「둘 이상 주면 거절」·「명령 실패에 stdout · 명령을 안 싣는다」·「출력 상한」·「시간 상한」이 한 자리다.
 * 다른 것은 이름과 오류 문구, 그리고 값을 키로 읽는 규칙(`parse`)뿐이다.
 */
export type KeySource = {
  /** 값을 그대로 주는 env 이름. `<name>_CMD` · `<name>_CMD_TIMEOUT_MS` · (`file` 이면) `<name>_FILE` 이 따라온다. */
  name: string;
  /** `<name>_FILE` 을 받는가. 인증서 KEK 는 받지 않는다(회전 도구 `rotate-kek.mjs` 가 값 · 명령만 안다). */
  file: boolean;
  /** 값 → 키. 길이 · 인코딩 판정과 그 오류 문구가 여기 있다. 던지면 기동이 거부된다. */
  parse: (raw: string) => Buffer;
  /** 명령 실패 문구 뒤에 붙는 「그래서 무엇이 안 뜨는가」. */
  needs: string;
  /** 명령이 빈 것을 냈을 때 붙는 형식 안내. */
  shape: string;
  /** 아무것도 안 줬을 때. 없으면 `parse('')` 가 안내를 든다(인증서 KEK 의 지금 동작). */
  missing?: string;
};

/** `<name>_FILE` 의 상한 — 명령 출력과 같다. 키 파일이 기가바이트일 일은 없다. */
const MAX_FILE = MAX_OUTPUT;

/** 인증서 저장소 KEK (§4.8.2). 판정 · 문구는 지금 그대로다. */
export const SECRET_KEK_SOURCE: KeySource = {
  name: 'BARY_SECRET_KEK',
  file: false,
  parse: readKek,
  needs: 'KEK 없이 pg 시크릿 백엔드는 안 뜬다 (§4.8.2)',
  shape: `${KEK_BYTES} 바이트, base64 또는 hex`,
};

function timeoutFrom(env: NodeJS.ProcessEnv, name: string): number {
  const key = `${name}_CMD_TIMEOUT_MS`;
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_TIMEOUT_MS || n > MAX_TIMEOUT_MS) {
    throw new Error(
      `${key} 가 ${MIN_TIMEOUT_MS}~${MAX_TIMEOUT_MS} 의 정수가 아니다: `
      + JSON.stringify(raw));
  }
  return n;
}

/** 파일을 읽는 창구. **테스트가 갈아 끼운다.** */
export type KeyFileReader = (path: string, maxBytes: number) => Promise<string>;

/** 작은 파일을 **세면서** 읽는다 — 상한 + 1 까지만 읽어 넘었는지 안다. 넘으면 `code: 'EFBIG'` 로 던진다. */
export const readBoundedFile: KeyFileReader = async (path, maxBytes) => {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(maxBytes + 1);
    let total = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, total, buf.length - total, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw Object.assign(new Error('too large'), { code: 'EFBIG' });
    }
    return buf.subarray(0, total).toString('utf8');
  } finally {
    await fh.close();
  }
};

/**
 * KEK 를 구해 온다. **실패하면 던진다** — 기동에서 죽는 편이 정직하다 (§4.8.1).
 *
 * ⚠️ **stdout 은 비밀이다.** 어떤 오류 메세지에도 안 싣는다. 명령이 실패하면 **stderr 만**
 * 싣는다 — 진단은 거기 있고 비밀은 저쪽에 있다.
 */
export async function resolveKek(
  env: NodeJS.ProcessEnv,
  opts: { run?: KekRunner } = {},
): Promise<Buffer> {
  return resolveKeyFrom(env, SECRET_KEK_SOURCE, opts);
}

/** `resolveKek` 의 일반형 — 출처 규칙(`KeySource`)만 바꿔 끼운다. */
export async function resolveKeyFrom(
  env: NodeJS.ProcessEnv,
  src: KeySource,
  opts: { run?: KekRunner; readFile?: KeyFileReader } = {},
): Promise<Buffer> {
  const name = src.name;
  const direct = (env[name] ?? '').trim();
  const cmd = (env[`${name}_CMD`] ?? '').trim();
  const file = src.file ? (env[`${name}_FILE`] ?? '').trim() : '';

  // **둘 이상 주면 안 뜬다.** 한 비밀에 출처가 둘이면 어느 쪽이 이기는지가 곧 사고다.
  // 골라서 이기게 하는 것보다 거절하는 것이 낫다 — `install.sh` 의 `MANAGED_ENV_KEYS` 가
  // 같은 이유로 같은 키를 두 번 못 넣게 한다.
  const given = [direct !== '' ? name : '', cmd !== '' ? `${name}_CMD` : '', file !== '' ? `${name}_FILE` : '']
    .filter((x) => x !== '');
  if (given.length > 1) {
    throw new Error(
      `${given.join(' 와 ')} 를 둘 다 줬다 — 한 비밀의 출처는 하나여야 한다 (§4.8.2)`);
  }

  if (file !== '') {
    const read = opts.readFile ?? readBoundedFile;
    let text: string;
    try {
      text = await read(file, MAX_FILE);
    } catch (e) {
      // 경로는 비밀이 아니다. 내용은 싣지 않는다(읽다 실패했으니 내용도 없다).
      const code = (e as { code?: string }).code;
      throw new Error(
        `${name}_FILE (${file}) 을 읽지 못했다 (${code === 'EFBIG' ? `${MAX_FILE} 바이트를 넘는다` : code ?? '알 수 없는 오류'}) — ${src.needs}`);
    }
    if (text.trim() === '') {
      throw new Error(`${name}_FILE (${file}) 이 비었다 — 파일에 키 한 줄을 둔다 (${src.shape})`);
    }
    return src.parse(text.trim());
  }

  if (cmd === '') {
    if (direct === '' && src.missing !== undefined) throw new Error(src.missing);
    return src.parse(direct); // 빈 것도 여기로 보낸다 — 안내는 parse 가 든다
  }

  const run = opts.run ?? defaultRunner;
  // **상한 판정을 try 밖에 둔다.** 안에 두면 설정이 잘못됐다는 오류가 아래 catch 에
  // 걸려 *"명령이 실패했다"* 로 둔갑한다 — 운영자는 멀쩡한 명령을 들여다보게 된다.
  // 이 결함은 오래 초록이었다: 오류 문구에 `err.message` 를 싣던 동안에는 안쪽 오류의
  // 문장이 그대로 실려 나와, 재현물이 **엉뚱한 이유로** 통과했다 (검수 2026-09-01).
  const timeoutMs = timeoutFrom(env, name);
  let stdout: string;
  try {
    ({ stdout } = await run(cmd, timeoutMs));
  } catch (e) {
    // **stdout 도 명령 자체도 안 싣는다.**
    //
    // 실패한 명령은 부분 출력에 비밀을 담을 수 있고 — 그건 처음부터 막았다 — **명령
    // 문자열 자체도 비밀일 수 있다.** `err.message` 는 execFile 이 만든 것이라
    // `Command failed: /bin/sh -c <명령>` 을 통째로 담는다. 처음엔 stderr 가 비었을 때
    // 그걸 실었고, 그래서 `BARY_SECRET_KEK_CMD='printf %s <키>'` 처럼 둔 배포에서
    // **키가 로그로 나갔다** (CodeQL js/clear-text-logging · 2026-09-01 실측).
    //
    // 대신 **어떻게 죽었는지만** 낸다. 진단에 필요한 것은 그것과 stderr 이고, 둘 다
    // 명령 문자열을 안 담는다.
    const err = e as { stderr?: string; code?: number | string; signal?: string; killed?: boolean };
    const why = (err.stderr ?? '').trim();
    const how = err.killed === true ? '상한을 넘겨 끊었다'
      : typeof err.signal === 'string' && err.signal !== '' ? `시그널 ${err.signal}`
      : err.code !== undefined ? `종료 코드 ${err.code}`
      : '알 수 없는 오류';
    throw new Error(
      `${name}_CMD 가 실패했다 (${how}) — ${src.needs}.`
      + (why === '' ? '' : `\n  stderr: ${why}`));
  }

  const value = stdout.trim();
  if (value === '') {
    throw new Error(
      `${name}_CMD 가 빈 것을 냈다 — 명령은 KEK 를 stdout 으로 내야 한다 `
      + `(${src.shape})`);
  }
  // 길이·인코딩 판정은 `parse` 한 자리에 둔다 — 두 곳에 두면 하나가 뒤처진다.
  return src.parse(value);
}
