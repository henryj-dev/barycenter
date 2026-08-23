#!/usr/bin/env bash
# S15 스파이크 러너 — 밸런서 품질 (DESIGN.md §12.0, §4.3)
#
#   ./spike/s15/run.sh [image]
#
# 합격 기준(§12.0): RR 공정성 편차 < 5%, hash 재매핑률, 재시도·failure penalty 동작,
#                   CPU/p99 오버헤드 < 10%.
# 실패 시 규칙: 알고리즘 축소.
#
# ── 무엇을 재고 무엇을 안 재는가
#
# 네 축 중 **셋을 잰다.** 넷째(재시도·failure penalty)는 잴 대상이 없다 —
# `passive`(max_fails·fail_timeout)가 §4.3 표에 적혀 있을 뿐 **모델에 없고 렌더에도
# 없다**. 없는 것을 "쟀는데 0 이다" 로 적으면 그건 측정이 아니라 은폐다. 그래서 그
# 축은 SKIP 으로 내고 이유를 함께 낸다.
#
# ── 왜 엔진 안에서 재나
#
# `ngx.crc32_short` 는 nginx 의 함수다. 재매핑률을 밖에서 재려면 그 함수를 다시
# 구현해야 하고, 그러면 재는 것은 **우리 구현이지 엔진이 아니다.** 밸런서가 실제로
# 쓰는 식을 그대로 엔진 안에서 돌린다.
#
# ── 재매핑률이 이 스파이크의 이유다
#
# `render.ts` 가 이렇게 적어 두었다:
#
#   > **consistent hashing 은 아니다.** 정적 경로의 `consistent` 는 peer 가 바뀔 때
#   > 재매핑을 최소화하는데, 여기 `% n` 은 목록이 바뀌면 거의 전부 재매핑된다.
#   > 멤버십이 자주 바뀌는 것이 이 평면의 이유이므로 **이건 실제로 다른 계약이다** —
#   > S15 가 잴 축이고, 지금은 그 사실을 여기 적어 둔다.
#
# "거의 전부" 를 숫자로 바꾼다. 이상적인 consistent hashing 은 peer 하나가 늘 때
# 1/(n+1) 만 옮긴다 — 그 값도 함께 내서 **얼마나 다른지**가 보이게 한다.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
NAME=bary-s15-engine
PORT=19150

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf "  PASS  %-22s %s\n" "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf "  FAIL  %-22s %s\n" "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); printf "  SKIP  %-22s %s\n" "$1" "$2"; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; }
trap cleanup EXIT
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "  이미 S15 가 돌고 있다 ($NAME 이 있다). 끝나고 다시 돌린다."
  exit 2
fi
cleanup >/dev/null 2>&1

echo ""
echo "=============================================================="
echo " S15 spike — 밸런서 품질"
echo " image: $IMAGE"
echo "=============================================================="
echo ""

WORK="$(mktemp -d)"
trap 'cleanup; rm -rf "$WORK"' EXIT
cp "$HERE/probe.lua" "$WORK/probe.lua"
cat > "$WORK/nginx.conf" <<EOF
worker_processes 1;
error_log /dev/stderr warn;
events { worker_connections 32; }
http {
  access_log off;
  server {
    listen $PORT;
    location /probe { content_by_lua_file /w/probe.lua; }
  }
}
EOF

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:$PORT" -v "$WORK:/w:ro" \
  -v "$WORK/nginx.conf:/usr/local/openresty/nginx/conf/nginx.conf:ro" \
  "$IMAGE" >/dev/null || { echo "  기동 실패"; exit 1; }

for _ in $(seq 1 40); do
  if docker exec "$NAME" sh -c "echo > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then break; fi
  sleep 0.25
done
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "  엔진이 죽었다:"; docker logs "$NAME" 2>&1 | tail -20; exit 1
fi

RAW="$(docker exec "$NAME" sh -c \
  "wget -q -O - http://127.0.0.1:$PORT/probe 2>/dev/null || curl -s http://127.0.0.1:$PORT/probe")"
R="${RAW#*---json---}"
if [ -z "$R" ] || [ "$R" = "$RAW" ]; then
  echo "  프로브 출력이 없다:"; echo "$RAW" | head -5
  docker logs "$NAME" 2>&1 | tail -10; exit 1
fi
echo "$R" | tr ',' '\n' | sed 's/^/    /'
echo ""

# jq 없이 읽는다 — 이미지에 있는 것만 쓴다.
v() { printf '%s' "$R" | sed -n "s/.*\"$1\":\([0-9.]*\).*/\1/p"; }
# 소수 비교를 셸에서 한다: awk 가 alpine 에도 있다.
le() { awk -v a="$1" -v b="$2" 'BEGIN { exit !(a <= b) }'; }

# ── S15.1 RR 공정성 < 5% ────────────────────────────────────────────────
rr_bad=0
for n in 3 7 16; do
  d="$(v "rr_dev_$n")"
  le "$d" 5 || { rr_bad=1; echo "      rr n=$n 편차 ${d}%"; }
done
[ "$rr_bad" -eq 0 ] \
  && ok S15.1 "RR 공정성 편차 < 5% (n=3·7·16)" \
  || bad S15.1 "RR 공정성이 기준을 넘었다"

# ── S15.2 hash 분포 — **두 입력 분포로 잰다** ──────────────────────────
#
# 해시는 균등해야 하는 것이 **아니다** — 같은 키가 같은 곳으로 가는 것이 목적이다.
# 그래도 한쪽으로 쏠리면 그건 알아야 할 사실이다.
#
# 한 분포만 재면 결과가 해시의 성질인지 내 키 생성의 성질인지 구분되지 않는다. 그래서
# 둘로 잰다 — 흩어진 주소(인터넷)와 한 /16 안의 연속 주소(사내망·NAT·클라우드 서브넷).
# 판정은 **흩어진 쪽**으로 한다. 서브넷 쪽이 쏠리는 것은 해시의 결함이 아니라 입력의
# 성질이고, 그때 할 말은 "해시를 바꿔라" 가 아니라 "서브넷 트래픽에서는 쏠린다" 다.
echo "  ----  hash 분포 (최대 편차)"
for n in 3 7 16; do
  printf "        n=%-2s   흩어짐 %8s%%   서브넷 %8s%%\n" \
    "$n" "$(v "hash_dev_spread_$n")" "$(v "hash_dev_subnet_$n")"
done
h_bad=0
for n in 3 7 16; do
  d="$(v "hash_dev_spread_$n")"
  le "$d" 25 || { h_bad=1; echo "      흩어진 주소 n=$n 편차 ${d}%"; }
done
[ "$h_bad" -eq 0 ] \
  && ok S15.2 "흩어진 주소에서는 안 쏠린다 (편차 < 25%)" \
  || bad S15.2 "흩어진 주소에서도 쏠린다 — 해시 자체의 문제다"

# ── S15.3 재매핑률 — **숫자를 낸다** ────────────────────────────────────
#
# 여기는 합격/불합격이 아니다. §12.0 의 기준이 "hash 재매핑률" 이라고만 적혀 있고
# 문턱이 없다 — 문턱을 지금 지어내면 그건 측정이 아니라 발명이다. 대신 **이상값과
# 나란히** 내서 §4.3 의 "다른 계약이다" 가 얼마나 다른지 보이게 한다.
echo "  ----  재매핑률 (peer 하나 추가)"
for n in 3 7 16; do
  got="$(v "remap_${n}_to_$((n+1))")"
  ideal="$(v "remap_ideal_${n}_to_$((n+1))")"
  printf "        n=%-2s → %-2s   우리 %6s%%   consistent 이상값 %6s%%\n" \
    "$n" "$((n+1))" "$got" "$ideal"
done
# 우리 값이 이상값보다 **훨씬** 크다는 것만 못 박는다. 비슷하면 주석이 틀린 것이다.
r3="$(v remap_3_to_4)"; i3="$(v remap_ideal_3_to_4)"
if le "$r3" "$i3"; then
  bad S15.3 "재매핑률이 이상값 이하다 — §4.3 의 '다른 계약이다' 가 사실이 아니다"
else
  ok S15.3 "재매핑률이 consistent 이상값보다 크다 — §4.3 의 서술이 사실이다 (${r3}% vs ${i3}%)"
fi

# ── S15.4 고르는 비용 ──────────────────────────────────────────────────
ns_rr="$(v ns_rr)"; ns_hash="$(v ns_hash)"
printf "  ----  %-22s rr %sns · hash %sns (요청당 한 번)\n" "고르는 비용" "$ns_rr" "$ns_hash"
# 요청 처리는 마이크로초 단위다. 고르는 식이 1µs 를 넘으면 그건 다른 얘기가 된다.
if le "$ns_rr" 1000 && le "$ns_hash" 1000; then
  ok S15.4 "고르는 식이 요청당 1µs 미만 — 오버헤드는 이 식이 아니다"
else
  bad S15.4 "고르는 식이 1µs 를 넘는다: rr=${ns_rr}ns hash=${ns_hash}ns"
fi

# ── S15.5 재시도·failure penalty — 잴 대상이 없다 ──────────────────────
skip S15.5 "재시도·failure penalty 는 **모델에 없다** — §4.3 표의 \`passive\`(max_fails·"
printf "        %s\n" "fail_timeout)가 Pool 타입에도 렌더에도 없다. 없는 것을 '쟀는데 0' 으로"
printf "        %s\n" "적으면 은폐다. 이 축은 그 필드가 생긴 뒤에 잰다."

echo ""
echo "  PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ]
