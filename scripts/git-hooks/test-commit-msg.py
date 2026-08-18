#!/usr/bin/env python3
"""commit-msg 훅 검사 — 표식 없는 `src/` 커밋을 막고, 나머지는 통과시키는가.

**격리 저장소에서 실제로 `git commit` 을 돌린다.** 훅을 손으로 실행해 보는 것으로는
부족하다 — git 이 무엇을 인자로 주고 어느 cwd 에서 부르는지가 판정의 전부이기 때문이다.
`test-pre-commit.py` 가 같은 이유로 같은 모양이다.

⚠️ **「막는 쪽」과 「통과하는 쪽」을 함께 잰다.** 전부 막는 훅도 막는 검사만으론 통과한다.
   이 저장소가 판별력 없는 테스트를 네 번 쓴 뒤에 세운 규칙이다.

⚠️ 실제 레포를 안 건드린다. 임시 디렉토리에 저장소를 새로 만들고, `core.hooksPath` 에는
   **commit-msg 만** 둔다 — pre-commit(메인 트리 가드)이 섞이면 무엇이 막았는지 모른다.
"""
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOOK = os.path.join(HERE, "commit-msg")
fail = 0


def check(label, ok, detail=""):
    global fail
    fail += not ok
    print(f"  {'PASS' if ok else 'FAIL'}  {label}{('  ' + detail) if detail else ''}")


def run(repo, *args, **kw):
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, text=True, **kw,
    )


def make_repo(tmp):
    repo = os.path.join(tmp, "repo")
    os.makedirs(os.path.join(repo, "src"))
    os.makedirs(os.path.join(repo, "docs"))
    subprocess.run(["git", "init", "-q", repo], check=True)
    for k, v in (("user.email", "t@t.test"), ("user.name", "t"), ("commit.gpgsign", "false")):
        run(repo, "config", k, v)

    hooks = os.path.join(tmp, "hooks")
    os.makedirs(hooks)
    shutil.copy2(HOOK, os.path.join(hooks, "commit-msg"))
    os.chmod(os.path.join(hooks, "commit-msg"), 0o755)
    run(repo, "config", "core.hooksPath", hooks)

    # 첫 커밋 — 훅이 HEAD 없는 상태에서 죽지 않는지도 여기서 걸린다.
    write(repo, "docs/a.md", "start\n")
    run(repo, "add", "-A")
    r = run(repo, "commit", "-m", "chore: 시작")
    return repo, r


def write(repo, rel, text):
    path = os.path.join(repo, rel)
    with open(path, "w", encoding="utf-8") as f:
        f.write(text)


def commit(repo, message, files, stage=True):
    for rel, text in files.items():
        write(repo, rel, text)
    if stage:
        run(repo, "add", "-A")
    return run(repo, "commit", "-m", message)


def main():
    tmp = tempfile.mkdtemp(prefix="commitmsg-")
    try:
        repo, first = make_repo(tmp)
        check("첫 커밋이 선다 (HEAD 없는 상태에서 안 죽는다)",
              first.returncode == 0, first.stderr.strip()[:80])

        # ① src 를 바꾸는데 표식이 없다 → 막힌다
        r = commit(repo, "fix: 뭔가 고쳤다", {"src/a.ts": "export const a = 1;\n"})
        check("**표식 없이 src 를 바꾸면 막힌다**",
              r.returncode != 0 and "Pinned-by" in r.stderr,
              f"rc={r.returncode}")

        # ② 표식이 있으면 통과 — **막는 검사만으론 전부 막는 훅도 통과한다**
        r = commit(repo, 'fix: 뭔가 고쳤다\n\nPinned-by: tests/unit/a.test.ts -t "이름"',
                   {"src/a.ts": "export const a = 1;\n"})
        check("표식이 있으면 통과한다", r.returncode == 0, r.stderr.strip()[:80])

        # ③ src 를 안 바꾸면 표식이 없어도 통과 — 문서 커밋을 막으면 안 된다
        r = commit(repo, "docs: 문서만 고쳤다", {"docs/a.md": "changed\n"})
        check("src 를 안 바꾸면 표식 없이도 통과한다", r.returncode == 0, r.stderr.strip()[:80])

        # ④ 맨 `none` 은 근거가 아니다 → 막힌다
        r = commit(repo, "fix: 또 고쳤다\n\nPinned-by: none",
                   {"src/b.ts": "export const b = 1;\n"})
        check("**맨 `none` 은 막힌다** — 근거를 요구한다",
              r.returncode != 0 and "근거" in r.stderr, f"rc={r.returncode}")

        # ⑤ `none — 근거` 는 통과
        r = commit(repo, "fix: 또 고쳤다\n\nPinned-by: none — 렌더 산출물이 안 바뀐다",
                   {"src/b.ts": "export const b = 1;\n"})
        check("`none — 근거` 는 통과한다", r.returncode == 0, r.stderr.strip()[:80])

        # ⑥ 미스테이지 src 수정은 이 커밋에 안 들어간다 → 통과
        #
        # **추적된 파일을 고쳐야 한다.** 처음엔 새 `src/c.ts` 를 쓰고 add 를 안 했는데,
        # `git diff` 는 untracked 를 **안 보여준다** — 그래서 "스테이지를 본다" 를
        # "작업 트리를 본다" 로 바꾸는 변이가 안 잡혔다. 판별력 없는 단언이었다.
        write(repo, "src/a.ts", "export const a = 999;\n")   # 추적됨, add 하지 않는다
        write(repo, "docs/b.md", "x\n")
        run(repo, "add", "docs/b.md")
        r = run(repo, "commit", "-m", "docs: 문서만")
        check("**스테이지 안 된 src 수정은 안 센다** — 이 커밋에 안 들어가므로",
              r.returncode == 0, r.stderr.strip()[:80])

        # ⑦ fixup! 은 최종 메시지가 나중에 정해진다 → 통과
        run(repo, "add", "-A")
        r = run(repo, "commit", "-m", "fixup! fix: 뭔가 고쳤다")
        check("`fixup!` 은 통과한다 — 최종 메시지는 rebase 때 정해진다",
              r.returncode == 0, r.stderr.strip()[:80])

    finally:
        shutil.rmtree(tmp, ignore_errors=True)

    print(f"\n  실패 {fail} 건")
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
