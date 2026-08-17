#!/usr/bin/env bash
# S16 스파이크 러너 — SNI 별 TLS policy (DESIGN.md §12.0, §4.6)
#
#   ./spike/s16/run.sh [image]
#
# 질문: 비-default server 의 `ssl_protocols` 가 실제 handshake 에 걸리는가.
# 실패 시 규칙(§12.0): `override` 제거 — TlsPolicy 를 SNI 별로 다르게 주지 않는다.
set -euo pipefail
IMAGE="${1:-${BARY_ENGINE_IMAGE:-openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "image: $IMAGE"
docker run --rm -v "$HERE:/spike:ro" --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
