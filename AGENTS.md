# barycenter — 에이전트 규칙

## 메인 트리는 읽기 전용 — 모든 수정은 워크트리에서

`Edit`/`Write`/트리 변경 git 명령은 메인 작업 트리에서 **항상 거부**된다. 단독 세션도 같다.

작업 흐름: `EnterWorktree` → 작업·커밋 → `git fetch origin && git rebase <base> && git push origin HEAD:<branch>`

메인은 세션 시작·종료에 자동 fast-forward 된다. 통과하는 것: `Read`·`Grep`·`git status|log|diff|pull|fetch`.

정말 메인에서 해야 하면 `touch .git/claude-main-tree-rescue` (30분 TTL, **사용자 승인 후에만**).

새 워크트리에서 먼저 할 것은 `.claude/worktree-bootstrap.md` 에 있다 — 거부 메세지가 함께 보여준다.
