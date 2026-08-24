/**
 * **저장소를 컨테이너에 올리는 한 가지 방법** (검수 2026-08-24 N4)
 *
 * ── 무엇이 깨졌나
 *
 * e2e 여섯 자리가 전부 이렇게 적혀 있었다:
 *
 *   '-v', `${process.cwd()}:/app:ro`
 *
 * 그리고 컨테이너 안에서 `node /app/dist/bin/barycenterd.js` 를 돌린다. 그 산출물은
 * `pg` 를 import 하므로 `/app/node_modules` 가 있어야 한다.
 *
 * **git worktree 에서는 `node_modules` 가 심볼릭 링크다.** 이 저장소의 규칙이
 * *"에이전트는 워크트리, 사람은 메인에서 작업"* 이고, 워크트리 생성기는 설치를 다시
 * 하지 않으려고 메인 체크아웃의 `node_modules` 로 링크를 건다. 그 링크의 대상은
 * **절대경로**이고, 컨테이너 안에는 그런 경로가 없다:
 *
 *   Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg'
 *     imported from /app/dist/control/leader.js
 *
 * 그래서 데몬이 안 뜨고, e2e 다섯 스위트가 `데몬이 안 떴다` 로 죽는다. 그런데 그
 * 메시지에 붙는 `docker logs` 는 **비어 있다** — 기동 스크립트가 `apk add` 를
 * `>/dev/null 2>&1` 로 지우고 나머지는 성공 시 조용하기 때문이다. 원인이 어디에도
 * 안 드러나는 실패다.
 *
 * ── 왜 워크트리 쪽을 안 고치는가
 *
 * `scripts/pinned.mjs` 도 **같은 짓을 한다**:
 *
 *   symlinkSync(join(process.cwd(), 'node_modules'), join(tree, 'node_modules'), 'dir')
 *
 * 재현물 게이트가 부모 트리를 임시 worktree 로 떼어 낼 때다. 워크트리를 만드는 자리는
 * 앞으로도 늘고, 전부 같은 이유로 링크를 건다(설치는 분 단위다). **고칠 자리는 링크가
 * 아니라 마운트다** — 심볼릭 링크가 바인드 마운트를 못 건넌다는 것은 도커의 성질이지
 * 누구의 실수가 아니다.
 *
 * ── 왜 파일 하나에 함수 하나인가
 *
 * `pg-ready.ts` 가 같은 이유로 존재하고 그 머리말이 이렇게 적어 뒀다:
 * *"넷에 복사하지 않고 여기 둔다. 같은 판정이 다섯 자리에 흩어지면 언젠가 하나가
 * 뒤처지고, 그때 그 스위트만 조용히 다시 경합한다."*
 */
import { realpathSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 저장소를 `/app` 에 읽기 전용으로 올리는 `docker run` 인자.
 *
 * `node_modules` 를 **따로** 싣는다. 워크트리가 아니면 두 번째 마운트는 첫 번째 안의
 * 같은 자리를 덮으므로 결과가 같다 — 즉 이 함수는 메인 체크아웃에서 아무것도 안 바꾼다.
 * 조건부로 두지 않는 이유가 그것이다: *"워크트리일 때만"* 이라는 분기는 워크트리에서
 * 아무도 e2e 를 안 돌리는 동안 조용히 썩는다.
 */
export function appMount(cwd: string = process.cwd()): string[] {
  return [
    '-v', `${cwd}:/app:ro`,
    // `realpathSync` 가 링크를 실체로 편다. 링크가 아니면 자기 자신이다.
    '-v', `${realpathSync(join(cwd, 'node_modules'))}:/app/node_modules:ro`,
  ];
}
