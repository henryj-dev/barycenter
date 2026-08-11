#!/bin/sh
# S7 프로브 — 활성화 판정. 컨테이너 안에서 실행된다.
#
# 합격 기준 (TESTS.md §2): 오탐/미탐 0, 판정 시간 < 3s.
set -u

BIN=/usr/local/openresty/bin/openresty
P=/tmp/s7
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

apk add --no-cache busybox-extras curl >/dev/null 2>&1 || true
rm -rf $P; mkdir -p $P/conf $P/logs

# render <gen> [extra-listen-port]
render() {
  extra=""
  [ $# -ge 2 ] && extra="    server { listen 127.0.0.1:$2; return 200 \"X\"; }"
  sed -e "s/__GEN__/$1/" -e "s|    # __EXTRA_LISTEN__.*|$extra|" \
      /spike/nginx.conf.tmpl > $P/conf/nginx.conf
}
hup()     { kill -HUP "$(cat $P/logs/nginx.pid)"; }
runtime() { curl -s --max-time 3 http://127.0.0.1:8081/runtime 2>/dev/null; }
kv()      { echo "$1" | tr ' ' '\n' | grep "^$2=" | cut -d= -f2; }
serving_count() { echo "$1" | tr ' ' '\n' | grep '^serving=' | cut -d= -f2- \
                  | tr ',' '\n' | grep "^$2=" | cut -d= -f2; }
mark()    { curl -s --max-time 3 http://127.0.0.1:8081/mark >/dev/null 2>&1; }

# error log 의 emerg 개수. HUP 전후를 비교해 "워터마크 이후의 실패"를 가른다.
emergs() { c=$(grep -c '\[emerg\]' $P/logs/error.log 2>/dev/null); echo "${c:-0}"; }

# 판정 (§6.3). 두 신호를 **함께** 본다.
#   양성 — 목표 세대의 워커가 expected 만큼 살아 있고 accepting 이 그 세대다
#   음성 — 워터마크 이후 새 emerg 가 찍혔다  ← 이게 없으면 실패 판정이 타임아웃을 다 쓴다
# 반환: "ACTIVATED <ms>" | "FAILED <ms>" | "TIMEOUT <ms>"
judge() {
  target=$1; budget=$2; base=$3; i=0; el=-1
  while [ $i -lt "$budget" ]; do
    if [ "$(emergs)" -gt "$base" ]; then
      el=$(kv "$(runtime)" elapsed_ms); echo "FAILED ${el:--1}"; return 1
    fi
    line=$(runtime)
    exp=$(kv "$line" expected)
    acc=$(kv "$line" accepting)
    cnt=$(serving_count "$line" "$target")
    el=$(kv "$line" elapsed_ms)
    if [ "$acc" = "$target" ] && [ "${cnt:-0}" -ge "${exp:-99}" ]; then
      echo "ACTIVATED ${el:--1}"; return 0
    fi
    i=$((i + 1)); sleep 0.05
  done
  echo "TIMEOUT ${el:--1}"; return 1
}

echo ""
echo "=============================================================="
echo " S7 spike — 활성화 판정"
echo " $($BIN -v 2>&1)"
echo "=============================================================="

render 1
$BIN -t -p $P -c conf/nginx.conf 2>&1 | tail -1
$BIN -p $P -c conf/nginx.conf &
sleep 1.2
[ -s $P/logs/nginx.pid ] || { echo "기동 실패"; tail $P/logs/error.log; exit 1; }
echo "        $(runtime)"

# ── 기준선 ───────────────────────────────────────────────────────────────
mark
r=$(judge 1 60 "$(emergs)")
case "$r" in
  ACTIVATED*) ok S7.baseline "기동 직후 전 워커가 gen1 을 보고한다 ($r)" ;;
  *)          bad S7.baseline "기준선 판정 실패 ($r) — $(runtime)" ;;
esac

# ── A4.3 — shared dict 마커는 어느 세대가 응답했는지 말해주지 못한다 ─────
echo ""
echo "[A4.3] 마커를 shared dict 로 두면"
( curl -s --max-time 8 http://127.0.0.1:8080/slow > $P/slow.txt 2>/dev/null ) &
SL=$!
sleep 1
render 2
mark
hup
wait $SL 2>/dev/null
got=$(cat $P/slow.txt 2>/dev/null)
echo "        옛 세대가 응답한 내용: $got"
case "$got" in
  "baked=1 shared=2")
    ok A4.3 "in-flight 요청은 **gen1 워커**가 처리했는데 shared 마커는 2 라고 답한다 — 마커는 세대별 렌더 리터럴이어야 한다" ;;
  "baked=1 shared=1")
    bad A4.3 "shared 마커가 옛 값이다 — 새 워커가 아직 init 을 안 했을 뿐. 재시도 필요" ;;
  *) bad A4.3 "예상 밖: '$got'" ;;
esac

# ── S7.success — 정상 HUP 을 성공으로 판정한다 (미탐 0) ──────────────────
echo ""
echo "[S7] 정상 HUP"
render 3
E0=$(emergs)
mark
hup
r=$(judge 3 60 "$E0")
ms=$(echo "$r" | cut -d' ' -f2)
case "$r" in
  ACTIVATED*)
    if [ "${ms:-9999}" -lt 3000 ]; then
      ok S7.success "정상 HUP 을 ${ms}ms 만에 활성화로 판정 (< 3000ms)"
    else
      bad S7.success "판정은 됐으나 ${ms}ms 로 기준 초과"
    fi ;;
  *) bad S7.success "정상 HUP 을 활성화로 판정하지 못했다 ($r) — **미탐**" ;;
esac

# ── S7.fail — 포트 점유 상태의 HUP 을 실패로 판정한다 (오탐 0) ───────────
echo ""
echo "[S7] 포트가 점유된 상태의 HUP (E23 자동화)"
(timeout 25 nc -l -p 8099 >/dev/null 2>&1 &)
sleep 0.6
render 4 8099
if $BIN -t -p $P -c conf/nginx.conf >/dev/null 2>&1; then
  ok S7.test_passes "포트 점유 중에도 nginx -t 는 통과한다 — 검증은 증거가 아니다"
else
  bad S7.test_passes "nginx -t 가 예상과 달리 실패"
fi

before=$(grep -c 'bind()' $P/logs/error.log 2>/dev/null); before=${before:-0}
E0=$(emergs)
mark
hup
r=$(judge 4 60 "$E0")
ms=$(echo "$r" | cut -d' ' -f2)
case "$r" in
  FAILED*)
    if [ "${ms:-9999}" -lt 3000 ]; then
      ok S7.fail_detect "실패한 HUP 을 ${ms}ms 만에 실패로 판정 (< 3000ms) — 워터마크 이후 emerg 가 즉시 신호가 된다"
    else
      bad S7.fail_detect "판정은 됐으나 ${ms}ms 로 기준 초과"
    fi ;;
  TIMEOUT*)
    bad S7.fail_detect "타임아웃으로만 판정했다 ($r) — 워커 레지스트리만으로는 실패 판정이 예산을 다 쓴다" ;;
  *) bad S7.fail_detect "실패한 HUP 을 활성화로 오판했다 ($r) — **오탐**" ;;
esac

line=$(runtime)
[ "$(kv "$line" accepting)" = 3 ] \
  && ok S7.stays_old "accepting 이 여전히 gen3 이다 — 옛 세대가 서비스 중임을 정확히 반영" \
  || bad S7.stays_old "accepting=$(kv "$line" accepting) (기대 3)"

[ "$(curl -s --max-time 3 http://127.0.0.1:8080/ 2>/dev/null)" = BACKEND ] \
  && ok S7.traffic "실패한 HUP 뒤에도 옛 설정으로 트래픽이 흐른다" \
  || bad S7.traffic "트래픽이 끊겼다"

after=$(grep -c 'bind()' $P/logs/error.log 2>/dev/null); after=${after:-0}
[ "$after" -gt "$before" ] \
  && ok S7.errlog "error log 에 bind 실패가 새로 남았다 ($before → $after) — 보조 판정 신호" \
  || bad S7.errlog "bind 실패 흔적이 없다 ($before → $after)"

# ── S7.recover — 포트를 놓아주면 다시 활성화된다 ─────────────────────────
echo ""
echo "[S7] 점유 해제 후 재시도"
pkill -f 'nc -l -p 8099' 2>/dev/null || true
sleep 1.2
E0=$(emergs)
mark
hup
r=$(judge 4 80 "$E0")
ms=$(echo "$r" | cut -d' ' -f2)
case "$r" in
  ACTIVATED*) ok S7.recover "점유가 풀리자 같은 세대가 ${ms}ms 만에 활성화됐다" ;;
  *)          bad S7.recover "복구 실패 ($r) — $(runtime)" ;;
esac

echo ""
echo "        $(runtime)"
echo "        error.log:"; tail -3 $P/logs/error.log 2>/dev/null | sed 's/^/          /'
kill -QUIT "$(cat $P/logs/nginx.pid)" 2>/dev/null || true
sleep 0.4

echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → §6.3 판정 절차가 성립한다. ApplyOperation 스키마를 고정할 수 있다."
else
  echo " → 판정 절차 재설계 필요. ApplyOperation freeze 는 계속 block."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
