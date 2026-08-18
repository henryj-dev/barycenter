#!/bin/sh
# S13 프로브 — 마커·워커 레지스트리·GC. 컨테이너 안에서 실행된다.
#
# 합격 기준(§12.0): **옛 워커 잔존 중 오삭제 0회** + §8.4 GC 각 단계 크래시에서
# 누수·이중감소 0회 + GC root 누락 0회. 실패 시 규칙: **GC 보수화**.
#
# ── 왜 지금 재는가 ──────────────────────────────────────────────────────
#
# 코드를 보니 `serving_generations` 가 **아예 없다.** 세대 청소의 보호 목록은 방금 만든
# 것·게시된 것·미완 오퍼레이션뿐이고, **옛 워커가 아직 들고 있는 세대는 숫자 상한
# (기본 10개)으로만 우연히 보호된다.**
#
# S8 이 그 대가를 실측해 뒀다: 쓰이는 중인 세대의 파일을 지워도 **열린 fd 로 트래픽은
# 계속 흐르고 다음 reload 가 깨진다.** 트래픽만 보면 알 수 없다. 그래서 여기서 묻는 것은
# 둘이다.
#
#   ① 옛 워커가 아직 어느 세대를 들고 있는지 **관측할 수 있는가**
#   ② 그 세대를 지우면 실제로 무엇이 깨지는가
set -u

B=/usr/local/openresty/bin/openresty
P=/tmp/s13/prefix
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

apk add --no-cache curl >/dev/null 2>&1 || true
rm -rf /tmp/s13; mkdir -p $P/logs $P/generations

mkgen() {   # mkgen <이름>
  d=$P/generations/$1; mkdir -p "$d/admin"
  cat > "$d/nginx.conf" <<EOF
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http {
    access_log off;
    default_type text/plain;
    include admin/*.conf;
    server {
        listen 19910;
        # 오래 잡아 두는 자리 — 옛 워커를 살려 두려면 in-flight 가 필요하다.
        location = /slow { echo_sleep 30; echo "$1"; }
        location / { return 200 "$1"; }
    }
}
EOF
  # **세대마다 다른 리터럴.** §6.3-4 — 마커가 "누가 응답했는가" 를 말하려면 이래야 한다.
  cat > "$d/admin/marker.conf" <<EOF
server {
    listen 127.0.0.1:19911;
    default_type text/plain;
    location = /generation { return 200 "$1"; }
}
EOF
}

mkgen gen-1
mkgen gen-2
ln -sfn generations/gen-1 $P/current
$B -p $P -c current/nginx.conf
sleep 1.0
[ -s $P/logs/nginx.pid ] || { echo "기동 실패"; tail -5 $P/logs/error.log; exit 1; }

echo ""
echo "=============================================================="
echo " S13 spike — 마커·워커 레지스트리·GC"
echo " $($B -v 2>&1)"
echo "=============================================================="
echo ""

MASTER=$(cat $P/logs/nginx.pid)
workers() { pgrep -P "$MASTER" 2>/dev/null | wc -l | tr -d ' '; }

# ── 옛 워커를 살려 둔다 ────────────────────────────────────────────────
#
# in-flight 요청이 없으면 HUP 뒤 옛 워커가 바로 죽는다. 그러면 이 스파이크가 재려는
# 상황 자체가 안 생긴다.
(curl -s --max-time 25 http://127.0.0.1:19910/slow >/tmp/s13/slow.out 2>&1 &) 
sleep 0.7
W_BEFORE=$(workers)

ln -sfn generations/gen-2 $P/current
kill -HUP "$MASTER"
sleep 1.2
W_AFTER=$(workers)

if [ "$W_AFTER" -gt "$W_BEFORE" ]; then
  ok S13.lingering "**옛 워커가 살아 있다** — in-flight 때문에 안 죽는다 (워커 $W_BEFORE → $W_AFTER)"
else
  bad S13.lingering "옛 워커가 안 남았다 ($W_BEFORE → $W_AFTER) — 이 상황을 못 만들면 아래가 무의미하다"
fi

# ── ① 관측할 수 있는가 ────────────────────────────────────────────────
#
# 마커는 세대에 구워진 리터럴이므로, 옛 워커가 응답하면 **옛 값**이 나온다. 그걸 여러 번
# 두드리면 "아직 옛 세대를 든 워커가 있다" 를 알 수 있는가?
SEEN=""
i=0
while [ "$i" -lt 40 ]; do
  g=$(curl -s --max-time 2 http://127.0.0.1:19911/generation)
  case "$SEEN" in *"$g"*) ;; *) SEEN="$SEEN $g" ;; esac
  i=$((i+1))
done
echo "  마커 40 회 관측 → 본 세대:$SEEN"
case "$SEEN" in
  *gen-1*)
    bad S13.registry_impossible "마커가 옛 세대를 답했다 ($SEEN) — 아래 결론을 다시 세워야 한다" ;;
  *)
    ok S13.registry_impossible "**마커로는 옛 워커를 못 센다** ($SEEN). HUP 뒤 옛 워커는 리스닝 소켓을 닫고 in-flight 만 처리하므로 **새 요청이 옛 워커에 절대 안 간다** — S7 의 A4.3 이 가리킨 자리이고, 워커 레지스트리를 마커로 짓는 길은 여기서 막힌다" ;;
esac

# ── 그럼 무엇으로 경계를 아는가 ────────────────────────────────────────
#
# nginx 는 "어느 워커가 어느 세대인가" 를 안 알려준다. 알 수 있는 것은 **몇 개 살아
# 있는가** 뿐이다(마스터의 자식 수). 그러면 GC 는 "옛 워커가 아직 쓰는가" 를 영영 모른다.
#
# 대신 **얼마나 오래 살 수 있는지에 상한을 걸 수 있다.** `worker_shutdown_timeout` 이
# 그것이고, 그게 걸리면 "이 시간이 지난 세대는 아무도 안 든다" 가 성립한다 — 모르는 것을
# **유계로 바꾸는** 길이다. 실제로 죽이는지 잰다.
echo ""
echo "  worker_shutdown_timeout 을 걸고 다시:"
mkgen gen-3
sed -i 's|events { worker_connections 64; }|worker_shutdown_timeout 2s;\nevents { worker_connections 64; }|' \
  $P/generations/gen-3/nginx.conf
ln -sfn generations/gen-3 $P/current
kill -HUP "$MASTER"; sleep 1.2
# 다시 in-flight 를 만들고 HUP — 이번엔 상한이 걸려 있다.
(curl -s --max-time 25 http://127.0.0.1:19910/slow >/dev/null 2>&1 &)
sleep 0.7
W1=$(workers)
mkgen gen-4
sed -i 's|events { worker_connections 64; }|worker_shutdown_timeout 2s;\nevents { worker_connections 64; }|' \
  $P/generations/gen-4/nginx.conf
ln -sfn generations/gen-4 $P/current
kill -HUP "$MASTER"; sleep 1.0
W2=$(workers)
sleep 3.5
W3=$(workers)
echo "    워커 수: HUP 전 $W1 → 직후 $W2 → 상한(2s) 뒤 $W3"
if [ "$W2" -gt "$W3" ] && [ "$W3" -le "$W1" ]; then
  ok S13.bounded "**\`worker_shutdown_timeout\` 이 잔존 창을 유계로 만든다** — 옛 워커가 상한 뒤 사라진다. GC 는 '어느 세대인가' 를 못 알아도 '이 시간이 지나면 아무도 안 든다' 는 쓸 수 있다"
else
  bad S13.bounded "상한이 안 걸린다 ($W1 → $W2 → $W3) — 잔존 창을 못 닫으면 GC 는 숫자 상한에만 기대야 한다"
fi

# ── ② 지우면 무엇이 깨지는가 ──────────────────────────────────────────
rm -rf $P/generations/gen-1
STILL=$(curl -s --max-time 2 http://127.0.0.1:19910/ || echo "(실패)")
if [ -n "$STILL" ] && [ "$STILL" != "(실패)" ]; then
  ok S13.traffic "지운 뒤에도 트래픽은 흐른다 ($STILL) — **삭제가 트래픽으로 안 보인다** (S8 과 같다)"
else
  bad S13.traffic "트래픽이 즉시 끊겼다 — S8 실측과 다르다"
fi

if $B -t -p $P -c current/nginx.conf >/dev/null 2>&1; then
  ok S13.configtest "활성 세대는 멀쩡하다 — 지운 것은 옛 세대뿐이다"
else
  bad S13.configtest "활성 세대의 config test 가 깨졌다"
fi

echo ""
echo "        error.log:"; tail -3 $P/logs/error.log 2>/dev/null | sed 's/^/          /'
kill -QUIT "$MASTER" 2>/dev/null
echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
echo "=============================================================="
[ "$FAIL" -eq 0 ]
