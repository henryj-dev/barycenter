#!/usr/bin/env bash
# S8 스파이크 러너 — 인증서 세대 롤백 (DESIGN.md §12.0, §7.2, §8.3, §8.4)
#
#   ./spike/s8/run.sh [image]
#
# 합격 기준: 갱신 후 롤백 시 옛 key/chain 이 정확히 복원된다.
# 실패 시 → 설계 재작업 (S8 은 프로젝트 block).
set -euo pipefail
IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "image: $IMAGE"
docker run --rm -v "$HERE:/spike:ro" --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
