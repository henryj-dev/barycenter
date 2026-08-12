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
run "conformance (반례)   " npm run test:conformance --silent

if [ $QUICK -eq 1 ]; then
  echo "  (--quick: 도커가 필요한 묶음은 실행하지 않았다)"
else
  if ! docker info >/dev/null 2>&1; then
    echo "  FAIL  도커가 필요하다. 골든·엔진·스파이크는 실제 nginx 로 판정한다."
    echo "        단위 테스트만 보려면 ./scripts/verify.sh --quick"
    FAILED=1
  else
    run "golden (nginx -t)    " npm run test:golden --silent
    run "e2e (실제 nginx)      " npm run test:e2e --silent
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
         DP Agent 상태기계(src/dp)로 재구현. P18~P21 이 통과하고(P22 는 리듀서
         이후 — 미구현), 직렬화를 제거하면 실패하는 것을 뮤테이션으로 확인했다.
         남은 것: plane 부분 전환(P5/P6), cut→replay(P3), 취소/재시작 조합.
         ❗ 5차 검수가 **녹색 상태에서 반례 7건을 재현**했다 (§9.1.1).

 ~  S1   멤버십 평면        primitive 만 확인. 가중치·재시도·drain·DNS 없음
 ~  S5   이중 zone 확정 / stream 평면 미측정, 부분 전환 미검증
 ~  S7   로그 행 수를 정본 신호로 씀 → 진단용으로 강등하고 판정 계약 재작성 필요
 ~  S8   CN 만 비교 / key·SPKI·chain·SNI 별 자료 미검증

 ~  S12  크래시 저널
         ApplyRunner 로 구현하고 **실제 nginx 와 물렸다** (tests/e2e).
         저장·부작용의 모든 직전/직후에 크래시를 주입해 훑고, 관측이 저널보다
         우선함을 확인. 관측을 빼거나 재전송 상한을 없애면 실패하는 것을
         뮤테이션으로 확인.
         남은 것: 시크릿 materialize, 평면별 전이, 세대 디렉토리 원자 게시.
 ❌ S13  GC ledger          미착수
 ❌ S2 S3 S4 S6 S9 S10 S14 S15 S16 S17 S18

 ─── 범위를 줄여도 남는 v0.1 blocker (§9.1.1) ─────────────────────────

 1. 소유권과 원자성    ✅ 해소. (plane, target_activation_epoch) 단일 CAS 예약 +
                       durable 버전 CAS. 반례 ①②③④⑥ 이 conformance 로 고정됐고
                       뮤턴트 7종이 전부 잡힌다.
 2. ApplyOperation     ✅ 해소. 두 평면이 한 오퍼레이션으로 넘어가고, 활성화 증거가
                       명시적 타입이자 commit 의 인자다. 뮤턴트 8종 전부 잡힘.
 3. 변이 envelope      ✅ 해소. MutationEnvelope 하나가 모든 변이를 지난다.
                       참조 구현(LocalDataplaneDriver)까지 함께 세웠다.
 4. fail-closed 타입   ✅ 해소. RawModel(입력) / Model(검증 통과) 두 층으로 나누고
                       리스너를 프로토콜 판별 유니온으로 만들었다. 뮤턴트 6종 전부 잡힘.
 5. durable store      ✅ 해소. FileStore — 원자적 교체 · 손상 탐지 · 버전 CAS ·
                       프로세스 간 락. 별도 프로세스로 배제를 확인. 뮤턴트 6종 잡힘.

 ─── 다음 검수가 확인해야 할 것 ───────────────────────────────────────

   · fsync 의 **순서**는 검증되지 않았다 (전원 차단 주입 필요)
   · e2e 가 http 평면만 실물로 확인한다 (stream · FsEffects 미확인)

 → v0.1 타입·API·DB 스키마 freeze: **No-Go**
GATES

# 스위트 통과와 freeze 가능은 다르다. CI 가 exit code 만 보고 오해하지 않게
# 게이트를 물으려면 명시적으로 물어야 한다.
if [ "${1:-}" = --freeze-gate ]; then
  echo ""
  echo " --freeze-gate: 지목된 blocker 5건은 닫혔으나 위 3건이 미확인 → non-zero."
  exit 2
fi

exit $FAILED
