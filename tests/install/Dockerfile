# 설치 스크립트를 재는 **판**이다 — 제품 이미지가 아니다.
#
# 여기서 하는 일은 하나뿐이다: 초기화 시스템을 넣어서 **PID 1 로 띄울 수 있는**
# 배포판 컨테이너를 만든다. barycenter 는 아무것도 안 깐다 — 그걸 까는 것이
# `deploy/install.sh` 이고, 그것이 이 판에서 재는 대상이다.
#
# 초기화 시스템을 굳이 넣는 이유: 유닛 파일이 **문법만 맞는 것**과 **실제로 뜨는 것**은
# 다르다. `ExecStartPre` 로 띄운 nginx 가 유닛의 cgroup 에 남는가, 재기동이 부트스트랩을
# 되돌리지 않는가 — 이 둘은 초기화 시스템 없이는 잴 수 없고, 못 재면 안 재는 것과 같다.
#
# alpine 쪽 `sed`·`rc_provide` 세 줄은 OpenRC 에게 (1) 여기가 도커라는 것,
# (2) loopback·net 은 이미 있다는 것, (3) 하드웨어 초기화는 할 것이 없다는 것을
# 말해 준다. 없으면 `openrc` 가 부팅 중에 멎는다.
ARG BASE
FROM ${BASE}

RUN set -eu; \
    if command -v apt-get >/dev/null 2>&1; then \
      export DEBIAN_FRONTEND=noninteractive; \
      apt-get update -qq; \
      apt-get install -y -qq systemd systemd-sysv dbus procps >/dev/null; \
    elif command -v dnf >/dev/null 2>&1; then \
      dnf install -y -q systemd procps-ng >/dev/null; \
    elif command -v apk >/dev/null 2>&1; then \
      apk add --no-cache openrc procps >/dev/null; \
      sed -i 's/^#\?rc_sys=.*/rc_sys="docker"/' /etc/rc.conf; \
      printf 'rc_provide="loopback net"\n' >> /etc/rc.conf; \
      rm -f /etc/init.d/hwdrivers /etc/init.d/machine-id; \
      mkdir -p /run/openrc; \
      touch /run/openrc/softlevel; \
    fi

# `install.sh` 가 쓰는 것 말고는 아무것도 넣지 않는다. curl 도 안 넣는다 —
# 스크립트가 자기 의존성을 챙기는지도 재는 대상이기 때문이다.
