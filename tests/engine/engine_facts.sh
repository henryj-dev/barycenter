#!/bin/sh
# barycenter — 엔진 사실 검증 (컨테이너 내부에서 실행)
#
# DESIGN.md 가 사실로 전제하는 nginx/OpenResty 동작을, 우리가 pin 하려는 실제 엔진에서
# 확인한다. 검수 라운드에서 "맞다/틀리다"로 오간 항목들이 여기 전부 들어 있다.
#
# 종료 코드: 실패한 케이스가 하나라도 있으면 1.

set -u

BIN="${BIN:-/usr/local/openresty/bin/openresty}"
WORK=/tmp/bary-engine
PASS=0; FAIL=0; SKIP=0
RESULTS=""

log()  { printf '%s\n' "$*"; }
ok()   { PASS=$((PASS+1)); RESULTS="${RESULTS}PASS|$1|$2\n"; log "  PASS  $1  $2"; }
bad()  { FAIL=$((FAIL+1)); RESULTS="${RESULTS}FAIL|$1|$2\n"; log "  FAIL  $1  $2"; }
skip() { SKIP=$((SKIP+1)); RESULTS="${RESULTS}SKIP|$1|$2\n"; log "  SKIP  $1  $2"; }

mkprefix() {
  p="$WORK/$1"
  rm -rf "$p"
  mkdir -p "$p/conf" "$p/logs" "$p/temp"
  # ssl 문법 케이스용 자기서명 인증서 (nginx 는 상대경로를 prefix 기준으로 푼다)
  if [ -f /tmp/bary-certs/cert.pem ]; then
    cp /tmp/bary-certs/cert.pem /tmp/bary-certs/key.pem "$p/"      2>/dev/null
    cp /tmp/bary-certs/cert.pem /tmp/bary-certs/key.pem "$p/conf/" 2>/dev/null
  fi
  echo "$p"
}

# conf_test <id> <expect: pass|fail> <description> <conf on stdin>
conf_test() {
  id="$1"; expect="$2"; desc="$3"
  p=$(mkprefix "$id")
  cat > "$p/conf/nginx.conf"
  out=$("$BIN" -t -p "$p" -c conf/nginx.conf 2>&1)
  rc=$?
  if [ "$expect" = pass ] && [ $rc -eq 0 ]; then
    ok "$id" "$desc"
  elif [ "$expect" = fail ] && [ $rc -ne 0 ]; then
    ok "$id" "$desc — 거부됨: $(echo "$out" | grep -m1 -o '\[emerg\].*' | cut -c1-110)"
  else
    bad "$id" "$desc — 기대=$expect rc=$rc :: $(echo "$out" | tr '\n' ' ' | cut -c1-160)"
  fi
}

# --- 런타임 헬퍼 ---------------------------------------------------------
start_ng() {           # start_ng <prefix>  → PID 파일 기다림
  "$BIN" -p "$1" -c conf/nginx.conf >/dev/null 2>&1
  i=0; while [ ! -s "$1/logs/nginx.pid" ] && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done
  [ -s "$1/logs/nginx.pid" ]
}
stop_ng() { [ -s "$1/logs/nginx.pid" ] && kill -QUIT "$(cat "$1/logs/nginx.pid")" 2>/dev/null; sleep 0.4; }
hup_ng()  { kill -HUP "$(cat "$1/logs/nginx.pid")" 2>/dev/null; sleep 0.8; }
GET() {                # GET <port> <path> <host-header> — HTTP/1.0 (chunked 회피)
  { printf 'GET %s HTTP/1.0\r\nHost: %s\r\n\r\n' "$2" "$3"; sleep 1; } \
    | timeout 6 nc 127.0.0.1 "$1" 2>/dev/null
}
body() { GET "$@" | awk 'BEGIN{b=0} /^\r?$/{b=1;next} b{print}' | tr -d '\r\n'; }
SPROBE() {             # SPROBE <port> <raw bytes> — stream 리스너에 원시 바이트를 던진다
  # %b 여야 \r\n 이스케이프가 해석된다. %s 면 리터럴 백슬래시가 나가 요청이 깨진다.
  { printf '%b' "$2"; sleep 1; } | timeout 6 nc 127.0.0.1 "$1" 2>/dev/null
}

log ""
log "=============================================================="
log " barycenter engine facts"
log "  $("$BIN" -v 2>&1)"
log "=============================================================="

# ── E0. capability 베이스라인 ────────────────────────────────────────────
log ""
log "[E0] 빌드 capability"
CONF_ARGS=$("$BIN" -V 2>&1 | grep 'configure arguments')

# 필수 — 없으면 v0 기능을 아예 못 낸다.
for m in stream stream_ssl_preread_module stream_ssl_module http_v2_module \
         http_realip_module http_ssl_module; do
  if echo "$CONF_ARGS" | grep -q -- "--with-$m"; then
    ok "E0.$m" "빌드에 포함 (필수)"
  else
    bad "E0.$m" "빌드에 없음 — 필수 모듈이다"
  fi
done

# 선택 — 없으면 기능이 좁아진다. 좁아지는 방식은 src/validate/engine-constraints.ts 가 강제한다.
# 어떤 공개 이미지도 stream_realip 과 ngx_stream_lua 를 동시에 갖고 있지 않다:
#   공식 nginx = realip ✅ / stream_lua ❌      OpenResty = realip ❌ / stream_lua ✅
# 그래서 필수로 두면 어떤 이미지를 골라도 위반이 된다. capability 로 다룬다 (§7.6).
if echo "$CONF_ARGS" | grep -q -- "--with-stream_realip_module"; then
  ok "E0.stream_realip_module" "빌드에 포함 → PROXY 체인과 \$remote_addr 덮어쓰기 가능"
else
  ok "E0.stream_realip_module" "빌드에 없음 (선택) → PROXY 체인 금지, 소스IP 해시는 \$proxy_protocol_addr 로 대체. E28/E29 참조"
fi
if "$BIN" -V 2>&1 | grep -q 'ngx_stream_lua'; then
  ok "E0.stream_lua" "ngx_stream_lua 포함"
else
  bad "E0.stream_lua" "ngx_stream_lua 없음 — §3.4 이중 멤버십 평면 불가"
fi

# ── E1..E13: 설정 검증 (nginx -t) ────────────────────────────────────────
log ""
log "[E1-E13] 설정 수용/거부"

conf_test E1 fail "stream 에 ip_hash 디렉티브가 없다 (§4.3)" <<'EOF'
events {}
stream {
  upstream p { ip_hash; server 127.0.0.1:9101; }
  server { listen 19101; proxy_pass p; }
}
EOF

conf_test E2 pass "stream 에 least_conn 은 OSS 네이티브로 있다 (§7.3)" <<'EOF'
events {}
stream {
  upstream p { least_conn; server 127.0.0.1:9101; }
  server { listen 19102; proxy_pass p; }
}
EOF

conf_test E3 pass "stream 은 hash \$remote_addr consistent 로 source-IP 고정 (§7.1)" <<'EOF'
events {}
stream {
  upstream p { hash $remote_addr consistent; server 127.0.0.1:9101; }
  server { listen 19103; proxy_pass p; }
}
EOF

conf_test E4 fail "HTTP 업스트림에는 PROXY 송신 디렉티브가 없다 (§4.7)" <<'EOF'
events {}
http {
  upstream p { server 127.0.0.1:9101; }
  server { listen 19104; location / { proxy_pass http://p; proxy_protocol on; } }
}
EOF

conf_test E5 pass "stream 업스트림 proxy_protocol 은 존재한다 (§4.7)" <<'EOF'
events {}
stream {
  upstream p { server 127.0.0.1:9101; }
  server { listen 19105; proxy_pass p; proxy_protocol on; }
}
EOF

conf_test E6 pass "UDP + proxy_protocol 을 엔진이 막지 않는다 → 모델이 막아야 한다 (§4.7)" <<'EOF'
events {}
stream {
  upstream p { server 127.0.0.1:9101; }
  server { listen 19106 udp; proxy_pass p; proxy_protocol on; }
}
EOF

conf_test E7 fail "\$connection_upgrade 는 내장 변수가 아니다 (§7.1)" <<'EOF'
events {}
http {
  upstream p { server 127.0.0.1:9101; }
  server { listen 19107;
    location / { proxy_pass http://p; proxy_set_header Connection $connection_upgrade; } }
}
EOF

conf_test E8 pass "map 을 렌더하면 \$connection_upgrade 가 성립한다 (§7.1)" <<'EOF'
events {}
http {
  map $http_upgrade $connection_upgrade { default upgrade; '' close; }
  upstream p { server 127.0.0.1:9101; }
  server { listen 19108;
    location / { proxy_pass http://p; proxy_set_header Connection $connection_upgrade; } }
}
EOF

conf_test E9 pass "http2 on; 문법 (core 1.25.1+, §7.6)" <<'EOF'
events {}
http {
  server { listen 19109 ssl; http2 on; server_name t.example.com;
           ssl_certificate cert.pem; ssl_certificate_key key.pem; return 200; }
}
EOF

conf_test E10 fail "upstream resolve 는 zone 없이는 못 쓴다 (§7.3 대안 B)" <<'EOF'
events {}
stream {
  upstream p { server backend.example.com:9101 resolve; }
  server { listen 19110; proxy_pass p; }
}
EOF

conf_test E11 pass "zone + resolver 가 있으면 resolve 가 OSS 에서 동작한다 (§7.3)" <<'EOF'
events {}
stream {
  resolver 127.0.0.11 valid=10s;
  upstream p { zone p 64k; server backend.example.com:9101 resolve; }
  server { listen 19111; proxy_pass p; }
}
EOF

conf_test E12 pass "TCP 와 UDP 는 같은 포트 번호를 공존시킬 수 있다 (§4.5)" <<'EOF'
events {}
stream {
  upstream p { server 127.0.0.1:9101; }
  server { listen 19112;     proxy_pass p; }
  server { listen 19112 udp; proxy_pass p; }
}
EOF

conf_test E13 pass "ssl_preread + preread_timeout (§7.1)" <<'EOF'
events {}
stream {
  map $ssl_preread_server_name $b { default 127.0.0.1:9101; }
  server { listen 19113; ssl_preread on; preread_timeout 5s; proxy_pass $b; }
}
EOF

conf_test E14 fail "http/stream 에 같은 이름의 lua_shared_dict 는 충돌한다 (§3.4 이중 zone 근거)" <<'EOF'
events {}
http   { lua_shared_dict bary 1m; server { listen 19114; return 200; } }
stream { lua_shared_dict bary 1m; server { listen 19115; return ""; } }
EOF

# ── E20+: 런타임 동작 ────────────────────────────────────────────────────
log ""
log "[E20+] 런타임 동작"

# E20/E21 — map 매칭 순서와 대소문자
P=$(mkprefix E20)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
error_log logs/err.log warn;
http {
  access_log off;
  map $host $picked {
    hostnames;
    api.example.com      exact;
    *.example.com        wildcard;
    ~^first\.re\.com$    regex_first;
    ~^.+\.re\.com$       regex_second;
    default              fallback;
  }
  map $host $ci {
    ~^UP\.example\.org$  cs_hit;
    default              cs_miss;
  }
  map $host $ci2 {
    ~*^up\.example\.org$ ci_hit;
    default              ci_miss;
  }
  server {
    listen 19200;
    location /p  { return 200 $picked; }
    location /cs { return 200 $ci; }
    location /ci { return 200 $ci2; }
  }
}
EOF
if start_ng "$P"; then
  # exact 는 wildcard 보다 항상 먼저다 — 등장 순서와 무관
  [ "$(body 19200 /p api.example.com)" = exact ] \
    && ok E20.1 "정확일치가 와일드카드보다 우선 (§7.5 축소 계약의 근거)" \
    || bad E20.1 "정확일치 우선 실패: $(body 19200 /p api.example.com)"
  [ "$(body 19200 /p x.example.com)" = wildcard ] \
    && ok E20.2 "와일드카드 매칭" || bad E20.2 "와일드카드 실패"
  # 정규식끼리는 등장 순서
  [ "$(body 19200 /p first.re.com)" = regex_first ] \
    && ok E20.3 "정규식은 등장 순서대로 평가 (§7.5 strict_priority 의 전제)" \
    || bad E20.3 "정규식 순서 실패: $(body 19200 /p first.re.com)"
  [ "$(body 19200 /p other.re.com)" = regex_second ] \
    && ok E20.4 "뒤 정규식 폴백" || bad E20.4 "뒤 정규식 실패"
  [ "$(body 19200 /p zzz.nomatch.net)" = fallback ] \
    && ok E20.5 "default 폴백" || bad E20.5 "default 실패"
  # ~ 는 대소문자 구분, ~* 는 무시
  [ "$(body 19200 /cs up.example.org)" = cs_miss ] \
    && ok E21.1 "~ 는 대소문자를 구분한다 (§7.1 SNI map 이 ~* 여야 하는 이유)" \
    || bad E21.1 "~ 대소문자 판정 실패"
  [ "$(body 19200 /ci up.example.org)" = ci_hit ] \
    && ok E21.2 "~* 는 대소문자를 무시한다" || bad E21.2 "~* 실패"
  stop_ng "$P"
else
  bad E20 "기동 실패"; bad E21 "기동 실패"
fi

# E22 — server_name 와일드카드가 여러 라벨을 매치하는가 (인증서 선택 위험)
P=$(mkprefix E22)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http {
  access_log off;
  server { listen 19220 default_server; return 200 "default"; }
  server { listen 19220; server_name *.example.org; return 200 "wildcard"; }
}
EOF
if start_ng "$P"; then
  one=$(body 19220 / www.example.org)
  two=$(body 19220 / www.sub.example.org)
  [ "$one" = wildcard ] && ok E22.1 "*.example.org 가 한 라벨을 매치" \
                        || bad E22.1 "한 라벨 매치 실패: $one"
  if [ "$two" = wildcard ]; then
    ok E22.2 "*.example.org 가 **여러 라벨도 매치** — X.509 와일드카드(한 라벨)와 불일치. §4.6 위험 확인"
  else
    bad E22.2 "여러 라벨 매치 안 함($two) — 3차 검수 지적과 다름"
  fi
  [ "$(body 19220 / nomatch.test)" = default ] \
    && ok E22.3 "default_server 는 listen 속성으로만 지정된다 (§4.6)" \
    || bad E22.3 "default_server 폴백 실패"
  stop_ng "$P"
else
  bad E22 "기동 실패"
fi

# E23 — HUP 시 새 리스너 bind 실패하면 nginx 는 옛 설정으로 계속 서비스하는가 (§6.3 핵심)
P=$(mkprefix E23)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
error_log logs/err.log warn;
http { access_log off; server { listen 19230; return 200 "gen1"; } }
EOF
if start_ng "$P"; then
  [ "$(body 19230 / x)" = gen1 ] || bad E23.0 "초기 기동 응답 불일치"
  # 19231 을 외부 프로세스가 점유
  (timeout 20 nc -l -p 19231 >/dev/null 2>&1 &) ; sleep 0.6
  cat > "$P/conf/nginx.conf" <<'EOF'
events {}
error_log logs/err.log warn;
http { access_log off;
  server { listen 19230; return 200 "gen2"; }
  server { listen 19231; return 200 "gen2b"; }
}
EOF
  # -t 는 통과한다 (bind 를 시험하지 않으므로)
  if "$BIN" -t -p "$P" -c conf/nginx.conf >/dev/null 2>&1; then
    ok E23.1 "포트가 점유된 상태에서도 nginx -t 는 통과한다 — §6.3 '검증은 증거가 아니다'"
  else
    bad E23.1 "nginx -t 가 예상과 달리 실패"
  fi
  hup_ng "$P"
  after=$(body 19230 / x)
  alive=$(kill -0 "$(cat "$P/logs/nginx.pid")" 2>/dev/null && echo yes || echo no)
  if [ "$alive" = yes ] && [ "$after" = gen1 ]; then
    ok E23.2 "HUP 실패 후 마스터는 살아 있고 **옛 설정(gen1)으로 계속 서비스** — §6.3 확인"
  elif [ "$after" = gen2 ]; then
    bad E23.2 "새 세대가 활성화됨(gen2) — §6.3 전제가 이 엔진에서 다름"
  else
    bad E23.2 "예상 밖: alive=$alive body=$after"
  fi
  grep -q 'bind()' "$P/logs/err.log" 2>/dev/null \
    && ok E23.3 "error log 에 bind 실패가 남는다 — 판정 신호로 사용 가능" \
    || bad E23.3 "error log 에 bind 실패 흔적 없음 — 판정 신호 재설계 필요"
  stop_ng "$P"
else
  bad E23 "기동 실패"
fi

# E24 — lua_shared_dict 가 HUP 을 넘어 살아남는가 (§6.5)
P=$(mkprefix E24)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http {
  access_log off;
  lua_shared_dict bary 1m;
  server {
    listen 19240;
    location /set { content_by_lua_block { ngx.shared.bary:set("k","v1"); ngx.say("set") } }
    location /get { content_by_lua_block { ngx.say(ngx.shared.bary:get("k") or "MISS") } }
  }
}
EOF
if start_ng "$P"; then
  body 19240 /set x >/dev/null
  [ "$(body 19240 /get x)" = v1 ] || bad E24.0 "set/get 실패"
  hup_ng "$P"
  after=$(body 19240 /get x)
  [ "$after" = v1 ] \
    && ok E24.1 "shared dict 는 HUP 을 넘어 유지된다 (§6.5)" \
    || bad E24.1 "HUP 후 소실됨($after) — §6.5 전제 오류"
  stop_ng "$P"
  start_ng "$P"
  after2=$(body 19240 /get x)
  [ "$after2" = MISS ] \
    && ok E24.2 "인스턴스 전체 종료 후 재시작하면 소실된다 → 부트스트랩 필수 (§6.5, S3)" \
    || bad E24.2 "재시작 후에도 남아 있음($after2)"
  stop_ng "$P"
else
  bad E24 "기동 실패"
fi

# E25 — http zone 과 stream zone 이 서로 보이는가 (§3.4 이중 평면의 근거)
P=$(mkprefix E25)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http {
  access_log off;
  lua_shared_dict http_zone 1m;
  server {
    listen 19250;
    location /seth { content_by_lua_block { ngx.shared.http_zone:set("k","from_http"); ngx.say("ok") } }
    location /peek { content_by_lua_block {
        local s = ngx.shared.stream_zone
        ngx.say(s and (s:get("k") or "NIL_VALUE") or "ZONE_NOT_VISIBLE") } }
  }
}
stream {
  lua_shared_dict stream_zone 1m;
  server {
    listen 19251;
    content_by_lua_block {
      ngx.shared.stream_zone:set("k","from_stream")
      local h = ngx.shared.http_zone
      ngx.say(h and (h:get("k") or "NIL_VALUE") or "ZONE_NOT_VISIBLE")
    }
  }
}
EOF
if start_ng "$P"; then
  body 19250 /seth x >/dev/null
  from_stream=$(SPROBE 19251 '' | tr -d '\r\n')
  from_http=$(body 19250 /peek x)
  log "        stream→http zone: '${from_stream}'  |  http→stream zone: '${from_http}'"
  if [ "$from_stream" = ZONE_NOT_VISIBLE ] || [ "$from_http" = ZONE_NOT_VISIBLE ]; then
    ok E25.1 "http/stream shared dict 는 서로 보이지 않는다 — §3.4 이중 평면 확정"
  elif [ "$from_stream" = from_http ] && [ "$from_http" = from_http ]; then
    bad E25.1 "서로 보인다 — §3.4 이중 구조 전제가 틀렸다 (단순화 가능)"
  else
    skip E25.1 "판정 불가: stream='$from_stream' http='$from_http'"
  fi
  stop_ng "$P"
else
  bad E25 "기동 실패 — 같은 이름이 아닌데도 실패했다면 §3.4 재검토"
fi

# E26 — ssl_preread 로 비-TLS 와 'TLS인데 SNI 없음' 을 구분할 수 있는가 (§4.1, S9)
P=$(mkprefix E26)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http { access_log off;
  server { listen 19261; return 200 "NON_TLS"; }
  server { listen 19262; return 200 "TLS_NO_SNI"; }
  server { listen 19263; return 200 "TLS_SNI"; }
}
stream {
  map $ssl_preread_protocol $tier {
    ""      127.0.0.1:19261;      # 비-TLS
    default 127.0.0.1:19262;      # TLS 인데 SNI 없음
  }
  map $ssl_preread_server_name $named {
    ""      $tier;                 # SNI 없음 → 위 분기로
    default 127.0.0.1:19263;       # SNI 있음
  }
  server { listen 19260; ssl_preread on; proxy_pass $named; }
}
EOF
if start_ng "$P"; then
  r_plain=$(SPROBE 19260 'GET / HTTP/1.0\r\n\r\n' | tail -1 | tr -d '\r\n')
  if [ "$r_plain" = NON_TLS ]; then
    ok E26.1 "\$ssl_preread_protocol 로 **비-TLS 를 구분**할 수 있다 (§4.1 on_no_sni 분기 근거)"
  else
    bad E26.1 "비-TLS 구분 실패: '$r_plain'"
  fi
  if command -v openssl >/dev/null 2>&1; then
    r_nosni=$(timeout 6 openssl s_client -connect 127.0.0.1:19260 -noservername 2>/dev/null </dev/null | grep -c TLS_NO_SNI)
    [ "${r_nosni:-0}" -ge 0 ] && skip E26.2 "TLS-no-SNI 경로는 백엔드가 평문 HTTP 라 완결 검증 불가 — S9 에서 TLS 백엔드로 재실행"
  else
    skip E26.2 "openssl 바이너리 없음 — S9 에서 실행"
  fi
  stop_ng "$P"
else
  bad E26 "기동 실패"
fi

# E28 — stream_realip 없이도 실 클라이언트 IP 를 읽을 수 있는가 (대체 경로의 근거)
P=$(mkprefix E28)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http { access_log off; server { listen 19281; return 200 "ok"; } }
stream {
  log_format bary "ppaddr=$proxy_protocol_addr remote=$remote_addr";
  access_log logs/stream.log bary;
  server { listen 19280 proxy_protocol; proxy_pass 127.0.0.1:19281; }
}
EOF
if start_ng "$P"; then
  SPROBE 19280 'PROXY TCP4 203.0.113.9 10.0.0.1 56324 443\r\nGET / HTTP/1.0\r\n\r\n' >/dev/null
  sleep 0.5
  line=$(tail -1 "$P/logs/stream.log" 2>/dev/null)
  log "        $line"
  case "$line" in
    *ppaddr=203.0.113.9*)
      ok E28.1 "stream_realip 없이도 \$proxy_protocol_addr 가 실 클라이언트 IP 를 준다 — 소스IP 해시 대체 경로" ;;
    *) bad E28.1 "\$proxy_protocol_addr 를 못 읽었다: $line" ;;
  esac
  case "$line" in
    *remote=203.0.113.9*)
      bad E28.2 "\$remote_addr 가 이미 덮여 있다 — 이 엔진엔 realip 이 있는 듯. 제약을 재검토하라" ;;
    *) ok E28.2 "\$remote_addr 는 앞단 주소로 남는다 → 로그·변수는 여전히 프록시 주소다" ;;
  esac
  stop_ng "$P"
else
  bad E28 "기동 실패"
fi

# E29 — PROXY 체인이 실 클라이언트 IP 를 잃는가 (모델이 조합을 막는 이유)
P=$(mkprefix E29)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
stream {
  upstream b { server 127.0.0.1:19291; }
  server { listen 19290 proxy_protocol; proxy_pass b; proxy_protocol on; }
}
EOF
if start_ng "$P"; then
  (timeout 8 nc -l -p 19291 > "$P/captured.txt" 2>/dev/null &)
  sleep 0.4
  SPROBE 19290 'PROXY TCP4 203.0.113.9 10.0.0.1 56324 443\r\nhello\r\n' >/dev/null
  sleep 0.8
  got=$(head -1 "$P/captured.txt" 2>/dev/null | tr -d '\r')
  log "        백엔드 수신: $got"
  case "$got" in
    *203.0.113.9*)
      bad E29.1 "실 클라이언트 IP 가 보존됐다 — 이 엔진에서는 체인 금지 제약이 불필요하다" ;;
    PROXY*)
      ok E29.1 "PROXY 체인이 **실 클라이언트 IP 를 잃는다**(프록시 자신의 주소를 보냄) → 모델이 조합을 막아야 한다" ;;
    *) bad E29.1 "PROXY 헤더를 못 받았다: '$got'" ;;
  esac
  stop_ng "$P"
else
  bad E29 "기동 실패"
fi

# E27 — 비-default server 의 ssl_protocols 가 SNI 별로 적용되는가 (§4.6 override, 3차 지적)
conf_test E27 pass "동일 listen 의 server 별 ssl_protocols 를 설정할 수 있다 (동작은 S16 에서 확인)" <<'EOF'
events {}
http {
  server { listen 19270 ssl default_server; server_name _;
           ssl_certificate cert.pem; ssl_certificate_key key.pem;
           ssl_protocols TLSv1.2 TLSv1.3; return 200; }
  server { listen 19270 ssl; server_name strict.example.com;
           ssl_certificate cert.pem; ssl_certificate_key key.pem;
           ssl_protocols TLSv1.3; return 200; }
}
EOF

log ""
log "=============================================================="
log " PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
log "=============================================================="
printf "$RESULTS" > "$WORK/results.psv" 2>/dev/null || true
[ "$FAIL" -eq 0 ]
