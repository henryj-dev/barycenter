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

# 스위트가 통과하는 것과 착수 게이트가 열리는 것은 다르다.
# 4차 검수 전까지 이 스크립트는 둘을 뭉뚱그려 "S12 만 남았다" 는 거짓 신호를 냈다.
if [ $FAILED -eq 0 ]; then
  echo " 구현된 스위트: 전부 통과."
else
  echo " 실패한 스위트가 있다."
fi

cat <<'GATES'

 ─── 착수 게이트는 별개다 (DESIGN.md §12.0) ───────────────────────────

 ~  S11  operation tuple 과 경합
         DP Agent 상태기계(src/dp)로 재구현. P18~P22 가 통과하고, 직렬화를
         제거하면 실패하는 것을 뮤테이션으로 확인했다.
         남은 것: 실제 nginx 와 물린 end-to-end, plane 부분 전환(P5/P6),
         cut→replay(P3), 취소/재시작 조합.

 ~  S1   멤버십 평면        primitive 만 확인. 가중치·재시도·drain·DNS 없음
 ~  S5   이중 zone 확정 / stream 평면 미측정, 부분 전환 미검증
 ~  S7   로그 행 수를 정본 신호로 씀 → 진단용으로 강등하고 판정 계약 재작성 필요
 ~  S8   CN 만 비교 / key·SPKI·chain·SNI 별 자료 미검증

 ~  S12  크래시 저널
         ApplyRunner(src/dp/apply.ts) 로 구현. 저장·부작용의 모든 직전/직후에
         크래시를 주입해 훑고, 관측이 저널보다 우선함을 확인했다. 관측을 빼거나
         재전송 상한을 없애면 실패하는 것을 뮤테이션으로 확인.
         남은 것: 실제 파일시스템·nginx 와 물린 end-to-end, 시크릿 materialize,
         평면별 전이.
 ❌ S13  GC ledger          미착수
 ❌ S2 S3 S4 S6 S9 S10 S14 S15 S16 S17 S18

 → v0.1 타입·API·DB 스키마 freeze: **No-Go**
GATES

exit $FAILED
