/**
 * **골든의 도구 이미지 — `apk add` 는 한 번만 한다** (2026-11-02)
 *
 * 엔진 이미지(`openresty:alpine`)에는 `curl`·`openssl`·`socat` 이 없다. 그래서 골든
 * 대부분이 `docker run` 마다 `apk add --no-cache curl >/dev/null 2>&1;` 로 시작했다.
 * 스위트 한 번에 **수십 번** 망에서 받는다.
 *
 * CI 41347907696 의 `verify (render)` 가 거기서 졌다. `next-upstream` 의 첫 검사가
 * 평소 5 초인데 **64 초** 걸렸고, 판정은 `slots=""` 였다. apk 가 거울에 매달렸다가
 * 실패했고, 출력은 `>/dev/null` 이 지웠다. 그러면 `curl: not found` 에서 `set -e` 가
 * 프로브를 끝낸다 — 표식 줄이 하나도 안 나오니 **"슬롯이 안 실렸다"** 로 읽힌다.
 * 엔진도 렌더도 잘못이 없었다.
 *
 * 파일마다 `|| exit 70` 을 붙여 실패를 크게 만든 곳도 있다(`nginx-t`·`vhost` 등).
 * 그건 진단을 고칠 뿐이고 확률은 그대로다. 여기서는 **망을 타는 횟수**를 줄인다:
 *
 *   · 엔진 이미지 위에 도구만 얹은 이미지를 **처음 한 번** 만든다
 *   · 태그에 바탕 이미지의 ID 를 넣는다 — 바탕이 바뀌면 새로 만들고, 같으면 다시 쓴다
 *   · 만들기가 실패하면 **그 자리에서** apk 출력과 함께 던진다. 재시도는 안 한다
 *
 * 바탕은 `BARY_ENGINE_IMAGE` 를 그대로 따른다. 얹는 것은 시험 도구뿐이라 재는 엔진은
 * 같은 바이너리다.
 */
import { execFileSync } from 'node:child_process';

const BASE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';

/** 골든 프로브가 쓰는 도구 전부. 하나 늘면 여기에 적는다. */
export const TOOLS = ['curl', 'openssl', 'socat'] as const;

let cached: string | undefined;

/** 도구가 얹힌 엔진 이미지의 태그. 없으면 지금 만든다 (프로세스당 한 번 본다). */
export function toolsImage(): string {
  if (cached !== undefined) return cached;
  const inspect = (): string =>
    execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', BASE], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  let raw: string;
  // `docker run` 이 하던 대로, 바탕이 없으면 받는다. CI 는 앞 단계에서 이미 받아 둔다.
  try { raw = inspect(); } catch { execFileSync('docker', ['pull', BASE], { stdio: 'ignore' }); raw = inspect(); }
  const id = raw.trim().replace(/^sha256:/, '').slice(0, 12);
  const tag = `bary-golden-tools:${id}-${TOOLS.join('-')}`;
  try {
    execFileSync('docker', ['image', 'inspect', tag], { stdio: 'ignore' });
  } catch {
    try {
      // 바탕은 이미 로컬에 있다(위 `inspect` 가 확인했다) — 레지스트리에 안 묻는다.
      execFileSync('docker', ['build', '--pull=false', '-t', tag, '-'], {
        input: `FROM ${BASE}\nRUN apk add --no-cache ${TOOLS.join(' ')}\n`,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 170_000,
      });
    } catch (e) {
      const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
      throw new Error(
        `골든 도구 이미지(${tag})를 못 만들었다 — apk 가 망에서 못 받은 것이다. 엔진·렌더 문제가 아니다.\n`
        + `${err.stderr?.toString() ?? ''}${err.stdout?.toString() ?? ''}${err.message}`,
      );
    }
  }
  cached = tag;
  return tag;
}
