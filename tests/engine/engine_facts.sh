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
  # **AND 다.** 한 방향만 안 보이는 것으로 양방향 비가시성을 주장할 수 없다.
  if [ "$from_stream" = ZONE_NOT_VISIBLE ] && [ "$from_http" = ZONE_NOT_VISIBLE ]; then
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
  # E26.2 는 **S9 가 가져갔다** (2026-08-23). 여기서는 백엔드가 평문 HTTP 라
  # TLS-no-SNI 경로를 완결 검증할 수 없었다. `spike/s9` 가 백엔드를 stream-lua 로
  # 바꿔 그 제약을 없앴고 — 클라이언트가 TLS 를 말할 필요가 사라진다 —
  # `tests/golden/on-no-sni.test.ts` 가 우리 렌더로 같은 것을 다시 잰다.
  # 스킵을 남겨 두면 "아직 못 쟀다" 로 계속 읽힌다.
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

# E30 — ipv6only 기본값. [::]:p 와 0.0.0.0:p 가 충돌하는가 (§4.5 겹침 판정의 근거)
P=$(mkprefix E30)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
error_log logs/err.log warn;
http {
  access_log off;
  server { listen [::]:19300;    return 200 "v6"; }
  server { listen 0.0.0.0:19300; return 200 "v4"; }
}
EOF
if start_ng "$P"; then
  ok E30.1 "[::]:p 와 0.0.0.0:p 가 **공존한다** — ipv6only 기본값은 on. 겹침으로 보면 안 된다"
  [ "$(body 19300 / x)" = v4 ] && ok E30.2 "IPv4 로 접속하면 v4 소켓이 받는다" \
                               || bad E30.2 "예상 밖: $(body 19300 / x)"
  stop_ng "$P"
else
  bad E30.1 "기동 실패 — 두 소켓이 충돌한다. ipv6only 기본이 off 인 빌드다: $(tail -1 "$P/logs/err.log" 2>/dev/null)"
fi

# E31 — location 은 선언 순서가 아니라 longest-prefix 다 (§7.5 라우트 컴파일러의 근거)
P=$(mkprefix E31)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http {
  access_log off;
  server {
    listen 19310;
    location /     { return 200 "ROOT"; }
    location /api  { return 200 "API"; }
  }
}
EOF
if start_ng "$P"; then
  r=$(body 19310 /api/x x)
  [ "$r" = API ] \
    && ok E31.1 "먼저 선언된 / 가 아니라 **더 긴 /api 가 이긴다** — 사용자 priority 로 path 순서를 뒤집을 수 없다" \
    || bad E31.1 "기대 API, 실제 '$r' — 선언 순서를 따른다면 §7.5 재작성 필요"
  [ "$(body 19310 /other x)" = ROOT ] && ok E31.2 "매칭 안 되면 / 로" || bad E31.2 "폴백 실패"
  stop_ng "$P"
else
  bad E31 "기동 실패"
fi

# E32 — default_server 가 없으면 모르는 Host 는 어디로 가는가 (§4.6)
P=$(mkprefix E32)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http {
  access_log off;
  server { listen 19320; server_name api.example.com; return 200 "FIRST_TENANT"; }
  server { listen 19320; server_name web.example.com; return 200 "SECOND_TENANT"; }
}
EOF
if start_ng "$P"; then
  r=$(body 19320 / evil.example)
  [ "$r" = FIRST_TENANT ] \
    && ok E32.1 "모르는 Host 가 **첫 번째 server 로 조용히 들어간다** — 명시적 default_server 가 없으면 테넌트 간 누수다" \
    || bad E32.1 "예상 밖: '$r'"
  stop_ng "$P"
else
  bad E32 "기동 실패"
fi

# E33 — map 의 제어어는 인용해도 제어어다 (§7.5 SNI/host 렌더의 근거)
conf_test E33.quoted fail "map 키를 \"default\" 로 인용해도 default 절로 해석된다" <<'EOF'
events {}
http {
  map $host $p {
    "default"       quoted;
    default         fallback;
  }
  server { listen 19330; location / { return 200 $p; } }
}
EOF

P=$(mkprefix E33)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http {
  access_log off;
  map $host $p {
    ~^default$    literal_default;
    ~^hostnames$  literal_hostnames;
    api.test      exact;
    default       fallback;
  }
  server { listen 19331; location / { return 200 $p; } }
}
EOF
if start_ng "$P"; then
  [ "$(body 19331 / default)" = literal_default ] \
    && ok E33.regex "앵커 정규식 ~^default\$ 로는 **리터럴 호스트 default 를 매칭할 수 있다**" \
    || bad E33.regex "기대 literal_default, 실제 $(body 19331 / default)"
  [ "$(body 19331 / hostnames)" = literal_hostnames ] && ok E33.regex2 "hostnames 도 동일" \
                                                      || bad E33.regex2 "실패"
  [ "$(body 19331 / api.test)" = exact ] && ok E33.exact "일반 호스트는 그대로" || bad E33.exact "실패"
  stop_ng "$P"
else
  bad E33 "기동 실패"
fi

# E34 — IPv6 업스트림은 대괄호가 필요하다
conf_test E34.bare fail "IPv6 백엔드를 bracket 없이 쓰면 거부된다" <<'EOF'
events {}
stream { upstream p { server 2001:db8::1:443; } server { listen 19340; proxy_pass p; } }
EOF

conf_test E34.bracket pass "bracket 을 씌우면 통과한다" <<'EOF'
events {}
stream { upstream p { server [2001:db8::1]:443; } server { listen 19341; proxy_pass p; } }
EOF

# E35 — server_name 정규식으로 1라벨 와일드카드를 만들 수 있는가 (§4.6 X.509 정합)
P=$(mkprefix E35)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
http {
  access_log off;
  server { listen 19350 default_server; return 200 "DEFAULT"; }
  server { listen 19350; server_name ~^[^.]+\.example\.com$; return 200 "ONE_LABEL"; }
}
EOF
if start_ng "$P"; then
  [ "$(body 19350 / www.example.com)" = ONE_LABEL ] \
    && ok E35.1 "앵커 정규식이 한 라벨을 매치한다" || bad E35.1 "실패: $(body 19350 / www.example.com)"
  [ "$(body 19350 / deep.sub.example.com)" = DEFAULT ] \
    && ok E35.2 "**여러 라벨은 매치하지 않는다** — X.509 와일드카드와 맞는다 (E22.2 와 대조)" \
    || bad E35.2 "다중 라벨이 매치됐다"
  [ "$(body 19350 / example.com)" = DEFAULT ] && ok E35.3 "apex 는 매치하지 않는다" || bad E35.3 "실패"
  [ "$(body 19350 / WWW.EXAMPLE.COM)" = ONE_LABEL ] \
    && ok E35.4 "대소문자 무관 — nginx 가 Host 를 소문자화한다" || bad E35.4 "실패"
  stop_ng "$P"
else
  bad E35 "기동 실패"
fi

# E36 — 겹치는 server_name 은 경고만 내고 첫 블록이 이긴다 (조용한 오동작)
P=$(mkprefix E36)
cat > "$P/conf/nginx.conf" <<'EOF'
events {}
error_log logs/err.log warn;
http {
  access_log off;
  server { listen 19360; server_name a.test b.test; return 200 "FIRST"; }
  server { listen 19360; server_name b.test c.test; return 200 "SECOND"; }
}
EOF
if start_ng "$P"; then
  r=$(body 19360 / b.test)
  if [ "$r" = FIRST ]; then
    ok E36.1 "겹치는 server_name 은 **경고뿐이고 첫 블록이 이긴다** — nginx -t 는 통과하므로 모델이 막아야 한다"
  else
    bad E36.1 "예상 밖: '$r'"
  fi
  # 이 경고는 설정 파싱 중에 나오므로 error_log 가 아니라 **stderr** 로 간다.
  # 즉 error.log 를 뒤져서는 못 찾는다 — 탐지하려면 nginx -t 출력을 봐야 한다.
  if "$BIN" -t -p "$P" -c conf/nginx.conf 2>&1 | grep -q 'conflicting server name'; then
    ok E36.2 "경고는 **nginx -t 의 stderr** 로 나온다. error.log 를 뒤져서는 못 찾는다"
  else
    bad E36.2 "nginx -t 에서도 경고가 없다"
  fi
  stop_ng "$P"
else
  bad E36 "기동 실패"
fi

# E37 — 인용하지 않은 정규식의 후행 백슬래시는 구분자를 이스케이프한다
conf_test E37 fail "정규식 끝의 백슬래시가 세미콜론을 삼킨다" <<'EOF'
events {}
http {
  map $host $x { ~^a\ v; default d; }
  server { listen 19370; return 200 $x; }
}
EOF

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

# ─────────────────────────────────────────────────────────────────────────
# E62 — `include` 의 상대경로는 무엇을 기준으로 풀리는가
#
# 설계가 여기 걸려 있다. §6.3 은 활성화를 **세대별 렌더 리터럴**로 판정하라고 하는데,
# 그 리터럴은 모델의 일부가 아니라서 렌더러가 굽지 못한다. 세대 안의 `admin/` 조각으로
# 빼려면 `include` 가 **conf_prefix**(= conf 파일의 디렉토리) 기준이어야 한다 —
# `ssl_certificate` 가 그런 것처럼(§7.2). prefix(`-p`) 기준이라면 `current` 심볼릭 링크를
# 지나도 항상 같은 파일을 읽어 **세대 결박이 성립하지 않는다.**

p=$(mkprefix E62)
mkdir -p "$p/gen1/admin" "$p/gen2/admin" "$p/admin"
for g in gen1 gen2; do
  cat > "$p/$g/nginx.conf" <<EOF
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http { include admin/*.conf; server { listen 19620; return 200 "root"; } }
EOF
  echo "server { listen 19621; location = /g { return 200 \"$g\"; } }" > "$p/$g/admin/marker.conf"
done
# **prefix 쪽 미끼.** conf_prefix 기준이면 이건 절대 안 읽힌다.
echo 'server { listen 19622; location = /g { return 200 "PREFIX"; } }' > "$p/admin/marker.conf"
ln -sfn "$p/gen1" "$p/current"

if "$BIN" -t -p "$p" -c current/nginx.conf >/dev/null 2>&1; then
  ok E62.1 "**빈 glob include 도 통과한다** — admin 조각이 없는 세대도 유효하다"
else
  bad E62.1 "include admin/*.conf 가 설정을 깨뜨린다"
fi

"$BIN" -p "$p" -c current/nginx.conf >/dev/null 2>&1
i=0; while [ ! -s "$p/logs/nginx.pid" ] && [ $i -lt 50 ]; do i=$((i+1)); sleep 0.1; done
if [ -s "$p/logs/nginx.pid" ]; then
  r=$(body 19621 /g x)
  [ "$r" = gen1 ] && ok E62.2 "**include 는 conf_prefix 기준이다** — current 링크를 지나 세대 자신의 admin 을 읽는다 ($r)" \
                  || bad E62.2 "기대 gen1, 실제 '$r'"
  r=$(body 19622 /g x)
  [ -z "$r" ] && ok E62.3 "**prefix(-p) 쪽의 같은 이름은 안 읽힌다** — 미끼가 로드되지 않았다" \
              || bad E62.3 "prefix 쪽 조각이 읽혔다: '$r' — 세대 결박이 성립하지 않는다"

  ln -sfn "$p/gen2" "$p/current.tmp" && mv -T "$p/current.tmp" "$p/current"
  kill -HUP "$(cat "$p/logs/nginx.pid")" 2>/dev/null; sleep 1.0
  r=$(body 19621 /g x)
  [ "$r" = gen2 ] && ok E62.4 "**링크 교체 + HUP 이 마커를 옮긴다** — 세대별 리터럴이 성립한다 ($r)" \
                  || bad E62.4 "기대 gen2, 실제 '$r' — HUP 뒤에도 옛 조각을 읽는다"
  stop_ng "$p"
else
  bad E62 "기동 실패"
fi

# ─────────────────────────────────────────────────────────────────────────
# E63 — PROXY 헤더의 신뢰 경계는 **어디에** 걸리는가
#
# §4.7 이 `trusted_proxy_cidrs` 를 "필수" 라고 못 박았는데 구현은 불리언 하나였고, 렌더러는
# `stream_realip` 이 없을 때 소스IP 해시를 `$proxy_protocol_addr` 로 계산했다. 근거는
# *"모듈 없이도 실 클라이언트 IP 를 준다"* 였고 **그 말 자체는 참이다.**
#
# 여기서 재는 것은 그 문장에 빠진 절반이다: **그 값을 누가 정하는가.**

p=$(mkprefix E63)
cat > "$p/conf/nginx.conf" <<'CONF'
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
    access_log off;
    default_type text/plain;
    server { listen 19730 proxy_protocol;
             return 200 "remote=$remote_addr pp=$proxy_protocol_addr"; }
    server { listen 19731 proxy_protocol; set_real_ip_from 127.0.0.1;
             real_ip_header proxy_protocol;
             return 200 "remote=$remote_addr pp=$proxy_protocol_addr"; }
    server { listen 19732 proxy_protocol; set_real_ip_from 10.9.9.9;
             real_ip_header proxy_protocol;
             return 200 "remote=$remote_addr pp=$proxy_protocol_addr"; }
}
CONF

if start_ng "$p"; then
  # 공격자가 아무 IP 나 적어 보낸다. peer 는 언제나 127.0.0.1 이다.
  spoof() {
    { printf 'PROXY TCP4 203.0.113.9 10.0.0.1 1234 80\r\nGET / HTTP/1.0\r\n\r\n'; sleep 1; } \
      | timeout 5 nc 127.0.0.1 "$1" 2>/dev/null | tail -1
  }

  r=$(spoof 19730)
  case "$r" in
    *"remote=127.0.0.1"*"pp=203.0.113.9"*)
      ok E63.1 "**realip 없이는 \$proxy_protocol_addr 가 헤더 값 그대로다** — 클라이언트가 정한다 ($r)" ;;
    *) bad E63.1 "예상 밖: '$r'" ;;
  esac

  r=$(spoof 19731)
  case "$r" in
    *"remote=203.0.113.9"*)
      ok E63.2 "신뢰하는 peer 의 헤더는 **\$remote_addr 를 덮는다** ($r)" ;;
    *) bad E63.2 "예상 밖: '$r'" ;;
  esac

  r=$(spoof 19732)
  case "$r" in
    *"remote=127.0.0.1"*"pp=203.0.113.9"*)
      ok E63.3 "**신뢰 목록에 없으면 \$remote_addr 는 안 바뀐다** — 여기가 유일한 게이트다. 그런데 \$proxy_protocol_addr 는 **그때도 헤더 값이다** ($r)" ;;
    *) bad E63.3 "예상 밖: '$r'" ;;
  esac
  stop_ng "$p"
else
  bad E63 "기동 실패"
fi

# E63.5·E63.6 — **stream 의 realip 은 http 와 모양이 다르다**
#
# http 에서는 `set_real_ip_from` + `real_ip_header proxy_protocol` 둘을 낸다. 그대로
# stream 에도 냈더니 기동이 깨졌다:
#
#   [emerg] "real_ip_header" directive is not allowed here
#
# stream 의 realip 모듈에는 그 디렉티브가 **아예 없다** — PROXY 가 유일한 출처라 선언할
# 것이 없기 때문이다. 게이트는 `set_real_ip_from` 만으로 그대로 성립한다.
#
# 이 모듈이 없는 빌드에서는 잴 수 없으므로 건너뛴다. 참조 이미지(OpenResty)가 그렇고,
# 공식 nginx 이미지에는 있다 — E0 이 말한 그 분리다.
if "$BIN" -V 2>&1 | grep -q -- '--with-stream_realip_module'; then
  p=$(mkprefix E63s)
  cat > "$p/conf/nginx.conf" <<'CONF'
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
stream {
    server { listen 19750 proxy_protocol; set_real_ip_from 127.0.0.1;
             return "remote=$remote_addr pp=$proxy_protocol_addr"; }
    server { listen 19751 proxy_protocol; set_real_ip_from 10.9.9.9;
             return "remote=$remote_addr pp=$proxy_protocol_addr"; }
}
CONF
  if start_ng "$p"; then
    sprobe() { printf 'PROXY TCP4 203.0.113.9 10.0.0.1 1234 80\r\n' | timeout 5 nc 127.0.0.1 "$1" 2>/dev/null; }
    r=$(sprobe 19750)
    case "$r" in
      *"remote=203.0.113.9"*) ok E63.5 "**stream 은 set_real_ip_from 만으로 게이트가 선다** — real_ip_header 는 http 전용이고 여기 넣으면 기동이 깨진다 ($r)" ;;
      *) bad E63.5 "예상 밖: '$r'" ;;
    esac
    r=$(sprobe 19751)
    case "$r" in
      *"remote=127.0.0.1"*) ok E63.6 "stream 에서도 신뢰 목록에 없으면 안 바뀐다 ($r)" ;;
      *) bad E63.6 "예상 밖: '$r'" ;;
    esac
    stop_ng "$p"
  else
    bad E63.5 "기동 실패"
  fi
else
  skip E63.5 "stream_realip 이 없는 빌드다 — 이 축은 tests/e2e/v02-capability.test.ts 가 공식 nginx 로 잰다 (E0 의 모듈 분리)"
fi

# **stream 에는 그 게이트가 아예 없을 수 있다.** 참조 이미지에 stream_realip 이 없다.
if "$BIN" -V 2>&1 | grep -q -- '--with-stream_realip_module'; then
  ok E63.4 "이 빌드에는 stream_realip 이 **있다** — stream 에서도 신뢰 경계를 걸 수 있다"
else
  ok E63.4 "이 빌드에는 stream_realip 이 **없다** — stream 에서는 신뢰 경계를 걸 방법이 없고, 그래서 검증기가 그 조합을 막는다"
fi

# ─────────────────────────────────────────────────────────────────────────
# E64 — nginx -t 는 Lua 블록을 **하나도 검증하지 않는다**
#
# 멤버십 평면(§7.3 · S1)은 balancer_by_lua_block 위에 선다. 그런데 §6.2 의 게시 전 검사는
# nginx -t 다. **그 둘이 만나는 지점을 재야 한다** — 게시 전 검사가 밸런서의 문법 오류를
# 잡는가?
#
# **안 잡는다. 하나도.** 그리고 그건 활성화 판정에 그대로 영향을 준다: 세대 마커는
# `return 200` 이라 Lua 와 무관하게 답하므로, **밸런서가 깨진 세대도 "활성화됐다" 로
# 판정된다.** 멤버십 평면을 apply 에 붙일 때 활성화 증거를 넓혀야 한다는 뜻이다.
#
# **처음 쟀을 때는 "content_by_lua 는 잡는다" 로 나왔다.** 거짓이었다 — 그 케이스만
# `location` 밖에 블록을 뒀고, 거부 사유가 Lua 문법이 아니라
# *"directive is not allowed here"* 였다. **거부를 보고 이유를 안 읽었다.**
# 컨텍스트를 맞춰 다시 재니 넷 다 통과다.

conf_test E64.1 pass "init_by_lua_block 의 문법 오류를 nginx -t 가 안 잡는다" <<'EOF'
events {}
http { init_by_lua_block { this is not lua (( } server { listen 19760; return 200; } }
EOF

conf_test E64.2 pass "balancer_by_lua_block 의 문법 오류도 안 잡는다 — **멤버십 평면이 여기 선다**" <<'EOF'
events {}
http { lua_shared_dict d 1m;
  upstream u { server 0.0.0.1:1; balancer_by_lua_block { this is not lua (( } }
  server { listen 19761; location / { proxy_pass http://u; } } }
EOF

conf_test E64.3 pass "init_worker_by_lua_block 도 안 잡는다 — epoch 리터럴이 여기 산다" <<'EOF'
events {}
http { init_worker_by_lua_block { this is not lua (( } server { listen 19762; return 200; } }
EOF

conf_test E64.4 pass "content_by_lua_block **도** 안 잡는다 — location 안에 제대로 둬도 통과한다" <<'EOF'
events {}
http { server { listen 19763; location / { content_by_lua_block { this is not lua (( } } } }
EOF

# ── E65. QUIC 은 UDP 를 점유하고, 그 충돌을 아무도 안 잡는다 (§4.5 · S20) ──
#
# S20 이 실물 h3 클라이언트로 잰 것: 이 엔진에서 h3 는 **된다**. 그런데 §4.5 겹침
# 검증기가 https 리스너를 **tcp 로만** 예약하므로, 같은 포트의 `udp` 리스너와의 충돌을
# 못 본다. 여기서 그 충돌이 실제로 무엇인지 고정한다.
#
# **`nginx -t` 도 안 잡고 런타임도 안 죽는다.** 소켓이 둘 다 열리고, 데이터그램은
# stream 쪽이 먹는다. h3 는 조용히 죽는다 — 운영자가 볼 수 있는 신호가 **하나도 없다.**
# 이것이 h3 를 v0 모델에서 빼 두는 이유이고, 나중에 열 때 검증기가 갚아야 할 빚이다.
log ""
log "[E65] QUIC 과 UDP 의 포트 충돌 (§4.5 · S20)"

if ! echo "$CONF_ARGS" | grep -q -- "--with-http_v3_module"; then
  skip "E65" "빌드에 http_v3_module 이 없다 — 이 엔진에서는 h3 를 낼 수 없다"
else
  QP=19165
  QP_HEX=$(printf '%04X' "$QP")

  # E65.1 — conf 검사는 통과한다. 즉 **정적 검사로는 못 잡는다.**
  conf_test E65.1 pass "\`listen N quic\` 과 stream \`listen N udp\` 가 같은 포트여도 nginx -t 는 통과한다 — 정적 검사로 못 잡는다" <<EOF
events {}
http {
  server {
    listen $QP ssl;
    listen $QP quic reuseport;
    ssl_certificate cert.pem; ssl_certificate_key key.pem;
    return 200 "h3-http";
  }
}
stream {
  server { listen $QP udp; return "udp-stream"; }
}
EOF

  # E65.2 — 런타임. 기동에 성공하고 UDP 소켓이 둘 열린다.
  P=$(mkprefix E65r)
  cat > "$P/conf/nginx.conf" <<EOF
events {}
error_log logs/err.log warn;
pid logs/nginx.pid;
http {
  access_log off;
  server {
    listen $QP ssl;
    listen $QP quic reuseport;
    ssl_certificate cert.pem; ssl_certificate_key key.pem;
    return 200 "h3-http";
  }
}
stream {
  server { listen $QP udp; return "udp-stream"; }
}
EOF
  if ! start_ng "$P"; then
    ok E65.2 "엔진이 기동에 실패한다 — 충돌이 런타임에 잡힌다: $(tail -1 "$P/logs/err.log" 2>/dev/null | cut -c1-110)"
  else
    nudp=$(cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk '{print $2}' | grep -c ":$QP_HEX\$")
    # 데이터그램을 누가 먹는가. stream 의 `return` 이 답하면 stream 이 이긴 것이다.
    ans=$({ printf 'ping'; sleep 0.5; } | timeout 4 nc -u -w2 127.0.0.1 "$QP" 2>/dev/null | head -c 20)
    # `grep -c` 는 못 찾아도 "0" 을 찍고 종료코드 1 을 준다. 거기에 `|| echo 0` 을 붙였더니
    # **"0\n0"** 이 되어 `-eq` 비교가 깨졌다 — 값은 셋 다 예상대로인데 판정만 빨개졌다.
    warn=$(grep -ciE 'duplicate|conflict|in use' "$P/logs/err.log" 2>/dev/null | head -1)
    [ -z "$warn" ] && warn=0
    if [ "${nudp:-0}" -ge 2 ] && [ "$ans" = "udp-stream" ] && [ "${warn:-0}" -eq 0 ]; then
      ok E65.2 "**둘 다 bind 되고(UDP 소켓 $nudp 개) 데이터그램은 stream 이 먹는다('$ans'). 경고 0줄** — h3 는 조용히 죽는다"
    else
      bad E65.2 "예상 밖 (udp소켓=$nudp, 응답='$ans', 경고=$warn) — 이 사실을 다시 세워야 한다"
    fi
    stop_ng "$P"
  fi

  # E65.3 — 대조군. quic 만 두면 UDP 소켓은 하나다. 위의 "둘" 이 충돌의 증거가 된다.
  P=$(mkprefix E65c)
  cat > "$P/conf/nginx.conf" <<EOF
events {}
error_log logs/err.log warn;
pid logs/nginx.pid;
http {
  access_log off;
  server {
    listen $QP ssl;
    listen $QP quic reuseport;
    ssl_certificate cert.pem; ssl_certificate_key key.pem;
    return 200 "h3-http";
  }
}
EOF
  if start_ng "$P"; then
    n1=$(cat /proc/net/udp /proc/net/udp6 2>/dev/null | awk '{print $2}' | grep -c ":$QP_HEX\$")
    t1=$(cat /proc/net/tcp /proc/net/tcp6 2>/dev/null | awk '{print $2}' | grep -c ":$QP_HEX\$")
    if [ "${n1:-0}" -eq 1 ] && [ "${t1:-0}" -ge 1 ]; then
      ok E65.3 "대조 — quic 만 두면 UDP 소켓은 **하나**(그리고 TCP $t1 개). 위의 '둘' 이 충돌의 증거다"
    else
      bad E65.3 "대조가 안 선다 (udp=$n1, tcp=$t1) — E65.2 의 '둘' 이 무엇의 증거인지 말할 수 없다"
    fi
    stop_ng "$P"
  else
    bad E65.3 "quic 단독으로도 안 뜬다 — E65.2 를 해석할 수 없다"
  fi
fi

log ""
log "=============================================================="
log " PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
log "=============================================================="
printf "$RESULTS" > "$WORK/results.psv" 2>/dev/null || true
[ "$FAIL" -eq 0 ]
