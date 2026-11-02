#!/usr/bin/env bash
# `deploy/install.sh` 를 **배포판별 실제 컨테이너에서** 돌린다.
#
#   ./tests/install/run.sh                 전부 (순차 — 도커 자원 경합을 안 만든다)
#   ./tests/install/run.sh debian alpine   골라서
#   ./tests/install/run.sh --keep debian   실패한 판을 남겨 둔다 (docker exec 로 들어간다)
#   ./tests/install/run.sh --list-planes   기본 판 이름 목록 (CI 가 매트릭스를 만든다)
#
# 설치 스크립트는 **문서와 같은 부류의 물건**이다: 읽어서는 도는지 알 수 없고, 손으로
# 확인하는 한 반드시 썩는다. 배포판이 저장소 경로를 옮기거나 패키지 이름을 바꾸면
# 조용히 깨지는데, 그 신호는 "새 VM 에 깔았더니 안 된다" 로 몇 달 뒤에 온다.
#
# 그래서 판정은 **설치가 0 을 냈는가**가 아니다. 그건 시작일 뿐이고, 여기서 보는 것은:
#
#   1. 서비스가 실제로 active 인가          — 유닛이 문법만 맞는 것과 다르다
#   2. `/readyz` 가 답하는가                — 엔진이 붙었는가. `/healthz` 와 뜻이 다르다
#   3. nginx 마스터가 비-root 로 도는가     — `setcap` 경로가 정말 섰는가
#   4. **재기동 뒤에도** 1·2 가 참인가      — `--write-bootstrap` 이 활성 세대를 되돌리지
#                                             않는다는 것은 재기동해 봐야만 안다
#   4-b. 데몬 재시작·정지가 nginx 를 안 건드리는가 (systemd, #122) — 마스터 PID 가 그대로
#   4-c. 데몬을 재시작하는 동안 API 요청이 실패하지 않는가 (systemd, 소켓 활성화 2026-11-02)
#   5. `bary status` 가 답하는가            — 토큰 해시와 API 가 맞물렸는가
#   5-b. reload 가 재시작 없이 토큰을 들이는가 — PID 가 그대로여야 한다. `/status` 의 판 표시도
#   5-c. 사람 계정이 설치에서 바로 서는가 — 첫 관리자 링크 → TOTP 관리자 → 로그인 → MFA → /me
#   6. apply 가 :80 을 여는가                — `setcap` 이 걸렸다는 것과 특권 포트가
#                                             열린다는 것은 다른 사실이다
#
#   7. `--dsn` 으로 다시 깔아도 서는가     — **debian 판에서만** 잰다. 하네스가
#                                             `--with-postgres` 만 돌면 실배포에서 더 흔한
#                                             쪽(외부 PG)이 한 번도 안 돌아 본 채 나간다
#
#   7-a. **재설치가 무엇을 안 부수는가**     — 재실행이 곧 업데이트 경로다. "다시 깔아도
#                                             선다" 는 절반이고, 나머지 절반은 **쓰던
#                                             것이 계속 사는가**다:
#                                               · 첫 설치의 토큰이 그대로 통하는가
#                                               · `BARY_SECRET_KEK` 이 env 에 남았는가
#                                                 (잃으면 자료를 영영 못 연다 — STATUS §2)
#                                             둘 다 **드러나는 데 시차가 있는** 종류라
#                                             — 토큰은 다음 배포 스크립트가, KEK 은
#                                             인증서를 읽는 순간이 알려 준다 — 여기서
#                                             안 재면 아무도 안 잰다
#   7-b. 좁은 umask 셸에서 깔아도 서는가 — **rocky10 판에서만** 잰다 (#98). umask 077 셸에서
#                                             돌리고 1~6 을 그대로 본다
#   8. 대화형으로 깔아도 같은 것이 서는가   — **ubuntu 판에서만** 잰다. 답을 파이프로
#                                             넣고 `--interactive` 로 강제한다. 프롬프트가
#                                             도는 것과 그 답이 **env 파일까지 가는 것**은
#                                             다른 사실이라, `--env` 로 받은 키가 파일에
#                                             있는지까지 본다
#
# **안 재는 것도 적어 둔다** (조용한 상한을 안 만든다): 나머지 네 판의 재설치, 실제
# 트래픽(백엔드는 일부러 죽은 것을 가리킨다), 그리고 재부팅 뒤 기동 — 유닛의
# `ExecStartPre=+install -d` 는 `/run` 이 비는 그 경로를 위한 것인데 컨테이너에는
# 재부팅이 없다.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 1

# **기본으로 도는 판의 목록은 여기 한 곳이다.** CI 는 `--list-planes` 로 이 목록을 받아 판마다
# 러너 하나씩 매트릭스를 만든다 — 워크플로에 이름을 다시 적으면 로컬과 갈라진다
# (`verify.sh --list-groups` 와 같은 모양이다).
DEFAULT_PLANES="debian ubuntu rocky rocky10 amazon alpine global"
if [ "${1:-}" = "--list-planes" ]; then printf '%s\n' $DEFAULT_PLANES; exit 0; fi

KEEP=0
if [ "${1:-}" = "--keep" ]; then KEEP=1; shift; fi

# 32 바이트 base64. **고정값이다** — 하네스가 재는 것은 이 값이 안전한가가 아니라
# 재설치가 이 줄을 **그대로 이어 가는가**이고, 그러려면 뒤에서 같은 문자열로 대조할 수
# 있어야 한다. 실배포에서 이 값을 쓰면 안 된다는 것은 말할 필요도 없다.
KEK='YmFyeWNlbnRlci1oYXJuZXNzLWtlay0zMi1ieXRlcyE='

# 이름|베이스 이미지|초기화 시스템|추가 검사
ALL_PLANES="
debian|debian:12|systemd|dsn
ubuntu|ubuntu:24.04|systemd|interactive
rocky|rockylinux/rockylinux:9|systemd|-
rocky10|rockylinux/rockylinux:10|systemd|umask
global|debian:12|systemd|global
amazon|amazonlinux:2023|systemd|-
alpine|alpine:3.21|openrc|-
"

WANT="$*"
[ -z "$WANT" ] && WANT="$DEFAULT_PLANES"

command -v docker >/dev/null 2>&1 || { echo "  FAIL  docker 가 없다"; exit 1; }
docker info >/dev/null 2>&1 || { echo "  FAIL  도커 데몬이 안 돈다"; exit 1; }

RESULTS=""
FAILED=0

plane_line() {                 # plane_line <이름>
  printf '%s' "$ALL_PLANES" | grep "^$1|" || true
}

expect() {                     # expect <설명> <컨테이너> <명령...>
  local what="$1"; shift
  if docker exec "$@" >/tmp/bary-install-expect.log 2>&1; then
    printf '    ok   %s\n' "$what"
    return 0
  fi
  printf '    NO   %s\n' "$what"
  sed 's/^/         /' /tmp/bary-install-expect.log | tail -n 15
  return 1
}

# `/readyz` 가 답할 때까지 기다린다. 고정 sleep 은 느린 머신에서 거짓 실패를 만든다.
wait_ready() {                 # wait_ready <컨테이너> [포트]
  local c="$1" port="${2:-8088}" i=0
  until docker exec "$c" curl -fsS --max-time 2 "http://127.0.0.1:$port/readyz" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then return 1; fi
    sleep 1
  done
  return 0
}

# **전역 판 — 한 프로세스, Host 로 고른다** (docs/adr-host-dispatch.md). 별도 전역 서비스는 없다. 지역을 깔면서
# `--env BARY_GLOBAL_HOST · BARY_GLOBAL_REGIONS` 를 준다. 지역 목록에는 **닿지 않는 지역** 하나만 둔다 — 재는 것은
# 중계가 아니라(그건 단위 테스트가 잰다) **설치가 그 env 를 이어 데몬이 Host 로 고르는가**다:
#   전역 Host 의 readyz 는 전역 · 다른 Host 는 지역 이름 · 못 닿은 지역을 「모른다」로 · 지역 목록은 전역 Host 에만 ·
#   서비스는 하나 · `--mode global` 은 안내하고 멈춘다 · 옛 `BARY_MODE=global` 이면 기동을 거부한다.
run_global() {                 # run_global <컨테이너> <이름>
  local c="$1" name="$2" rc=0 d token gh=global.test
  d=$(mktemp -d)
  openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=127.0.0.1 \
    -keyout "$d/k.pem" -out "$d/ca.pem" >/dev/null 2>&1 || { printf '    NO   시험용 CA 를 못 만들었다\n'; return 1; }
  printf 'region-token' > "$d/t"
  printf '[{"name":"faraway","api":"https://127.0.0.1:1","gui":"https://faraway.example:8443","ca":"/etc/bary-regions/ca.pem","token":"/etc/bary-regions/t"}]\n' > "$d/r.json"
  docker exec "$c" mkdir -p /etc/bary-regions
  for f in ca.pem t r.json; do docker cp "$d/$f" "$c:/etc/bary-regions/$f"; done
  rm -rf "$d"
  # 시험용이라 모두 읽게 둔다. 운영은 root:bary 0640 (런북).
  docker exec "$c" sh -c 'chmod 0755 /etc/bary-regions && chmod 0644 /etc/bary-regions/*' >/dev/null 2>&1
  if docker exec "$c" sh /repo/deploy/install.sh --mode global > "/tmp/bary-install-$name-mode.log" 2>&1 \
     || ! grep -q 'BARY_GLOBAL_HOST' "/tmp/bary-install-$name-mode.log"; then
    printf '    NO   --mode global 이 안내하고 멈추지 않았다\n'; rc=1
  else
    printf '    ok   --mode global 은 없어졌다고 안내하고 멈춘다\n'
  fi
  printf '  ..    install.sh --with-postgres --no-accounts + 전역 Host (몇 분 걸린다)\n'
  if ! docker exec "$c" sh /repo/deploy/install.sh --with-postgres --no-accounts \
       --env BARY_REGION=alpha --env "BARY_GLOBAL_HOST=$gh" --env BARY_GLOBAL_REGIONS=/etc/bary-regions/r.json \
       > "/tmp/bary-install-$name.log" 2>&1; then
    printf '    NO   install.sh 가 실패했다 — 마지막 30줄:\n'
    tail -n 30 "/tmp/bary-install-$name.log" | sed 's/^/         /'
    return 1
  fi
  printf '    ok   install.sh\n'
  wait_ready "$c" 8088 || { printf '    NO   8088 이 준비되지 않았다\n'; return 1; }
  if docker exec "$c" curl -s --max-time 3 -H "host: $gh" http://127.0.0.1:8088/readyz | grep -Eq '"mode": *"global"'; then
    printf '    ok   전역 Host 의 /readyz 가 전역이라고 답한다\n'
  else
    printf '    NO   전역 Host 의 /readyz 가 전역이 아니다\n'; rc=1
  fi
  if docker exec "$c" curl -s --max-time 3 http://127.0.0.1:8088/readyz | tr -d ' \n' | grep -q '"region":"alpha"'; then
    printf '    ok   다른 Host 는 지역으로 답하고 자기 이름(alpha)을 말한다\n'
  else
    printf '    NO   다른 Host 가 지역 이름을 말하지 않는다\n'; rc=1
  fi
  token=$(sed -n 's/^ *\([A-Za-z0-9_-]\{20,\}\) *$/\1/p' "/tmp/bary-install-$name.log" | tail -1)
  if docker exec "$c" curl -s --max-time 10 -H "host: $gh" -H "authorization: Bearer $token" http://127.0.0.1:8088/api/v1/regions \
       | tr -d ' \n' | grep -q '"name":"faraway","gui":"https://faraway.example:8443","reachable":false'; then
    printf '    ok   못 닿은 지역을 「모른다」로 싣는다\n'
  else
    printf '    NO   /api/v1/regions 가 기대한 모양이 아니다\n'; rc=1
  fi
  code=$(docker exec "$c" curl -s --max-time 5 -o /dev/null -w '%{http_code}' -H "authorization: Bearer $token" http://127.0.0.1:8088/api/v1/regions || true)
  if [ "$code" = 404 ]; then
    printf '    ok   지역 목록은 전역 Host 에만 있다\n'
  else
    printf '    NO   지역 Host 에서 /api/v1/regions 가 %s 다\n' "$code"; rc=1
  fi
  if ! docker exec "$c" systemctl cat barycenter-global >/dev/null 2>&1 && ! docker exec "$c" test -e /etc/barycenter-global; then
    printf '    ok   별도 전역 서비스가 없다\n'
  else
    printf '    NO   barycenter-global 이 깔렸다\n'; rc=1
  fi
  # 옛 env 로 뜨면 **기동을 거부**한다 — 지역으로 오해하고 엉뚱한 곳에서 죽지 않게.
  docker exec "$c" sh -c "printf \"BARY_MODE='global'\\n\" >> /etc/barycenter/env && systemctl restart barycenterd" >/dev/null 2>&1
  sleep 3
  if ! docker exec "$c" systemctl is-active --quiet barycenterd \
     && docker exec "$c" journalctl -u barycenterd --no-pager -n 30 2>/dev/null | grep -q 'BARY_MODE=global 는 없어졌다'; then
    printf '    ok   옛 BARY_MODE=global 이면 기동을 거부한다\n'
  else
    printf '    NO   BARY_MODE=global 인데 떴거나 안내가 없다\n'; rc=1
  fi
  return "$rc"
}

run_plane() {                  # run_plane <이름> <베이스> <초기화> <추가검사>
  local name="$1" base="$2" init="$3" extra="${4:--}"
  local img="bary-install-test:$name"
  local c="bary-install-$name"
  local t0 rc=0
  t0=$(date +%s)

  printf '\n── %s (%s · %s)\n' "$name" "$base" "$init"

  docker rm -f "$c" >/dev/null 2>&1

  printf '  ..    판 이미지 빌드\n'
  if ! docker build -q -t "$img" --build-arg "BASE=$base" -f tests/install/Dockerfile tests/install >/dev/null; then
    printf '    NO   판 이미지 빌드 실패\n'
    return 1
  fi

  # `--privileged` 와 cgroup 마운트는 **초기화 시스템을 PID 1 로 띄우기 위한 것**이다.
  # 제품이 그걸 요구하는 것이 아니다 — 판이 요구한다.
  # systemd 도 OpenRC 도 `/sbin/init` 이 진입점이다 (alpine 은 openrc-init 이 거기 걸린다).
  if ! docker run -d --name "$c" --privileged --cgroupns=host \
       --tmpfs /run --tmpfs /run/lock \
       -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
       "$img" /sbin/init >/dev/null; then
    printf '    NO   컨테이너 기동 실패\n'
    return 1
  fi

  # 초기화 시스템이 설 때까지 기다린다.
  local i=0
  while : ; do
    if [ "$init" = systemd ]; then
      case "$(docker exec "$c" systemctl is-system-running 2>&1)" in
        running|degraded) break ;;
      esac
    else
      docker exec "$c" rc-status -r >/dev/null 2>&1 && break
    fi
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then printf '    NO   초기화 시스템이 60초 안에 안 섰다\n'; return 1; fi
    sleep 1
  done
  printf '    ok   %s 기동\n' "$init"

  # 저장소를 **복사해서** 넣는다. 마운트가 아니다 — 워크트리의 `node_modules` 는
  # 메인 트리를 가리키는 심링크라 컨테이너 안에서 끊긴다(`.claude/worktree-bootstrap.md`).
  # 그리고 설치는 원래 「체크아웃을 가져다 깐다」이므로 복사가 실제 모양이다.
  # **macOS 의 tar 는 확장 속성을 같이 싼다.** 그러면 `docker cp` 가
  # `lsetxattr /repo/drivers: xattr "com.apple.provenance": operation not supported`
  # 로 죽는다 — 리눅스 컨테이너가 그 속성을 모른다. 실측했다.
  local tar_extra=""
  [ "$(uname -s)" = Darwin ] && tar_extra="--no-mac-metadata --no-xattrs"
  docker exec "$c" mkdir -p /repo
  # shellcheck disable=SC2086
  if ! tar $tar_extra -cf - \
        --exclude ./node_modules --exclude ./gui/node_modules --exclude ./.git \
        --exclude ./dist --exclude ./dist-testing --exclude ./gui/build \
        --exclude ./.claude \
        . | docker cp - "$c:/repo"; then
    printf '    NO   저장소 복사 실패\n'
    return 1
  fi

  # `--env` 를 **첫 설치에** 준다. 재설치가 관리 밖 줄을 이어 가는지 보려면 이어 갈
  # 것이 있어야 하고, 그 대상은 실제로 걸린 것 중 제일 아픈 것이어야 한다 —
  # `BARY_SECRET_KEK` 이다. 백엔드는 `fs` 그대로라 이 값은 쓰이지 않고 **놓여만 있다**;
  # 재는 것은 데몬의 동작이 아니라 **설치가 이 줄을 보존하는가**다.
  if [ "$extra" = global ]; then
    run_global "$c" "$name"
    return $?
  fi

  # **좁은 umask 의 셸에서 깐다** (#98) — 보안 강화 호스트(CIS 의 027 등)의 모양이다. 스크립트가
  # umask 를 안 정하면 `/opt/barycenter` 가 root 전용으로 복사되고 아래 ① 이 「서비스 active」에서 죽는다.
  local umask_prefix=""
  [ "$extra" = umask ] && umask_prefix="umask 077 && "
  printf '  ..    install.sh --with-postgres (패키지·빌드로 몇 분 걸린다)%s\n' "${umask_prefix:+ — umask 077 셸}"
  if ! docker exec "$c" sh -c "${umask_prefix}exec sh /repo/deploy/install.sh --with-postgres --env BARY_SECRET_KEK=$KEK" \
       > "/tmp/bary-install-$name.log" 2>&1; then
    printf '    NO   install.sh 가 실패했다 — 마지막 30줄:\n'
    tail -n 30 "/tmp/bary-install-$name.log" | sed 's/^/         /'
    return 1
  fi
  printf '    ok   install.sh (전체 로그: /tmp/bary-install-%s.log)\n' "$name"

  # ① 서비스가 active 인가
  if [ "$init" = systemd ]; then
    expect "서비스 active" "$c" systemctl is-active --quiet barycenterd || rc=1
  else
    expect "서비스 started" "$c" rc-service barycenterd status || rc=1
  fi

  # ② /readyz — 엔진이 붙었는가
  if wait_ready "$c"; then printf '    ok   /readyz\n'; else printf '    NO   /readyz 가 안 답한다\n'; rc=1; fi

  # ③ nginx 마스터가 비-root 인가. `setcap` 을 쓰는 이유가 이것이다 —
  #    프로세스는 비-root 이고 낮은 포트를 여는 능력 하나만 갖는다.
  # **pid 파일 경로로 찾지 않는다.** 그 자리가 배포판마다 다르다 — alpine 의 엔진은
  # `/var/run/nginx/nginx.pid` 에 쓴다. 프로세스 목록에서 찾으면 그 차이에 안 걸리고,
  # 재는 것(누가 마스터를 들고 있는가)도 그대로다.
  local nginx_user
  nginx_user=$(docker exec "$c" sh -c "ps -eo user=,args= 2>/dev/null | grep '[n]ginx: master' | head -1 | awk '{print \$1}'" | tr -d ' \n')
  if [ "$nginx_user" = bary ]; then
    printf '    ok   nginx 마스터가 bary 로 돈다\n'
  else
    printf '    NO   nginx 마스터 소유자가 bary 가 아니다 (%s)\n' "${nginx_user:-없음}"
    rc=1
  fi

  # ④ 재기동. **부트스트랩이 활성 세대를 되돌리지 않는다**는 것은 재기동해 봐야 안다.
  #    systemd 에서는 **데몬을 재시작해도 nginx 마스터가 그대로**여야 한다(#122) — 엔진은
  #    별도 유닛이다. 같은 PID 가 「데이터 플레인이 안 끊겼다」의 증거다.
  local master_pid master_pid2
  master_pid=$(docker exec "$c" sh -c "ps -eo pid=,args= | grep '[n]ginx: master' | head -1 | awk '{print \$1}'" | tr -d ' \n')
  if [ "$init" = systemd ]; then
    expect "엔진 유닛 active (barycenter-engine)" "$c" systemctl is-active --quiet barycenter-engine || rc=1
    # **API 소켓은 systemd 가 든다** (2026-11-02) — 재시작하는 동안 들어온 요청이 거절되지 않고 기다린다.
    # 재시작을 걸어 두고 0.1 초마다 부른다. 하나라도 연결 거절(000)이면 소켓 활성화가 안 걸린 것이다.
    expect "API 소켓 유닛 active (barycenterd.socket)" "$c" systemctl is-active --quiet barycenterd.socket || rc=1
    local refused
    refused=$(docker exec "$c" sh -c 'systemctl restart barycenterd & i=0; while [ $i -lt 30 ]; do
        curl -s -o /dev/null -w "%{http_code}\n" --max-time 15 http://127.0.0.1:8088/healthz; i=$((i + 1)); sleep 0.1; done; wait' \
      | grep -cv '^200$' || true)
    if [ "$refused" = 0 ]; then
      printf '    ok   데몬을 재시작하는 동안에도 요청이 실패하지 않는다 (30 번)\n'
    else
      printf '    NO   데몬 재시작 중 요청 %s 번이 실패했다 — 소켓 활성화가 안 걸렸다\n' "$refused"; rc=1
    fi
    docker exec "$c" systemctl restart barycenterd >/dev/null 2>&1 || rc=1
  else
    docker exec "$c" rc-service barycenterd restart >/dev/null 2>&1 || rc=1
  fi
  if wait_ready "$c"; then printf '    ok   재기동 뒤에도 /readyz\n'; else printf '    NO   재기동 뒤 /readyz 가 안 답한다\n'; rc=1; fi
  if [ "$init" = systemd ]; then
    master_pid2=$(docker exec "$c" sh -c "ps -eo pid=,args= | grep '[n]ginx: master' | head -1 | awk '{print \$1}'" | tr -d ' \n')
    if [ -n "$master_pid" ] && [ "$master_pid" = "$master_pid2" ]; then
      printf '    ok   데몬을 재시작해도 nginx 마스터가 그대로다 (PID %s)\n' "$master_pid"
    else
      printf '    NO   데몬 재시작이 nginx 를 다시 띄웠다 (PID %s → %s)\n' "${master_pid:-?}" "${master_pid2:-?}"; rc=1
    fi
    # 데몬을 **내려도** 엔진은 산다 — 그리고 다시 올리면 붙는다.
    docker exec "$c" systemctl stop barycenterd >/dev/null 2>&1
    master_pid2=$(docker exec "$c" sh -c "ps -eo pid=,args= | grep '[n]ginx: master' | head -1 | awk '{print \$1}'" | tr -d ' \n')
    if [ "$master_pid" = "$master_pid2" ]; then
      printf '    ok   데몬을 내려도 nginx 가 산다\n'
    else
      printf '    NO   데몬을 내리자 nginx 가 죽었다\n'; rc=1
    fi
    docker exec "$c" systemctl start barycenterd >/dev/null 2>&1 || rc=1
    if wait_ready "$c"; then printf '    ok   다시 올린 데몬이 엔진에 붙는다\n'; else printf '    NO   다시 올린 데몬이 안 붙는다\n'; rc=1; fi
  fi

  # ⑤ CLI 가 API 에 닿는가 — 토큰 해시와 스코프가 맞물렸는가.
  local token
  token=$(sed -n 's/^ *\([A-Za-z0-9_-]\{20,\}\) *$/\1/p' "/tmp/bary-install-$name.log" | tail -1)
  if [ -n "$token" ]; then
    if docker exec -e BARY_URL=http://127.0.0.1:8088 -e "BARY_TOKEN=$token" \
         "$c" node /opt/barycenter/dist/bin/bary.js status >/dev/null 2>&1; then
      printf '    ok   bary status\n'
    else
      printf '    NO   bary status 가 실패했다\n'
      rc=1
    fi
  else
    printf '    NO   설치 로그에서 토큰을 못 찾았다\n'
    rc=1
  fi

  # ⑤-b **reload 가 재시작 없이 토큰을 들인다** (2026-10-18). 재시작은 데이터 플레인을
  #      끊으므로 토큰 철회가 그 비용을 지면 철회가 늦어진다. 그래서 재는 것은 셋이다:
  #      새 토큰이 통하는가 · **데몬 PID 가 그대로인가**(= 재시작이 아니다) · `/status` 가
  #      설치된 판(`build.commit`)을 말하는가 — 전역 모드가 판 차이를 드러내는 근거다.
  local pid_before pid_after aud
  if [ "$init" = systemd ]; then
    pid_before=$(docker exec "$c" systemctl show -p MainPID --value barycenterd 2>/dev/null | tr -d ' \n')
  else
    pid_before=$(docker exec "$c" cat /run/barycenterd.pid 2>/dev/null | tr -d ' \n')
  fi
  aud=$(docker exec "$c" node -e '
    const fs = require("fs"), c = require("crypto");
    const plain = c.randomBytes(24).toString("base64url");
    const f = "/etc/barycenter/tokens.json";
    const t = JSON.parse(fs.readFileSync(f, "utf8"));
    t.push({ name: "harness-auditor", role: "auditor", hash: "sha256:" + c.createHash("sha256").update(plain).digest("hex") });
    fs.writeFileSync(f, JSON.stringify(t) + "\n");
    process.stdout.write(plain);
  ' 2>/dev/null)
  if [ "$init" = systemd ]; then
    docker exec "$c" systemctl reload barycenterd >/dev/null 2>&1 || rc=1
  else
    docker exec "$c" rc-service barycenterd reload >/dev/null 2>&1 || rc=1
  fi
  sleep 1
  if [ "$init" = systemd ]; then
    pid_after=$(docker exec "$c" systemctl show -p MainPID --value barycenterd 2>/dev/null | tr -d ' \n')
  else
    pid_after=$(docker exec "$c" cat /run/barycenterd.pid 2>/dev/null | tr -d ' \n')
  fi
  local st
  st=$(docker exec "$c" curl -s --max-time 5 -H "authorization: Bearer $aud" http://127.0.0.1:8088/api/v1/status 2>/dev/null)
  if [ -n "$aud" ] && printf '%s' "$st" | grep -q '"head"' \
     && [ -n "$pid_before" ] && [ "$pid_before" = "$pid_after" ]; then
    printf '    ok   reload 가 새 토큰을 들였다 (PID %s 그대로)\n' "$pid_after"
  else
    printf '    NO   reload 뒤 새 토큰이 안 통하거나 데몬이 재시작됐다 (PID %s → %s)\n' "${pid_before:-?}" "${pid_after:-?}"
    rc=1
  fi
  if printf '%s' "$st" | grep -q '"commit"'; then
    printf '    ok   /status 가 설치된 판을 말한다\n'
  else
    printf '    NO   /status 에 build.commit 이 없다\n'
    rc=1
  fi

  # ⑤-c **사람 계정이 설치에서 바로 선다** (공통 회원정책 1차). `--with-postgres` 는 같은 PG 에
  #      `bary_accounts` 를 만들고 KEK 를 만들어 첫 관리자 링크를 낸다. 재는 것은 그 링크 하나로
  #      **관리자 생성(TOTP 포함) → 로그인 → MFA → /me** 가 실제 데몬에서 끝까지 가는가다.
  local link
  link=$(sed -n 's/^  첫 관리자  \(http[^ ]*\/invite#[A-Za-z0-9_-]*\)$/\1/p' "/tmp/bary-install-$name.log" | tail -1)
  if [ -z "$link" ]; then
    printf '    NO   설치 요약에 첫 관리자 링크가 없다\n'
    rc=1
  elif docker exec "$c" node -e '
    const crypto = require("crypto");
    const [link] = process.argv.slice(1);
    const base = "http://127.0.0.1:8088", tok = link.split("#")[1];
    const H = { "content-type": "application/json", origin: base };
    const b32 = (s) => { const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"; let bits = 0, v = 0; const o = [];
      for (const ch of s) { v = (v << 5) | A.indexOf(ch); bits += 5; if (bits >= 8) { o.push((v >>> (bits - 8)) & 255); bits -= 8; } }
      return Buffer.from(o); };
    const totp = (key, t) => { const m = Buffer.alloc(8); m.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
      const h = crypto.createHmac("sha1", key).update(m).digest(); const f = h[h.length - 1] & 15;
      return String((((h[f] & 127) << 24) | (h[f + 1] << 16) | (h[f + 2] << 8) | h[f + 3]) % 1e6).padStart(6, "0"); };
    (async () => {
      const post = (p, b, extra = {}) => fetch(base + p, { method: "POST", headers: { ...H, ...extra }, body: JSON.stringify(b) });
      const pv = await (await post("/api/v1/invitations/preview", { token: tok })).json();
      const key = b32(pv.totp.secret);
      const acc = await post("/api/v1/invitations/accept", { token: tok, username: "root", password: "Harness-admin-pass1",
        totp: { secret: pv.totp.secret, code: totp(key, Date.now()) } });
      if (!acc.ok) throw new Error("accept " + acc.status);
      const li = await post("/api/v1/session/login", { username: "root", password: "Harness-admin-pass1" });
      if ((await li.json()).status !== "mfa_required") throw new Error("mfa 단계가 아니다");
      const mfaC = li.headers.getSetCookie().find((x) => x.startsWith("bary_mfa=")).split(";")[0];
      const mf = await post("/api/v1/session/mfa", { code: totp(key, Date.now() + 30000) }, { cookie: mfaC });
      if (!mf.ok) throw new Error("mfa " + mf.status);
      const sid = mf.headers.getSetCookie().find((x) => /^(__Host-)?bary_sid=/.test(x)).split(";")[0];
      const me = await (await fetch(base + "/api/v1/me", { headers: { cookie: sid } })).json();
      if (me.username !== "root" || me.role !== "admin") throw new Error("me " + JSON.stringify(me));
    })().catch((e) => { console.error(e.message); process.exit(1); });
  ' "$link" >/dev/null 2>&1; then
    printf '    ok   첫 관리자 링크 → 관리자(TOTP) → 로그인 → MFA → /me\n'
  else
    printf '    NO   첫 관리자 흐름이 끝까지 안 갔다\n'
    rc=1
  fi

  # ⑥ **특권 포트를 실제로 연다.** `setcap` 이 걸렸다는 것과 80 번이 열린다는 것은
  #    다른 사실이고, 후자만이 배포가 쓸모 있다는 증거다. 백엔드는 일부러 죽은 것을
  #    가리킨다 — 재는 것은 트래픽이 아니라 **bind 와 활성화**다. nginx 가 답을 하면
  #    (5xx 여도) 소켓이 섰다는 뜻이다.
  if [ -n "$token" ]; then
    docker exec "$c" sh -c 'cat > /tmp/bary-p80.json <<JSON
[
  {"op":"put","kind":"pool","key":"t","body":{"protocolClass":"http","algorithm":"round_robin"}},
  {"op":"put","kind":"backend","key":"t1","body":{"pool":"t","host":"127.0.0.1","port":11,"weight":1}},
  {"op":"put","kind":"listener","key":"l80","body":{"protocol":"http","bind":"0.0.0.0","port":80,"enabled":true,"http":{"defaultAction":{"pool":"t"}}}}
]
JSON' >/dev/null 2>&1
    if docker exec -e BARY_URL=http://127.0.0.1:8088 -e "BARY_TOKEN=$token" \
         "$c" node /opt/barycenter/dist/bin/bary.js apply /tmp/bary-p80.json >/dev/null 2>&1 \
       && docker exec "$c" curl -s --max-time 3 -o /dev/null http://127.0.0.1:80/ >/dev/null 2>&1; then
      printf '    ok   apply → :80 이 열렸다 (특권 포트)\n'
    else
      printf '    NO   :80 리스너를 못 열었다 — setcap 이나 활성화가 안 섰다\n'
      rc=1
    fi
  fi

  # ⑦ `--dsn` 경로 — 이미 서 있는 PG 를 가리켜 **다시** 깐다.
  if [ "$extra" = dsn ]; then
    if docker exec "$c" sh /repo/deploy/install.sh \
         --dsn 'postgres:///bary?host=/run/postgresql' > "/tmp/bary-install-$name-dsn.log" 2>&1 \
       && wait_ready "$c"; then
      printf '    ok   --dsn 으로 재설치해도 선다\n'
    else
      printf '    NO   --dsn 재설치가 실패했다 — 마지막 15줄:\n'
      tail -n 15 "/tmp/bary-install-$name-dsn.log" | sed 's/^/         /'
      rc=1
    fi

    # ⑦-a **재설치가 무엇을 안 부쉈는가.** 여기가 업데이트 경로의 판정이다.
    #
    # 토큰은 **첫 설치의 것**을 쓴다 ($token 은 ⑤ 에서 첫 로그에서 뽑았다). 이것이
    # 통하면 "업데이트해도 쓰던 토큰이 산다" 가 서고, 안 통하면 실배포에서 업데이트가
    # 운영자의 스크립트·CI 를 전부 끊는다는 뜻이다.
    if [ -n "$token" ]; then
      if docker exec -e BARY_URL=http://127.0.0.1:8088 -e "BARY_TOKEN=$token" \
           "$c" node /opt/barycenter/dist/bin/bary.js status >/dev/null 2>&1; then
        printf '    ok   재설치 뒤에도 첫 설치의 토큰이 통한다\n'
      else
        printf '    NO   재설치가 토큰을 갈아 끼웠다 — 업데이트가 클라이언트를 끊는다\n'
        rc=1
      fi
    fi

    # KEK 은 **재설치 명령에 안 줬다.** 그런데도 env 에 남아 있어야 한다 — 그것이
    # 「관리 밖 줄을 이어 간다」의 뜻이고, 이 값을 잃으면 자료를 영영 못 연다.
    if docker exec "$c" grep -q "^BARY_SECRET_KEK='$KEK'\$" /etc/barycenter/env; then
      printf '    ok   재설치 뒤에도 BARY_SECRET_KEK 이 env 에 남았다\n'
    else
      printf '    NO   재설치가 BARY_SECRET_KEK 을 지웠다 — 자료를 영영 못 연다\n'
      rc=1
    fi

    # ⑦-a2 **플래그 없이 다시 깔아도 설정이 살아 있는가** (2026-09-01).
    #
    # 위 ⑦ 은 `--dsn` 을 준다. 그런데 **업데이트하는 사람은 플래그를 다시 안 준다** —
    # 그게 이 회차가 고친 것이다. 아무 옵션 없이 돌려서 `BARY_DSN` 과 `BARY_LISTEN` 이
    # 옛 값 그대로인지 본다. 안 그러면 API 가 조용히 기본값으로 되돌아간다.
    if docker exec "$c" sh /repo/deploy/install.sh > "/tmp/bary-install-$name-bare.log" 2>&1 \
       && wait_ready "$c"; then
      printf '    ok   플래그 없이 재설치해도 선다\n'
      if docker exec "$c" grep -q "^BARY_DSN='postgres:///bary?host=/run/postgresql'\$" \
           /etc/barycenter/env; then
        printf '    ok   DSN 을 이어받았다 (--dsn 을 안 줬는데)\n'
      else
        printf '    NO   DSN 이 사라졌다 — 업데이트가 설정을 잃는다\n'
        rc=1
      fi
      # **이어받았다고 말했는가.** 조용히 이어받으면 무엇이 물려온 값인지 모른다.
      if grep -q '옛 설정을 이어받는다' "/tmp/bary-install-$name-bare.log"; then
        printf '    ok   무엇을 이어받았는지 말한다\n'
      else
        printf '    NO   조용히 이어받았다\n'
        rc=1
      fi
    else
      printf '    NO   플래그 없는 재설치가 실패했다 — 마지막 15줄:\n'
      tail -n 15 "/tmp/bary-install-$name-bare.log" | sed 's/^/         /'
      rc=1
    fi

    # ⑦-a3 **무엇이 설치됐는지 적혔는가.** 없으면 업데이트 앞뒤로 "지금 뭐지" 를 못 묻는다.
    if docker exec "$c" grep -q '^commit=' /etc/barycenter/version; then
      printf '    ok   설치된 커밋을 적었다\n'
    else
      printf '    NO   버전 기록이 없다 — 무엇이 도는지 알 수 없다\n'
      rc=1
    fi

    # ⑦-b **깨진 tokens.json 은 보존하지 않고 고친다** (검수 2026-09-01 ㉮).
    #
    # `tokens_usable` 이 데몬의 `parseTokenSpecs` 를 흉내 내던 때, 그 흉내가 정본보다
    # 느슨해서 **데몬이 거절할 파일을 보존**했다. 그러면 설치는 ⑩ 을 지나 ⑫ 에서
    # `데몬이 60초 안에 안 답했다` 로 죽는다 — 원인을 안 가리키는 메세지다.
    #
    # 여기서 쓰는 입력은 **옛 검사를 통과하던 것**이다: `sha256:` 로 시작하는 해시는
    # 있는데 `name` 이 없다. 단위 테스트는 위임만 재고(그쪽엔 `dist` 가 없다),
    # **두 판정이 실제로 같은지는 여기서만 잰다.**
    docker exec "$c" sh -c \
      'printf "%s" "[{\"scopes\":[\"read\"],\"hash\":\"sha256:deadbeef\"}]" > /etc/barycenter/tokens.json' \
      >/dev/null 2>&1
    if docker exec "$c" sh /repo/deploy/install.sh \
         --dsn 'postgres:///bary?host=/run/postgresql' > "/tmp/bary-install-$name-repair.log" 2>&1 \
       && wait_ready "$c"; then
      printf '    ok   깨진 tokens.json 을 고치고 선다\n'
      # 고쳤으면 **새 토큰을 화면에 냈어야 한다** — 조용히 고치면 운영자는 자기 토큰이
      # 죽은 것을 다음에 API 를 부를 때 안다.
      if grep -q '기존 토큰은 죽는다' "/tmp/bary-install-$name-repair.log"; then
        printf '    ok   고쳤다고 말한다 (새 토큰을 낸다)\n'
      else
        printf '    NO   조용히 고쳤다 — 운영자가 토큰이 바뀐 것을 모른다\n'
        rc=1
      fi
    else
      printf '    NO   깨진 tokens.json 을 못 고쳤다 — 마지막 15줄:\n'
      tail -n 15 "/tmp/bary-install-$name-repair.log" | sed 's/^/         /'
      rc=1
    fi

    # 그리고 **두 줄이 되지 않았는가.** 이어 가기가 관리 키까지 나르면 같은 키가
    # 두 번 들어가고, 어느 쪽이 이기는지는 읽는 쪽(systemd·sh)마다 다르다.
    dup=$(docker exec "$c" sh -c "sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' /etc/barycenter/env | sort | uniq -d" | tr -d '\r')
    if [ -z "$dup" ]; then
      printf '    ok   env 에 중복 키가 없다\n'
    else
      printf '    NO   env 에 같은 키가 두 번 있다: %s\n' "$(printf '%s' "$dup" | tr '\n' ' ')"
      rc=1
    fi
  fi

  # ⑧ 대화형 경로 — 답을 파이프로 넣는다.
  #
  #    답의 순서가 곧 프롬프트의 순서다: PG 선택(2=DSN) · DSN · API 주소 · prefix ·
  #    app-dir · 유저 · 추가 설정 한 줄 · 빈 줄(끝) · 진행 확인.
  #    빈 줄은 "기본값을 쓴다" 이고, 그래서 이 파이프는 **기본값 경로도 같이 잰다.**
  if [ "$extra" = interactive ]; then
    if printf '2\npostgres:///bary?host=/run/postgresql\n\n\n\n\nBARY_PROBE_INTERVAL_MS=3000\n\n\n' \
       | docker exec -i "$c" sh /repo/deploy/install.sh --interactive \
           > "/tmp/bary-install-$name-int.log" 2>&1 \
       && wait_ready "$c" \
       && docker exec "$c" grep -q "^BARY_PROBE_INTERVAL_MS='3000'$" /etc/barycenter/env; then
      printf '    ok   대화형으로 깔아도 선다 (--env 가 env 파일까지 간다)\n'
    else
      printf '    NO   대화형 설치가 실패했다 — 마지막 15줄:\n'
      tail -n 15 "/tmp/bary-install-$name-int.log" | sed 's/^/         /'
      rc=1
    fi
  fi

  local t1; t1=$(date +%s)
  printf '  %s (%d초)\n' "$([ $rc -eq 0 ] && echo PASS || echo FAIL)" "$((t1 - t0))"
  return $rc
}

for name in $WANT; do
  line=$(plane_line "$name")
  if [ -z "$line" ]; then
    echo "  FAIL  모르는 배포판: $name"
    FAILED=1
    continue
  fi
  base=$(printf '%s' "$line" | cut -d'|' -f2)
  init=$(printf '%s' "$line" | cut -d'|' -f3)
  extra=$(printf '%s' "$line" | cut -d'|' -f4)

  if run_plane "$name" "$base" "$init" "$extra"; then
    RESULTS="$RESULTS  PASS  $name\n"
  else
    RESULTS="$RESULTS  FAIL  $name\n"
    FAILED=1
  fi

  # 실패한 판은 남겨 두면 들어가 볼 수 있다. 성공한 판은 치운다 — 도커에
  # 몇 GB 짜리 컨테이너가 배포판 수만큼 쌓인다.
  if [ "$KEEP" = 1 ]; then
    printf '  (컨테이너 유지: docker exec -it bary-install-%s sh)\n' "$name"
  else
    docker rm -f "bary-install-$name" >/dev/null 2>&1
  fi
done

printf '\n'
printf '%b' "$RESULTS"
exit $FAILED
