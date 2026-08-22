#!/bin/sh
# 데이터 플레인 기동 — 엔진을 먼저 세우고 에이전트를 붙인다.
#
# 순서가 중요하다. 에이전트는 기동하자마자 `fence()` 를 지나고, 그 뒤 첫 apply 가
# HUP 을 보낸다. 엔진이 아직 없으면 그 HUP 이 갈 곳이 없다.
set -eu

PREFIX="${BARY_PREFIX:-/prefix}"
ENGINE=/usr/local/openresty/bin/openresty

# **쓸 수 있는지 먼저 이름 지어 확인한다** (검수 S-10b).
#
# 이 이미지는 비-root 로 돈다. compose 의 named volume 은 처음 만들어질 때 이미지의
# 소유권을 가져가므로 새 배포는 그냥 되지만, **비-root 전환 이전에 만들어진 볼륨은
# root 소유**다. 그대로 두면 `mkdir` 이 EACCES 로 죽고, 그 메세지는 원인을 안 말한다.
#
# 없는 것을 없다고 말하지 못하는 진단은 진단이 아니다 — quickstart 가 배운 그대로다.
if ! ( mkdir -p "$PREFIX/.wtest" && rmdir "$PREFIX/.wtest" ) 2>/dev/null; then
  echo "FAIL  $PREFIX 에 쓸 수 없다 — 이 이미지는 uid $(id -u) 로 돈다." >&2
  echo "      이 볼륨이 비-root 전환 이전에 만들어졌다면 소유권이 root 다. 고치려면:" >&2
  echo "        docker compose -f deploy/docker-compose.yml down" >&2
  echo "        docker run --rm -v <볼륨>:/p alpine chown -R 10001:10001 /p" >&2
  echo "      (새로 만드는 배포라면 볼륨을 지우고 다시 올려도 된다: down -v)" >&2
  exit 1
fi

# `run` 은 admin 유닉스 소켓이 사는 곳이다 (검수 S-08b). nginx 는 소켓을 만들 뿐
# 부모 디렉토리는 안 만든다. 0700 인 이유는 **접근 통제를 지는 것이 이 디렉토리**라서다 —
# nginx 의 `listen unix:` 에는 mode 옵션이 없어 소켓 자체의 모드는 정할 수 없다.
mkdir -p "$PREFIX/logs" "$PREFIX/state" "$PREFIX/generations" "$PREFIX/run"
chmod 700 "$PREFIX/run"

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
