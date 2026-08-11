#!/bin/sh
# S11 프로브 — activation_epoch 경합. 컨테이너 안에서 실행된다.
#
# 검증하는 불변식 (TESTS.md P1·P7·P8·P15, DESIGN.md §3.3·§3.5·§6.5)
set -u

BIN=/usr/local/openresty/bin/openresty
P=/tmp/s11
T=10                      # leader token
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

apk add --no-cache busybox-extras curl >/dev/null 2>&1 || true
rm -rf $P; mkdir -p $P/conf $P/logs

render() { sed "s/__EPOCH__/$1/" /spike/nginx.conf.tmpl > $P/conf/nginx.conf; }
hup()    { kill -HUP "$(cat $P/logs/nginx.pid)"; sleep 0.8; }
get()    { curl -s --max-time 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:8080/ 2>/dev/null; }
body()   { curl -s --max-time 3 http://127.0.0.1:8080/ 2>/dev/null; }
stage()  { curl -s --max-time 3 -o /dev/null -w '%{http_code}' -X POST --data-binary "$3" \
             "http://127.0.0.1:8081/stage?token=$1&epoch=$2" 2>/dev/null; }
activate() { curl -s --max-time 3 -o /dev/null -w '%{http_code}' -X POST \
             "http://127.0.0.1:8081/activate?token=$1&epoch=$2" 2>/dev/null; }
state()  { curl -s --max-time 3 http://127.0.0.1:8081/state 2>/dev/null; }

echo ""
echo "=============================================================="
echo " S11 spike — activation_epoch 경합"
echo " $($BIN -v 2>&1)"
echo "=============================================================="

render 1
$BIN -t -p $P -c conf/nginx.conf 2>&1 | tail -1
$BIN -p $P -c conf/nginx.conf &
sleep 1
[ -s $P/logs/nginx.pid ] || { echo "기동 실패"; tail $P/logs/error.log; exit 1; }

# ── 준비: E1 = A ─────────────────────────────────────────────────────────
stage    $T 1 "127.0.0.1:9001" >/dev/null
activate $T 1 >/dev/null
[ "$(body)" = BACKEND_A ] || { echo "초기 상태 실패: $(body)"; exit 1; }
echo "        $(state)"

# ── P7 (admin) — staging 되지 않은 epoch 은 활성화할 수 없다 ─────────────
echo ""
echo "[P7] staging 되지 않은 epoch"
code=$(activate $T 99)
[ "$code" = 409 ] && ok P7.admin "미staging epoch 활성화 거부 (409)" \
                  || bad P7.admin "기대 409, 실제 $code"

# ── P8 — HUP 뒤 옛 세대는 어디까지 살아 있는가 ───────────────────────────
#
# 3차 검수는 "옛 HTTP 워커가 기존 keepalive 연결에서 새 요청을 계속 처리하므로 E-old
# 멤버십이 필요하다"고 했다. 앞부분이 사실인지부터 확인한다.
echo ""
echo "[P8] HUP 뒤 옛 세대의 수명"

# (a) 대조군 — HUP 이 없으면 keepalive 재사용이 된다
{ printf 'GET / HTTP/1.1\r\nHost: x\r\n\r\n'
  sleep 2
  printf 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'
  sleep 1
} | timeout 8 nc 127.0.0.1 8080 > $P/ka_control.txt 2>/dev/null
n=$(tr -d '\r' < $P/ka_control.txt | grep -c 'HTTP/1.1 200')
[ "$n" = 2 ] && ok P8.control "HUP 없으면 keepalive 로 응답 2개 — 재사용은 정상 동작한다" \
             || bad P8.control "대조군에서 응답 $n 개 (기대 2)"

# (b) HUP 을 끼우면 유휴 keepalive 연결이 닫힌다
{ printf 'GET / HTTP/1.1\r\nHost: x\r\n\r\n'
  sleep 3
  printf 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'
  sleep 1
} | timeout 9 nc 127.0.0.1 8080 > $P/keepalive.txt 2>/dev/null &
KA=$!
sleep 1

render 2
stage    $T 2 "127.0.0.1:9002" >/dev/null      # E2 = B
activate $T 2 >/dev/null
hup

new_conn=$(body)
[ "$new_conn" = BACKEND_B ] && ok P8.new "새 연결은 E2(B) 로 간다" \
                            || bad P8.new "새 연결 기대 BACKEND_B, 실제 '$new_conn'"

wait $KA 2>/dev/null
n=$(tr -d '\r' < $P/keepalive.txt | grep -c 'HTTP/1.1 200')
seq=$(tr -d '\r' < $P/keepalive.txt | grep -o 'BACKEND_[AB]' | tr '\n' ' ')
echo "        HUP 끼운 keepalive: 응답 ${n}개 [$seq]"
if [ "$n" = 1 ]; then
  ok P8.keepalive_closed "**HUP 이 유휴 keepalive 연결을 닫는다** — 옛 워커가 그 연결에서 새 요청을 받지 않는다"
elif [ "$seq" = "BACKEND_A BACKEND_A " ]; then
  bad P8.keepalive_closed "연결이 유지되고 E-old 를 썼다 — 3차 검수 전제가 맞다. §3.4 재작성 필요"
else
  bad P8.keepalive_closed "예상 밖: 응답 ${n}개 [$seq]"
fi

# (c) 그렇다면 E-old 는 왜 필요한가 — HUP 을 가로지르는 in-flight 요청
render 5
stage    $T 5 "127.0.0.1:9004" >/dev/null      # E5 = 느린 백엔드
activate $T 5 >/dev/null
hup
( timeout 9 curl -s --max-time 8 http://127.0.0.1:8080/ > $P/inflight.txt 2>/dev/null ) &
IF=$!
sleep 1
render 6
stage    $T 6 "127.0.0.1:9002" >/dev/null      # E6 = B
activate $T 6 >/dev/null
hup                                            # 요청이 흐르는 중에 세대 전환
wait $IF 2>/dev/null
got=$(cat $P/inflight.txt 2>/dev/null)
[ "$got" = BACKEND_SLOW ] \
  && ok P8.inflight "HUP 을 가로지른 in-flight 요청이 **옛 세대에서 완료된다** — E-old 세대는 계속 살아 있다" \
  || bad P8.inflight "in-flight 요청이 완료되지 않았다: '$got'"

# 이후 테스트를 위해 E3 계열로 되돌린다
render 3
stage    $T 3 "127.0.0.1:9001" >/dev/null
activate $T 3 >/dev/null 2>&1 || true

# ── P1 — ABA. 롤백은 옛 topology 를 **새 epoch** 로 활성화한다 ───────────
echo ""
echo "[P1] 롤백 후 지연된 옛 epoch RPC"
render 7
stage    $T 7 "127.0.0.1:9001" >/dev/null      # E7 = A (E1 과 같은 topology, 새 epoch)
activate $T 7 >/dev/null
hup
rolled=$(body)
[ "$rolled" = BACKEND_A ] && ok P1.rollback "롤백이 옛 topology(A) 를 **새 epoch(E7)** 로 활성화했다" \
                          || bad P1.rollback "롤백 후 기대 BACKEND_A, 실제 '$rolled'"

# v2 설계였다면 여기서 E1 이 다시 활성이라 아래 지연 RPC 가 먹혔다.
code=$(stage $T 1 "127.0.0.1:9003")            # 지연된 옛 리더의 델타 (EVIL)
[ "$code" = 409 ] && ok P1.stale_stage "지연된 (E1) 델타를 거부한다 — active=7 (409)" \
                  || bad P1.stale_stage "기대 409, 실제 $code"

code=$(activate $T 1)
[ "$code" = 409 ] && ok P1.not_monotonic "epoch 되돌리기(activate E1) 거부 — 엄격 단조 (409)" \
                  || bad P1.not_monotonic "기대 409, 실제 $code"

after=$(body)
[ "$after" = BACKEND_A ] && ok P1.traffic "지연 RPC 이후에도 트래픽은 A 그대로 — EVIL 로 새지 않았다" \
                         || bad P1.traffic "트래픽이 오염됐다: '$after'"

# ── P15 — leader token 펜싱 ──────────────────────────────────────────────
echo ""
echo "[P15] leader token 펜싱"
code=$(stage 9 8 "127.0.0.1:9003")
[ "$code" = 409 ] && ok P15.lower "더 낮은 토큰(9 < 10) 거부" || bad P15.lower "기대 409, 실제 $code"

code=$(stage 11 8 "127.0.0.1:9002")
[ "$code" = 200 ] && ok P15.higher "더 높은 토큰(11) 수용" || bad P15.higher "기대 200, 실제 $code"

code=$(stage 10 8 "127.0.0.1:9003")
[ "$code" = 409 ] && ok P15.demoted "한 번 11 을 본 뒤에는 옛 리더(10) 를 전부 거부" \
                  || bad P15.demoted "기대 409, 실제 $code"

after=$(body)
[ "$after" = BACKEND_A ] && ok P15.traffic "토큰 경합 중에도 활성 세대(E7=A) 는 흔들리지 않는다" \
                         || bad P15.traffic "트래픽 오염: '$after'"

# ── P7 (dataplane) — staging 안 된 세대로 HUP 하면 조용히 옛 peer 로 가지 않는다 ──
echo ""
echo "[P7] staging 없이 새 세대로 HUP (마지막 — 서비스가 깨진다)"
render 9
hup
code=$(get)
[ "$code" = 503 ] && ok P7.dataplane "슬롯이 없으면 **503 으로 실패한다** — 옛 peer 로 조용히 흘러가지 않는다" \
                  || bad P7.dataplane "기대 503, 실제 $code (조용히 옛 peer 로 갔을 수 있다)"

echo ""
echo "        $(state)"
echo "        error.log:"; tail -3 $P/logs/error.log 2>/dev/null | sed 's/^/          /'
kill -QUIT "$(cat $P/logs/nginx.pid)" 2>/dev/null || true
sleep 0.4

echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → §3.3 activation_epoch 분리 · §3.5 리더 펜싱 · §6.5 세대별 슬롯이 성립한다."
else
  echo " → 불변식에 구멍이 있다. 설계 재작업 대상 (S11 은 block)."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
