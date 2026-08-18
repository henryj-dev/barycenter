# barycenter — 에이전트 규칙

## 메인 트리는 읽기 전용 — 모든 수정은 워크트리에서

`Edit`/`Write`/트리 변경 git 명령은 메인 작업 트리에서 **항상 거부**된다. 단독 세션도 같다.

작업 흐름: `EnterWorktree` → 작업·커밋 → `git fetch origin && git rebase <base> && git push origin HEAD:<branch>`

**대화(작업 사이클)가 끝났다고 선언하려면 이 push 까지 끝나 있어야 한다 — 그것이 곧
「메인 브랜치로 머지」다.** 별도의 병합 절차는 없다. 워크트리에 커밋만 남기고 push 를
미루면 그 사이클은 아직 메인에 반영되지 않은 것이다.

메인은 세션 시작·종료에 자동 fast-forward 된다 — 다만 이건 안전망일 뿐, **사용자는
기다리지 않고 언제든 메인 트리에서 직접 `git pull`(ff-only) 을 받아도 된다.** 통과하는
것: `Read`·`Grep`·`git status|log|diff|pull|fetch`.

정말 메인에서 해야 하면 `touch .git/claude-main-tree-rescue` (30분 TTL, **사용자 승인 후에만**).

새 워크트리에서 먼저 할 것은 `.claude/worktree-bootstrap.md` 에 있다 — 거부 메세지가 함께 보여준다.
