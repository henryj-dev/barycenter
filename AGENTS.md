# barycenter — 에이전트 규칙

## 에이전트는 워크트리, 사람은 메인에서 작업

에이전트의 `Edit`/`Write`/트리 변경 git 명령은 메인에서 **항상 거부**된다. 사람은 메인에서
수정·커밋·push 할 수 있다. 에이전트 작업 흐름: 하네스 전용 worktree 도구 또는
`python3 scripts/claude-hooks/enter-worktree.py <이름>` → 생성된 경로에서 작업·커밋 →
`git fetch origin && git rebase <base> && git push origin HEAD:<branch>`

**대화(작업 사이클)가 끝났다고 선언하려면 이 push 까지 끝나 있어야 한다 — 그것이 곧
「메인 브랜치로 머지」다.** 별도의 병합 절차는 없다. 워크트리에 커밋만 남기고 push 를
미루면 그 사이클은 아직 메인에 반영되지 않은 것이다.

메인은 세션 시작·종료에 깨끗할 때만 자동 fast-forward 된다. 에이전트가 정말 메인에서
해야 하면 `touch .git/claude-main-tree-rescue` (30분 TTL, **사용자 승인 후에만**).

새 워크트리에서 먼저 할 것은 `.claude/worktree-bootstrap.md` 에 있다 — 거부 메세지가 함께 보여준다.

임의 `git worktree add` 는 계속 차단된다. 도구 중립 생성기는 경로·기준 ref를 제한하고
생성 즉시 소유권을 기록하므로 세션 시작·종료 회수 규칙과 함께 쓸 수 있다.
