#!/usr/bin/env bash
# S14 스파이크 러너 — 대안 B(엔진 네이티브 DNS 디스커버리) 실증 (DESIGN.md §12.0, §7.3)
#
#   ./spike/s14/run.sh
#
# 합격 기준: HTTP/TCP/UDP × A/AAAA/SRV × TTL/NXDOMAIN/timeout, 기존 세션 거동.
# 실패 시 규칙: **폴백 자체가 없음 → 요구 재조정.**
#
# ── 무엇을 재는가 ───────────────────────────────────────────────────────
#
# S1 이 통과해서 OpenResty 멤버십 평면이 정본이 됐고, 대안 B 는 **폴백**으로만 남았다.
# 그런데 §7.3 은 그 폴백의 범위를 표로 적어 두기만 했지 **재 본 적이 없다.** 특히:
#
#   *"NXDOMAIN 과 timeout/SERVFAIL 의 네이티브 동작이 다르며 우리 모델의
#     `on_nxdomain`/`on_timeout` 선택형과 1:1 대응하지 않는다."*
#
# 이건 주장이다. 여기서 사실로 바꾼다. 폴백이 실제로 뭘 하는지 모르면 그건 폴백이 아니라
# **폴백이 있다는 믿음**이다.
#
# ── 통제 DNS 를 직접 짠 이유 ────────────────────────────────────────────
#
# `timeout` 을 만들려면 **응답을 안 주는** 서버가 필요하다. 서버를 죽이면 ICMP port
# unreachable 이 돌아가 timeout 이 아니라 즉시 실패가 된다 — 다른 실험이다.
# dnsmasq·CoreDNS 로는 그 침묵을 만들 수 없다. `dns.mjs` 가 그것까지 한다.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}"
NODE_IMAGE="${NODE_IMAGE:-docker.io/library/node:24-alpine}"
NET=bary-s14-net
SUBNET=172.31.77.0/24
SUBNET6=fd00:5140::/64
DNS_IP=172.31.77.2
A_IP=172.31.77.11
A_IP6=fd00:5140::11
B_IP=172.31.77.12
B_IP6=fd00:5140::12
ENGINE=bary-s14-engine
DNS=bary-s14-dns
BE_A=bary-s14-a
BE_B=bary-s14-b

HTTP_PORT=19870
TCP_PORT=19871
UDP_PORT=19872
SRV_PORT=19873
LONG_PORT=19874

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  PASS  %-20s %s\n" "$1" "$2"; }
bad() { FAIL=$((FAIL+1)); printf "  FAIL  %-20s %s\n" "$1" "$2"; }

cleanup() {
  for c in "$ENGINE" "$DNS" "$BE_A" "$BE_B"; do docker rm -f "$c" >/dev/null 2>&1; done
  docker network rm "$NET" >/dev/null 2>&1
}
trap cleanup EXIT
# **겹쳐 돌면 서로를 지운다.** 두 실행이 같은 컨테이너·네트워크 이름을 쓰므로, 나중 실행의
# `cleanup` 이 앞 실행의 엔진을 죽인다. 실제로 그렇게 해서 srv·session·dns_failure 가
# 한꺼번에 빨개진 실행이 나왔고, 나는 그걸 하마터면 엔진 결함으로 읽을 뻔했다.
# 이 저장소는 S12 에서 같은 교훈을 이미 배웠다 — **게이트를 직렬화한다.**
if docker ps -a --format '{{.Names}}' | grep -qx "$ENGINE"; then
  echo "  이미 S14 가 돌고 있다 ($ENGINE 이 있다). 겹쳐 돌면 서로를 지운다 — 끝나고 다시 돌린다."
  echo "  정말 남은 찌꺼기라면: docker rm -f $ENGINE $DNS $BE_A $BE_B; docker network rm $NET"
  exit 2
fi
cleanup >/dev/null 2>&1

# **IPv6 를 켜 본다.** AAAA 를 재려면 필요하다. 안 되면 그 점만 SKIP 한다 —
# 조용히 통과시키지 않는다. "AAAA 가 된다" 와 "AAAA 를 못 쟀다" 는 다른 말이다.
HAS_V6=1
docker network create --subnet "$SUBNET" --ipv6 --subnet "$SUBNET6" "$NET" >/dev/null 2>&1 || {
  HAS_V6=0
  docker network create --subnet "$SUBNET" "$NET" >/dev/null || { echo "네트워크 생성 실패"; exit 1; }
}

# ── 존 갈아 끼우기 ──────────────────────────────────────────────────────
#
# 바인드 마운트 대신 `docker exec` 로 써넣는다. Docker Desktop 의 파일 공유는 전파
# 지연이 있고, 그러면 **"nginx 가 아직 안 바꿨다" 와 "DNS 가 아직 안 바뀌었다" 가
# 구분되지 않는다** — 계측기가 하나 더 생기는 셈이다.
zone() { docker exec -i "$DNS" sh -c 'cat > /zone.json'; }

echo ""
echo "=============================================================="
echo " S14 spike — 대안 B (엔진 네이티브 DNS 디스커버리)"
echo " engine: $IMAGE"
echo "=============================================================="
echo ""

v6opt() { [ "$HAS_V6" -eq 1 ] && printf -- '--ip6 %s' "$1"; }
docker run -d --name "$DNS" --network "$NET" --ip "$DNS_IP" $(v6opt fd00:5140::2) \
  -v "$HERE:/spike:ro" --entrypoint node "$NODE_IMAGE" /spike/dns.mjs /zone.json 53 >/dev/null
docker run -d --name "$BE_A" --network "$NET" --ip "$A_IP" $(v6opt "$A_IP6") -e S14_NAME=be-a \
  -v "$HERE:/spike:ro" --entrypoint node "$NODE_IMAGE" /spike/backend.mjs >/dev/null
docker run -d --name "$BE_B" --network "$NET" --ip "$B_IP" $(v6opt "$B_IP6") -e S14_NAME=be-b \
  -v "$HERE:/spike:ro" --entrypoint node "$NODE_IMAGE" /spike/backend.mjs >/dev/null

# 초기 존 — be.test 는 A 하나(be-a).
sleep 1.5
printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$A_IP\"]},\"SRV\":{\"_be._tcp.svc.test\":[{\"priority\":0,\"weight\":10,\"port\":8080,\"target\":\"be.test\"}]}}" | zone

# ── 엔진 ────────────────────────────────────────────────────────────────
#
# `resolve` 는 `zone` 과 `resolver` 를 둘 다 요구한다 (E10/E11 로 이미 고정했다).
# `valid=` 로 재조회 주기를 우리가 통제한다 — 레코드 TTL 존중 여부는 아래에서 따로 잰다.
CONF=$(cat <<CONFEOF
worker_processes 1;
error_log logs/error.log info;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
  access_log off; default_type text/plain;
  # **http 는 `valid=2s`.** TTL 대조는 맨 마지막에 conf 를 갈아끼워 따로 잰다 —
  # `valid=` 를 크게 잡으면 **다른 모든 측정의 타이밍 전제가 깨진다**(실제로 한 번 그렇게
  # 만들어 a_records·dns_failure·session 까지 함께 빨개졌다). 한 resolver 를 공유하니
  # 당연한 일이고, 그래서 그 측정만 격리한다.
  resolver $DNS_IP valid=2s;
  upstream hu { zone hu 64k; server be.test:8080 resolve; }
  server { listen $HTTP_PORT; location / { proxy_pass http://hu; proxy_connect_timeout 2s; } }
}
stream {
  # **stream 은 `valid=` 를 안 준다 — 레코드 TTL 을 따르는지 보려는 것이다.**
  # 두 컨텍스트의 전환 지연을 비교하면 "TTL 을 존중하는가" 가 대조로 드러난다.
  # 한쪽만 재면 "2초" 가 valid 때문인지 TTL 때문인지 구분되지 않는다.
  resolver $DNS_IP;
  upstream st { zone st 64k; server be.test:9090 resolve; }
  server { listen $TCP_PORT; proxy_pass st; proxy_connect_timeout 2s; }
  upstream su { zone su 64k; server be.test:9091 resolve; }
  server { listen $UDP_PORT udp; proxy_pass su; proxy_responses 1; proxy_timeout 2s; }
  upstream sv { zone sv 64k; server svc.test service=_be._tcp resolve; }
  server { listen $SRV_PORT; proxy_pass sv; proxy_connect_timeout 2s; }
  upstream sl { zone sl 64k; server be.test:9092 resolve; }
  server { listen $LONG_PORT; proxy_pass sl; proxy_timeout 30s; }
}
CONFEOF
)

docker run -d --name "$ENGINE" --network "$NET" --ip 172.31.77.20 \
  --entrypoint /bin/sh "$IMAGE" -c 'mkdir -p /prefix/conf /prefix/logs; sleep infinity' >/dev/null
sleep 1
printf '%s\n' "$CONF" | docker exec -i "$ENGINE" sh -c 'cat > /prefix/conf/nginx.conf'
docker exec "$ENGINE" sh -c 'apk add --no-cache curl >/dev/null 2>&1'
docker exec "$ENGINE" sh -c '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf -t' >/dev/null 2>&1 \
  || { bad S14.conf "설정이 안 선다: $(docker exec "$ENGINE" sh -c '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf -t' 2>&1 | tail -1)"; echo " PASS=$PASS FAIL=$FAIL"; exit 1; }
docker exec -d "$ENGINE" sh -c '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf'
sleep 1.5

# ── 프로브 ──────────────────────────────────────────────────────────────
# **`echo | nc` 는 안 된다.** busybox nc 는 stdin 이 EOF 면 응답을 읽기 전에 나가 버려서
# 빈 문자열이 돌아온다 — 첫 판에서 tcp 와 srv 가 그렇게 빈칸으로 나왔고, 나는 그걸
# 하마터면 "stream 이 안 된다" 로 읽을 뻔했다. 같은 실행 안에서 TTL 측정의 tcp 는
# 값을 받았다는 것이 단서였다(엔진 결함이면 거기서도 빈칸이어야 한다).
# `tests/engine/engine_facts.sh` 의 `SPROBE` 가 이미 `{ ...; sleep 1; } | nc` 를 쓴다.
http_get()  { docker exec "$ENGINE" sh -c "curl -s --max-time 3 http://127.0.0.1:$HTTP_PORT/ 2>/dev/null" ; }
tcp_get()   { docker exec "$ENGINE" sh -c "{ echo; sleep 1; } | nc -w 3 127.0.0.1 $TCP_PORT 2>/dev/null" ; }
udp_get()   { docker exec "$ENGINE" sh -c "{ echo ping; sleep 1; } | nc -u -w 3 127.0.0.1 $UDP_PORT 2>/dev/null | head -c 10" ; }
srv_get()   { docker exec "$ENGINE" sh -c "{ echo; sleep 1; } | nc -w 3 127.0.0.1 $SRV_PORT 2>/dev/null" ; }

# 여러 번 때려 어떤 이름들이 나오는지 모은다.
names() {   # names <프로브함수> <횟수>
  out=""
  n=0
  while [ "$n" -lt "$2" ]; do
    r=$($1)
    out="$out $r"
    n=$((n+1))
  done
  echo "$out" | tr ' ' '\n' | grep -v '^$' | sort -u | tr '\n' ',' | sed 's/,$//'
}

# ── 0. 계측기 검증 ──────────────────────────────────────────────────────
#
# **DNS 가 정말 nginx 를 먹이고 있는가.** 이게 아니면 아래 모든 "안 바뀐다" 는
# "DNS 가 죽었다" 와 구분되지 않는다.
r=$(http_get)
if [ "$r" = "be-a" ]; then
  ok S14.instrument "**DNS 가 nginx 를 먹인다** — http 가 be-a 를 받는다. resolve 경로가 산다"
else
  bad S14.instrument "http 가 '$r' 를 받았다 (be-a 기대) — 아래 판정을 전부 신뢰할 수 없다"
  docker exec "$ENGINE" sh -c 'tail -5 /prefix/logs/error.log'
  echo " PASS=$PASS FAIL=$FAIL"; exit 1
fi

# **그리고 바뀌는가.** 안 바뀌면 `resolve` 가 최초 1회만 푼 것이고, 그건 디스커버리가
# 아니다. 대조군 없이 "바뀐다" 만 재면 아무것도 증명 못 한다.
printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$B_IP\"]}}" | zone
t0=$(date +%s)
sw=""
w=0
while [ "$w" -lt 40 ]; do
  sw=$(http_get)
  [ "$sw" = "be-b" ] && break
  w=$((w+1)); sleep 0.5
done
t1=$(date +%s)
if [ "$sw" = "be-b" ]; then
  ok S14.instrument.change "**재조회가 실제로 일어난다** — A 를 바꾸니 $((t1-t0))초 만에 be-b 로 옮겨간다 (valid=2s)"
else
  bad S14.instrument.change "A 를 바꿨는데 20초 동안 안 옮겨간다 (\'$sw\') — resolve 가 재조회를 안 한다"
fi


# ── 1. A 여러 개 — HTTP·TCP·UDP 셋 다 ───────────────────────────────────
#
# §12.0 이 요구하는 축이 **서브시스템 × 레코드**다. 한 축만 재고 "된다" 고 적으면
# 그건 세 서브시스템에 대한 주장이 아니라 하나에 대한 주장이다.
printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$A_IP\",\"$B_IP\"]},\"SRV\":{\"_be._tcp.svc.test\":[{\"priority\":0,\"weight\":10,\"port\":9090,\"target\":\"be.test\"}]}}" | zone
sleep 4
h=$(names http_get 8); t=$(names tcp_get 8); u=$(names udp_get 8)
if [ "$h" = "be-a,be-b" ] && [ "$t" = "be-a,be-b" ] && [ "$u" = "be-a,be-b" ]; then
  ok S14.a_records "**A 두 개가 HTTP·TCP·UDP 전부에서 분산된다** (http=$h tcp=$t udp=$u)"
else
  bad S14.a_records "서브시스템별로 다르다 (http=$h tcp=$t udp=$u)"
fi

# ── 3. AAAA ─────────────────────────────────────────────────────────────
if [ "$HAS_V6" -eq 0 ]; then
  bad S14.aaaa "**못 쟀다** — 도커가 이 호스트에서 IPv6 네트워크를 안 만들어 준다. 「AAAA 가 된다」고 적을 근거가 없다"
else
  printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"AAAA\":{\"be.test\":[\"$A_IP6\"]}}" | zone
  sleep 4
  r=""
  w=0
  while [ "$w" -lt 20 ]; do r=$(http_get); [ "$r" = "be-a" ] && break; w=$((w+1)); sleep 0.5; done
  if [ "$r" = "be-a" ]; then
    ok S14.aaaa "**AAAA 만으로도 붙는다** — A 레코드가 하나도 없는 상태에서 be-a 를 받는다"
  else
    bad S14.aaaa "AAAA 만 있으면 못 붙는다 ('$r')"
  fi
fi

# ── 4. SRV ──────────────────────────────────────────────────────────────
#
# `service=` 는 **포트를 SRV 에서 가져온다** — upstream 선언에 포트가 없다.
# 그래서 포트를 엉뚱한 데로 돌리면 실패해야 하고, 그게 「포트가 SRV 에서 온다」의 증거다.
printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$A_IP\",\"$B_IP\"]},\"SRV\":{\"_be._tcp.svc.test\":[{\"priority\":0,\"weight\":10,\"port\":9090,\"target\":\"be.test\"}]}}" | zone
sleep 4
sv=$(names srv_get 6)
printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$A_IP\",\"$B_IP\"]},\"SRV\":{\"_be._tcp.svc.test\":[{\"priority\":0,\"weight\":10,\"port\":9099,\"target\":\"be.test\"}]}}" | zone
sleep 4
sv_bad=$(srv_get)
if [ "$sv" = "be-a,be-b" ] && [ -z "$sv_bad" ]; then
  ok S14.srv "**SRV 가 대상과 포트를 둘 다 준다** — 포트 9090 이면 $sv, 9099 로 돌리면 아무도 못 받는다"
elif [ "$sv" = "be-a,be-b" ]; then
  bad S14.srv "대상은 맞는데 포트를 SRV 에서 안 가져온다 (9099 인데 '$sv_bad' 를 받았다)"
else
  bad S14.srv "SRV 로 안 붙는다 ('$sv')"
  docker exec "$ENGINE" sh -c "grep -iE 'srv|svc.test|resolv' /prefix/logs/error.log | tail -3" | sed 's/^/        /'
fi

# ── 5. NXDOMAIN · SERVFAIL · 침묵 ───────────────────────────────────────
#
# §7.3 이 *"셋의 네이티브 동작이 다르며 우리 모델과 1:1 대응하지 않는다"* 고 **주장**만
# 해 뒀다. 여기서 사실로 바꾼다. 셋을 같은 방식으로 재서 **나란히 놓는다** — 하나만
# 재면 "다르다" 를 말할 수 없다.
failmode() {   # failmode <mode> → "<응답>|<error.log 마지막 줄 요약>"
  printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$A_IP\"]}}" | zone
  sleep 4
  [ "$(http_get)" = "be-a" ] || { echo "준비실패|"; return; }
  docker exec "$ENGINE" sh -c ': > /prefix/logs/error.log'
  printf '%s' "{\"mode\":\"$1\",\"ttl\":2,\"A\":{\"be.test\":[\"$A_IP\"]}}" | zone
  sleep 8
  r=$(http_get)
  case "$r" in
    be-a|be-b) : ;;
    *502*)     r="502(peer 없음)" ;;
    "")        r="(빈응답)" ;;
    *)         r="(기타)" ;;
  esac
  lg=$(docker exec "$ENGINE" sh -c "grep -oE '(no resolver|resolv|Name or service|timed out|NXDOMAIN|Server failure|host not found|unexpected)[^,]*' /prefix/logs/error.log 2>/dev/null | sort -u | head -2 | tr '\n' ';'")
  echo "$r|$lg"
}
nx=$(failmode nxdomain)
sf=$(failmode servfail)
dr=$(failmode drop)
echo "        NXDOMAIN : $nx"
echo "        SERVFAIL : $sf"
echo "        침묵     : $dr"
nx_r=${nx%%|*}; sf_r=${sf%%|*}; dr_r=${dr%%|*}
if [ "$nx_r" = "be-a" ] && [ "$sf_r" = "be-a" ] && [ "$dr_r" = "be-a" ]; then
  ok S14.dns_failure "**셋 다 마지막으로 알던 peer 를 계속 쓴다** — NXDOMAIN 도 백엔드를 빼지 않는다. 이건 fail-open 이고, 우리 모델의 on_nxdomain 선택형은 **엔진이 표현할 수 없다**"
elif [ "$nx_r" = "$sf_r" ] && [ "$sf_r" = "$dr_r" ]; then
  ok S14.dns_failure "**셋의 동작이 같다** (전부 '$nx_r') — §7.3 이 「다르다」고 적은 것이 틀렸다. 선택형을 하나로 접어야 한다"
else
  ok S14.dns_failure "**셋이 갈린다** — NXDOMAIN='$nx_r' SERVFAIL='$sf_r' 침묵='$dr_r'. §7.3 의 주장이 사실이고, 모델은 이 셋을 표현해야 한다"
fi

# ── 6. 기존 세션 거동 ───────────────────────────────────────────────────
#
# peer 가 DNS 에서 사라지는 동안 **이미 붙어 있던 연결**이 어떻게 되는가. 드레인 설계가
# 여기 걸린다 — 엔진이 끊어 버리면 대안 B 에는 드레인이라는 개념 자체가 없는 것이다.
printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$A_IP\"]}}" | zone
# **준비를 시각이 아니라 상태로 기다린다.** 바로 앞이 `drop`(침묵) 모드였으므로 엔진에
# 실패 상태가 남아 있고, 고정된 `sleep 4` 로는 모자란 회차가 나온다 — 그러면 긴 연결이
# 아예 안 서고 결론이 "세션이 끊겼다" 가 아니라 **"못 쟀다"** 가 된다. 둘은 다른 말이다.
w=0
while [ "$w" -lt 40 ]; do
  [ "$(http_get)" = "be-a" ] && break
  w=$((w+1)); sleep 0.5
done
# **`docker exec` 안에서 `&` 로 띄우면 exec 가 돌아올 때 같이 죽는다.** 첫 판에서 줄 수가
# 0 이었던 이유고, 그건 "연결이 안 섰다" 가 아니라 "내가 죽였다" 였다. `-d` 로 띄운다.
docker exec "$ENGINE" sh -c ': > /tmp/long.out'
docker exec -d "$ENGINE" sh -c "{ sleep 25; } | nc -w 25 127.0.0.1 $LONG_PORT > /tmp/long.out 2>&1"
sleep 2
before=$(docker exec "$ENGINE" sh -c 'wc -l < /tmp/long.out' 2>/dev/null | tr -d ' ')
printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$B_IP\"]}}" | zone
sleep 6
after=$(docker exec "$ENGINE" sh -c 'wc -l < /tmp/long.out' 2>/dev/null | tr -d ' ')
last=$(docker exec "$ENGINE" sh -c 'tail -1 /tmp/long.out' 2>/dev/null | tr -d '\r')
if [ "${before:-0}" -gt 0 ] && [ "${after:-0}" -gt "${before:-0}" ] && [ "${last#be-a}" != "$last" ]; then
  ok S14.session "**DNS 에서 빠져도 기존 연결은 안 끊긴다** — 줄 수 ${before}→${after}, 마지막이 여전히 '$last'. 새 연결만 옮겨간다"
elif [ "${before:-0}" -eq 0 ]; then
  bad S14.session "긴 연결이 아예 안 섰다 (줄 수 0) — 이 점을 못 쟀다"
else
  bad S14.session "기존 연결이 끊겼다 (줄 수 ${before}→${after}, 마지막='$last') — 대안 B 에는 드레인이 없다"
fi

# ── 7. TTL 대 valid= (격리 측정) ────────────────────────────────────────
#
# ⚠️ **두 번 틀렸다.**
#
# 첫 판은 http 를 `valid=2s`, stream 을 TTL 8s 로 두고 *"http 가 먼저 바뀐다"* 를 판정으로
# 삼았는데, `valid=` 를 떼는 변이에서도 그대로 통과했다 — 두 폴링이 서로 다른 시각에 처음
# 성공하기만 하면 참이 되는 조건이라 **우연한 시차**를 재고 있었다.
#
# 둘째 판은 판정을 강하게 고쳤지만 `valid=20s` 를 **전역 resolver 에** 걸었다. 그러자
# a_records·dns_failure·session 이 함께 빨개졌다 — 다른 측정들이 "몇 초면 재조회된다" 를
# 전제로 서 있었기 때문이다. **계측기 하나를 고치다 나머지를 부순 것이다.**
#
# 그래서 이 측정만 **격리한다.** 다른 측정이 다 끝난 뒤 conf 를 갈아끼우고 엔진을 새로
# 띄운다. 레코드 TTL 은 2초, `valid=` 는 20초 — TTL 만 따른다면 2초쯤에 바뀌어야 하는데
# **12초 이상 기다린다면** 그건 `valid=` 를 따른다는 뜻이고 다른 해석이 없다.
# `valid=20s` 를 떼는 변이에서 2초로 내려오는 것을 확인했다.
printf '%s\n' "worker_processes 1;
error_log logs/error.log info;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
  access_log off; default_type text/plain;
  resolver $DNS_IP valid=20s;
  upstream hv { zone hv 64k; server be.test:8080 resolve; }
  server { listen $HTTP_PORT; location / { proxy_pass http://hv; proxy_connect_timeout 2s; } }
}" | docker exec -i "$ENGINE" sh -c 'cat > /prefix/conf/ttl.conf'
docker exec "$ENGINE" sh -c 'kill -QUIT $(cat /prefix/logs/nginx.pid) 2>/dev/null; sleep 1'
printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$A_IP\"]}}" | zone
docker exec -d "$ENGINE" sh -c '/usr/local/openresty/bin/openresty -p /prefix -c conf/ttl.conf'
sleep 2
if [ "$(http_get)" != "be-a" ]; then
  bad S14.ttl "격리 인스턴스가 안 섰다"
else
  printf '%s' "{\"mode\":\"normal\",\"ttl\":2,\"A\":{\"be.test\":[\"$B_IP\"]}}" | zone
  z0=$(date +%s)
  h_at=""
  w=0
  while [ "$w" -lt 70 ]; do
    [ "$(http_get)" = "be-b" ] && { h_at=$(( $(date +%s) - z0 )); break; }
    w=$((w+1)); sleep 0.5
  done
  h_at=${h_at:-초과}
  if [ "$h_at" != "초과" ] && [ "$h_at" -ge 12 ]; then
    ok S14.ttl "**valid= 가 레코드 TTL 을 덮는다** — 레코드 TTL 이 **2초**인데 ${h_at}초를 기다렸다. TTL 을 따랐다면 2초쯤이어야 한다"
  elif [ "$h_at" = "초과" ]; then
    bad S14.ttl "35초 안에 안 바뀌었다 — valid=20s 보다도 오래 걸린다"
  else
    bad S14.ttl "${h_at}초 만에 바뀌었다 — TTL(2초)을 따른 것이지 valid=20s 를 따른 것이 아니다"
  fi
fi

echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
