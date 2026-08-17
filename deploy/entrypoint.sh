#!/bin/sh
# 데이터 플레인 기동 — 엔진을 먼저 세우고 에이전트를 붙인다.
#
# 순서가 중요하다. 에이전트는 기동하자마자 `fence()` 를 지나고, 그 뒤 첫 apply 가
# HUP 을 보낸다. 엔진이 아직 없으면 그 HUP 이 갈 곳이 없다.
set -eu

PREFIX="${BARY_PREFIX:-/prefix}"
ENGINE=/usr/local/openresty/bin/openresty

mkdir -p "$PREFIX/logs" "$PREFIX/state" "$PREFIX/generations"

# **부트스트랩 세대를 데몬이 만든다.**
#
# 손으로 쓴 conf 로는 안 된다 — §6.5-1 은 멤버십을 HUP **전에** 적재하라고 하고, 그 시점에
# 도는 설정은 아직 옛 세대다. 첫 apply 에서 그 옛 세대가 부트스트랩이므로, 슬롯이 사는
# `lua_shared_dict` 와 admin 엔드포인트가 **부트스트랩에 이미 있어야** 한다. 그 모양은
# 엔진 capability 에 따라 달라지므로 셸이 쓸 수 없다.
node /app/dist/bin/barycenterd.js --write-bootstrap

# 엔진은 데몬으로 띄운다. 포그라운드로 두면 에이전트를 붙일 수 없고, 그렇다고 에이전트를
# 백그라운드로 돌리면 **에이전트가 죽어도 컨테이너가 산 채로 남는다** — 그건 조용한
# 고장이다. 죽어야 하는 쪽(에이전트)을 pid 1 의 자식 포그라운드로 둔다.
"$ENGINE" -p "$PREFIX" -c "$PREFIX/current/nginx.conf"

exec node /app/dist/bin/barycenterd.js
