#!/bin/sh
# S17 프로브 — TLS 인증서 선택. 컨테이너 안에서 실행된다.
#
# 답해야 할 질문: **SAN 이 커버하지 않는 인증서를 클라이언트에게 제시하는 일이 있는가.**
#
# 합격 기준(§12.0): exact / 1라벨 와일드카드 / `default_server` 조합에서 **SAN 미커버
# 인증서 제시 0회**. 실패하면 v0 은 exact host 만 지원한다.
#
# 왜 이걸 재야 하는가 — 모델이 `https` 를 **일부러 뺐다**:
#
#   "렌더러가 TLS 종단을 내지 못하는데 타입으로 제공하면, v3 처럼 protocol: 'https' 가
#    평문 listen 443; 으로 렌더된다. S16·S17 이 통과하고 실제 TLS 렌더러가 생긴 뒤에
#    되살린다."
#
# 그래서 이 스파이크가 `https` 를 되살리는 전제다.
#
# ── 무엇이 함정인가 ──────────────────────────────────────────────────────
#
# TLS 는 **인증서를 고른 뒤에** 요청을 파싱한다. 그래서 `server_name` 매칭(E35 로 실측)과
# **인증서 선택**이 같은 규칙일 것이라고 가정하면 안 된다 — handshake 시점에는 SNI 밖에
# 없고, Host 헤더는 아직 오지도 않았다. §4.6 이 *"handshake 시점과 라우팅 시점을 분리"*
# 하라고 한 것이 이 뜻이다.
set -u

BIN=/usr/local/openresty/bin/openresty
P=/tmp/s17/prefix
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

apk add --no-cache openssl >/dev/null 2>&1 || true
rm -rf /tmp/s17; mkdir -p $P/logs $P/certs

# mkcert <이름> <CN> <SAN 목록(콤마)>
mkcert() {
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj "/CN=$2" -addext "subjectAltName=$3" \
    -keyout "$P/certs/$1.key" -out "$P/certs/$1.crt" >/dev/null 2>&1
}

mkcert exact   a.test        "DNS:a.test"
mkcert wild    '*.wild.test' "DNS:*.wild.test"
mkcert def     default.test  "DNS:default.test"

cat > $P/nginx.conf <<'EOF'
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
    access_log off;
    default_type text/plain;

    # default_server — 아무 SNI 도 안 맞을 때 여기로 온다.
    server {
        listen 19770 ssl default_server;
        server_name default.test;
        ssl_certificate     certs/def.crt;
        ssl_certificate_key certs/def.key;
        return 200 "default";
    }
    # exact
    server {
        listen 19770 ssl;
        server_name a.test;
        ssl_certificate     certs/exact.crt;
        ssl_certificate_key certs/exact.key;
        return 200 "exact";
    }
    # 1라벨 와일드카드 — **나이브한 형태.** nginx 와일드카드는 다중 라벨을 삼킨다(E22.2).
    server {
        listen 19770 ssl;
        server_name *.wild.test;
        ssl_certificate     certs/wild.crt;
        ssl_certificate_key certs/wild.key;
        return 200 "wild";
    }
    # 같은 것을 **앵커 정규식**으로. 패스스루 SNI map 이 이미 쓰는 수법이다.
    #
    # **`~*` 가 아니라 `~` 다.** map 은 `~*` 로 대소문자를 무시시키지만(E21),
    # `server_name` 은 `~*` 를 안 받는다 — 아래 S17.tilde_star 가 실측한다.
    server {
        listen 19772 ssl default_server;
        server_name default.test;
        ssl_certificate     certs/def.crt;
        ssl_certificate_key certs/def.key;
        return 200 "default";
    }
    server {
        listen 19772 ssl;
        server_name ~^[^.]+\.wild\.test$;
        ssl_certificate     certs/wild.crt;
        ssl_certificate_key certs/wild.key;
        return 200 "wild";
    }
}
EOF

$BIN -t -p $P -c nginx.conf 2>&1 | tail -1
$BIN -p $P -c nginx.conf &
sleep 1.2
[ -s $P/logs/nginx.pid ] || { echo "기동 실패"; tail -5 $P/logs/error.log; exit 1; }

# 제시된 인증서의 CN 을 읽는다. **본문이 아니라 인증서를 본다** — 인증서 선택이 질문이다.
served_cn() {   # served_cn <SNI 또는 빈 문자열>
  if [ -z "$1" ]; then
    echo | timeout 5 openssl s_client -connect 127.0.0.1:19770 -noservername 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'
  else
    echo | timeout 5 openssl s_client -connect 127.0.0.1:19770 -servername "$1" 2>/dev/null \
      | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'
  fi
}

echo ""
echo "=============================================================="
echo " S17 spike — TLS 인증서 선택"
echo " $($BIN -v 2>&1)"
echo "=============================================================="
echo ""

r=$(served_cn a.test)
[ "$r" = "a.test" ] && ok S17.exact "exact SNI 는 그 인증서를 받는다 ($r)" \
                    || bad S17.exact "기대 a.test, 실제 '$r'"

r=$(served_cn x.wild.test)
[ "$r" = "*.wild.test" ] && ok S17.wildcard "1라벨 와일드카드 SNI 는 와일드카드 인증서를 받는다 ($r)" \
                        || bad S17.wildcard "기대 *.wild.test, 실제 '$r'"

# **여기가 합격 기준이 겨누는 자리다.**
# `deep.x.wild.test` 는 X.509 와일드카드가 커버하지 않는다(한 라벨만 매치, E35.2).
# nginx 의 `server_name *.wild.test` 도 한 라벨만 매치하므로(E35.2) 이건 default 로 가야
# 한다. default 인증서는 이 이름을 커버하지 않지만 **그건 클라이언트가 거절할 일**이고,
# 서버가 "커버한다고 주장하는 잘못된 인증서" 를 주는 것과는 다르다.
# **`server_name *.x` 는 다중 라벨을 삼킨다** (E22.2). X.509 와일드카드는 한 라벨만
# 보장하므로, 그 형태로 렌더하면 **SAN 이 커버하지 않는 인증서를 제시**하게 된다.
# 이건 nginx 의 버그가 아니라 두 문법의 범위가 다른 것이고, **렌더러가 좁혀야 한다.**
r=$(served_cn deep.x.wild.test)
if [ "$r" = "*.wild.test" ]; then
  ok S17.naive_trap "**나이브한 \`server_name *.wild.test\` 는 SAN 미커버 인증서를 제시한다** ($r) — 렌더러가 이 형태를 쓰면 안 되는 이유"
else
  bad S17.naive_trap "예상 밖: '$r' — E22.2 가 뒤집혔다면 렌더 규칙을 다시 정해야 한다"
fi

served_cn2() {
  echo | timeout 5 openssl s_client -connect 127.0.0.1:19772 -servername "$1" 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'
}
r=$(served_cn2 x.wild.test)
[ "$r" = "*.wild.test" ] && ok S17.anchored_ok "앵커 정규식도 1라벨은 와일드카드로 보낸다 ($r)" \
                        || bad S17.anchored_ok "기대 *.wild.test, 실제 '$r'"

r=$(served_cn2 deep.x.wild.test)
if [ "$r" = "default.test" ]; then
  ok S17.anchored "**앵커 정규식은 다중 라벨을 안 삼킨다** — default 로 간다 ($r). X.509 와 렌더가 같은 범위가 된다"
else
  bad S17.anchored "**앵커 정규식으로도 SAN 미커버 인증서가 나갔다** ($r) — v0 은 exact host 만 지원해야 한다"
fi

# **대소문자.** map 에서는 `~*` 를 써야 했다(E21). `server_name` 은 `~` 만 받으니,
# 대소문자 무시를 누가 책임지는지 실측해야 한다 — 아무도 안 하면 `X.WILD.test` 가
# default 로 새고, 그건 SAN 미커버 인증서 제시다.
r=$(served_cn2 X.WILD.test)
if [ "$r" = "*.wild.test" ]; then
  ok S17.case "**대문자 SNI 도 와일드카드로 간다** ($r) — nginx 가 SNI 를 내려서 비교한다. \`~\` 만으로 충분하다"
else
  bad S17.case "대문자 SNI 가 '$r' 로 샜다 — 렌더러가 (?i) 를 직접 붙여야 한다"
fi

# **`server_name` 은 `~*` 를 안 받는다.** map 문법을 그대로 옮기면 nginx -t 가 죽는다.
cat > $P/tilde.conf <<'EOF'
events { worker_connections 8; }
http { server { listen 19779; server_name ~*^[^.]+\.wild\.test$; return 200 "x"; } }
EOF
if $BIN -t -p $P -c tilde.conf >/dev/null 2>&1; then
  bad S17.tilde_star "\`~*\` 가 통과했다 — E21 의 map 문법이 server_name 에도 된다면 렌더 규칙을 다시 정한다"
else
  ok S17.tilde_star "**\`server_name ~*\` 는 nginx -t 가 거절한다** — \`~*\` 는 map 전용이다(E21). 렌더러가 문법을 옮겨 쓰면 안 된다"
fi

r=$(served_cn nope.test)
[ "$r" = "default.test" ] && ok S17.unmatched "모르는 SNI 는 default_server 의 인증서 ($r)" \
                          || bad S17.unmatched "기대 default.test, 실제 '$r'"

r=$(served_cn "")
[ "$r" = "default.test" ] && ok S17.no_sni "**SNI 가 없어도 handshake 는 끊기지 않는다** — default 인증서를 준다 ($r)" \
                          || bad S17.no_sni "기대 default.test, 실제 '$r'"

# ── default_server 가 없으면 ────────────────────────────────────────────
#
# E32 는 http 에서 *"default_server 가 없으면 모르는 Host 가 첫 번째 server 로 조용히
# 들어간다"* 를 실측했다. TLS 에서도 같은가 — 그러면 **모르는 SNI 가 첫 블록의 인증서를
# 받는다.** 멀티테넌트에서 그건 테넌트 간 누수다.
kill -QUIT "$(cat $P/logs/nginx.pid)" 2>/dev/null; sleep 0.4
cat > $P/nginx.conf <<'EOF'
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
    access_log off;
    default_type text/plain;
    server {
        listen 19771 ssl;
        server_name a.test;
        ssl_certificate     certs/exact.crt;
        ssl_certificate_key certs/exact.key;
        return 200 "exact";
    }
    server {
        listen 19771 ssl;
        server_name *.wild.test;
        ssl_certificate     certs/wild.crt;
        ssl_certificate_key certs/wild.key;
        return 200 "wild";
    }
}
EOF
$BIN -p $P -c nginx.conf &
sleep 1.2

first_cn() {
  echo | timeout 5 openssl s_client -connect 127.0.0.1:19771 -servername "$1" 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'
}
r=$(first_cn nope.test)
if [ "$r" = "a.test" ]; then
  ok S17.no_default "**default_server 가 없으면 모르는 SNI 가 첫 블록의 인증서를 받는다** ($r) — E32 와 같은 함정이다. 렌더러가 default_server 를 반드시 낸다"
else
  bad S17.no_default "예상 밖: '$r' — 이 사실이 바뀌면 렌더 규칙을 다시 정해야 한다"
fi

kill -QUIT "$(cat $P/logs/nginx.pid)" 2>/dev/null; sleep 0.4

echo ""
echo "        error.log:"; tail -3 $P/logs/error.log 2>/dev/null | sed 's/^/          /'
echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → 인증서 선택이 성립한다. **단, 조건이 둘 있다.**"
  echo "   ① 와일드카드는 \`server_name *.x\` 가 아니라 **앵커 정규식 \`~^[^.]+\\.suffix$\`**"
  echo "      로 낸다. 나이브한 형태는 다중 라벨을 삼켜 SAN 미커버 인증서를 제시한다(E22.2)."
  echo "      **\`~*\` 가 아니다** — 그건 map 전용이고 server_name 에서는 nginx -t 가 죽는다."
  echo "   ② TLS 리스너마다 **default_server 를 반드시 낸다.** 없으면 모르는 SNI 가"
  echo "      첫 블록의 인증서를 받는다 — E32 와 같은 함정이다."
else
  echo " → v0 은 exact host 만 지원한다 (§12.0 S17 실패 시 규칙)."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
