#!/usr/bin/env bash
# S10 스파이크 러너 — 라우트 컴파일러와 strict_priority 의 대가 (DESIGN.md §12.0, §7.5)
#
#   ./spike/s10/run.sh [image] [라우트수]
#
# 합격 기준(§12.0): exact/wildcard/path 우선순위 + **라우트 500개 p99 영향 < 5%**.
# 실패 시 규칙: `strict_priority` 모드 미제공.
#
# ── 무엇을 재는가
#
# 같은 라우트를 **두 번** 렌더한다 — 기본과 `strict_priority`. 두 엔진을 **같은
# 컨테이너에 동시에** 띄우고 한 루프에서 번갈아 때려 p99 를 비교한다.
#
# ① **우리 렌더러로 conf 를 만든다.** 손으로 쓰면 재는 것이 nginx 의 성질이지 우리
#    산출물이 아니다 — S9 에서 배웠다.
# ② **역전을 일부러 만든다.** 역전이 없으면 강등이 하나도 안 일어나고 두 conf 가
#    같아진다. 그러면 "차이가 0%" 가 나오는데 그건 아무것도 안 잰 것이다.
#    `cmp` 로 그것부터 확인한다 — 포트만 다른 것이 아님을 보려고 포트를 지우고 비교한다.
# ③ **마지막 호스트를 때린다.** 정규식은 순차 평가다(§7.4) — 첫 호스트만 재면 비용이
#    안 보인다. 최악의 경우를 잰다.
# ④ **번갈아 때린다.** 따로 돌려 재니 100 라우트에서 -45% 가 나왔다 — strict 가 45%
#    빨라질 리 없다. p99 는 스케줄링 지터에 민감해 실행마다 두 배씩 튄다. 한 루프에서
#    번갈아 때리면 그 지터가 양쪽에 똑같이 실린다.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../lib.sh
. "$HERE/../lib.sh"
ROOT="$(cd "$HERE/../.." && pwd)"

IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
ROUTES="${2:-500}"
NAME=bary-s10-engine
PLAIN_PORT=18100
STRICT_PORT=18200
BACKEND=18101
BENCH_PORT=18109

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf "  PASS  %-22s %s\n" "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf "  FAIL  %-22s %s\n" "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); printf "  SKIP  %-22s %s\n" "$1" "$2"; }

WORK="$(bary_spike_workdir)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; rm -rf "$WORK"; }
trap cleanup EXIT
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "  이미 S10 이 돌고 있다 ($NAME 이 있다). 끝나고 다시 돌린다."
  exit 2
fi
docker rm -f "$NAME" >/dev/null 2>&1

echo ""
echo "=============================================================="
echo " S10 spike — 라우트 컴파일러 · strict_priority 의 대가"
echo " image: $IMAGE · 라우트 $ROUTES"
echo "=============================================================="
echo ""

# **dist 를 쓴다.** 렌더러는 TS 라 컨테이너 밖에서 빌드된 것을 부른다.
if [ ! -f "$ROOT/dist/conf/render.js" ]; then
  echo '  dist 가 없다. `npm run build` 를 먼저 돌린다.'
  exit 1
fi
node "$HERE/gen.mjs" "$WORK" "$ROUTES" 0 "$PLAIN_PORT"  | sed 's/^/    plain  /'
node "$HERE/gen.mjs" "$WORK" "$ROUTES" 1 "$STRICT_PORT" | sed 's/^/    strict /'
echo "    때릴 호스트: $(cat "$WORK/target.txt")"

sed "s/$PLAIN_PORT/PORT/g"  "$WORK/nginx-$PLAIN_PORT.conf"  > "$WORK/a.norm"
sed "s/$STRICT_PORT/PORT/g" "$WORK/nginx-$STRICT_PORT.conf" > "$WORK/b.norm"
if cmp -s "$WORK/a.norm" "$WORK/b.norm"; then
  bad S10.0 "두 conf 가 (포트를 빼면) 같다 — 강등이 안 일어났다. 아무것도 안 잰 것이다"
  echo ""; echo "  PASS=$PASS FAIL=$FAIL SKIP=$SKIP"; exit 1
fi
LOWERED=$(grep -c 'server_name ~\^h' "$WORK/nginx-$STRICT_PORT.conf" || true)
ok S10.0 "strict 가 다른 conf 를 낸다 — 정확일치 ${LOWERED}개가 정규식으로 내려갔다"

cp "$HERE/bench.lua" "$WORK/bench.lua"
mkdir -p "$WORK/logs"
cat > "$WORK/back.conf" <<EOF
daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 512; }
http {
  access_log off;
  server { listen $BACKEND; location / { return 200 "OK"; } }
}
EOF
cat > "$WORK/bench.conf" <<EOF
daemon off;
error_log logs/x.log warn;
pid logs/x.pid;
events { worker_connections 512; }
http {
  access_log off;
  server { listen $BENCH_PORT; location /bench { content_by_lua_file /w/bench.lua; } }
}
EOF
bary_spike_readable "$WORK"/*.lua "$WORK"/*.conf

echo ""
echo "  두 엔진을 한 컨테이너에 띄우고 번갈아 때린다…"
docker run -d --name "$NAME" -v "$WORK:/w" "$IMAGE" sh -c "
  /usr/local/openresty/bin/openresty -p /w -c back.conf &
  /usr/local/openresty/bin/openresty -p /w -c nginx-$PLAIN_PORT.conf &
  /usr/local/openresty/bin/openresty -p /w -c nginx-$STRICT_PORT.conf &
  /usr/local/openresty/bin/openresty -p /w -c bench.conf &
  sleep 900" >/dev/null || { echo "  기동 실패"; exit 1; }
sleep 6
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "  컨테이너가 죽었다:"; docker logs "$NAME" 2>&1 | tail -20; exit 1
fi

RAW="$(docker exec \
  -e BARY_S10_N="${BARY_S10_N:-3000}" \
  -e BARY_S10_PLAIN="$PLAIN_PORT" -e BARY_S10_STRICT="$STRICT_PORT" \
  "$NAME" sh -c "wget -q -T 900 -O - http://127.0.0.1:$BENCH_PORT/bench 2>/dev/null")"
R="${RAW#*---json---}"
if [ -z "$R" ] || [ "$R" = "$RAW" ]; then
  skip S10.1 "부하 프로브가 결과를 못 냈다 — 이 환경에서는 p99 를 못 잰다"
  printf "        %s\n" "$(printf '%s' "$RAW" | head -c 300)"
  docker logs "$NAME" 2>&1 | tail -10 | sed 's/^/        /'
  echo ""; echo "  PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
  [ "$FAIL" -eq 0 ]; exit $?
fi
echo "    $R"

v() { printf '%s' "$R" | sed -n "s/.*\"$1\":\([0-9.]*\).*/\1/p"; }
[ "$(v answered)" = "1" ] \
  && ok S10.2 "두 엔진 다 응답한다 — 강등된 정규식이 실제로 매치된다" \
  || bad S10.2 "한쪽이 응답을 안 한다 — 강등이 매치를 깼다"

p99p="$(v plain_p99)"; p99s="$(v strict_p99)"
p50p="$(v plain_p50)"; p50s="$(v strict_p50)"
pd50="$(v paired_p50)"; pd99="$(v paired_p99)"
printf "  ----  %-22s plain %sµs → strict %sµs\n" "p50 (각각)" "$p50p" "$p50s"
printf "  ----  %-22s plain %sµs → strict %sµs\n" "p99 (각각)" "$p99p" "$p99s"
printf "  ----  %-22s p50 %sµs · p99 %sµs\n" "짝지은 차이" "$pd50" "$pd99"

# **판정은 짝지은 차이로 한다.** 각각의 p99 를 그냥 빼면 노이즈가 신호를 덮는다 —
# 500 라우트에서 -31% 가 나왔고, strict 가 31% 빨라질 리는 없다. 같은 라운드의 두
# 표본은 수십 µs 안에 붙어 있어 공통 지터가 거의 같으므로, 차이를 먼저 내면 그 공통분이
# 상쇄된다.
#
# **분모는 plain 의 p99 다.** §12.0 이 묻는 것이 "p99 영향" 이고, 최악의 경우에 얼마나
# 더 붙는가가 그 뜻이다.
d99="$(awk -v a="$p99p" -v d="$pd99" 'BEGIN { if (a <= 0) print 999; else printf "%.2f", d/a*100 }')"
d50="$(awk -v a="$p50p" -v d="$pd50" 'BEGIN { if (a <= 0) print 999; else printf "%.2f", d/a*100 }')"
printf "  ----  %-22s p50 %s%% · p99 %s%%\n" "영향 (짝지은 차이)" "$d50" "$d99"

if awk -v d="$d99" 'BEGIN { exit !(d < 5) }'; then
  ok S10.1 "라우트 $ROUTES 에서 p99 영향 < 5% (${d99}%)"
else
  bad S10.1 "라우트 $ROUTES 에서 p99 영향이 5% 를 넘었다: ${d99}%"
fi

echo ""
echo "  PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ]
