#!/usr/bin/env bash
# barycenter — 엔진 사실 검증 러너 (호스트 측)
#
#   ./tests/engine/run.sh [image]
#
# DESIGN.md 가 전제하는 nginx/OpenResty 동작을, pin 하려는 실제 이미지에서 확인한다.
# 구현 코드가 없어도 지금 실행할 수 있는 유일한 테스트 묶음이다.
#
# 종료 코드: 실패 케이스가 하나라도 있으면 1.

set -euo pipefail

IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "image: $IMAGE"

docker run --rm \
  -v "$HERE:/bary-tests:ro" \
  --entrypoint /bin/sh \
  "$IMAGE" /bary-tests/bootstrap.sh
