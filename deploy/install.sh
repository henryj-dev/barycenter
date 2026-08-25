#!/bin/sh
# barycenter 단일 인스턴스 설치 — 전용 VM 한 대 (§11.3 의 권장 배포)
#
#   sudo deploy/install.sh --with-postgres
#   sudo deploy/install.sh --dsn postgres://bary:...@db.internal:5432/bary
#
# 이 스크립트가 세우는 것은 `deploy/Dockerfile` + `deploy/entrypoint.sh` 가 컨테이너
# 안에서 세우는 것과 **같은 모양**이다. 다른 것은 격리 수단뿐이다: 거기서는 이미지가
# 경계를 지고, 여기서는 전용 유저 + `setcap` + 유닛이 진다. 그래서 순서도 같다 —
# 부트스트랩 세대를 데몬이 쓰고(§6.5-1), 엔진을 띄우고, 그 다음 에이전트를 붙인다.
#
# **POSIX sh 다.** alpine 에는 bash 가 없고, 설치 스크립트는 *아무것도 설치되기 전에*
# 돌아야 한다. `scripts/build.sh` 가 같은 이유로 `#!/bin/sh` 인 것과 같다 —
# `#!/usr/bin/env bash` 는 거기서 `exit 127` 로 죽었다.
#
# 검증은 `tests/install/run.sh` 가 진다. 배포판 네 종의 실제 컨테이너에 이 스크립트를
# 그대로 돌리고, systemd 로 서비스를 올리고, `/readyz` 와 `bary status` 까지 본다.
# **문서가 아니라 도는 것이 답한다.**
set -eu

PREFIX=/etc/barycenter
APP_DIR=/opt/barycenter
SVC_USER=bary
LISTEN=127.0.0.1:8088
DSN=
WITH_PG=0
NO_SERVICE=0
SKIP_PACKAGES=0
TLS_CERT=
TLS_KEY=
INTERACTIVE=auto
ASSUME_YES=0
EXTRA_ENV=

# **옵션으로 준 것과 기본값을 가른다.** 둘을 못 가르면 대화가 "이미 정한 것"을 다시
# 묻게 되고, 그러면 옵션이 뜻을 잃는다.
LISTEN_SET=0
PREFIX_SET=0
APP_DIR_SET=0
USER_SET=0

# 이 스크립트가 스스로 정하는 키들. `--env` 로 덮어쓰지 못하게 한다 — 같은 키가 두 줄
# 들어가면 어느 쪽이 이기는지 형식(systemd·sh)마다 다르고, 그건 나중에 찾기 나쁘다.
MANAGED_ENV_KEYS="BARY_DSN BARY_PREFIX BARY_LISTEN BARY_TOKENS_FILE BARY_ENGINE_BIN
BARY_GUI BARY_CONFIGTEST_CMD BARY_RELOAD_CMD BARY_TLS_CERT_FILE BARY_TLS_KEY_FILE"

REPO=$(cd "$(dirname "$0")/.." && pwd)

usage() {
  cat <<'EOF'
barycenter 단일 인스턴스 설치

  deploy/install.sh [--dsn <DSN> | --with-postgres] [옵션]

PostgreSQL (택일 — 터미널에서는 안 주면 물어본다)
  --dsn <postgres://...>   이미 있는 PostgreSQL 을 쓴다
  --with-postgres          같은 호스트에 PostgreSQL 을 설치하고 role·db 를 만든다
                           (유닉스 소켓 + peer 인증 — 비밀번호를 만들지 않는다)

옵션
  --prefix <경로>          세대·상태·소켓이 사는 곳 (기본 /etc/barycenter)
  --app-dir <경로>         산출물이 사는 곳 (기본 /opt/barycenter)
  --user <이름>            서비스 유저 (기본 bary)
  --listen <host:port>     컨트롤 플레인 API (기본 127.0.0.1:8088)
  --tls-cert <경로>        API 서버 인증서 — 루프백 밖으로 열려면 필요하다
  --tls-key <경로>         그 개인키
  --env KEY=VALUE          env 파일에 넣을 BARY_* 설정. 여러 번 줄 수 있다
                           (예: --env BARY_ACME=1 --env BARY_PROBE_INTERVAL_MS=3000)
  --no-service             유닛 파일만 쓰고 enable·start 는 하지 않는다
  --skip-packages          패키지 설치를 건너뛴다 (이미 준비된 이미지)
  -h, --help               이 도움말

대화
  --interactive            빈 칸을 물어본다 (TTY 이고 PostgreSQL 을 안 골랐으면 자동)
  --non-interactive        절대 안 묻는다. 빈 칸이 있으면 죽는다 (CI 에서 쓴다)
  -y, --yes                마지막 확인을 건너뛴다

  **옵션으로 준 값은 안 묻는다.** 대화는 다른 모드가 아니라 빈 칸을 채우는 절차다 —
  그래서 같은 스크립트가 사람 앞에서도 CI 에서도 같은 뜻이다.

지원 배포판: Debian 11+ · Ubuntu 20.04+ · RHEL 계열 9 (Rocky·Alma·CentOS Stream)
             · Amazon Linux 2023 · Alpine 3.19+
EOF
}

say()  { printf '%s\n' "$*"; }
step() { printf '\n== %s\n' "$*"; }
ok()   { printf '  OK    %s\n' "$*"; }
warn() { printf '  WARN  %s\n' "$*" >&2; }
die()  { printf '  FAIL  %s\n' "$*" >&2; exit 1; }

# 값에 작은따옴표를 두르는 것은 취향이 아니라 **양쪽을 만족시키기 위해서다** —
# systemd 의 `EnvironmentFile` 도 sh 의 `.` 도 이 형식을 읽는다(OpenRC 쪽 init
# 스크립트가 이 파일을 그대로 source 한다).
#
# **값 안의 작은따옴표는 못 담는다.** `'\''` 로 이어 붙이는 셸의 관용구를 systemd 의
# 파서가 같은 뜻으로 읽는다는 보장이 없고, 두 파서가 다르게 읽는 설정 파일은 조용히
# 갈린다. 그래서 담을 수 없다고 **말하고** 죽는다 — 몰래 망가뜨리지 않는다.
env_line() {                    # env_line <KEY> <VALUE>
  case "$2" in
    *\'*) die "$1 의 값에 작은따옴표가 있다 — 이 env 파일 형식이 못 담는다 (값을 바꾸거나 설치 뒤 $ENV_FILE 을 직접 고친다)" ;;
  esac
  printf "%s='%s'\n" "$1" "$2"
}

extra_env_add() {               # extra_env_add <KEY=VALUE>
  case "$1" in
    BARY_*=*) : ;;
    *) die "--env 는 BARY_ 로 시작하는 KEY=VALUE 여야 한다 (받은 것: $1)" ;;
  esac
  _k=${1%%=*}
  _v=${1#*=}
  case " $MANAGED_ENV_KEYS " in
    *" $_k "*) die "$_k — 이 스크립트가 정하는 값이다. 해당 옵션을 쓴다 (--help)" ;;
  esac
  EXTRA_ENV="$EXTRA_ENV$(env_line "$_k" "$_v")
"
}

# 한 줄 물어본다. **프롬프트는 stderr 로 낸다** — 답을 `$(...)` 로 받기 때문이다.
ask() {                         # ask <질문> <기본값>
  if [ -n "$2" ]; then printf '  %s [%s]: ' "$1" "$2" >&2
  else                 printf '  %s: ' "$1" >&2
  fi
  if ! IFS= read -r _ans; then
    printf '\n' >&2
    die "입력이 끝났다 — 비대화형으로 돌리려면 옵션으로 준다 (--help)"
  fi
  # 답이 파이프로 오면 개행이 안 따라온다 — 그러면 프롬프트들이 한 줄에 붙어
  # 로그가 읽히지 않는다. TTY 면 사람이 친 Enter 가 이미 그 개행이다.
  [ -t 0 ] || printf '%s\n' "$_ans" >&2
  [ -z "$_ans" ] && _ans=$2
  printf '%s' "$_ans"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dsn)            DSN=${2:?--dsn 에 값이 필요하다}; shift 2 ;;
    --with-postgres)  WITH_PG=1; shift ;;
    --prefix)         PREFIX=${2:?--prefix 에 값이 필요하다}; PREFIX_SET=1; shift 2 ;;
    --app-dir)        APP_DIR=${2:?--app-dir 에 값이 필요하다}; APP_DIR_SET=1; shift 2 ;;
    --user)           SVC_USER=${2:?--user 에 값이 필요하다}; USER_SET=1; shift 2 ;;
    --listen)         LISTEN=${2:?--listen 에 값이 필요하다}; LISTEN_SET=1; shift 2 ;;
    --tls-cert)       TLS_CERT=${2:?--tls-cert 에 값이 필요하다}; shift 2 ;;
    --tls-key)        TLS_KEY=${2:?--tls-key 에 값이 필요하다}; shift 2 ;;
    --env)            extra_env_add "${2:?--env 에 KEY=VALUE 가 필요하다}"; shift 2 ;;
    --interactive)    INTERACTIVE=1; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
    -y|--yes)         ASSUME_YES=1; shift ;;
    --no-service)     NO_SERVICE=1; shift ;;
    --skip-packages)  SKIP_PACKAGES=1; shift ;;
    -h|--help)        usage; exit 0 ;;
    *)                usage >&2; die "모르는 인자: $1" ;;
  esac
done

[ "$(id -u)" = 0 ] || die "root 로 돌려야 한다 (sudo deploy/install.sh ...)"

if [ -n "$DSN" ] && [ "$WITH_PG" = 1 ]; then
  die "--dsn 과 --with-postgres 는 같이 못 쓴다 — 어느 PG 를 쓸지 하나만 정한다"
fi

# ── ⓪ 대화형 설정 ───────────────────────────────────────────────────────
#
# **자동으로 물어보는 것은 두 조건이 같이 참일 때뿐이다**: PostgreSQL 을 안 골랐고,
# stdin 이 TTY 다.
#
#   PG 를 골랐으면  이미 뜻을 밝힌 것이다. 나머지는 기본값으로 간다 — 여기서 더
#                   물으면 `--with-postgres` 한 줄로 끝나던 설치가 갑자기 대화가 된다
#   TTY 가 아니면   프롬프트는 대화가 아니라 **멎은 것**이다. CI 가 정확히 그렇게
#                   걸리므로, 빈 칸이 있으면 지금처럼 사용법을 내고 죽는다
#
# `--interactive` 는 그 판단을 덮어 강제로 묻고, `--non-interactive` 는 절대 안 묻는다.
if [ "$INTERACTIVE" = auto ]; then
  if [ -z "$DSN" ] && [ "$WITH_PG" = 0 ] && [ -t 0 ]; then INTERACTIVE=1; else INTERACTIVE=0; fi
fi

if [ "$INTERACTIVE" = 1 ]; then
  step "⓪ 설정"
  say "  빈 칸으로 두면 대괄호 안의 기본값을 쓴다. 옵션으로 준 값은 안 묻는다."
  say ""

  if [ -z "$DSN" ] && [ "$WITH_PG" = 0 ]; then
    say "  PostgreSQL — 정본이 사는 곳이다 (§11.2)."
    say "    1) 이 호스트에 설치한다 (유닉스 소켓 + peer 인증 — 비밀번호를 안 만든다)"
    say "    2) 이미 있는 것을 쓴다 (DSN 을 입력한다)"
    while [ -z "$DSN" ] && [ "$WITH_PG" = 0 ]; do
      choice=$(ask "고른다" "1")
      case "$choice" in
        1) WITH_PG=1 ;;
        2) DSN=$(ask "DSN" "") ;;
        *) warn "1 이나 2 를 고른다" ;;
      esac
    done
    say ""
  fi

  [ "$LISTEN_SET"  = 0 ] && LISTEN=$(ask "컨트롤 플레인 API 주소 (GUI 도 같은 자리)" "$LISTEN")
  [ "$PREFIX_SET"  = 0 ] && PREFIX=$(ask "세대·상태·소켓이 살 곳" "$PREFIX")
  [ "$APP_DIR_SET" = 0 ] && APP_DIR=$(ask "산출물이 살 곳" "$APP_DIR")
  [ "$USER_SET"    = 0 ] && SVC_USER=$(ask "서비스 유저" "$SVC_USER")

  case "$LISTEN" in
    127.*|localhost:*|\[::1\]:*) : ;;
    *)
      if [ -z "$TLS_CERT" ] || [ -z "$TLS_KEY" ]; then
        say ""
        warn "$LISTEN 은 루프백이 아니다 — 이 API 로 개인키와 Bearer 토큰이 지나간다."
        TLS_CERT=$(ask "TLS 인증서 경로" "$TLS_CERT")
        TLS_KEY=$(ask "TLS 개인키 경로" "$TLS_KEY")
      fi ;;
  esac

  say ""
  say "  env 에 더 넣을 설정이 있으면 KEY=VALUE 로 한 줄씩 준다. 빈 줄이면 끝."
  say "  예: BARY_ACME=1 · BARY_PROBE_INTERVAL_MS=3000 · BARY_OIDC_ISSUER=https://..."
  while : ; do
    kv=$(ask "추가 설정" "")
    if [ -z "$kv" ]; then break; fi
    extra_env_add "$kv"
  done

  # **바꾸기 전에 무엇을 바꿀지 보여 준다.** 이 스크립트는 패키지를 깔고 유저를 만들고
  # 서비스를 띄운다 — 되돌리는 값이 싸지 않다.
  say ""
  say "  ── 이대로 세운다 ─────────────────────────────"
  if [ "$WITH_PG" = 1 ]; then
    say "    PostgreSQL   이 호스트에 설치한다"
  else
    say "    PostgreSQL   $DSN"
  fi
  say "    API          $LISTEN$([ -n "$TLS_CERT" ] && printf ' (TLS)')"
  say "    prefix       $PREFIX"
  say "    산출물       $APP_DIR"
  say "    유저         $SVC_USER"
  if [ -n "$EXTRA_ENV" ]; then
    say "    추가 설정    $(printf '%s' "$EXTRA_ENV" | sed 's/=.*//' | tr '\n' ' ')"
  fi
  say "  ──────────────────────────────────────────────"

  if [ "$ASSUME_YES" = 0 ]; then
    yn=$(ask "진행할까? (y/n)" "y")
    case "$yn" in
      y|Y|yes|YES|ye) : ;;
      *) die "중단했다 — 아무것도 안 바꿨다" ;;
    esac
  fi
fi

# **둘 다 안 주면 세운다.** 기본값으로 로컬 PG 를 깔아 주면 "관리형 PG 를 쓰려던
# 호스트에 쓰지 않을 PG 가 깔린다" 가 되고, 기본값으로 DSN 을 요구하면서 조용히
# 넘어가면 데몬이 기동 시점에 `환경변수 BARY_DSN 이 필요하다` 로 죽는다 —
# 그 메세지는 설치가 어디서 갈렸는지 말하지 않는다.
if [ -z "$DSN" ] && [ "$WITH_PG" = 0 ]; then
  usage >&2
  die "--dsn 이나 --with-postgres 중 하나가 필요하다 (터미널이면 물어봤을 것이다)"
fi

# DSN 은 **여기서** 본다. 대화로 받았든 옵션으로 받았든 같은 검사를 지난다.
if [ -n "$DSN" ]; then
  case "$DSN" in
    postgres://*|postgresql://*) : ;;
    *) die "DSN 이 postgres:// 로 시작하지 않는다: $DSN" ;;
  esac
fi

# **루프백 밖이면 TLS 를 먼저 요구한다.**
#
# 이 API 로 개인키와 Bearer 토큰이 지나간다. 데몬은 평문 + 외부 주소 조합을 거부하는데
# (`plaintextExposureError`), 그 거부는 ⑫ 에서야 나온다 — 패키지를 다 깔고 PG 까지
# 세운 뒤에 "안 뜬다" 를 보는 것은 진단이 아니다. 지금 갈라 둔다.
case "$LISTEN" in
  127.*|localhost:*|\[::1\]:*) LISTEN_LOOPBACK=1 ;;
  *)                            LISTEN_LOOPBACK=0 ;;
esac
if [ "$LISTEN_LOOPBACK" = 0 ] && { [ -z "$TLS_CERT" ] || [ -z "$TLS_KEY" ]; }; then
  die "$LISTEN 은 루프백이 아니다 — --tls-cert 와 --tls-key 를 같이 준다 (평문으로 열지 않는다)"
fi
if [ -n "$TLS_CERT" ] && [ ! -r "$TLS_CERT" ]; then die "--tls-cert $TLS_CERT 를 못 읽는다"; fi
if [ -n "$TLS_KEY" ]  && [ ! -r "$TLS_KEY" ];  then die "--tls-key $TLS_KEY 를 못 읽는다"; fi

# ── ① 배포판 판별 ────────────────────────────────────────────────────────
#
# `uname` 으로는 못 가른다. `/etc/os-release` 가 정본이고(systemd 이전부터 사실상
# 표준이다), `ID_LIKE` 는 파생 배포판(Alma·Rocky·CentOS Stream)을 한 갈래로 모은다.

step "① 배포판 판별"
[ -r /etc/os-release ] || die "/etc/os-release 가 없다 — 배포판을 판별할 수 없다"
# shellcheck source=/dev/null
. /etc/os-release
OS_ID=${ID:-unknown}
OS_VER=${VERSION_ID:-}
OS_CODENAME=${VERSION_CODENAME:-}
OS_LIKE=${ID_LIKE:-}

case "$OS_ID" in
  debian|ubuntu)                     FAMILY=deb ;;
  rocky|almalinux|rhel|centos)       FAMILY=el ;;
  amzn)                              FAMILY=amzn ;;
  alpine)                            FAMILY=apk ;;
  *)
    case " $OS_LIKE " in
      *" rhel "*|*" fedora "*)       FAMILY=el ;;
      *" debian "*)                  FAMILY=deb ;;
      *) die "지원하지 않는 배포판: $OS_ID $OS_VER (ID_LIKE=$OS_LIKE)" ;;
    esac ;;
esac
ok "$OS_ID $OS_VER ($FAMILY) · $(uname -m)"

# EL 계열은 9 만 본다. 8 은 OpenResty 저장소는 있지만 AppStream 의 nodejs 모듈이
# 22 를 안 내므로 여기서 갈린다 — 조용히 진행해서 나중에 버전 검사로 죽는 것보다
# 지금 이름 지어 세우는 편이 낫다.
if [ "$FAMILY" = el ]; then
  case "$OS_VER" in
    9|9.*) : ;;
    *) die "EL 계열은 9 만 지원한다 (지금 $OS_VER) — nodejs 22 모듈이 9 부터다" ;;
  esac
fi

# ── ② 패키지 ─────────────────────────────────────────────────────────────

ENGINE_BIN=

install_packages_deb() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg libcap2-bin >/dev/null

  # **arm64 는 저장소 트리가 다르다.** openresty.org 의 `ubuntu/`·`debian/` 은
  # `Architectures: i386 amd64 source` 다 — arm64 패키지는 `package/arm64/` 밑에
  # 따로 산다. 이 한 줄을 모르면 `apt-get install openresty` 가
  # "E: Unable to locate package" 로 죽고, 그 메세지는 이유를 말하지 않는다.
  deb_arch=$(dpkg --print-architecture)
  case "$deb_arch" in
    amd64|i386) or_base="https://openresty.org/package/$OS_ID" ;;
    arm64)      or_base="https://openresty.org/package/arm64/$OS_ID" ;;
    *) die "OpenResty 가 이 아키텍처의 deb 를 안 낸다: $deb_arch" ;;
  esac
  [ -n "$OS_CODENAME" ] || die "VERSION_CODENAME 이 없다 — apt 저장소 suite 를 못 정한다"

  # **컴포넌트 이름이 배포판마다 다르다.** debian 트리는 `openresty`, ubuntu 트리는
  # `main` 이다 (`dists/<codename>/Release` 의 `Components:`). 틀리면 apt 는 저장소를
  # 조용히 건너뛰고 — `W: Skipping acquire of configured file 'main/binary-arm64/Packages'` —
  # 그 다음 줄에서 `E: Unable to locate package openresty` 로 죽는다. 실측했다.
  case "$OS_ID" in
    debian) or_component=openresty ;;
    *)      or_component=main ;;
  esac

  # **키를 둘 다 넣는다.** openresty 는 서명 키를 갈고 있고(`pubkey2.gpg`), 어느
  # 저장소가 언제 넘어가는지는 우리가 정하지 않는다. 키링 하나에 둘을 담으면
  # 그 전환이 이 스크립트를 안 깨뜨린다.
  install -d -m 0755 /usr/share/keyrings
  curl -fsSL https://openresty.org/package/pubkey.gpg -o /tmp/or1.asc
  curl -fsSL https://openresty.org/package/pubkey2.gpg -o /tmp/or2.asc
  cat /tmp/or1.asc /tmp/or2.asc | gpg --dearmor --yes -o /usr/share/keyrings/openresty.gpg
  rm -f /tmp/or1.asc /tmp/or2.asc
  printf 'deb [arch=%s signed-by=/usr/share/keyrings/openresty.gpg] %s %s %s\n' \
    "$deb_arch" "$or_base" "$OS_CODENAME" "$or_component" > /etc/apt/sources.list.d/openresty.list

  # **NodeSource 저장소를 손으로 건다.** 공식 안내는 `curl ... | bash` 인데, 그
  # 한 줄은 설치 스크립트가 하는 일을 검토 불가능하게 만든다. 저장소 등록은
  # 키 + suite 한 줄이 전부다 — 그 두 줄이면 파이프가 필요 없다.
  #
  # suite 가 `nodistro` 인 것은 오타가 아니다: NodeSource 는 배포판별 트리를 접고
  # 하나로 합쳤다 (`Architectures: amd64 arm64 armhf`).
  if ! node_version_ok; then
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor --yes -o /usr/share/keyrings/nodesource.gpg
    printf 'deb [signed-by=/usr/share/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main\n' \
      > /etc/apt/sources.list.d/nodesource.list
  fi

  apt-get update -qq
  apt-get install -y -qq openresty >/dev/null
  node_version_ok || apt-get install -y -qq nodejs >/dev/null
}

install_packages_el() {
  # **`curl` 을 조건 없이 깔지 않는다.** RHEL9·AL2023 의 기본 이미지에는
  # `curl-minimal` 이 이미 있고, 그 위에 `curl` 을 깔면 파일 충돌로 트랜잭션이
  # 통째로 죽는다. 있으면 그냥 쓴다.
  dnf install -y -q libcap >/dev/null
  command -v curl >/dev/null 2>&1 || dnf install -y -q curl >/dev/null

  # `$releasever` 를 그대로 쓰지 않는다 — Alma·Rocky·CentOS Stream 에서 값이
  # `9`·`9.5`·`9-stream` 으로 갈리는데 openresty 저장소에는 `9/` 만 있다.
  #
  # **키는 `pubkey2.gpg` 다.** 옛 `pubkey.gpg` 는 자체서명이 SHA1(digest algo 2)이고,
  # RHEL9 의 기본 암호 정책은 그걸 거부한다:
  #   `warning: Signature not supported. Hash algorithm SHA1 not available.`
  #   `error: .../pubkey.gpg: key 1 import failed.`
  # 실측했다. 새 키는 SHA256(algo 8)이라 정책을 손대지 않고 지나간다 —
  # `update-crypto-policies --set DEFAULT:SHA1` 로 호스트 전체를 낮추는 것보다 낫다.
  cat > /etc/yum.repos.d/openresty.repo <<EOF
[openresty]
name=Official OpenResty Open Source Repository
baseurl=https://openresty.org/package/rocky/9/\$basearch
skip_if_unavailable=False
gpgcheck=1
repo_gpgcheck=0
gpgkey=https://openresty.org/package/pubkey2.gpg
enabled=1
EOF
  rpm --import https://openresty.org/package/pubkey2.gpg
  dnf install -y -q openresty >/dev/null

  if ! node_version_ok; then
    dnf module reset -y -q nodejs >/dev/null 2>&1 || true
    dnf module enable -y -q nodejs:22 >/dev/null
    dnf install -y -q nodejs npm >/dev/null
  fi
}

# openresty 의 amazon 트리는 **AL 릴리스 날짜로 갈린다** (`2023.7.20250331/`).
# 두 가지가 함정이다:
#
#   `$releasever`  AL2023 에서 이 값은 날짜까지 붙은 문자열이고, openresty 가 그 릴리스의
#                  스냅샷을 안 냈으면 그 디렉터리가 없다 → `Cannot download repomd.xml`
#   `latest/`      이름과 달리 **amzn1** 이다. x86_64 밑에 있는 것은 2020년의
#                  openresty-1.19.3.1-1.amzn1 이고 **aarch64 는 비어 있다**. 실측했다 —
#                  처음에 여기를 가리켰고 amazon 판이 그 오류로 죽었다
#
# 그래서 목록에서 **실제로 있는 최신 2023.\* 을 고른다.** 인덱스를 긁는 것이 곱지는
# 않지만, 고정해 두면 openresty 가 새 스냅샷을 낸 날 조용히 옛것에 묶인다.
amzn_pick_repo() {              # amzn_pick_repo <basearch>
  for d in $(curl -fsSL https://openresty.org/package/amazon/ \
      | sed -n 's/.*href="\(2023\.[^"]*\)\/".*/\1/p' | sort -Vr); do
    if curl -fsI "https://openresty.org/package/amazon/$d/$1/repodata/repomd.xml" \
         >/dev/null 2>&1; then
      printf '%s' "$d"
      return 0
    fi
  done
  return 1
}

install_packages_amzn() {
  dnf install -y -q libcap >/dev/null
  command -v curl >/dev/null 2>&1 || dnf install -y -q curl >/dev/null

  amzn_arch=$(uname -m)
  amzn_dir=$(amzn_pick_repo "$amzn_arch") \
    || die "openresty 의 amazon 저장소에 $amzn_arch 스냅샷이 없다"
  # **키가 트리마다 다르다** (실측). amazon 트리의 rpm 은 아직 **옛 키**(`pubkey.gpg`)
  # 로 서명돼 있어서 새 키만 넣으면 `GPG check FAILED` 로 죽는다. 반대로 RHEL9 은 그
  # 옛 키를 **들이지도 못한다**(자체서명이 SHA1). 즉 어느 한쪽으로 통일할 수가 없다.
  # AL2023 의 암호 정책은 옛 키를 받으므로 여기서는 **둘 다** 넣는다 — 지금 도는 것과
  # 회전한 뒤가 모두 지나간다.
  cat > /etc/yum.repos.d/openresty.repo <<EOF
[openresty]
name=Official OpenResty Open Source Repository for Amazon Linux
baseurl=https://openresty.org/package/amazon/$amzn_dir/$amzn_arch
skip_if_unavailable=False
gpgcheck=1
repo_gpgcheck=0
gpgkey=https://openresty.org/package/pubkey.gpg https://openresty.org/package/pubkey2.gpg
enabled=1
EOF
  rpm --import https://openresty.org/package/pubkey.gpg
  rpm --import https://openresty.org/package/pubkey2.gpg || true
  dnf install -y -q openresty >/dev/null
  # AL2023 은 모듈이 아니라 **버전이 이름에 붙은 패키지**다 (`nodejs22`).
  # 맨 `nodejs` 는 18 이라 여기서 쓰면 버전 검사에서 죽는다.
  #
  # **`npm` 도 이름을 맞춰야 한다** (실측). 맨 `npm` 을 같이 부르면 그것이 의존성으로
  # **nodejs 18 을 끌고 들어오고**, alternatives 의 `node` 가 그쪽을 가리켜 버린다 —
  # `nodejs22` 를 깔았는데 `node -v` 가 `v18.20.8` 인 상태가 된다.
  if ! node_version_ok; then
    dnf install -y -q nodejs22 nodejs22-npm >/dev/null
    # 이미 옛 nodejs 가 있던 호스트라면 그래도 18 을 가리킨다. 그때는 링크를 옮긴다.
    if ! node_version_ok && [ -x /usr/bin/node-22 ]; then
      alternatives --set node /usr/bin/node-22 >/dev/null 2>&1 || true
    fi
  fi
}

install_packages_apk() {
  # alpine 은 openresty.org 저장소를 안 쓴다 — 거기 트리는 v3.18 에서 멈췄고,
  # 그 뒤로는 community 에 openresty 가 들어왔다. 남의 저장소를 붙이는 것보다
  # 배포판이 관리하는 쪽이 낫다.
  apk add --no-cache openresty nodejs npm libcap curl >/dev/null
}

# **엔진은 찾는다, 정하지 않는다.** 경로가 배포판마다 다르다 — openresty.org 의
# rpm/deb 는 `/usr/local/openresty/bin/openresty`, alpine 의 community 패키지는
# `/usr/sbin/nginx`(실체는 `/usr/lib/nginx/bin/openresty`) 다. 목록을 손으로 들고 있으면
# 다음 배포판에서 또 틀리고, 그 증상은 "설치는 됐는데 엔진이 없다" 로 나온다.
# **판정은 `-V` 가 한다** — 이름이 nginx 여도 OpenResty 면 된다.
detect_engine() {
  for c in /usr/local/openresty/bin/openresty /usr/bin/openresty \
           /usr/sbin/openresty /usr/local/bin/openresty /usr/sbin/nginx; do
    if [ -x "$c" ] && "$c" -V 2>&1 | grep -q openresty; then
      ENGINE_BIN=$c
      return 0
    fi
  done
  return 1
}

# node 22 이상인지 본다. **`command -v node` 만으로는 부족하다** — 배포판 기본
# node 는 18 이 흔하고, 그걸로 뜨면 데몬은 기동은 하되 나중에 문법으로 죽는다.
node_version_ok() {
  command -v node >/dev/null 2>&1 || return 1
  v=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "${v:-0}" -ge 22 ]
}

step "② 패키지"
if [ "$SKIP_PACKAGES" = 1 ]; then
  ok "건너뛴다 (--skip-packages)"
else
  case "$FAMILY" in
    deb)  install_packages_deb ;;
    el)   install_packages_el ;;
    amzn) install_packages_amzn ;;
    apk)  install_packages_apk ;;
  esac
  ok "openresty · nodejs 설치됨"
fi

# ── ③ 설치된 것을 확인한다 ───────────────────────────────────────────────
#
# 패키지 매니저가 0 을 냈다는 것은 "받았다" 이지 "쓸 수 있다" 가 아니다.
# 여기서 갈라 두지 않으면 첫 apply 에서 갈리고, 그때는 원인이 훨씬 멀다.

step "③ 확인"
command -v node >/dev/null 2>&1 || die "node 가 없다"
node_version_ok || die "node 22 이상이 필요하다 (지금 $(node -v))"
NODE_BIN=$(command -v node)
ok "node $(node -v) — $NODE_BIN"

# **OpenResty 여야 한다.** 맨 nginx 로도 렌더는 되지만 멤버십 평면(Lua)이 없다 —
# 그러면 백엔드 하나 바꿀 때마다 reload 가 돌고, 그건 이 설계의 전제가 아니다.
detect_engine || die "OpenResty 를 못 찾았다 — 설치가 안 됐거나 맨 nginx 만 있다"
ENGINE_V=$("$ENGINE_BIN" -V 2>&1 || true)
ok "$(printf '%s' "$ENGINE_V" | head -1) — $ENGINE_BIN"

# ── ④ 서비스 유저와 디렉터리 ────────────────────────────────────────────

step "④ 유저 · 디렉터리"
if id "$SVC_USER" >/dev/null 2>&1; then
  ok "유저 $SVC_USER 가 이미 있다"
else
  case "$FAMILY" in
    apk) addgroup -S "$SVC_USER" && adduser -S -D -H -G "$SVC_USER" -s /sbin/nologin "$SVC_USER" ;;
    *)   groupadd -r "$SVC_USER" 2>/dev/null || true
         useradd -r -g "$SVC_USER" -M -d "$PREFIX" -s /sbin/nologin "$SVC_USER" ;;
  esac
  ok "유저 $SVC_USER 생성"
fi

# `entrypoint.sh` 와 같은 목록이다. `run` 이 0700 인 것은 **접근 통제를 지는 것이
# 이 디렉터리**라서다 — nginx 의 `listen unix:` 에는 mode 옵션이 없어 소켓 자체의
# 모드를 정할 수 없다 (검수 S-08b).
install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$PREFIX"
for d in logs state generations run secrets; do
  install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$PREFIX/$d"
done
chmod 700 "$PREFIX/run" "$PREFIX/secrets"
ok "$PREFIX (logs · state · generations · run · secrets)"

# ── ⑤ 특권 포트 ─────────────────────────────────────────────────────────
#
# 비-root 로 도는데 80·443 을 bind 해야 한다. `setcap` 으로 **포트 권한 하나만** 준다
# (Dockerfile 이 같은 이유로 같은 일을 한다). systemd 의 `AmbientCapabilities` 로도
# 되지만 alpine(OpenRC)에는 그 자리가 없다 — 초기화 시스템에 안 기대는 쪽을 쓴다.
#
# 그리고 유닛에 `NoNewPrivileges=yes` 를 **넣지 않는다.** 넣으면 파일 capability 로
# 권한을 얻는 경로가 통째로 막혀서, 이 setcap 이 무효가 된다.

step "⑤ 특권 포트 (setcap)"
# 심볼릭 링크에 걸면 조용히 아무 일도 안 난다. 실제 ELF 를 찾아 건다.
ENGINE_REAL=$(readlink -f "$ENGINE_BIN")
if setcap cap_net_bind_service=+ep "$ENGINE_REAL" 2>/dev/null; then
  ok "cap_net_bind_service → $ENGINE_REAL"
else
  # 컨테이너·특수 파일시스템에서는 xattr 을 못 쓸 수 있다. 여기서 세우지 않는다 —
  # 1024 이상 포트만 쓰는 배포는 이것 없이도 정상이다. 대신 침묵하지 않는다.
  warn "setcap 실패 — 1024 미만 포트 리스너는 bind 에서 죽는다 (파일시스템이 xattr 을 지원하는지 본다)"
fi

# ── ⑥ nginx 의 절대 경로들 ──────────────────────────────────────────────
#
# nginx 의 임시 파일·로그·pid 경로는 **컴파일 기본값**이고, 그 값이 상대 경로인 빌드와
# 절대 경로인 빌드가 있다. 상대면 `-p $PREFIX` 로 풀려서 손댈 것이 없지만(openresty.org
# 의 rpm/deb 가 그렇다), 절대면 그 경로는 root 소유이고 우리는 비-root 로 돈다.
#
# alpine 의 community 패키지가 그 경우다 — 실측하면 이렇다:
#
#   --pid-path=/var/run/nginx/nginx.pid   --error-log-path=/var/log/nginx/error.log
#   --http-client-body-temp-path=/var/tmp/nginx/client_body   (외 넷)
#
# 그리고 이 셋은 **각각 다른 것을 깨뜨린다**:
#
#   임시 경로  큰 요청 본문을 디스크로 흘릴 때만 실패한다 — `nginx -t` 는 통과하고
#              트래픽에서만 드러난다
#   로그       기동 자체가 `[alert] could not open error log file` 로 죽는다.
#              그리고 데몬은 활성화의 **음성 신호**로 `$PREFIX/logs/error.log` 의 치명
#              줄을 센다(§6.3) — 엔진이 다른 파일에 쓰면 그 신호가 조용히 사라진다
#   pid        데몬의 기본 reload 는 `$PREFIX/logs/nginx.pid` 를 읽어 HUP 을 보낸다.
#              엔진이 다른 곳에 쓰면 **reload 가 안 걸린다**
#
# 그래서 셋을 각각 다르게 다룬다: 임시 경로는 소유권만, 로그는 소유권 + 심볼릭 링크로
# 데몬이 보는 자리와 잇고, pid 는 `BARY_RELOAD_CMD` 로 데몬에게 알려 준다.

step "⑥ nginx 의 절대 경로들"

# `-V` 에서 `--<이름>=/절대경로` 를 뽑는다. 상대 경로면 아무것도 안 나온다 — 그게 정상이다.
engine_path_of() {              # engine_path_of <설정옵션이름>
  printf '%s' "$ENGINE_V" | tr ' ' '\n' | sed -n "s|^--$1=\(/.*\)\$|\1|p" | head -1
}

ENGINE_PID_FILE="$PREFIX/logs/nginx.pid"
ENGINE_ERROR_LOG="$PREFIX/logs/error.log"
ENGINE_RUN_DIR=

for opt in http-client-body-temp-path http-proxy-temp-path http-fastcgi-temp-path \
           http-uwsgi-temp-path http-scgi-temp-path; do
  p=$(engine_path_of "$opt")
  if [ -n "$p" ]; then
    install -d -m 0700 -o "$SVC_USER" -g "$SVC_USER" "$p"
    ok "임시 $p → $SVC_USER"
  fi
done

for opt in error-log-path http-log-path; do
  p=$(engine_path_of "$opt")
  if [ -n "$p" ]; then
    install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$(dirname "$p")"
    : > "$p" 2>/dev/null || true
    chown "$SVC_USER":"$SVC_USER" "$p" 2>/dev/null || true
    ok "로그 $p → $SVC_USER"
    if [ "$opt" = error-log-path ]; then ENGINE_ERROR_LOG=$p; fi
  fi
done

# **데몬이 보는 자리와 잇는다.** 링크를 걸면 워터마크가 같은 파일을 센다 —
# 엔진의 경로를 바꾸는 것보다 낫다(그건 렌더러의 몫이고 여기서 정할 것이 아니다).
if [ "$ENGINE_ERROR_LOG" != "$PREFIX/logs/error.log" ]; then
  ln -sfn "$ENGINE_ERROR_LOG" "$PREFIX/logs/error.log"
  ok "$PREFIX/logs/error.log → $ENGINE_ERROR_LOG (활성화 음성 신호)"
fi

p=$(engine_path_of pid-path)
if [ -n "$p" ]; then
  ENGINE_PID_FILE=$p
  ENGINE_RUN_DIR=$(dirname "$p")
  install -d -m 0755 -o "$SVC_USER" -g "$SVC_USER" "$ENGINE_RUN_DIR"
  ok "pid $ENGINE_PID_FILE"
fi

if [ -z "$ENGINE_RUN_DIR" ] && [ "$ENGINE_PID_FILE" = "$PREFIX/logs/nginx.pid" ]; then
  ok "나머지는 상대 경로다 — $PREFIX 밑에 생긴다"
fi

# ── ⑦ 빌드 ──────────────────────────────────────────────────────────────
#
# **체크아웃 안에서 빌드하지 않는다.** root 로 `npm ci` 를 돌리면 운영자의 저장소에
# root 소유 `node_modules` 가 남고, 그 다음부터 사람이 그 저장소에서 뭘 할 때마다
# 권한으로 걸린다. 스테이징 디렉터리에 필요한 것만 복사해서 거기서 짓는다.

step "⑦ 빌드"
BUILD_DIR=$(mktemp -d)
# shellcheck disable=SC2064
trap "rm -rf '$BUILD_DIR'" EXIT INT TERM

for f in package.json package-lock.json tsconfig.json tsconfig.build.json tsconfig.testing.json; do
  [ -f "$REPO/$f" ] || die "$REPO/$f 가 없다 — 저장소 체크아웃 안에서 돌려야 한다"
  cp "$REPO/$f" "$BUILD_DIR/"
done
for d in scripts src gui drivers; do
  [ -d "$REPO/$d" ] || die "$REPO/$d 가 없다"
  cp -R "$REPO/$d" "$BUILD_DIR/"
done
# 심링크된 `node_modules` 나 앞선 빌드 산출물을 끌고 오지 않는다 (워크트리에서는
# `node_modules` 가 메인 트리를 가리키는 심링크다 — 그대로 복사하면 깨진 링크가 된다).
rm -rf "$BUILD_DIR/gui/node_modules" "$BUILD_DIR/gui/build"

say "  ..    npm ci (조용히 도는 동안 네트워크를 쓴다)"
( cd "$BUILD_DIR" && npm ci --no-audit --no-fund >/dev/null )
( cd "$BUILD_DIR" && ./scripts/build.sh >/dev/null )
[ -f "$BUILD_DIR/dist/bin/barycenterd.js" ] || die "빌드가 dist/bin/barycenterd.js 를 안 냈다"
[ -d "$BUILD_DIR/gui/build" ] || die "빌드가 gui/build 를 안 냈다 — GUI 없이 뜨는 배포가 된다"
ok "dist · gui/build"

# 런타임 의존성만 따로 짓는다 (`pg` 하나다). Dockerfile 의 `deps` 스테이지와 같은
# 이유다 — 프로덕션에 빌드 도구를 끌어들이지 않는다.
DEPS_DIR="$BUILD_DIR/.prod"
mkdir -p "$DEPS_DIR"
cp "$REPO/package.json" "$REPO/package-lock.json" "$DEPS_DIR/"
( cd "$DEPS_DIR" && npm ci --omit=dev --no-audit --no-fund >/dev/null )
ok "런타임 의존성 (--omit=dev)"

# ── ⑧ 설치 ──────────────────────────────────────────────────────────────

step "⑧ 설치 → $APP_DIR"
install -d -m 0755 "$APP_DIR"
rm -rf "$APP_DIR/dist" "$APP_DIR/node_modules" "$APP_DIR/gui" "$APP_DIR/drivers"
cp -R "$BUILD_DIR/dist" "$APP_DIR/dist"
cp -R "$DEPS_DIR/node_modules" "$APP_DIR/node_modules"
install -d -m 0755 "$APP_DIR/gui"
cp -R "$BUILD_DIR/gui/build" "$APP_DIR/gui/build"
cp -R "$BUILD_DIR/drivers" "$APP_DIR/drivers"
cp "$REPO/package.json" "$APP_DIR/package.json"
chown -R root:root "$APP_DIR"
ok "$APP_DIR (dist · node_modules · gui/build · drivers)"

# ── ⑨ PostgreSQL ────────────────────────────────────────────────────────
#
# `--with-postgres` 는 **비밀번호를 만들지 않는다.** 유닉스 소켓 + peer 인증이면
# OS 유저가 곧 DB 롤이고, 그러면 어딘가에 적어 둘 비밀이 하나도 없다. 비밀번호는
# env 파일·프로세스 목록·백업으로 새는 경로가 있고, 한 대짜리 배포에서 그 위험을
# 질 이유가 없다.

pg_socket_dir() {
  for d in /run/postgresql /var/run/postgresql /tmp; do
    if [ -S "$d/.s.PGSQL.5432" ]; then printf '%s' "$d"; return 0; fi
  done
  return 1
}

install_postgres() {
  case "$FAMILY" in
    deb)
      export DEBIAN_FRONTEND=noninteractive
      apt-get install -y -qq postgresql >/dev/null
      PG_UNIT=postgresql ;;
    el|amzn)
      # **패키지 이름이 갈린다.** RHEL 계열은 `postgresql-server` 로 기본 메이저를
      # 가리키지만, AL2023 에는 그 이름이 아예 없고 메이저가 이름에 붙는다
      # (`postgresql16-server`). 없는 이름을 부르면 `No match for argument` 로 죽는다.
      if [ "$FAMILY" = amzn ]; then
        dnf install -y -q postgresql16-server postgresql16 >/dev/null
      else
        dnf install -y -q postgresql-server postgresql >/dev/null
      fi
      # RHEL 계열은 데이터 디렉터리를 **패키지가 안 만든다.** 이 한 줄이 빠지면
      # `systemctl start postgresql` 이 "Data directory is not initialized" 로 죽는다.
      if [ ! -f /var/lib/pgsql/data/PG_VERSION ]; then
        postgresql-setup --initdb >/dev/null
      fi
      PG_UNIT=postgresql ;;
    apk)
      apk add --no-cache postgresql postgresql-contrib >/dev/null
      # alpine 은 데이터 디렉터리 경로가 **패키지 버전에 매여 있고**
      # (`/var/lib/postgresql/<major>/data`), 그 값을 아는 것은 `/etc/conf.d/postgresql` 다.
      # 여기서 손으로 정하면 initdb 는 되는데 서비스는 다른 곳을 보게 되고, 그 어긋남은
      # "초기화는 됐다는데 start 가 안 된다" 로 나온다 — 원인을 안 가리키는 부류다.
      # shellcheck source=/dev/null
      pg_data=$( { . /etc/conf.d/postgresql; printf '%s' "${data_dir:-}"; } 2>/dev/null || true )
      [ -n "$pg_data" ] || pg_data=/var/lib/postgresql/data
      if [ ! -f "$pg_data/PG_VERSION" ]; then
        install -d -m 0700 -o postgres -g postgres "$pg_data"
        su postgres -c "initdb -D '$pg_data'" >/dev/null
      fi
      PG_UNIT=postgresql ;;
  esac
  svc_start "$PG_UNIT"

  # 소켓이 뜰 때까지 기다린다. 고정 sleep 은 느린 머신에서 거짓 실패를 만든다.
  i=0
  while ! su postgres -c 'psql -tAc "SELECT 1"' >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 60 ] && die "PostgreSQL 이 60초 안에 안 떴다"
    sleep 1
  done

  # 롤·DB 를 만든다. **다시 돌려도 되게 한다** — 설치 스크립트가 한 번만 돌 수
  # 있다는 가정은 재실행하는 날 깨진다.
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_roles WHERE rolname='$SVC_USER'\"" \
    | grep -q 1 || su postgres -c "createuser '$SVC_USER'"
  su postgres -c "psql -tAc \"SELECT 1 FROM pg_database WHERE datname='$SVC_USER'\"" \
    | grep -q 1 || su postgres -c "createdb -O '$SVC_USER' '$SVC_USER'"

  sock=$(pg_socket_dir) || die "PostgreSQL 유닉스 소켓을 못 찾았다"
  DSN="postgres:///$SVC_USER?host=$sock"
  ok "로컬 PostgreSQL — $DSN (peer 인증, 비밀번호 없음)"
}

# ── 초기화 시스템 ────────────────────────────────────────────────────────
#
# **뭐가 도는지 보고 정한다.** `command -v systemctl` 로는 못 가른다 — 패키지만
# 깔려 있고 PID 1 은 다른 것일 수 있고, 컨테이너가 정확히 그렇다.
INIT=none
if [ -d /run/systemd/system ]; then INIT=systemd
elif command -v rc-service >/dev/null 2>&1; then INIT=openrc
fi

# **`enable --now` 를 안 쓴다.** AL2023 에서 그것은 0 을 내면서 서비스를 **안 띄웠다** —
# 그리고 0 을 냈으니 폴백도 안 돌았고, 설치는 ⑫ 에서 60초를 기다린 뒤에야 죽었다.
# 부팅 등록과 지금 띄우는 것은 **다른 일**이므로 따로 시킨다.
#
# 그리고 `start` 가 아니라 `restart` 다: 재실행일 때 이미 도는 서비스를 새 유닛으로
# 바꿔 세워야 하고, 앞선 실패가 cgroup 에 남긴 nginx 도 그때 같이 걷힌다.
svc_start() {   # svc_start <이름>
  case "$INIT" in
    systemd) systemctl enable "$1" >/dev/null 2>&1 || true
             systemctl restart "$1" ;;
    openrc)  rc-update add "$1" default >/dev/null 2>&1 || true
             rc-service "$1" restart >/dev/null ;;
    none)    die "초기화 시스템을 못 찾았다 — $1 을 띄울 수 없다 (--no-service 로 유닛만 쓸 수 있다)" ;;
  esac
}

step "⑨ PostgreSQL"
if [ "$WITH_PG" = 1 ]; then
  install_postgres
else
  ok "외부 DSN 을 쓴다 — 건드리지 않는다"
fi

# ── ⑩ 설정 ──────────────────────────────────────────────────────────────
#
# 토큰은 **해시로** 저장한다. 평문을 설정에 두면 그 파일이 곧 비밀이 되고,
# 감사 로그·에러 메세지·코어 덤프로 새는 경로가 늘어난다 (`scripts/token.mjs`).
# 평문은 여기서 **한 번만** 화면에 낸다.

step "⑩ 설정"
TOKEN_PLAIN=$(node -e 'process.stdout.write(require("crypto").randomBytes(24).toString("base64url"))')
TOKEN_HASH=$(printf '%s' "$TOKEN_PLAIN" \
  | node -e 'let b="";process.stdin.on("data",d=>b+=d).on("end",()=>process.stdout.write("sha256:"+require("crypto").createHash("sha256").update(b,"utf8").digest("hex")))')

TOKENS_FILE="$PREFIX/tokens.json"
printf '[{"name":"ops","scopes":["read","write","apply"],"hash":"%s"}]\n' "$TOKEN_HASH" > "$TOKENS_FILE"
chown root:"$SVC_USER" "$TOKENS_FILE"
chmod 0640 "$TOKENS_FILE"

# 한 줄 한 줄을 `env_line` 이 만든다 — 인용 규칙이 한 자리에만 있게 하려는 것이다.
# heredoc 으로 늘어놓던 때는 값에 따옴표가 든 경우(암호를 담은 DSN)가 조용히 깨졌다.
ENV_FILE="$PREFIX/env"
{
  env_line BARY_DSN "$DSN"
  env_line BARY_PREFIX "$PREFIX"
  env_line BARY_LISTEN "$LISTEN"
  env_line BARY_TOKENS_FILE "$TOKENS_FILE"
  env_line BARY_ENGINE_BIN "$ENGINE_BIN"
  env_line BARY_GUI "$APP_DIR/gui/build"
  env_line BARY_CONFIGTEST_CMD \
    "$ENGINE_BIN -p $PREFIX -c $PREFIX/generations/{generation}/nginx.conf -t"
  # **pid 가 기본 자리에 없을 때만 적는다.** 기본이면 데몬이 `$PREFIX/logs/nginx.pid` 를
  # 읽어 직접 HUP 을 보낸다(`effects-boot.ts`) — 같은 값을 두 자리에 두지 않는다.
  if [ "$ENGINE_PID_FILE" != "$PREFIX/logs/nginx.pid" ]; then
    env_line BARY_RELOAD_CMD "kill -HUP \$(cat $ENGINE_PID_FILE)"
  fi
  if [ -n "$TLS_CERT" ]; then
    env_line BARY_TLS_CERT_FILE "$TLS_CERT"
    env_line BARY_TLS_KEY_FILE "$TLS_KEY"
  fi
  # `--env` 와 대화로 받은 것들. **끝에 둔다** — 위의 관리 키와 겹치는 것은 이미
  # `extra_env_add` 가 거절했으므로, 여기 오는 것은 데몬이 읽는 다른 설정들뿐이다.
  [ -n "$EXTRA_ENV" ] && printf '%s' "$EXTRA_ENV"
} > "$ENV_FILE"
chown root:"$SVC_USER" "$ENV_FILE"
chmod 0640 "$ENV_FILE"
if [ -n "$EXTRA_ENV" ]; then
  ok "$ENV_FILE · $TOKENS_FILE (추가 설정 $(printf '%s' "$EXTRA_ENV" | grep -c .) 줄)"
else
  ok "$ENV_FILE · $TOKENS_FILE"
fi

# ── ⑪ 서비스 ────────────────────────────────────────────────────────────
#
# 순서가 계약이다 (`entrypoint.sh`): 부트스트랩 세대를 **데몬이** 쓰고 → 엔진을 띄우고
# → 에이전트를 붙인다. 손으로 쓴 conf 로는 안 된다 — 슬롯이 사는 `lua_shared_dict` 와
# admin 엔드포인트가 옛 세대에 이미 있어야 첫 apply 가 성립하고, 그 모양은 엔진
# capability 에 따라 달라진다.
#
# 엔진과 데몬을 **한 유닛**에 둔다. 나누면 "엔진만 살아 있고 제어가 없는" 상태가
# 정상 상태처럼 보이는데, 그건 S8 이 실측한 조용한 고장의 모양이다.

step "⑪ 서비스"
write_systemd_unit() {
  # `+` 접두는 **root 로 돈다**는 뜻이다. `$ENGINE_RUN_DIR`(엔진의 pid 디렉터리)은 대개
  # `/run` 밑이고 거기는 tmpfs 라 **재부팅마다 사라진다** — 설치 때 한 번 만들어 두는
  # 것으로는 모자라고, 유닛은 비-root 로 돌아 스스로 만들 수 없다.
  RUNDIR_PRE=""
  if [ -n "$ENGINE_RUN_DIR" ]; then
    RUNDIR_PRE="ExecStartPre=+/usr/bin/install -d -m 0755 -o $SVC_USER -g $SVC_USER $ENGINE_RUN_DIR"
  fi
  cat > /etc/systemd/system/barycenterd.service <<EOF
[Unit]
Description=barycenter control plane (nginx)
# network-online.target 을 **안 쓴다.** 쓰면 그 타깃을 채우는
# systemd-networkd-wait-online 이 못 끝나는 환경에서 start 작업이 queued 인 채로
# 매달린다 — AL2023 판에서 실측했다: "systemctl enable --now" 가 0 을 냈는데 서비스는
# inactive 였고, list-jobs 에 "barycenterd.service start waiting" 이 남아 있었다.
# 네트워크가 늦으면 데몬이 DSN 에서 죽고 아래 Restart= 가 다시 세운다 — 그쪽이
# 기다림보다 낫다.
# (이 주석에 역따옴표를 안 쓰는 것은 취향이 아니다 — 이 heredoc 은 확장되므로
#  역따옴표가 그대로 명령 치환이 된다.)
After=network.target postgresql.service

[Service]
Type=exec
User=$SVC_USER
Group=$SVC_USER
EnvironmentFile=$ENV_FILE
$RUNDIR_PRE
ExecStartPre=$NODE_BIN $APP_DIR/dist/bin/barycenterd.js --write-bootstrap
ExecStartPre=$ENGINE_BIN -p $PREFIX -c $PREFIX/current/nginx.conf
ExecStart=$NODE_BIN $APP_DIR/dist/bin/barycenterd.js
Restart=on-failure
RestartSec=5
# **재시도 상한을 끈다.** 기본값(10초에 5번)이면 PG 가 늦게 뜨는 부팅에서 다섯 번
# 만에 포기하고 failed 로 남는다 — 트래픽은 흐르는데 제어가 없는 그 상태다.
StartLimitIntervalSec=0
TimeoutStopSec=15
# NoNewPrivileges 를 켜지 않는다 — 켜면 ⑤ 의 파일 capability 가 무효가 되고
# 80·443 리스너가 bind 에서 죽는다.

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
}

write_openrc_unit() {
  cat > /etc/init.d/barycenterd <<EOF
#!/sbin/openrc-run
name="barycenterd"
description="barycenter control plane (nginx)"

# **최상위에서 읽는다.** start_pre 안에서 export 하면 그 셸 밖으로 안 나간다.
set -a
[ -f "$ENV_FILE" ] && . "$ENV_FILE"
set +a

command="$NODE_BIN"
command_args="$APP_DIR/dist/bin/barycenterd.js"
command_user="$SVC_USER:$SVC_USER"
command_background=true
pidfile="/run/barycenterd.pid"
output_log="$PREFIX/logs/daemon.log"
error_log="$PREFIX/logs/daemon.log"

depend() {
	need net
	after postgresql
}

start_pre() {
	# systemd 유닛의 ExecStartPre 와 같은 순서·같은 명령이다.
	${ENGINE_RUN_DIR:+checkpath -d -m 0755 -o "$SVC_USER:$SVC_USER" "$ENGINE_RUN_DIR" || return 1}
	su -s /bin/sh "$SVC_USER" -c "$NODE_BIN $APP_DIR/dist/bin/barycenterd.js --write-bootstrap" || return 1
	su -s /bin/sh "$SVC_USER" -c "$ENGINE_BIN -p $PREFIX -c $PREFIX/current/nginx.conf" || return 1
}

stop_post() {
	# 엔진은 이 유닛이 띄웠으므로 이 유닛이 내린다. 안 내리면 제어 없는 nginx 가
	# 남고, 그게 옛 세대를 계속 서빙한다.
	[ -f "$ENGINE_PID_FILE" ] && kill -QUIT "\$(cat "$ENGINE_PID_FILE")" 2>/dev/null
	return 0
}
EOF
  chmod +x /etc/init.d/barycenterd
}

case "$INIT" in
  systemd) write_systemd_unit; ok "/etc/systemd/system/barycenterd.service" ;;
  openrc)  write_openrc_unit;  ok "/etc/init.d/barycenterd" ;;
  none)
    warn "초기화 시스템을 못 찾았다 (systemd·OpenRC 둘 다) — 유닛을 쓰지 않는다"
    NO_SERVICE=1 ;;
esac

if [ "$NO_SERVICE" = 1 ]; then
  say ""
  say "  --no-service 다. 손으로 띄우려면 (순서가 계약이다):"
  say "    sudo -u $SVC_USER env \$(grep -v '^#' $ENV_FILE | tr -d \"'\" | xargs) \\"
  say "      $NODE_BIN $APP_DIR/dist/bin/barycenterd.js --write-bootstrap"
  say "    sudo -u $SVC_USER $ENGINE_BIN -p $PREFIX -c $PREFIX/current/nginx.conf"
  say "    sudo -u $SVC_USER env \$(grep -v '^#' $ENV_FILE | tr -d \"'\" | xargs) \\"
  say "      $NODE_BIN $APP_DIR/dist/bin/barycenterd.js"
else
  svc_start barycenterd
  ok "barycenterd 시작"
fi

# ── ⑫ 검증 ──────────────────────────────────────────────────────────────
#
# **설치했다고 도는 것이 아니다.** 여기까지 초록인데 데몬이 죽어 있는 경우를 실제로
# 봤다(볼륨 소유권·node 버전). 답하는 것을 확인하고 끝낸다.

step "⑫ 검증"
if [ "$NO_SERVICE" = 1 ]; then
  ok "건너뛴다 — 서비스를 안 띄웠다"
else
  if [ -n "$TLS_CERT" ]; then URL="https://$LISTEN"; CURL_OPTS=-k; else URL="http://$LISTEN"; CURL_OPTS=; fi
  i=0
  until curl -fsS $CURL_OPTS --max-time 2 "$URL/healthz" >/dev/null 2>&1; do
    i=$((i + 1))
    if [ "$i" -gt 60 ]; then
      say ""
      case "$INIT" in
        systemd) journalctl -u barycenterd --no-pager -n 40 >&2 || true ;;
        openrc)  tail -n 40 "$PREFIX/logs/daemon.log" >&2 || true ;;
      esac
      die "데몬이 60초 안에 $URL/healthz 에 안 답했다"
    fi
    sleep 1
  done
  ok "$URL/healthz"

  # `/readyz` 는 「엔진이 살아 있고 드라이버가 답하는가」다. `/healthz` 와 뜻이 다르다 —
  # 여기가 초록이어야 첫 apply 가 성립한다.
  i=0
  until curl -fsS $CURL_OPTS --max-time 2 "$URL/readyz" >/dev/null 2>&1; do
    i=$((i + 1))
    [ "$i" -gt 30 ] && die "$URL/readyz 가 30초 안에 안 답했다 — 엔진이 안 붙었다"
    sleep 1
  done
  ok "$URL/readyz"

  BARY_URL="$URL" BARY_TOKEN="$TOKEN_PLAIN" "$NODE_BIN" "$APP_DIR/dist/bin/bary.js" status >/dev/null \
    || die "bary status 가 실패했다 — API 나 토큰이 안 맞는다"
  ok "bary status"
fi

case "$INIT" in
  systemd) SVC_HINT="systemctl status barycenterd" ;;
  openrc)  SVC_HINT="rc-service barycenterd status" ;;
  *)       SVC_HINT="(없음 — 손으로 띄운다)" ;;
esac

# ── 끝 ──────────────────────────────────────────────────────────────────

cat <<EOF

설치 끝.

  API        ${URL:-http://$LISTEN}   (GUI 도 같은 자리)
  prefix     $PREFIX
  산출물     $APP_DIR
  서비스     $SVC_HINT

  토큰(평문, **지금 한 번만 보인다**):
    $TOKEN_PLAIN

CLI:

  export BARY_URL=${URL:-http://$LISTEN}
  export BARY_TOKEN=$TOKEN_PLAIN
  $NODE_BIN $APP_DIR/dist/bin/bary.js status

⚠️ $LISTEN 을 넓은 인터페이스로 옮기려면 TLS 를 먼저 켠다 — 이 API 로 개인키와
   Bearer 토큰이 지나간다. $ENV_FILE 에 BARY_TLS_CERT_FILE·BARY_TLS_KEY_FILE 을 준다.

⚠️ 리스너를 열어도 방화벽·보안그룹은 이 스크립트가 안 건드린다. 그리고 이 배포는
   **단일 장애점**이다 — 자동 페일오버는 없다 (docs/runbook-spof.md).
EOF
