#!/bin/sh
# S19 프로브 — 롤백 경로 합성. 컨테이너 안에서 실행된다.
#
# 답해야 할 질문: **S8 과 S11 이 롤백에서 동시에 성립하는가.**
#
#   S8  인증서는 세대에 결박된다  → 롤백은 옛 세대의 자료를 되살려야 한다
#   S11 epoch 는 재사용 금지      → 롤백도 새 epoch 를 써야 한다
#
# 세대에는 epoch 가 **구워져** 있다(§6.5-1). 그래서 §3.3 은 롤백을 "옛 자료를 새 세대로
# clone 하고 **새 epoch 리터럴을 구워** 활성화" 로 정의했다. 여기서 재는 것은 그 clone 이
# 실제로 성립하는지, 그리고 **clone 을 잘못하면 무엇이 깨지는지**다.
#
# 세 배치를 나란히 돌린다.
#   [A] 재렌더 clone (§3.3 설계)      — 새 epoch 를 다시 굽고 인증서는 바이트로 복사
#   [B] 순진한 clone (`cp -r`)        — epoch 리터럴이 딸려온다
#   [C] 인증서를 symlink 로 clone     — GC 가 옛 세대를 지우면
#
# B·C 는 **실패를 기대하는 배치**다. 통과 = "그렇게 하면 깨진다는 것을 확인했다".
set -u

BIN=/usr/local/openresty/bin/openresty
P=/tmp/s19/prefix
TMPL=/spike/nginx.conf.tmpl
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  PASS  $1  $2"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL  $1  $2"; }

apk add --no-cache openssl curl >/dev/null 2>&1 || true
rm -rf /tmp/s19; mkdir -p $P/logs

# mkcert <dir> <cn>
mkcert() {
  mkdir -p "$1"
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 \
    -subj "/CN=$2" -addext "subjectAltName=DNS:$2" \
    -keyout "$1/privkey.pem" -out "$1/fullchain.pem" >/dev/null 2>&1
}

# render <gen> <epoch> — epoch 리터럴을 **구워서** 세대 conf 를 만든다.
render() {
  mkdir -p "$P/generations/$1"
  sed "s/__EPOCH__/$2/" "$TMPL" > "$P/generations/$1/nginx.conf"
}

publish() { ln -sfn "generations/$1" "$P/current.tmp" && mv -T "$P/current.tmp" "$P/current"; }
hup()     { kill -HUP "$(cat $P/logs/nginx.pid)"; }

stage()    { curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
               -d "$3" "http://127.0.0.1:8081/stage?token=$1&epoch=$2"; }
activate() { curl -s -o /dev/null -w '%{http_code}' --max-time 3 \
               "http://127.0.0.1:8081/activate?token=$1&epoch=$2"; }
state()    { curl -s --max-time 3 http://127.0.0.1:8081/state; }
body()     { curl -s --max-time 3 http://127.0.0.1:8080/ 2>/dev/null; }
whoami_()  { curl -s --max-time 3 http://127.0.0.1:8080/whoami 2>/dev/null; }
certcn()   { echo | timeout 5 openssl s_client -connect 127.0.0.1:8443 2>/dev/null \
               | openssl x509 -noout -subject 2>/dev/null | grep -o 'gen[0-9]*\.example\.com'; }

# **고정 sleep 은 거짓 실패를 만든다** — S8 이 이걸로 두 번 간헐 실패했다. HUP 뒤 옛 워커가
# 드레이닝하는 동안 새 워커와 옛 워커가 번갈아 답하므로, **연속으로** 같은 답이 나와야
# 전환이 끝난 것이다. 예산을 넘기면 마지막 값을 그대로 돌려주므로 진짜 실패는 여전히 실패다.
settled() {   # settled <fn> <want>
  hits=0; i=0; got=""
  while [ $i -lt 60 ]; do
    got=$("$1")
    if [ "$got" = "$2" ]; then
      hits=$((hits+1)); [ $hits -ge 5 ] && { echo "$got"; return; }
    else
      hits=0
    fi
    sleep 0.1; i=$((i+1))
  done
  echo "$got"
}

echo ""
echo "=============================================================="
echo " S19 spike — 롤백 경로 합성 (S8 × S11)"
echo " $($BIN -v 2>&1)"
echo "=============================================================="

# ── 준비: gen1(E10, certA, peers A) → gen2(E20, certB 갱신, peers B) ────────
mkcert "$P/generations/1/certs" gen1.example.com; render 1 10
mkcert "$P/generations/2/certs" gen2.example.com; render 2 20

publish 1
$BIN -t -p $P -c current/nginx.conf >/dev/null 2>&1 || { echo "conf 오류"; $BIN -t -p $P -c current/nginx.conf; exit 1; }
$BIN -p $P -c current/nginx.conf &
sleep 1.2
[ -s $P/logs/nginx.pid ] || { echo "기동 실패"; tail $P/logs/error.log; exit 1; }

stage 1 10 "127.0.0.1:9001" >/dev/null; activate 1 10 >/dev/null
b=$(settled body BACKEND_A)
[ "$b" = BACKEND_A ] && ok S19.setup "E10 이 활성이고 peers=A ($b)" \
                     || bad S19.setup "기대 BACKEND_A, 실제 '$b'"

publish 2; hup
stage 1 20 "127.0.0.1:9002" >/dev/null; activate 1 20 >/dev/null
b=$(settled body BACKEND_B)
c=$(certcn)
[ "$b" = BACKEND_B ] && [ "$c" = gen2.example.com ] \
  && ok S19.forward "E20 으로 전진 — peers=B, 인증서 gen2 ($b/$c)" \
  || bad S19.forward "기대 BACKEND_B/gen2, 실제 '$b'/'$c'"

# ── [A] 재렌더 clone — §3.3 이 규정한 롤백 ────────────────────────────────
echo ""
echo "[A] 옛 자료를 새 세대로 clone + **새 epoch 리터럴을 다시 굽는다** (§3.3)"

mkdir -p "$P/generations/3"
cp -a "$P/generations/1/certs" "$P/generations/3/certs"   # 자료는 **바이트로** 복사
render 3 30                                                # epoch 는 **다시 굽는다**

# §6.2 prepare — 게시 전에 그 자리에서 검증할 수 있는가 (S8.prevalidate 의 롤백판)
if $BIN -t -p $P -c generations/3/nginx.conf >/dev/null 2>&1; then
  ok S19.prevalidate "**롤백 세대를 게시 전에 그 자리에서 검증할 수 있다** — clone 된 인증서 경로가 성립"
else
  bad S19.prevalidate "롤백 세대가 게시 전 검증을 통과하지 못한다 — clone 이 자기완결적이지 않다"
fi

# 롤백 페이로드는 E10 과 **바이트가 같다.** S11 P8 이 잰 "같은 좌표 다른 digest 거부" 의
# 역방향(다른 좌표 같은 digest)이 여기서 생긴다.
#
# **그 축은 여기서 잴 수 없다.** 이 스파이크의 admin 에는 digest 로직이 한 줄도 없어서
# "같은 digest 라 거부됐다" 가 나올 경로 자체가 없다 — 넣어 봤자 **통과할 수밖에 없는
# 체크**라 PASS 수만 부풀린다. 그건 계측이 아니다. digest 비교는 엔진이 아니라 DP 층의
# 질문이고(`src/dp/agent.ts` commit 분기의 `sameCoordinate && digest && authoredBy`),
# `tests/unit/dp-agent.test.ts` P20 과 e2e "롤백도 새 오퍼레이션으로 수렴한다" 가 본다.
stage 1 30 "127.0.0.1:9001" >/dev/null
activate 1 30 >/dev/null
publish 3; hup

w=$(settled whoami_ 30)
[ "$w" = 30 ] && ok S19.epoch_rebaked "**워커가 새 epoch 리터럴을 들고 있다** (GEN_EPOCH=$w) — S11 성립" \
              || bad S19.epoch_rebaked "워커의 epoch 리터럴이 '$w' — 컨트롤 플레인은 30 을 믿는데 갈라졌다"

b=$(settled body BACKEND_A)
[ "$b" = BACKEND_A ] && ok S19.topology_back "topology 가 옛 값으로 돌아왔다 ($b)" \
                     || bad S19.topology_back "기대 BACKEND_A, 실제 '$b'"

c=$(certcn)
[ "$c" = gen1.example.com ] \
  && ok S19.tls_back "**TLS 자료도 그 시점으로 복원됐다** ($c) — S8 성립" \
  || bad S19.tls_back "기대 gen1, 실제 '$c' — 새 세대로 clone 하니 세대 결박이 깨졌다"

# **롤백된 세대의 멤버십 평면이 살아 있는가.** 여기가 A/B 를 가른다 — 롤백은 정적인
# 스냅샷 복원이 아니라 그 위에서 헬스가 계속 흘러야 한다 (§3.3-2 헬스 재투영).
stage 1 30 "127.0.0.1:9003" >/dev/null
b=$(settled body BACKEND_C)
[ "$b" = BACKEND_C ] \
  && ok S19.live_after "**롤백된 세대에서 멤버십 갱신이 계속 먹는다** ($b) — 헬스 재투영이 성립" \
  || bad S19.live_after "롤백 뒤 멤버십 갱신이 안 먹는다 (기대 BACKEND_C, 실제 '$b')"

# ABA — clone 롤백 뒤에도 옛 좌표가 막히는가 (S11 P1 의 롤백판)
r1=$(stage 1 20 "127.0.0.1:9002"); r2=$(activate 1 20); r3=$(stage 1 10 "127.0.0.1:9002")
[ "$r1" = 409 ] && [ "$r2" = 409 ] && [ "$r3" = 409 ] \
  && ok S19.aba "**늦은 E20·E10 RPC 가 전부 거부된다** ($r1/$r2/$r3) — clone 롤백 뒤에도 ABA 가 막힌다" \
  || bad S19.aba "옛 좌표가 통과했다 ($r1/$r2/$r3)"
b=$(body)
[ "$b" = BACKEND_C ] && ok S19.aba_clean "거부되는 동안 트래픽이 오염되지 않았다 ($b)" \
                     || bad S19.aba_clean "트래픽이 흔들렸다: '$b'"

# ── [B] 순진한 clone — `cp -r` 로 세대를 통째로 베낀다 ────────────────────
echo ""
echo "[B] 옛 세대를 **그대로 복사**하고 새 epoch 로 활성화한 경우"

cp -a "$P/generations/1" "$P/generations/4"    # epoch 리터럴 10 이 딸려온다
stage 1 40 "127.0.0.1:9002" >/dev/null; activate 1 40 >/dev/null
publish 4; hup
sleep 1.5

w=$(whoami_)
if [ "$w" = 10 ]; then
  ok S19.naive_diverges "**워커는 E10 을 들고 있는데 컨트롤 플레인은 E40 을 믿는다** ($(state | tr -d '\n') / worker=$w)"
else
  bad S19.naive_diverges "복사했는데 epoch 리터럴이 '$w' — 실험 설계 오류"
fi

b=$(body)
if [ "$b" = BACKEND_A ]; then
  ok S19.naive_wrong_peer "**E40 로 staging 한 peer 가 아니라 E10 슬롯의 옛 peer 를 쓴다** ($b, 기대했던 것은 BACKEND_B)"
else
  bad S19.naive_wrong_peer "예상 밖: '$b'"
fi

# 그리고 **영구히 귀머거리다** — E40 에 무엇을 넣어도 워커는 E10 슬롯만 본다.
stage 1 40 "127.0.0.1:9003" >/dev/null
sleep 1.0
b=$(body)
if [ "$b" = BACKEND_A ]; then
  ok S19.naive_deaf "**멤버십 갱신이 영영 안 닿는다** — 헬스가 죽은 세대가 된다 ($b)"
else
  bad S19.naive_deaf "갱신이 닿았다: '$b' — 실험 설계 오류"
fi

# ── [C] 인증서를 symlink 로 clone — GC 와 부딪힌다 ────────────────────────
echo ""
echo "[C] 인증서를 옛 세대로 **symlink** 해서 clone 한 경우 (§8.4 GC)"

mkdir -p "$P/generations/5"
ln -s "../1/certs" "$P/generations/5/certs"    # 바이트 복사 대신 링크
render 5 50
stage 1 50 "127.0.0.1:9001" >/dev/null; activate 1 50 >/dev/null
publish 5; hup
w=$(settled whoami_ 50)
c=$(certcn)
[ "$w" = 50 ] && [ "$c" = gen1.example.com ] \
  && ok S19.symlink_works "symlink clone 도 **평소에는 멀쩡하다** (E$w, $c) — 그래서 위험하다" \
  || bad S19.symlink_works "기대 50/gen1, 실제 '$w'/'$c'"

# GC 가 gen1 을 회수한다. gen5 는 롤백 세대라 root 지만, **gen1 은 root 가 아니다.**
mv "$P/generations/1/certs" "$P/generations/1/certs.gone"

alive=$(body)
[ "$alive" = BACKEND_A ] \
  && ok S19.symlink_traffic "지운 직후에도 **이미 로드된 워커는 계속 서비스한다** (열린 fd) — 트래픽만 보면 모른다" \
  || bad S19.symlink_traffic "즉시 끊겼다: '$alive'"

if $BIN -t -p $P -c current/nginx.conf >/dev/null 2>&1; then
  bad S19.symlink_breaks "인증서가 없는데 통과했다 — 실험 설계 오류"
else
  ok S19.symlink_breaks "**다음 reload 가 실패한다** — symlink clone 은 세대를 자기완결적으로 만들지 못한다"
fi

# 대조군: 바이트로 복사한 [A] 의 롤백 세대는 gen1 이 사라져도 멀쩡하다.
if $BIN -t -p $P -c generations/3/nginx.conf >/dev/null 2>&1; then
  ok S19.copy_survives "**바이트로 복사한 롤백 세대는 gen1 이 사라져도 검증을 통과한다** — 이것이 §7.2 가 요구하는 자기완결성"
else
  bad S19.copy_survives "바이트 복사본도 깨졌다 — clone 이 자료를 다 안 옮겼다"
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
  echo " → §3.3 의 롤백 경로가 성립한다. S8 과 S11 이 합성된다."
  echo "   단, clone 은 **재렌더 + 바이트 복사**여야 한다 (B·C 가 그 이유다)."
else
  echo " → 설계 재작업 (S19 는 block)."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
