#!/bin/sh
# S16 프로브 — SNI 별 TLS policy 렌더. 컨테이너 안에서 실행된다.
#
# 답해야 할 질문(§12.0): **비-default server 에 적은 `ssl_protocols` 가 실제 handshake 에
# 적용되는가.**  실패 시 규칙: `override` 제거 — TlsPolicy 를 SNI 별로 다르게 주는 것을
# 모델에서 없앤다.
#
# ── 왜 의심했는가 ────────────────────────────────────────────────────────
#
# S17 이 "인증서는 SNI 별로 갈린다" 를 실측했다. 그래서 TLS 설정도 갈리겠거니 미루어
# 짚기 쉽다. 그런데 **프로토콜 버전 협상은 인증서 선택보다 먼저** 일어난다 —
# ClientHello 를 읽는 시점에 SNI 콜백으로 ctx 를 바꾸기 전이다. 안 걸릴 이유가 충분하다.
#
# 안 재고 타입에 SNI 별 `ssl_protocols` 를 열어두면, GUI 가 "이 도메인만 TLS1.2 이상"
# 이라고 **표시하는데 실제로는 안 걸리는** 상태가 된다. 없는 것보다 나쁘다.
#
# ── 계측기 함정 (이 스파이크가 실제로 밟았다) ────────────────────────────
#
#   openssl s_client -tls1_3 ... | sed -n 's/Protocol *: *//p'
#
# 이건 **성공 판정이 아니다.** `Protocol :` 줄은 s_client 가 *자기 설정*을 찍는 것이라,
# 서버가 alert 70(protocol version) 으로 끊어도 그대로 "TLSv1.3" 이 나온다. 이 지표로
# 재면 **모든 조합이 통과로 보이고**, "ssl_protocols 는 아무 데서도 안 먹는다" 라는
# 있을 수 없는 결론에 도달한다.
#
# 그래서 여기서는 **handshake 가 실제로 섰는가**로 판정한다: `Cipher is (NONE)` /
# `alert protocol version` / `unsupported protocol` 이면 거절, `New, TLSv1.x, Cipher is`
# 가 있으면 그 버전으로 성립.
set -u

BIN=/usr/local/openresty/bin/openresty
P=/tmp/s16/prefix
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

apk add --no-cache openssl >/dev/null 2>&1 || true
rm -rf /tmp/s16; mkdir -p $P/logs $P/certs
for n in default.test strict.test; do
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=$n" \
    -addext "subjectAltName=DNS:$n" \
    -keyout "$P/certs/$n.key" -out "$P/certs/$n.crt" >/dev/null 2>&1
done

PORT=19760

# hs <SNI> <-tls1_2|-tls1_3> → 협상된 버전, 또는 "거절"
hs() {
  out=$(echo | timeout 5 openssl s_client -connect "127.0.0.1:$PORT" -servername "$1" "$2" 2>&1)
  case "$out" in
    *"Cipher is (NONE)"*|*"alert protocol version"*|*"unsupported protocol"*) echo "거절" ;;
    *"Cipher is "*) echo "$out" | sed -n 's/^New, \(TLSv[0-9.]*\),.*/\1/p' | head -1 ;;
    *) echo "거절" ;;
  esac
}
served_cn() {
  echo | timeout 5 openssl s_client -connect "127.0.0.1:$PORT" -servername "$1" 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'
}

# conf <http 레벨> <default server 레벨> <strict server 레벨>  (빈 문자열이면 안 적는다)
conf() {
  h=""; d=""; s=""
  [ -n "$1" ] && h="ssl_protocols $1;"
  [ -n "$2" ] && d="ssl_protocols $2;"
  [ -n "$3" ] && s="ssl_protocols $3;"
  cat > $P/nginx.conf <<EOF
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
  access_log off; default_type text/plain;
  $h
  server { listen $PORT ssl default_server; server_name default.test;
    ssl_certificate certs/default.test.crt; ssl_certificate_key certs/default.test.key;
    $d return 200 "default"; }
  server { listen $PORT ssl; server_name strict.test;
    ssl_certificate certs/strict.test.crt; ssl_certificate_key certs/strict.test.key;
    $s return 200 "strict"; }
}
EOF
  $BIN -t -p $P -c nginx.conf >/dev/null 2>&1 || { echo "  conf 거절"; return 1; }
  $BIN -p $P -c nginx.conf & sleep 1.1
}
stop() { kill -QUIT "$(cat $P/logs/nginx.pid)" 2>/dev/null; sleep 0.5; }

echo ""
echo "=============================================================="
echo " S16 spike — SNI 별 TLS policy"
echo " $($BIN -v 2>&1)"
echo "=============================================================="
echo ""

# ── 0. 계측기 검증 ──────────────────────────────────────────────────────
#
# **판정 지표부터 검증한다.** 이 스파이크는 한 번 여기서 틀렸다. http 레벨 정책은
# 의심의 여지 없이 걸려야 하니, 그게 안 걸리면 지표가 죽은 것이다.
conf "TLSv1.2" "" "" || exit 1
a=$(hs default.test -tls1_2); b=$(hs default.test -tls1_3)
if [ "$a" = "TLSv1.2" ] && [ "$b" = "거절" ]; then
  ok S16.instrument "**계측기 검증** — http 레벨 TLSv1.2 에서 1.3 이 거절된다 (1.2=$a, 1.3=$b)"
else
  bad S16.instrument "계측기가 죽었다 (1.2=$a, 1.3=$b) — 아래 판정을 전부 신뢰할 수 없다"
fi
stop

# ── 1. 전제: server 블록이 SNI 로 갈리는가 ──────────────────────────────
conf "" "TLSv1.2 TLSv1.3" "TLSv1.3" || exit 1
r=$(served_cn strict.test)
[ "$r" = "strict.test" ] && ok S16.precondition "전제 — 인증서는 SNI 별로 갈린다 ($r). server 블록이 실제로 선택된다" \
                        || bad S16.precondition "전제가 깨졌다: 인증서가 '$r'"

# ── 2. 핵심: 비-default server 의 정책이 걸리는가 ───────────────────────
o2=$(hs strict.test -tls1_2); d2=$(hs default.test -tls1_2)
if [ "$o2" = "거절" ] && [ "$d2" = "TLSv1.2" ]; then
  ok S16.applied "**비-default server 의 ssl_protocols 가 걸린다** — strict.test 는 1.2 거절, 같은 리스너의 default 는 1.2 수락. **SNI 별 policy 가 성립한다**"
elif [ "$o2" = "TLSv1.2" ]; then
  bad S16.applied "**안 걸린다** — strict.test 가 1.2 로 붙었다. ssl_protocols 가 리스너 단위라는 뜻이고, §12.0 에 따라 \`override\` 를 제거해야 한다"
else
  bad S16.applied "예상 밖 (strict 1.2=$o2, default 1.2=$d2)"
fi
stop

# ── 3. 반대 방향 ────────────────────────────────────────────────────────
#
# 위가 통과해도 "엄격한 쪽이 리스너 전체를 조인 것" 일 수 있다. default 를 엄격하게,
# 비-default 를 느슨하게 뒤집어서 **비-default 가 default 를 이길 수 있는지** 본다.
conf "" "TLSv1.3" "TLSv1.2 TLSv1.3" || exit 1
o2=$(hs strict.test -tls1_2); d2=$(hs default.test -tls1_2)
if [ "$o2" = "TLSv1.2" ] && [ "$d2" = "거절" ]; then
  ok S16.reverse "**뒤집어도 성립한다** — default 가 1.3 전용이어도 비-default 는 1.2 를 받는다. default_server 값이 리스너를 지배하지 않는다"
else
  bad S16.reverse "비대칭이다 (strict 1.2=$o2, default 1.2=$d2) — 어느 쪽이 이기는지 규칙을 다시 세워야 한다"
fi
stop

# ── 4. 우선순위: server 가 http 를 이긴다 ───────────────────────────────
conf "TLSv1.2 TLSv1.3" "TLSv1.3" "TLSv1.2" || exit 1
o3=$(hs strict.test -tls1_3); d2=$(hs default.test -tls1_2)
if [ "$o3" = "거절" ] && [ "$d2" = "거절" ]; then
  ok S16.precedence "**server 레벨이 http 레벨을 덮는다** — http 가 둘 다 허용해도 각 server 의 값이 이긴다. 렌더러는 policy 를 server 블록에 낸다"
else
  bad S16.precedence "http 레벨이 새어 나온다 (strict 1.3=$o3, default 1.2=$d2)"
fi
stop

echo ""
echo "        error.log:"; tail -3 $P/logs/error.log 2>/dev/null | sed 's/^/          /'
echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → **SNI 별 TLS policy 가 성립한다.** \`override\` 를 유지한다."
  echo "   렌더러는 TlsPolicy 를 **각 server 블록 안**에 낸다 (http 레벨이 아니라)."
  echo ""
  echo "   ⚠ 이건 **엔진 버전에 딸린 사실**이다. 오래된 nginx 는 default_server 의"
  echo "     ssl_protocols 만 살았다. 다른 이미지로 바꾸면 이 스파이크를 다시 돌린다."
else
  echo " → §12.0 규칙에 따라 \`override\` 제거를 검토한다."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
