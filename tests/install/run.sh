#!/usr/bin/env bash
# `deploy/install.sh` 를 **배포판별 실제 컨테이너에서** 돌린다.
#
#   ./tests/install/run.sh                 전부 (순차 — 도커 자원 경합을 안 만든다)
#   ./tests/install/run.sh debian alpine   골라서
#   ./tests/install/run.sh --keep debian   실패한 판을 남겨 둔다 (docker exec 로 들어간다)
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
#   5. `bary status` 가 답하는가            — 토큰 해시와 API 가 맞물렸는가
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
amazon|amazonlinux:2023|systemd|-
alpine|alpine:3.21|openrc|-
"

WANT="$*"
[ -z "$WANT" ] && WANT="debian ubuntu rocky amazon alpine"

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
wait_ready() {                 # wait_ready <컨테이너>
  local c="$1" i=0
  until docker exec "$c" curl -fsS --max-time 2 http://127.0.0.1:8088/readyz >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then return 1; fi
    sleep 1
  done
  return 0
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
  printf '  ..    install.sh --with-postgres (패키지·빌드로 몇 분 걸린다)\n'
  if ! docker exec "$c" sh /repo/deploy/install.sh --with-postgres \
       --env "BARY_SECRET_KEK=$KEK" > "/tmp/bary-install-$name.log" 2>&1; then
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
  if [ "$init" = systemd ]; then
    docker exec "$c" systemctl restart barycenterd >/dev/null 2>&1 || rc=1
  else
    docker exec "$c" rc-service barycenterd restart >/dev/null 2>&1 || rc=1
  fi
  if wait_ready "$c"; then printf '    ok   재기동 뒤에도 /readyz\n'; else printf '    NO   재기동 뒤 /readyz 가 안 답한다\n'; rc=1; fi

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
