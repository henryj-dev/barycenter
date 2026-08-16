#!/bin/sh
# 데이터 플레인 기동 — 엔진을 먼저 세우고 에이전트를 붙인다.
#
# 순서가 중요하다. 에이전트는 기동하자마자 `fence()` 를 지나고, 그 뒤 첫 apply 가
# HUP 을 보낸다. 엔진이 아직 없으면 그 HUP 이 갈 곳이 없다.
set -eu

PREFIX="${BARY_PREFIX:-/prefix}"
ENGINE=/usr/local/openresty/bin/openresty

mkdir -p "$PREFIX/logs" "$PREFIX/state" "$PREFIX/generations"

# **부트스트랩 세대.** 아직 아무것도 커밋되지 않았을 때 엔진이 설 자리다.
#
# `admin/` 을 **비워 둔다.** 여기에 마커를 두면 컨트롤 플레인이 만들지도 않은 세대가
# "활성" 으로 보고돼 첫 활성화 판정이 거짓 양성이 된다 — 증거가 증거 노릇을 못 한다.
if [ ! -e "$PREFIX/current" ]; then
  mkdir -p "$PREFIX/generations/bootstrap/admin"
  cat > "$PREFIX/generations/bootstrap/nginx.conf" <<'CONF'
error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 1024; }
http {
    access_log off;
    include admin/*.conf;
}
CONF
  ln -sfn generations/bootstrap "$PREFIX/current"
fi

# 엔진은 데몬으로 띄운다. 포그라운드로 두면 에이전트를 붙일 수 없고, 그렇다고 에이전트를
# 백그라운드로 돌리면 **에이전트가 죽어도 컨테이너가 산 채로 남는다** — 그건 조용한
# 고장이다. 죽어야 하는 쪽(에이전트)을 pid 1 의 자식 포그라운드로 둔다.
"$ENGINE" -p "$PREFIX" -c "$PREFIX/current/nginx.conf"

exec node /app/dist/bin/barycenterd.js
