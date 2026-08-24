#!/usr/bin/env python3
"""흔들림 계수기 검사 — 검수 2026-08-24 W4-9.

**실제 셸에서 소스해 실물 명령으로 돌린다.** 로직을 파이썬으로 다시 짜서 재면 재는
것이 그 사본이 되고, 그건 이 저장소가 반복해서 경계하는 자리다.

⚠️ 셋을 함께 잰다 — 「흔들림을 잡는가」만 재면 **전부 흔들림이라고 답하는 구현**도
   통과한다.

     초록      한 번에 통과하면 재실행을 안 한다 (시간을 두 배로 안 쓴다)
     흔들림    첫 번째 빨강 + 두 번째 초록 → 기록하되 **판정은 여전히 빨강**
     진짜 빨강 두 번 다 빨강 → 기록 안 한다
"""
import json, os, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "flake.sh")
fail = 0


def check(label, ok, detail=""):
    global fail
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  — {detail}" if detail else ""))
    if not ok:
        fail = 1


def sh(script, cwd):
    """`flake.sh` 를 소스한 POSIX 셸에서 스크립트를 돌린다."""
    return subprocess.run(
        ["/bin/sh", "-c", f". '{LIB}'\n{script}"],
        cwd=cwd, capture_output=True, text=True,
    )


def counter_cmd(tmp, name, fail_times):
    """`fail_times` 번 실패한 뒤 성공하는 명령. 호출 횟수를 파일로 센다."""
    path = os.path.join(tmp, name)
    with open(path, "w", encoding="utf-8") as f:
        f.write(
            "#!/bin/sh\n"
            f'n=$(cat "{tmp}/{name}.n" 2>/dev/null || echo 0)\n'
            f'echo $((n+1)) > "{tmp}/{name}.n"\n'
            f'if [ "$n" -lt {fail_times} ]; then echo "빨강 $n"; exit 3; fi\n'
            'echo "초록"\n'
        )
    os.chmod(path, 0o755)
    return path


def calls(tmp, name):
    try:
        with open(os.path.join(tmp, f"{name}.n"), encoding="utf-8") as f:
            return int(f.read().strip())
    except FileNotFoundError:
        return 0


with tempfile.TemporaryDirectory(prefix="flake-") as tmp:
    log = os.path.join(tmp, "flakes.jsonl")
    env = f'BARY_FLAKE_LOG="{log}"\n'

    # ── ① 한 번에 초록이면 재실행을 안 한다 ─────────────────────────────
    ok_cmd = counter_cmd(tmp, "ok", 0)
    r = sh(env + f'bary_run_twice "{ok_cmd}"\n'
                 'printf "rc=%s flake=%s out=%s" "$BARY_RUN_RC" "$BARY_RUN_FLAKE" "$BARY_RUN_OUT"', tmp)
    check("초록.한번", r.stdout.strip() == "rc=0 flake=0 out=초록", r.stdout.strip())
    check("초록.재실행안함", calls(tmp, "ok") == 1,
          f"{calls(tmp, 'ok')} 회 불렀다 — 초록인데 두 번 돌면 게이트 시간이 두 배다")

    # ── ② 흔들림: 첫 빨강 + 둘째 초록 ───────────────────────────────────
    fl_cmd = counter_cmd(tmp, "flaky", 1)
    r = sh(env + f'bary_run_twice "{fl_cmd}"\n'
                 'printf "rc=%s flake=%s out=%s" "$BARY_RUN_RC" "$BARY_RUN_FLAKE" "$BARY_RUN_OUT"', tmp)
    out = r.stdout.strip()
    check("흔들림.잡는다", "flake=1" in out, out)
    # **이것이 이 검사의 핵심이다.** 두 번째가 초록이어도 판정은 빨강이다.
    check("흔들림.판정은여전히빨강", "rc=3" in out,
          f"{out} — 재실행이 판정을 바꾸면 흔들림이 통과로 샌다")
    # 진단은 **실패한 실행**의 것이어야 한다. 초록인 두 번째 출력에는 단서가 없다.
    check("흔들림.진단은실패쪽", "out=빨강" in out, out)
    check("흔들림.두번만돈다", calls(tmp, "flaky") == 2, f"{calls(tmp, 'flaky')} 회")

    # ── ③ 진짜 빨강: 두 번 다 빨강 ──────────────────────────────────────
    red_cmd = counter_cmd(tmp, "red", 99)
    r = sh(env + f'bary_run_twice "{red_cmd}"\n'
                 'printf "rc=%s flake=%s" "$BARY_RUN_RC" "$BARY_RUN_FLAKE"', tmp)
    check("빨강.흔들림아님", r.stdout.strip() == "rc=3 flake=0", r.stdout.strip())
    check("빨강.두번만돈다", calls(tmp, "red") == 2,
          f"{calls(tmp, 'red')} 회 — 세 번 이상 돌면 게이트가 실패에 갇힌다")

    # ── ④ 장부 ──────────────────────────────────────────────────────────
    r = sh(env + 'bary_record_flake "e2e (실제 nginx)      " 302\n'
                 'bary_record_flake "store (실물 PG)" 180', tmp)
    check("장부.기록됨", r.returncode == 0, r.stderr.strip())
    with open(log, encoding="utf-8") as f:
        rows = [json.loads(x) for x in f if x.strip()]
    check("장부.두줄", len(rows) == 2, str(rows))
    # **꼬리 공백을 벗긴다.** `verify.sh` 의 라벨은 표를 맞추려고 공백이 붙어 있고,
    # 그대로 적으면 같은 스위트가 두 이름으로 세어진다.
    check("장부.이름이깨끗하다", rows[0]["suite"] == "e2e (실제 nginx)", repr(rows[0]["suite"]))
    check("장부.JSON이다", all("at" in x and "seconds" in x for x in rows), str(rows))
    check("장부.UTC다", rows[0]["at"].endswith("Z"), rows[0]["at"])
    # **누적된다.** 회차를 가로질러 쌓여야 세는 뜻이 있다.
    sh(env + 'bary_record_flake "golden" 141', tmp)
    with open(log, encoding="utf-8") as f:
        check("장부.누적된다", len([x for x in f if x.strip()]) == 3)

print("\n  흔들림 계수기: " + ("전부 통과" if fail == 0 else "실패한 검사가 있다"))
sys.exit(fail)
