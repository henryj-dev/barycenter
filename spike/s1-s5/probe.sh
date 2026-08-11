#!/bin/sh
# S1/S5 프로브 — 컨테이너 안에서 실행된다.
set -u

BIN=/usr/local/openresty/bin/openresty
P=/tmp/s1s5
PASS=0; FAIL=0

ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

apk add --no-cache busybox-extras curl >/dev/null 2>&1 || true

rm -rf $P; mkdir -p $P/conf $P/logs
cp /spike/nginx.conf $P/conf/nginx.conf

echo ""
echo "=============================================================="
echo " S1 / S5 spike — $($BIN -v 2>&1)"
echo "=============================================================="

$BIN -t -p $P -c conf/nginx.conf 2>&1 | tail -1
$BIN -p $P -c conf/nginx.conf &
sleep 1
MASTER=$(cat $P/logs/nginx.pid 2>/dev/null || echo "")
[ -n "$MASTER" ] || { echo "기동 실패"; cat $P/logs/error.log 2>/dev/null | tail; exit 1; }
echo "master pid=$MASTER  workers=$(pgrep -P "$MASTER" | wc -l | tr -d ' ')"

# ── 헬퍼 ────────────────────────────────────────────────────────────────
http_get()  { curl -s --max-time 3 "http://127.0.0.1:$1$2" 2>/dev/null; }
push_http() { curl -s --max-time 3 -X POST --data-binary "$1" http://127.0.0.1:8081/http 2>/dev/null; }
tcp_probe() { { printf ''; sleep 0.6; } | timeout 3 nc 127.0.0.1 "$1" 2>/dev/null | tr -d '\r\n'; }
push_line() { { printf '%s\n' "$2"; sleep 0.6; } | timeout 3 nc 127.0.0.1 "$1" 2>/dev/null | tr -d '\r\n'; }
udp_probe() { { printf 'x'; sleep 0.6; } 2>/dev/null | timeout 3 nc -u -w2 127.0.0.1 "$1" 2>/dev/null | tr -d '\r\n'; }

reloads() { grep -c 'signal process started\|reconfiguring' "$P/logs/error.log" 2>/dev/null || echo 0; }
RELOADS_BEFORE=$(reloads)

# ── S1-A: HTTP ──────────────────────────────────────────────────────────
echo ""
echo "[S1] balancer_by_lua 로 reload 없이 백엔드 전환"

push_http "127.0.0.1:9001" >/dev/null; sleep 0.2
r1=$(http_get 8080 /)
push_http "127.0.0.1:9002" >/dev/null
r2=$(http_get 8080 /)          # 지연 없이 **첫 요청**
if [ "$r1" = A ] && [ "$r2" = B ]; then
  ok S1.http "HTTP — 전환 후 첫 요청부터 반영 (A→B)"
else
  bad S1.http "HTTP — 기대 A→B, 실제 '$r1'→'$r2'"
fi

# ── S1-B: TCP (stream) ──────────────────────────────────────────────────
push_line 8091 "127.0.0.1:9101" >/dev/null; sleep 0.2
t1=$(tcp_probe 8090)
push_line 8091 "127.0.0.1:9102" >/dev/null
t2=$(tcp_probe 8090)
if [ "$t1" = A ] && [ "$t2" = B ]; then
  ok S1.tcp "TCP — 전환 후 첫 연결부터 반영 (A→B)"
else
  bad S1.tcp "TCP — 기대 A→B, 실제 '$t1'→'$t2'"
fi

# ── S1-C: UDP (stream) ──────────────────────────────────────────────────
push_line 8093 "127.0.0.1:9201" >/dev/null; sleep 0.2
u1=$(udp_probe 8092)
push_line 8093 "127.0.0.1:9202" >/dev/null
u2=$(udp_probe 8092)
if [ "$u1" = A ] && [ "$u2" = B ]; then
  ok S1.udp "UDP — 전환 후 첫 세션부터 반영 (A→B)"
else
  bad S1.udp "UDP — 기대 A→B, 실제 '$u1'→'$u2'"
fi

# ── S1-D: reload 가 정말 일어나지 않았는가 ──────────────────────────────
RELOADS_AFTER=$(reloads)
if [ "$RELOADS_BEFORE" = "$RELOADS_AFTER" ]; then
  ok S1.noreload "전 과정에서 reload 0회 (error.log 기준)"
else
  bad S1.noreload "reload 흔적이 늘었다: $RELOADS_BEFORE → $RELOADS_AFTER"
fi
NOW_MASTER=$(cat $P/logs/nginx.pid 2>/dev/null)
if [ "$NOW_MASTER" = "$MASTER" ]; then
  ok S1.samemaster "마스터 PID 불변 ($MASTER)"
else
  bad S1.samemaster "마스터가 바뀌었다: $MASTER → $NOW_MASTER"
fi

# ── S5: 워커 수렴 ───────────────────────────────────────────────────────
echo ""
echo "[S5] 이중 zone 과 전 워커 수렴"

if [ "$(http_get 8081 /crosszone)" = NOT_VISIBLE ]; then
  ok S5.zones "http Lua 에서 stream zone 이 보이지 않는다 — 이중 평면 확정 (E25 재확인)"
else
  bad S5.zones "stream zone 이 http 에서 보인다 — 설계 §3.4 재검토"
fi

# 새 리비전을 밀고, **모든** 워커가 그것을 채택할 때까지의 지연을 잰다.
# 두 가지를 피해야 한다.
#   · 요청을 때려서 세면 커널의 accept 분배 운에 좌우된다 → 워커가 스스로 보고한다.
#   · busybox date 는 %N 을 지원하지 않는다 → 시각은 엔진 안에서 ngx.now() 로 잰다.
WORKERS=$(http_get 8081 "/converged?rev=-999" | cut -d' ' -f2)
TARGET=$(push_http "127.0.0.1:9001")
echo "        목표 리비전=$TARGET, 워커 $WORKERS 개"
CONVERGED=""
LAG=-1
hit=0
i=0
while [ $i -lt 400 ]; do
  line=$(http_get 8081 "/converged?rev=$TARGET")
  hit=$(echo "$line" | cut -d' ' -f1)
  total=$(echo "$line" | cut -d' ' -f2)
  LAG=$(echo "$line" | cut -d' ' -f3)
  if [ "$hit" = "$total" ]; then CONVERGED=yes; break; fi
  i=$((i+1))
done

if [ -n "$CONVERGED" ] && [ "$LAG" -ge 0 ]; then
  if [ "$LAG" -lt 500 ]; then
    ok S5.converge "워커 $WORKERS 개 전부가 새 리비전을 채택 — 가장 늦은 워커 ${LAG}ms (< 500ms, 동기화 주기 20ms)"
  else
    bad S5.converge "수렴은 했지만 가장 늦은 워커가 ${LAG}ms 로 기준(500ms) 초과"
  fi
else
  bad S5.converge "워커 수렴 실패 — ${hit}/${WORKERS}, lag=${LAG}"
fi

# 실제로 balancer 가 워커별 캐시를 새로 만들었는지 — 트래픽으로 확인
push_http "127.0.0.1:9002" >/dev/null
mism=0; k=0
while [ $k -lt 30 ]; do
  [ "$(http_get 8080 /)" = B ] || mism=$((mism+1))
  k=$((k+1))
done
if [ "$mism" -eq 0 ]; then
  ok S5.perworker "전환 직후 30요청 전부 새 peer — 워커별 캐시가 즉시 교체된다"
else
  bad S5.perworker "30요청 중 ${mism}건이 옛 peer 로 갔다 — 워커 수렴에 구멍"
fi

# ── 정리 ────────────────────────────────────────────────────────────────
echo ""
echo "        error.log 마지막:"
tail -3 "$P/logs/error.log" 2>/dev/null | sed 's/^/          /'
kill -QUIT "$MASTER" 2>/dev/null || true
sleep 0.5

echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → S1/S5 통과. OpenResty 멤버십 평면 경로가 성립한다."
else
  echo " → 실패 항목 있음. §7.3 대안 B(순수 nginx + DNS resolve) 검토 대상."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
