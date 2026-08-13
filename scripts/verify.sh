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

 ─── 6차 검수: 반례 7건이 **녹색 상태에서** 재현됐다 ────────────────

 앞선 "blocker 1~5 해소" 중 셋은 **부분적이었다.** 아래는 전부 직접 재현했다.

 ① 런타임 타입 검증        ✅ 해소. src/model/decode.ts — 경계에서 unknown 을 해독한다.
                            모르는 enum · 모르는 키 · 강제 변환을 전부 거부.
                            뮤턴트 7종 잡힘.
 ② 증거 판정              ✅ 해소. commit() 이 provesActivation 을 직접 부른다.
                            §3.5 — Agent 가 최종 심판이다.
 ③ 동시 멱등성            ✅ 해소. 전역 activeOperation + reserveAll + 저널 seq CAS
                            + apply 실행 큐. 6개 동시 → publish 1회 · HUP 1회.
 ④ partial 복구           ✅ 해소. partially_activated 가 비종단이다. 유한 재시도 뒤
                            소유권과 남은 예약을 반납한다.
 ⑤ FileStore 락           ✅ 해소. 락 레코드에 nonce. save 마다 주인 확인, release 도
                            내 락만 지운다. 읽기 전용은 save 가 없는 타입이다.
 ⑥ 복구 경로 펜싱         ✅ 해소. drive() 가 **매 단계 부작용 앞에서** 토큰과
                            소유권을 재확인한다.
 ⑦ 좌표 정규화            ✅ 해소. tupleFor 가 BigInt 정규형으로 만든다.
                            10진 정수가 아니면 거부한다.

 6차 반례 7건은 전부 닫혔다. **그러나 검수 E 의 목록은 그것만이 아니다.**

 6차 E 의 남은 항목
   ✅ 세대 materializer(§7.2) · 게시 전 nginx -t · artifact digest 결박
   ✅ DESIGN §6.2 · §6.3 · §9.2 — 실제 ABI 로 다시 쓰고 대조를 테스트로 걸었다
   ·  OpenAPI · DDL · changeset · auth/audit 스키마가 없다      → 아래 B
   ·  fsync 순서 · 락 생성 원자성 미검증 (fault injection 필요)  → 아래 A

 ─── 동결은 둘로 나뉜다 (§9.1.1) ──────────────────────────────────────

 A. 타입 · DP ABI      src/index.ts 가 동결 대상이다. 목록이 바뀌면 테스트가 깨진다.
                       렌더러는 엔진 사실 61 건 위에, DP ABI 는 반례 conformance 와
                       실물 nginx e2e 위에 서 있다.

    남은 것: fsync 순서 · 락 생성 원자성이 **검증되지 않았다** (코드에는 있다).
             전원 차단 / 파일시스템 fault injection 이 필요하다.
             6차 검수 판단으로는 "타입 freeze 자체보다 구현·출시 blocker" 다.

 B. API · DB 스키마    OpenAPI · PG DDL · changeset · auth/audit — **아직 없다.**
                       구현과 함께 고정한다. 구현하지 않은 계약을 고정하면 깨진다는
                       것을 여섯 번 배웠다 (§9.1 멤버십 철회).

 ─── 7차 검수: A 는 **동결 불가** ───────────────────────────────────────

 ① 리더 승계가 없다 — **영구 교착**                        [ABI 모양]
    fence(11) 뒤: 옛 저널 복구 → stale_leader
                  새 리더의 새 작업 → operation_in_flight
                  abortConfig 로 풀기 → stale_leader (옛 토큰이라 거부)
    새 리더가 apply 경로를 영영 못 잡는다. activeOperation 을 도입하며 만든 구멍이다.

 ② 펜싱이 비동기 관측 앞의 TOCTOU                          [구현 품질]
    관측 await 중 fence(11) 가 완주하면 옛 러너가 publish 1회를 낸 뒤 stale_leader.

 ③ 뺐다고 적은 것이 공개 모델에 남아 있다                  [ABI 모양]
    tls_passthrough · source_ip_hash 가 parseModel 을 통과한다.
    §9.1.1 은 v0.2 라고 적어 놨다. 지금 동결하면 v0.1 계약이 된다.

 ④ 표면만으로 구현할 수 없다                                [ABI 모양]
    LocalDataplaneDriver 는 비공개 DpAgent 를 인자로 받는다.
    DurableStore 는 비공개 AgentState · StoreConflict 에 의존한다.

 ⑤ 표면 테스트가 런타임 이름만 본다                        [검증의 문제]
    타입 export · 필드 · optional · 인자 · 반환형이 바뀌어도 통과한다.

 → A(타입·DP ABI): **No-Go**
 → B(API·DB):      **No-Go** — 만들지 않았다.
GATES

# 스위트 통과와 freeze 가능은 다르다. CI 가 exit code 만 보고 오해하지 않게
# 게이트를 물으려면 명시적으로 물어야 한다.
if [ "${1:-}" = --freeze-gate ]; then
  echo ""
  echo " --freeze-gate: B(API·DB)가 없고 A는 미확인 → non-zero 로 끝낸다."
  exit 2
fi

exit $FAILED
