#!/usr/bin/env bash
# S20 스파이크 러너 — HTTP/3 (QUIC) (DESIGN.md §12.0, §4.9)
#
#   ./spike/s20/run.sh
#
# 합격 기준: ① h3 로 실제 요청이 오간다 ② UDP 점유가 §4.5 겹침 검증에 잡힌다
# ③ 같은 포트 TCP(h1/h2)와 공존 ④ Alt-Svc 승격 ⑤ reload 중 h3 연결 거동.
# 실패 시 규칙: **v0 은 h1/h2 만 — h3 는 모델에서 뺀다.**
#
# ── 첫 과제는 클라이언트였다 ────────────────────────────────────────────
#
# §4.9 가 *"설정이 선다"* 까지만 재고 멈춰 있었다. 엔진 이미지의 `curl` 이 nghttp2 만
# 들고 있어서 h3 로 붙어 볼 수가 없었기 때문이다. **`ymuski/curl-http3`(quiche 0.18)**
# 이 그 구멍을 메운다. arm64 호스트에서는 amd64 에뮬레이션으로 돈다 — 느리지만 돈다.
#
# 엔진 쪽도 확인했다: openresty 1.31.1.1 이 `--with-http_v3_module` 로 빌드돼 있고
# **OpenSSL 3.5.7** 이다. 서버측 QUIC API 가 들어온 것이 3.5 라, 이 조합이라야 선다.
#
# ── 계측기를 먼저 의심한다 ──────────────────────────────────────────────
#
# `curl --http3` 은 **함정이다.** 실패하면 조용히 h2/h1 로 내려가므로, 이걸로 재면
# "h3 가 된다" 가 아니라 "무언가로 붙었다" 를 재게 된다. 이 저장소가 s_client 의
# `Protocol :` 줄에서 똑같이 물린 적이 있다(S16).
#
# 그래서 `--http3-only` 만 쓰고, **판정은 `%{http_version}` 이 3 인가**로 한다.
# 그리고 그 플래그가 진짜로 강제하는지를 먼저 잰다 — TCP 전용 서버에 `--http3-only`
# 를 던져 **실패해야** 한다. 거기서 200 이 나오면 아래 판정이 전부 무의미하다.
# ── 이 스파이크는 게이트에 없다 ─────────────────────────────────────────
#
# 8 개 중 7 개가 통과하고 ②(겹침 검증)가 실패한다. 그 실패는 우리 코드의 결함이 아니라
# **h3 를 열기 위한 선결 조건**이므로, 고치기 전까지 영원히 빨갛다. 그걸 `verify.sh` 에
# 넣으면 빨강을 무시하는 법을 익히게 된다. 충돌 사실 자체는 h3 클라이언트 없이도 재므로
# **엔진 사실 E65** 로 갈라 넣었고, 그쪽은 게이트 안에서 초록으로 산다.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}"
H3CLIENT="${BARY_H3_CLIENT:-docker.io/ymuski/curl-http3}"
NET=bary-s20-net
ENGINE=bary-s20-engine
PORT=19860
PORT_HEX=$(printf '%04X' "$PORT")

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf "  PASS  %-18s %s\n" "$1" "$2"; }
bad() { FAIL=$((FAIL+1)); printf "  FAIL  %-18s %s\n" "$1" "$2"; }

TMP=$(mktemp -d)
cleanup() {
  docker rm -f "$ENGINE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT
cleanup >/dev/null 2>&1
docker network create "$NET" >/dev/null

# 인증서는 **`conf/` 아래**에 둔다. `-c conf/nginx.conf` 라 conf_prefix 가 `/prefix/conf/`
# 이고, 상대 경로는 prefix 가 아니라 거기서 풀린다(E62). 처음에 `$TMP/certs` 에 뒀다가
# `cannot load certificate "/prefix/conf/certs/s.crt"` 로 엔진이 안 떴다.
mkdir -p "$TMP/conf/certs" "$TMP/logs"
openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
  -subj "/CN=$ENGINE" -addext "subjectAltName=DNS:$ENGINE" \
  -keyout "$TMP/conf/certs/s.key" -out "$TMP/conf/certs/s.crt" >/dev/null 2>&1

# conf <이름> — $TMP/conf/nginx.conf 를 갈아끼운다.
write_conf() {
  cat > "$TMP/conf/nginx.conf"
}

engine_start() {
  docker rm -f "$ENGINE" >/dev/null 2>&1 || true
  docker run -d --name "$ENGINE" --network "$NET" -v "$TMP:/prefix" \
    --entrypoint /usr/local/openresty/bin/openresty "$IMAGE" \
    -p /prefix -c conf/nginx.conf -g 'daemon off;' >/dev/null 2>&1
  for _ in $(seq 1 40); do
    docker exec "$ENGINE" cat /prefix/logs/nginx.pid >/dev/null 2>&1 && return 0
    sleep 0.25
  done
  return 1
}
engine_stop() { docker rm -f "$ENGINE" >/dev/null 2>&1 || true; }

# h3 <추가 인자...> → "<http_version> <본문>" 또는 "거절 <사유>"
#
# `--http3-only` 만 쓴다. `--http3` 은 조용히 내려가므로 판정에 쓸 수 없다.
curl_run() {
  out=$(docker run --rm --network "$NET" -v "$TMP/altsvc:/altsvc" \
        --entrypoint curl "$H3CLIENT" \
        -sk -o /tmp/body -w '%{http_version} %{http_code}' \
        --max-time 20 "$@" 2>"$TMP/curl.err")
  rc=$?
  if [ $rc -ne 0 ]; then
    echo "거절 rc=$rc $(tr '\n' ' ' < "$TMP/curl.err" | cut -c1-90)"
  else
    echo "$out"
  fi
}
# 본문까지 필요할 때
curl_body() {
  docker run --rm --network "$NET" --entrypoint curl "$H3CLIENT" \
    -sk --max-time 20 "$@" 2>/dev/null
}

echo ""
echo "=============================================================="
echo " S20 spike — HTTP/3 (QUIC)"
echo " engine: $IMAGE"
echo " client: $H3CLIENT"
echo "=============================================================="
echo ""

# ── 0. 계측기 검증 — `--http3-only` 가 정말 강제하는가 ──────────────────
#
# TCP 전용(ssl, quic 없음) 서버를 세우고 `--http3-only` 를 던진다. **실패해야 한다.**
# 여기서 200 이 나오면 그 플래그는 아무것도 강제하지 않는 것이고, 아래 판정은 전부
# "무언가로 붙었다" 를 h3 라고 부르는 것이 된다.
write_conf <<CONF
worker_processes 1;
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
  access_log off; default_type text/plain;
  server {
    listen $PORT ssl;
    http2 on;
    ssl_certificate certs/s.crt; ssl_certificate_key certs/s.key;
    return 200 "tcp-only";
  }
}
CONF
if engine_start; then
  r=$(curl_run --http3-only "https://$ENGINE:$PORT/")
  case "$r" in
    거절*) ok S20.instrument "**계측기 검증** — TCP 전용 서버에 \`--http3-only\` 가 실패한다 ($r). 플래그가 h3 를 강제한다" ;;
    *)     bad S20.instrument "\`--http3-only\` 가 TCP 전용 서버에 붙었다 ($r) — 아래 판정을 전부 신뢰할 수 없다" ;;
  esac
  # 같은 서버에 h2 는 붙어야 한다. 안 붙으면 네트워크가 죽은 것이지 h3 문제가 아니다.
  r2=$(curl_run --http2 "https://$ENGINE:$PORT/")
  case "$r2" in
    "2 200") ok S20.instrument.net "대조 — 같은 서버에 h2 는 붙는다 ($r2). 위 실패는 네트워크가 아니라 프로토콜이다" ;;
    *)       bad S20.instrument.net "h2 도 안 붙는다 ($r2) — 컨테이너 네트워크를 먼저 봐야 한다" ;;
  esac
else
  bad S20.instrument "TCP 전용 엔진이 안 떴다"
fi
engine_stop

# ── 1~3. h3 서빙 · 같은 포트 공존 · Alt-Svc ─────────────────────────────
write_conf <<CONF
worker_processes 1;
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
  access_log off; default_type text/plain;
  server {
    listen $PORT ssl;
    listen $PORT quic reuseport;
    http2 on;
    ssl_certificate certs/s.crt; ssl_certificate_key certs/s.key;
    add_header Alt-Svc 'h3=":$PORT"; ma=86400' always;
    location / { return 200 "hello-\$server_protocol"; }
    location /slow { content_by_lua_block { ngx.sleep(4) ngx.say("slow-ok") } }
  }
}
CONF
if ! engine_start; then
  bad S20.serve "quic 리스너를 단 엔진이 안 떴다"
  docker logs "$ENGINE" 2>&1 | tail -5 | sed 's/^/        /'
else
  # ① h3 로 실제 요청이 오간다
  r=$(curl_run --http3-only "https://$ENGINE:$PORT/")
  body=$(curl_body --http3-only "https://$ENGINE:$PORT/")
  if [ "$r" = "3 200" ]; then
    ok S20.serve "**h3 로 실제 요청이 오간다** — http_version=3, 본문 '$body'. \$server_protocol 이 엔진 쪽 판정이다"
  else
    bad S20.serve "h3 요청이 안 됐다 ($r)"
    docker exec "$ENGINE" tail -3 /prefix/logs/error.log 2>/dev/null | sed 's/^/        /'
  fi

  # ② UDP 점유 — §4.5 겹침 검증기가 세야 할 사실
  #
  # 도구를 안 쓴다. `/proc/net/udp` 의 local_address 가 HEX:HEX 라 포트만 보면 된다.
  udp=$(docker exec "$ENGINE" sh -c "cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk '{print \$2}' | grep -c ':$PORT_HEX\$'" 2>/dev/null || echo 0)
  tcp=$(docker exec "$ENGINE" sh -c "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '{print \$2}' | grep -c ':$PORT_HEX\$'" 2>/dev/null || echo 0)
  if [ "${udp:-0}" -ge 1 ] && [ "${tcp:-0}" -ge 1 ]; then
    ok S20.udp_occupancy "**같은 포트를 UDP·TCP 양쪽으로 점유한다** (udp=$udp, tcp=$tcp). §4.5 가 https 를 tcp 로만 예약하면 이 UDP 를 못 본다"
  else
    bad S20.udp_occupancy "점유가 예상과 다르다 (udp=$udp, tcp=$tcp)"
  fi

  # ③ 같은 포트에서 h1/h2/h3 공존
  r1=$(curl_run --http1.1 "https://$ENGINE:$PORT/")
  r2=$(curl_run --http2 "https://$ENGINE:$PORT/")
  r3=$(curl_run --http3-only "https://$ENGINE:$PORT/")
  if [ "$r1" = "1.1 200" ] && [ "$r2" = "2 200" ] && [ "$r3" = "3 200" ]; then
    ok S20.coexist "**한 포트에서 셋 다 산다** — h1.1/h2 는 TCP, h3 는 UDP ($r1 · $r2 · $r3)"
  else
    bad S20.coexist "공존이 안 된다 (h1=$r1, h2=$r2, h3=$r3)"
  fi

  # ④ Alt-Svc — 헤더가 나가는가, 그리고 **그걸로 실제 승격이 되는가**
  #
  # 헤더 존재만 재면 부족하다. 브라우저가 하는 일은 "받아서 캐시하고 다음에 h3 로 간다"
  # 이므로, curl 의 alt-svc 캐시로 그 두 단계를 다 밟는다.
  hdr=$(curl_body --http2 -I "https://$ENGINE:$PORT/" | tr -d '\r' | grep -i '^alt-svc:' || true)
  mkdir -p "$TMP/altsvc"; rm -f "$TMP/altsvc/cache.txt"
  first=$(curl_run --http2 --alt-svc /altsvc/cache.txt "https://$ENGINE:$PORT/")
  second=$(curl_run --alt-svc /altsvc/cache.txt "https://$ENGINE:$PORT/")
  if [ -n "$hdr" ] && [ "$first" = "2 200" ] && [ "$second" = "3 200" ]; then
    ok S20.altsvc "**승격이 실제로 일어난다** — 1회차 h2($first)에서 '$hdr' 를 캐시하고 2회차가 h3($second) 로 간다"
  else
    bad S20.altsvc "승격이 안 된다 (헤더='$hdr', 1회차=$first, 2회차=$second)"
  fi

  # ⑤ reload 중 h3 연결 거동
  #
  # **진행 중인 요청**을 걸어 두고 HUP 을 보낸다. h1/h2 라면 옛 워커가 들고 끝낸다 —
  # QUIC 은 소켓이 UDP 라 같은 보장이 있는지가 물음이다.
  ( curl_body --http3-only "https://$ENGINE:$PORT/slow" > "$TMP/slow.out" 2>&1; echo $? > "$TMP/slow.rc" ) &
  slowpid=$!
  sleep 1.5
  docker exec "$ENGINE" sh -c 'kill -HUP $(cat /prefix/logs/nginx.pid)' >/dev/null 2>&1
  wait $slowpid
  inflight=$(cat "$TMP/slow.out" 2>/dev/null | tr -d '\n')
  inflight_rc=$(cat "$TMP/slow.rc" 2>/dev/null)
  after=$(curl_run --http3-only "https://$ENGINE:$PORT/")
  if [ "$inflight" = "slow-ok" ] && [ "$after" = "3 200" ]; then
    ok S20.reload "**reload 가 진행 중인 h3 요청을 안 끊는다** (본문='$inflight'), 이후 새 h3 요청도 선다 ($after)"
  elif [ "$after" = "3 200" ]; then
    bad S20.reload "reload 가 진행 중인 h3 요청을 끊었다 (rc=$inflight_rc, 본문='$inflight') — 이후 요청은 산다 ($after). h1/h2 와 보장이 다르다"
  else
    bad S20.reload "reload 뒤 h3 가 안 선다 (진행중 rc=$inflight_rc '$inflight', 이후=$after)"
  fi
fi
engine_stop

# ── 6. 같은 포트의 stream udp 리스너와 충돌하는가 ───────────────────────
#
# §4.5 겹침 검증기가 답해야 할 물음이다. 두 갈래를 다 잰다: quic 에 `reuseport` 가
# 있을 때와 없을 때. **`reuseport` 가 붙으면 둘 다 bind 에 성공해 패킷이 갈릴 수 있고**,
# 그건 "거절당한다" 보다 훨씬 나쁜 결말이다 — 조용히 절반씩 먹는다.
# **"떴다" 는 판정이 아니다.** 처음에 pid 파일 존재만 보고 "둘 다 조용히 떴다 → 패킷이
# 갈린다" 라고 적었는데, 그건 관측이 아니라 추측이다. 실제로 **누가 답하는가**를 잰다:
# h3 요청 하나와 raw UDP 데이터그램 하나를 던져 각각의 응답을 본다.
conflict_case() {
  label="$1"; ru="$2"
  write_conf <<CONF
worker_processes 1;
error_log logs/error.log info;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
  access_log off; default_type text/plain;
  server {
    listen $PORT ssl;
    listen $PORT quic$ru;
    ssl_certificate certs/s.crt; ssl_certificate_key certs/s.key;
    return 200 "h3-http";
  }
}
stream {
  server { listen $PORT udp; return "udp-stream"; }
}
CONF
  t=$(docker run --rm -v "$TMP:/prefix" --entrypoint /usr/local/openresty/bin/openresty \
        "$IMAGE" -t -p /prefix -c conf/nginx.conf 2>&1 | tail -1)
  case "$t" in
    *successful*) conf_t="conf=통과" ;;
    *)            conf_t="conf=거절($t)" ;;
  esac

  if ! engine_start; then
    echo "$label|$conf_t|기동=실패: $(docker logs "$ENGINE" 2>&1 | tail -1 | cut -c1-90)|h3=-|udp=-"
    engine_stop
    return
  fi
  # 소켓이 몇 개 열렸나. 하나면 nginx 가 합친 것이고, 그러면 둘 중 하나가 조용히 진다.
  nudp=$(docker exec "$ENGINE" sh -c "cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk '{print \$2}' | grep -c ':$PORT_HEX\$'" 2>/dev/null || echo 0)
  h3=$(curl_run --http3-only "https://$ENGINE:$PORT/")
  udp=$(docker run --rm --network "$NET" docker.io/library/busybox:latest \
        sh -c "echo ping | nc -u -w2 $ENGINE $PORT 2>/dev/null | head -c 40" 2>/dev/null)
  [ -z "$udp" ] && udp="(무응답)"
  engine_stop
  echo "$label|$conf_t|udp소켓=$nudp|h3=$h3|udp응답=$udp"
}
c1=$(conflict_case "reuseport 있음" " reuseport")
c2=$(conflict_case "reuseport 없음" "")
echo "        $c1"
echo "        $c2"

# 판정: **둘 다 답하면** 패킷이 갈린 것이고, **하나만 답하면** 다른 하나가 조용히 진 것이다.
# 어느 쪽이든 §4.5 가 막아야 하지만, 적어 두는 사실은 다르다.
both_alive() { echo "$1" | grep -q "h3=3 200" && ! echo "$1" | grep -q "udp응답=(무응답)"; }
if echo "$c1$c2" | grep -qi "기동=실패\|conf=거절"; then
  ok S20.udp_conflict "**엔진이 거절한다** — 위 두 줄이 근거다. §4.5 가 h3 를 udp 예약으로 세면 이걸 apply 전에 잡는다"
elif both_alive "$c1" || both_alive "$c2"; then
  bad S20.udp_conflict "**둘 다 답한다 — 패킷이 갈린다.** 거절보다 나쁘다. 검증기가 반드시 막아야 한다"
else
  bad S20.udp_conflict "**한쪽이 조용히 진다** — 엔진도 conf 검사도 아무 말을 안 한다. 운영자는 설정한 것이 사라진 이유를 알 수 없다. 검증기가 반드시 막아야 한다"
fi

echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → **h3 가 성립한다.** §12.0 의 축소 규칙(h3 를 모델에서 뺀다)을 적용할 이유가 없다."
  echo "   다만 §4.5 겹침 검증기가 **quic 을 udp 예약으로 세도록** 고쳐야 h3 를 열 수 있다."
else
  echo " → §12.0 규칙에 따라 **v0 은 h1/h2 만 — h3 는 모델에서 뺀다.**"
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
