#!/bin/sh
# S12 프로브 — 크래시 저널. 컨테이너 안에서 실행된다.
#
# 합격 기준(§12.0): §6.2 표의 모든 지점(durable write · 외부 side-effect 직전/직후)에서
# **복구가 정확**하다. 최종 세대가 정확하고 **중복 cycle 이 상한 이내**여야 한다.
# exactly-once 는 요구하지 않는다 (§6.2).
#
# 실패 시 규칙: **설계 재작업 (block).**
#
# ── 이미 있는 것과 여기서 더하는 것 ─────────────────────────────────────
#
# `tests/conformance/review5-crash-points.test.ts` 가 지점 15 개 × 직전/직후를 훑고
# 수렴을 확인한다. 그건 **로직**이고, 거기서 죽는 방식은 예외다 — 힙만 버려지고
# 파일시스템은 정상 종료한 상태로 남는다.
#
# 여기서는 `process.abort()` 로 **진짜 죽인다**. 실물 `FileStore`·실물 `FsEffects`·
# 실물 nginx 위에서. 그래야 다음이 판정에 들어온다:
#
#   · 반쯤 쓰인 durable 파일, 이름이 바뀌다 만 임시 파일
#   · **주인이 죽은 락을 회수할 수 있는가** (6차 반례 ⑤)
#   · `current` 링크와 저널의 순서가 프로세스 경계를 넘어 지켜지는가
set -u

P=/tmp/s12/prefix
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

ENGINE=/usr/local/openresty/bin/openresty
apk add --no-cache nodejs curl >/dev/null 2>&1 || true
rm -rf /tmp/s12; mkdir -p $P/logs $P/state $P/generations

# ── 세대 둘을 손으로 만든다 ────────────────────────────────────────────
#
# 컨트롤 플레인을 안 태운다. S12 의 질문은 **DP 의 복구**이고, CP 를 끼우면 실패가
# 어느 층의 것인지 흐려진다.
# **실물 `materializeGeneration` 으로 만든다.** manifest digest 규칙을 흉내 내면
# preflight 가 전부 거절하고, 그러면 스윕이 "복구가 잘 된다" 는 잘못된 초록을 낸다 —
# 아무 일도 안 일어났으니까. (처음에 그렇게 짰다가 baseline 이 failed 로 나와 알았다.)
DIGEST1=$(node /spike/mkgen.mjs $P gen-1)
DIGEST2=$(node /spike/mkgen.mjs $P gen-2)
DIGEST3=$(node /spike/mkgen.mjs $P gen-3)
echo "  세대 digest: gen-1=$(echo $DIGEST1 | cut -c1-20)… gen-2=$(echo $DIGEST2 | cut -c1-20)…"



# ── 봉투 둘 ────────────────────────────────────────────────────────────
#
# 두 번째가 왜 필요한가 — 복구가 *같은* 오퍼레이션만 다시 돌리면, `finishOperation` 이
# 실행권을 영영 안 놓아도 스파이크가 통과한다. 같은 신원의 오퍼레이션은 자기 실행권에
# 막히지 않기 때문이다. 실제로 그 변이(6차 반례 ④ — "이게 빠지면 좌표가 영구히
# 잠긴다")를 넣고 돌렸더니 **5 PASS 로 그냥 통과했다.**
#
# 잠김은 **다음 오퍼레이션**에서만 보인다.
node /spike/mkop.mjs $P op.json  ""  gen-2 0 2
node /spike/mkop.mjs $P op2.json "b" gen-3 2 3

# gen-1 을 활성으로 두고 엔진을 띄운다.
ln -sfn generations/gen-1 $P/current
$ENGINE -p $P -c current/nginx.conf
sleep 1.0
if [ "$(curl -s --max-time 2 http://127.0.0.1:19990/generation)" != "gen-1" ]; then
  echo "엔진 기동 실패"; tail -5 $P/logs/error.log; exit 1
fi

echo ""
echo "=============================================================="
echo " S12 spike — 크래시 저널 (실제 프로세스 종료)"
echo " $($ENGINE -v 2>&1)"
echo "=============================================================="
echo ""

# ── 정상 경로로 지점 수를 센다 ─────────────────────────────────────────
snapshot() { rm -rf /tmp/s12/base; cp -a $P /tmp/s12/base; }
restore()  { rm -rf $P; cp -a /tmp/s12/base $P; }

# **엔진도 되돌려야 한다.**
#
# nginx 는 스윕 내내 살아 있는 별개 프로세스다. 앞 회차에서 gen-2 로 reload 되고 나면
# `restore` 로 prefix 를 되돌려도 **계속 gen-2 를 서빙한다** — HUP 을 받기 전까지 자기가
# 읽은 설정을 든다.
#
# 그대로 두면 뒤쪽 회차의 "복구가 gen-2 로 수렴했다" 가 **앞 회차 덕일 수 있다.** 이번
# 복구가 한 일이 아니라. `S12.metric`(지표 검증)이 정상 경로에서도 reload 0 회를 보고해서
# 알았다 — 엔진이 이미 gen-2 라 러너가 reload 를 건너뛴 것이었다.
reset_engine() {
  ln -sfn generations/gen-1 $P/current
  kill -HUP "$(cat $P/logs/nginx.pid)" 2>/dev/null
  n=0
  while [ "$n" -lt 40 ]; do
    [ "$(curl -s --max-time 1 http://127.0.0.1:19990/generation)" = "gen-1" ] && return 0
    n=$((n+1)); sleep 0.1
  done
  echo "  ⚠ 엔진을 gen-1 로 못 되돌렸다 — 이 회차 판정은 믿을 수 없다"
  return 1
}
snapshot

OUT=$(node /spike/runner.mjs $P none gen-2 2>&1)
TOTAL=$(echo "$OUT" | grep -c '^POINT ')
PHASE=$(echo "$OUT" | sed -n 's/^RESULT //p')
# **지점 목록을 찍는다.** 이 스파이크가 무엇을 훑었는지 개수로만 말하면, 정작 중요한
# 지점이 목록에 없어도 알 수 없다 — 5차 검수가 개수 판정으로 물렸던 자리다.
echo "  정상 경로 지점:"
echo "$OUT" | sed -n 's/^POINT /    /p'
echo ""

if [ "$PHASE" = "activated" ]; then
  ok S12.baseline "정상 경로가 activated 로 끝난다 — 크래시 지점 $TOTAL 개"
else
  bad S12.baseline "정상 경로가 '$PHASE' 로 끝났다. 스윕이 무의미하다"
  echo "$OUT" | tail -12 | sed 's/^/      /'
  echo " PASS=$PASS FAIL=$FAIL"; exit 1
fi

# ── 전 지점 스윕 ───────────────────────────────────────────────────────
#
# 각 지점마다: 깨끗한 상태 → 그 지점에서 죽인다 → **다시 돌린다**(복구) →
# 최종 세대와 종단 상태를 본다.
CRASHED=0; RECOVERED=0; MISSED=0; CYCLES=0
FAILED_POINTS=""; MISSED_POINTS=""
BASE_LABELS=$(echo "$OUT" | sed -n 's/^POINT [0-9]* //p')
i=0
while [ "$i" -lt "$TOTAL" ]; do
  restore
  reset_engine || { bad S12.sweep "엔진 되돌리기 실패 (#$i)"; break; }

  CRASH_OUT=$(node /spike/runner.mjs $P "$i" gen-2 2>/dev/null)
  RC=$?
  if [ "$RC" -eq 3 ]; then
    # **어느 지점을 못 지났는지 남긴다.** 개수만 세면 "전 지점" 이라는 말이 과장이 된다.
    MISSED=$((MISSED+1))
    MISSED_POINTS="$MISSED_POINTS #$i($(echo "$BASE_LABELS" | sed -n "$((i+1))p"))"
    i=$((i+1)); continue
  fi
  CRASHED=$((CRASHED+1))
  WHERE=$(echo "$CRASH_OUT" | sed -n 's/^ABORT [0-9]* //p' | head -1)

  # **복구.** 같은 오퍼레이션을 다시 돌린다 — 멱등해야 한다 (§6.2).
  #
  # **한 번으로 안 끝날 수 있다.** §12.0 의 합격 기준은 *"최종 세대가 정확하고 중복
  # cycle 이 상한 이내"* 이고 **exactly-once 를 요구하지 않는다.** 처음엔 첫 복구가
  # `activated` 여야 한다고 단언했는데, 그건 기준보다 엄격하다.
  #
  # 실제로 게이트 안에서(다른 컨테이너들과 부하를 나눌 때) `phase=failed` 인데 **링크도
  # 서빙 세대도 gen-2** 인 회차가 나왔다 — 세상은 수렴했고 러너가 활성화 증거를 예산
  # (25×100ms) 안에 못 본 것이다. S7 이 다룬 그 판정 지연이고, 그때 러너는 유한 재시도로
  # 넘어간다. 여기서 그걸 재현한다: **상한 안에서 다시 돈다.**
  RECOVERY_LIMIT=3
  REC_TRIES=0
  while [ "$REC_TRIES" -lt "$RECOVERY_LIMIT" ]; do
    REC_OUT=$(node /spike/runner.mjs $P none gen-2 2>&1)
    REC_PHASE=$(echo "$REC_OUT" | sed -n 's/^RESULT //p')
    REC_TRIES=$((REC_TRIES+1))
    [ "$REC_PHASE" = "activated" ] && break
  done
  CYCLES=$((CYCLES + REC_TRIES))
  LINK=$(readlink $P/current)
  # **워커 교체는 비동기다.** 러너가 돌아온 순간을 읽으면 아직 옛 워커가 답할 수 있다 —
  # 그건 "수렴 못 했다" 가 아니라 아직 안 봤다는 뜻이다. 유계로 기다린다.
  SERVED=""
  w=0
  while [ "$w" -lt 30 ]; do
    SERVED=$(curl -s --max-time 1 http://127.0.0.1:19990/generation)
    [ "$SERVED" = "gen-2" ] && break
    w=$((w+1)); sleep 0.1
  done

  # **다음 오퍼레이션이 지나가는가** — 실행권이 놓였는지는 이걸로만 보인다.
  #
  # ── 여기에 복구와 같은 처방을 안 줬었다 (2026-08-18) ────────────────────
  #
  # 위의 복구 단계는 이미 배웠다: 러너가 활성화 증거를 예산 안에 못 보면 `failed` 라고
  # 말하는데 **세상은 이미 수렴해 있다**(S7). 그래서 유계 재시도를 넣었다.
  # 그런데 후속 단계는 **한 방에, 러너의 말만 보고** 판정하고 있었다.
  #
  # 부하가 걸린 기계에서 그게 터졌다. 38 지점 중 두엇이 `next=failed` 로 빨개지는데,
  # 회차마다 **다른 지점**이었다 — #10·#25 → #8·#35 → #18·#37 → 없음. 러너 자신의
  # 주석이 이 판별법을 적어 뒀다: *"고정된 로직 결함이면 같은 지점이 나온다."*
  # 그리고 그때조차 `link` 와 `served` 는 둘 다 gen-2 였다. 세상은 멀쩡했다.
  #
  # **그래서 판정을 러너의 말에서 세계로 옮긴다.** §12.0 이 요구하는 것은
  # *"다음 오퍼레이션이 막히지 않는다"* 이고, 그건 **gen-3 가 실제로 서빙되는가**다.
  # `phase` 문자열은 그 사실의 보고일 뿐이고, 보고는 늦을 수 있다. 보고를 재면
  # 계측기를 재게 된다 — 이 저장소가 S16 에서 `Protocol :` 줄로 물린 그 형태다.
  #
  # 약화가 아니다. 오히려 **빈 `phase=`**(러너가 아예 출력을 못 낸 회차)까지 정직하게
  # 판정된다. 러너가 죽어도 세상이 gen-3 로 갔으면 실행권은 놓인 것이다.
  NEXT_LIMIT=3
  NEXT_TRIES=0
  while [ "$NEXT_TRIES" -lt "$NEXT_LIMIT" ]; do
    NEXT_OUT=$(node /spike/runner.mjs $P none gen-3 op2.json 2>&1)
    NEXT=$(echo "$NEXT_OUT" | sed -n 's/^RESULT //p')
    NEXT_TRIES=$((NEXT_TRIES+1))
    [ "$NEXT" = "activated" ] && break
  done
  NEXT_LINK=$(readlink $P/current)
  NEXT_SERVED=""
  w=0
  while [ "$w" -lt 30 ]; do
    NEXT_SERVED=$(curl -s --max-time 1 http://127.0.0.1:19990/generation)
    [ "$NEXT_SERVED" = "gen-3" ] && break
    w=$((w+1)); sleep 0.1
  done

  if [ "$REC_PHASE" = "activated" ] && [ "$LINK" = "generations/gen-2" ] \
     && [ "$SERVED" = "gen-2" ] \
     && [ "$NEXT_LINK" = "generations/gen-3" ] && [ "$NEXT_SERVED" = "gen-3" ]; then
    RECOVERED=$((RECOVERED+1))
  else
    FAILED_POINTS="$FAILED_POINTS
      #$i $WHERE → phase=$REC_PHASE(${REC_TRIES}회) link=$LINK served=$SERVED next=$NEXT(${NEXT_TRIES}회) next_link=$NEXT_LINK next_served=$NEXT_SERVED"
    # **실패한 회차의 복구 로그를 남긴다.** 어느 지점이 깨졌는지만 알면 다음에 또
    # 재현부터 해야 한다.
    # **왜 실패했는지 그 자리에서 남긴다.** 게이트 안에서만 재현되는 종류가 있어서
    # (부하 의존), 나중에 로그를 찾아가면 이미 컨테이너가 없다.
    echo "        복구 로그:"; echo "$REC_OUT" | tail -4 | sed 's/^/          /'
    echo "        후속 로그:"; echo "$NEXT_OUT" | tail -4 | sed 's/^/          /'
  fi
  i=$((i+1))
done

echo "  지점 $TOTAL 개 중 실제로 죽은 것 $CRASHED, 못 지난 것 $MISSED"
[ -n "$MISSED_POINTS" ] && echo "  못 지난 지점:$MISSED_POINTS"
[ -n "$MISSED_POINTS" ] && echo "    (정상 경로가 재시도로 더 길어서 생긴 꼬리다 — 크래시 주입 실행은 그만큼 안 간다)"

if [ -z "$FAILED_POINTS" ] && [ "$CRASHED" -gt 0 ]; then
  ok S12.sweep "**전 지점에서 죽여도 복구가 gen-2 로 수렴하고, 다음 오퍼레이션이 막히지 않는다** ($CRASHED 개 전부, 복구 cycle $CYCLES 회 = 지점당 $((CYCLES * 100 / CRASHED))/100)"
else
  bad S12.sweep "수렴하지 못한 지점이 있다:$FAILED_POINTS"
fi

# ── 락 회수 ────────────────────────────────────────────────────────────
#
# 6차 반례 ⑤ 이고, 컨테이너에서 한 번 물렸다 — pid 1 이 항상 살아 있어 보여서 죽은
# 주인의 락을 회수하지 못했다. **abort 로 죽은 뒤 다음 프로세스가 잡을 수 있는가.**
restore
reset_engine
node /spike/runner.mjs $P 0 gen-2 >/dev/null 2>&1
if [ -f "$P/state/agent.json.lock" ]; then
  LOCKED="락 파일이 남아 있다"
else
  LOCKED="락 파일이 없다"
fi
# **출력을 붙잡는다.** 전에는 `RESULT` 줄만 걸러서, 실패했을 때 남는 것이
# "'failed' 였다" 뿐이었다 — 게이트에서 이 점이 간헐로 떨어질 때 그 한 줄로는 원인을
# 못 좁힌다. 나머지 줄을 함께 낸다.
REC_OUT=$(node /spike/runner.mjs $P none gen-2 2>&1)
REC=$(printf '%s' "$REC_OUT" | sed -n 's/^RESULT //p')
if [ "$REC" = "activated" ]; then
  ok S12.lock "**죽은 주인의 락을 회수한다** ($LOCKED → 다음 프로세스가 activated)"
else
  bad S12.lock "락을 회수하지 못했다 ($LOCKED → '$REC')"
  printf '%s\n' "$REC_OUT" | grep -v '^RESULT ' | tail -6 | sed 's/^/          /'
fi

# ── 중복 cycle 상한 ────────────────────────────────────────────────────
#
# **지표부터 검증한다.** 처음 짰을 때 grep 패턴이 `^POINT reload:before` 였는데 실제
# 형식은 `POINT <번호> reload:before` 라 **한 번도 안 맞았다.** 38 회 복구에 reload 0 회가
# 나왔고 그건 "유계" 가 아니라 **아무것도 안 센 것**이다. 통과할 수밖에 없는 체크는
# PASS 수만 부풀린다 (S19.same_digest 를 걷어낸 것과 같은 이유).
#
# §6.2 는 exactly-once 를 요구하지 않는다. 대신 **중복이 상한 이내**여야 한다 —
# 무한 재시도는 "결국 수렴한다" 와 구분되지 않는다.
restore
reset_engine
BASE_RELOADS=$(node /spike/runner.mjs $P none gen-2 2>&1 | grep -c '^POINT [0-9]* reload:before')
if [ "$BASE_RELOADS" -ge 1 ]; then
  ok S12.metric "**지표 검증** — 정상 경로가 reload 를 $BASE_RELOADS 회로 세어진다"
else
  bad S12.metric "정상 경로에서도 reload 가 0 으로 세어진다 — 아래 상한 판정은 무의미하다"
fi

RELOADS=0
i=0
while [ "$i" -lt "$TOTAL" ]; do
  restore
  reset_engine
  node /spike/runner.mjs $P "$i" gen-2 >/dev/null 2>&1
  N=$(node /spike/runner.mjs $P none gen-2 2>&1 | grep -c '^POINT [0-9]* reload:before')
  RELOADS=$((RELOADS+N))
  i=$((i+1))
done
AVG=$((RELOADS * 100 / TOTAL))
# **하한도 건다.** `<=` 만 보면 "아무것도 안 돌았다"(0 회)도 통과한다 — 변이 실험에서
# 실제로 그랬다. 유계라는 말은 위아래가 다 있어야 뜻이 있다.
if [ "$RELOADS" -ge 1 ] && [ "$RELOADS" -le "$((TOTAL * 2))" ]; then
  ok S12.bounded "**복구가 reload 를 한 번씩만 더 쓴다** — $TOTAL 회 복구에 reload $RELOADS 회 (평균 ${AVG}/100)"
else
  bad S12.bounded "복구의 reload 가 $RELOADS 회다 ($TOTAL 지점) — 0 이면 아무것도 안 돈 것이고, 상한을 넘으면 유계가 아니다"
fi

echo ""
echo "        error.log:"; tail -3 $P/logs/error.log 2>/dev/null | sed 's/^/          /'
echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → **크래시 저널이 성립한다.** 실제 프로세스를 전 지점에서 죽여도 복구가"
  echo "   같은 세대로 수렴하고, 죽은 주인의 락이 회수되며, 중복이 유계다."
else
  echo " → §12.0 규칙에 따라 **설계 재작업**을 검토해야 한다 (block 등급)."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
