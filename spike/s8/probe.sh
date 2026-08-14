#!/bin/sh
# S8 프로브 — 인증서 세대 롤백. 컨테이너 안에서 실행된다.
#
# 답해야 할 질문: **갱신 후 롤백하면 그 시점의 key/chain 이 정확히 복원되는가.**
#
# v0/v1 설계는 conf 를 generations/N 에 두면서 인증서는 mutable 한 /certs/<domain> 에
# 뒀다. 그러면 symlink 를 되돌려도 **그 시점의 인증서를 재현할 수 없다.** 여기서는
# 두 배치를 나란히 돌려 차이를 눈으로 확인한다.
set -u

BIN=/usr/local/openresty/bin/openresty
P=/tmp/s8/prefix
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

apk add --no-cache openssl busybox-extras curl >/dev/null 2>&1 || true
rm -rf /tmp/s8; mkdir -p $P/logs $P/mutable-certs

# mkcert <dir> <cn>
mkcert() {
  mkdir -p "$1"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj "/CN=$2" -addext "subjectAltName=DNS:$2" \
    -keyout "$1/privkey.pem" -out "$1/fullchain.pem" >/dev/null 2>&1
}

# gen <n> <certpath> — **conf 파일이 있는 디렉토리 기준**의 상대경로다.
#   nginx 는 ssl_certificate 를 prefix 가 아니라 conf_prefix(= conf 파일의 디렉토리)
#   기준으로 푼다. 그래서 세대 conf 안의 `certs/...` 는
#     · `-c current/nginx.conf`        → $P/current/certs/...      (symlink 를 따라간다)
#     · `-t -c generations/2/nginx.conf` → $P/generations/2/certs/... (게시 전 검증)
#   양쪽 모두 자기 세대의 인증서를 가리킨다. 세대가 자기완결적이 되는 핵심이다.
gen() {
  mkdir -p "$P/generations/$1"
  cat > "$P/generations/$1/nginx.conf" <<EOF
daemon off;
error_log logs/error.log warn;
events { worker_connections 64; }
http {
    access_log off;
    server {
        listen 127.0.0.1:8443 ssl;
        server_name _;
        ssl_certificate     $2/fullchain.pem;
        ssl_certificate_key $2/privkey.pem;
        return 200 "gen$1";
    }
    server { listen 127.0.0.1:8080; return 200 "gen$1"; }
}
EOF
}

publish() { ln -sfn "generations/$1" "$P/current.tmp" && mv -T "$P/current.tmp" "$P/current"; }
hup()     { kill -HUP "$(cat $P/logs/nginx.pid)"; }

# **고정 sleep 은 거짓 실패를 만든다.** HUP 직후 바로 관측하면 옛 워커가 답할 수 있고,
# 그러면 느린 머신에서 간헐적으로 깨진다 — 실제로 그렇게 한 번 깨졌다.
# 조건이 참이 될 때까지 기다리되 예산을 둔다. 예산을 넘기면 마지막 값을 그대로 돌려주므로
# 진짜 실패는 여전히 실패로 드러난다.
served_until() {
  local want="$1" got="" i=0
  while [ $i -lt 30 ]; do
    got=$(served)
    [ "$got" = "$want" ] && { echo "$got"; return; }
    sleep 0.1; i=$((i+1))
  done
  echo "$got"
}

# HTTP 본문도 같은 이유로 폴링한다.
body_until() {
  local want="$1" got="" i=0
  while [ $i -lt 30 ]; do
    got=$(body)
    [ "$got" = "$want" ] && { echo "$got"; return; }
    sleep 0.1; i=$((i+1))
  done
  echo "$got"
}
served()  { echo | timeout 5 openssl s_client -connect 127.0.0.1:8443 2>/dev/null \
              | openssl x509 -noout -subject 2>/dev/null | grep -o 'gen[0-9]*\.example\.com'; }
body()    { curl -s --max-time 3 http://127.0.0.1:8080/ 2>/dev/null; }

echo ""
echo "=============================================================="
echo " S8 spike — 인증서 세대 롤백"
echo " $($BIN -v 2>&1)"
echo "=============================================================="

# ── 배치 A: 인증서를 **세대 안에** 둔다 (§7.2 설계) ──────────────────────
echo ""
echo "[A] 인증서를 세대 디렉토리 안에 결박한 경우 (§7.2)"

mkcert "$P/generations/1/certs" gen1.example.com
gen 1 "certs"
mkcert "$P/generations/2/certs" gen2.example.com     # 갱신된 인증서
gen 2 "certs"

# §6.2 prepare — 아직 게시하지 않은 세대를 그 자리에서 검증할 수 있는가
publish 1
if $BIN -t -p $P -c generations/2/nginx.conf >/dev/null 2>&1; then
  PREVALIDATE=yes
else
  PREVALIDATE=no
fi
$BIN -t -p $P -c current/nginx.conf 2>&1 | tail -1
$BIN -p $P -c current/nginx.conf &
sleep 1.2
[ -s $P/logs/nginx.pid ] || { echo "기동 실패"; tail $P/logs/error.log; exit 1; }

[ "$PREVALIDATE" = yes ] \
  && ok S8.prevalidate "**게시 전에 gen2 를 그 자리에서 nginx -t 할 수 있다** — §6.2 prepare 가 성립한다" \
  || bad S8.prevalidate "게시하지 않은 세대를 검증할 수 없다 — prepare 단계가 불가능하다"

s=$(served)
[ "$s" = gen1.example.com ] && ok S8.initial "gen1 의 인증서를 제시한다 ($s)" \
                            || bad S8.initial "기대 gen1, 실제 '$s'"

publish 2; hup
s=$(served_until gen2.example.com)
[ "$s" = gen2.example.com ] && ok S8.renew "세대 전환 후 갱신된 인증서를 제시한다 ($s)" \
                            || bad S8.renew "기대 gen2, 실제 '$s'"
[ "$(body)" = gen2 ] && ok S8.swap "symlink 교체 + HUP 으로 새 세대의 conf 가 로드된다" \
                     || bad S8.swap "conf 가 바뀌지 않았다: $(body)"

publish 1; hup
s=$(served_until gen1.example.com)
[ "$s" = gen1.example.com ] \
  && ok S8.rollback "**롤백이 그 시점의 key/chain 을 정확히 복원한다** ($s)" \
  || bad S8.rollback "롤백 후 기대 gen1, 실제 '$s' — 세대 결박이 동작하지 않는다"

# ── 배치 B: 인증서를 세대 밖 mutable 경로에 둔다 (v0/v1 설계) ────────────
echo ""
echo "[B] 인증서를 세대 밖 mutable 경로에 둔 경우 (v0/v1 의 설계)"

cp "$P/generations/1/certs/"*.pem "$P/mutable-certs/"
gen 3 "../../mutable-certs"
gen 4 "../../mutable-certs"          # 내용이 같은 다음 세대 — conf 만 보면 구분되지 않는다
publish 3; hup
s=$(served_until gen1.example.com)
[ "$s" = gen1.example.com ] && ok S8.mutable_initial "mutable 경로에서도 처음엔 gen1 인증서 ($s)" \
                            || bad S8.mutable_initial "기대 gen1, 실제 '$s'"

# 갱신 — 같은 경로를 덮어쓴다
cp "$P/generations/2/certs/"*.pem "$P/mutable-certs/"
publish 4; hup
s=$(served_until gen2.example.com)
[ "$s" = gen2.example.com ] && ok S8.mutable_renew "갱신 후 gen2 인증서 ($s)" \
                            || bad S8.mutable_renew "기대 gen2, 실제 '$s'"

# 롤백 — conf 는 되돌아가지만 인증서 파일은 이미 덮였다
publish 3; hup
# 여기서는 **바뀌지 않는 것**을 기대한다 (mutable 경로라 롤백이 안 된다).
# 그래도 폴링으로 안정될 때까지 기다린 뒤 판정한다.
s=$(served_until gen2.example.com)
if [ "$s" = gen2.example.com ]; then
  ok S8.mutable_broken "**롤백해도 갱신된 인증서가 그대로 나온다** ($s) — v0/v1 설계로는 TLS 를 되돌릴 수 없음을 확인"
elif [ "$s" = gen1.example.com ]; then
  bad S8.mutable_broken "mutable 경로인데도 되돌아갔다 — 실험 설계 오류"
else
  bad S8.mutable_broken "예상 밖: '$s'"
fi

# ── 무결성 검증 ──────────────────────────────────────────────────────────
echo ""
echo "[검증] materialize 직후 확인해야 하는 것"

mkdir -p "$P/generations/5/certs"
cp "$P/generations/1/certs/fullchain.pem" "$P/generations/5/certs/"
cp "$P/generations/2/certs/privkey.pem"   "$P/generations/5/certs/"   # 서로 안 맞는 짝
gen 5 "certs"
if $BIN -t -p $P -c generations/5/nginx.conf >/dev/null 2>&1; then
  bad S8.mismatch "cert/key 불일치가 nginx -t 를 통과했다 — 별도 검증이 필수"
else
  ok S8.mismatch "cert/key 불일치는 nginx -t 가 거부한다 (그래도 materialize 직후 자체 검증은 필요)"
fi

# ── GC root — 현재 로드된 세대의 인증서를 지우면 ─────────────────────────
echo ""
echo "[GC] 현재 세대의 인증서를 지우면 어떻게 되는가 (§8.4 GC root 의 근거)"
publish 1; hup
# **지우기 전에 세대가 실제로 활성화된 것을 확인한다.** 안 그러면 옛 세대를 지운 뒤
# 엉뚱한 것을 재는 셈이 된다.
body_until gen1 >/dev/null
mv "$P/generations/1/certs" "$P/generations/1/certs.gone"
alive=$(body)
[ "$alive" = gen1 ] \
  && ok S8.gc_traffic "인증서 파일을 지워도 **이미 로드된 세대는 계속 서비스한다** (열린 fd)" \
  || bad S8.gc_traffic "즉시 끊겼다: '$alive'"

if $BIN -t -p $P -c current/nginx.conf >/dev/null 2>&1; then
  bad S8.gc_root "인증서가 없는데 nginx -t 가 통과했다"
else
  ok S8.gc_root "**다음 reload 는 실패한다** — 트래픽만 보면 알 수 없다. 그래서 현재/서빙 세대는 GC root 여야 한다"
fi
mv "$P/generations/1/certs.gone" "$P/generations/1/certs"

echo ""
echo "        error.log:"; tail -3 $P/logs/error.log 2>/dev/null | sed 's/^/          /'
kill -QUIT "$(cat $P/logs/nginx.pid)" 2>/dev/null || true
sleep 0.4

echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → §7.2 세대 결박이 성립한다. 롤백이 TLS 까지 되돌린다."
else
  echo " → 설계 재작업 (S8 은 block)."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
