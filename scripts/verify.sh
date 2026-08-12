#!/usr/bin/env bash
# barycenter — 전체 검증. 지금 어디까지 확인됐는지 한 번에 본다.
#
#   ./scripts/verify.sh          전부
#   ./scripts/verify.sh --quick  도커가 필요 없는 것만 (단위 + 타입)
#
# 도커가 필요한 묶음(골든·엔진·스파이크)은 도커가 없으면 **건너뛰지 않고 실패**한다.
# 조용히 건너뛰면 통과 신호를 위조하게 된다. 굳이 빼려면 --quick 을 명시한다.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

QUICK=0
[ "${1:-}" = "--quick" ] && QUICK=1

RESULTS=()
FAILED=0

run() {                      # run <label> <command...>
  local label="$1"; shift
  local out rc
  out=$("$@" 2>&1); rc=$?
  if [ $rc -eq 0 ]; then
    RESULTS+=("  ok    $label  —  $(summarize "$out")")
  else
    RESULTS+=("  FAIL  $label  —  $(summarize "$out")")
    FAILED=1
    printf '\n----- %s -----\n%s\n' "$label" "$(echo "$out" | tail -25)"
  fi
}

summarize() {
  echo "$1" | grep -oE 'Tests +[0-9]+ passed \([0-9]+\)|PASS=[0-9]+ +FAIL=[0-9]+( +SKIP=[0-9]+)?' \
    | tail -1 | tr -s ' ' || echo "완료"
}

echo "═══════════════════════════════════════════════════════════════"
echo " barycenter verify"
echo "═══════════════════════════════════════════════════════════════"

run "typecheck            " npx tsc --noEmit
run "unit                 " npm test --silent

if [ $QUICK -eq 1 ]; then
  echo "  (--quick: 도커가 필요한 묶음은 실행하지 않았다)"
else
  if ! docker info >/dev/null 2>&1; then
    echo "  FAIL  도커가 필요하다. 골든·엔진·스파이크는 실제 nginx 로 판정한다."
    echo "        단위 테스트만 보려면 ./scripts/verify.sh --quick"
    FAILED=1
  else
    run "golden (nginx -t)    " npm run test:golden --silent
    run "engine facts         " ./tests/engine/run.sh
    run "spike S1/S5          " ./spike/s1-s5/run.sh
    run "spike S7             " ./spike/s7/run.sh
    run "spike S8             " ./spike/s8/run.sh
    run "spike S11            " ./spike/s11/run.sh
  fi
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
printf '%s\n' "${RESULTS[@]}"
echo "═══════════════════════════════════════════════════════════════"

if [ $FAILED -eq 0 ]; then
  echo " 전부 통과."
  echo ""
  echo " 남은 착수 게이트 (DESIGN.md §12.0):"
  echo "   S12  크래시 저널        — v0.1 스키마 freeze 의 마지막 block"
  echo "   S13  GC ledger"
  echo "   S5/S11 프로토콜 잔여분  — 평면 부분 전환 · 스냅샷 cut→replay"
  echo "   S2 S3 S4 S6 S9 S10 S14 S15 S16 S17 S18"
else
  echo " 실패한 묶음이 있다."
fi
exit $FAILED
