#!/usr/bin/env python3
"""진행 표시 검사 — 검수 2026-08-29(4).

**실제 셸에서 소스해 실물 명령으로 돌린다.** 로직을 파이썬으로 다시 짜서 재면 재는
것이 그 사본이 되고, 그건 이 저장소가 반복해서 경계하는 자리다 (`test-flake.py` 와
같은 이유).

⚠️ **여기서 제일 중요한 것은 예쁘게 보이는 것이 아니라 판정이다.** `bary_live` 는 자식을
   파이프라인으로 감싼다 — 종료코드가 새면 **게이트가 영원히 초록이 된다.** 그래서
   넷을 함께 잰다:

     종료코드   성공은 0, 실패는 그 코드 그대로 (여기가 이 파일의 존재 이유다)
     캡처       원문이 한 줄도 안 빠지고 캡처로 간다 — 진단이 그것을 쓴다
     고르기     진행으로 읽히는 줄만 화면으로 간다 (결론 줄은 표가 싣는다)
     상한       넘으면 멈추되 **그 사실을 말한다** — 조용히 자르면 표시가 거짓이 된다
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LIB = os.path.join(HERE, "live.sh")
fail = 0


def check(label, ok, detail=""):
    global fail
    if ok:
        print(f"  PASS  {label}" + (f"  — {detail}" if detail else ""))
    else:
        print(f"  FAIL  {label}  — {detail}")
        fail += 1


def sh(script):
    """fd 3 을 stderr 로 돌려 화면 몫과 캡처 몫을 갈라 받는다."""
    r = subprocess.run(
        ["bash", "-c", f". {LIB}\n{script}"],
        capture_output=True, text=True,
    )
    return r.stdout, r.stderr, r.returncode


CHILD = (
    'child() { echo "PASS 하나"; echo "그냥 로그 한 줄"; '
    'echo "ok  결론이다"; return ${1:-0}; }\n'
)

# ── 종료코드 ─────────────────────────────────────────────────────────────
out, _, rc = sh(CHILD + 'o=$(bary_live child 0 3>&2); echo "rc=$?"')
check("종료코드.성공", "rc=0" in out, out.strip())

out, _, rc = sh(CHILD + 'o=$(bary_live child 7 3>&2); echo "rc=$?"')
check("종료코드.실패가 그대로 나온다", "rc=7" in out,
      f"{out.strip()} — 여기가 새면 게이트가 영원히 초록이다")

# ── 캡처 ─────────────────────────────────────────────────────────────────
out, _, rc = sh(CHILD + 'o=$(bary_live child 0 3>&2); printf "%s" "$o" | grep -c .')
check("캡처.원문이 다 간다", out.strip().endswith("3"),
      f"줄 수 {out.strip()} (3 이어야 한다)")

# ── 고르기 ───────────────────────────────────────────────────────────────
_, err, _ = sh(CHILD + 'bary_live child 0 3>&2 >/dev/null')
check("고르기.진행 줄은 낸다", "PASS 하나" in err, err.strip())
check("고르기.그냥 로그는 안 낸다", "그냥 로그" not in err, err.strip())
check("고르기.결론 줄은 안 낸다 (표가 싣는다)", "결론이다" not in err, err.strip())

# ── 끄기 ─────────────────────────────────────────────────────────────────
_, err, _ = sh(CHILD + 'BARY_LIVE=0 bary_live child 0 3>&2 >/dev/null')
check("끄기.BARY_LIVE=0 이면 한 줄도 안 낸다", err.strip() == "", err.strip())

# ── 상한 ─────────────────────────────────────────────────────────────────
many = 'many() { i=0; while [ $i -lt 20 ]; do echo "PASS $i"; i=$((i+1)); done; }\n'
_, err, _ = sh(many + 'BARY_LIVE_MAX=5 bary_live many 3>&2 >/dev/null')
check("상한.넘으면 멈춘다", err.count("PASS") <= 5, f"{err.count('PASS')} 줄")
check("상한.자른 사실을 말한다", "넘었다" in err,
      "조용히 자르면 표시가 거짓이 된다")

print()
print(f"  진행 표시: {'전부 통과' if fail == 0 else f'{fail} 건 실패'}")
sys.exit(1 if fail else 0)
