#!/usr/bin/env bash
# S13 스파이크 러너 — 마커·워커 레지스트리·GC (DESIGN.md §12.0, §8.4)
#
#   ./spike/s13/run.sh [image]
#
# 합격 기준: 옛 워커 잔존 중 오삭제 0회 + GC 각 단계 크래시에서 누수·이중감소 0회 +
# root 누락 0회. 실패 시 규칙: **GC 보수화**.
set -euo pipefail
IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "image: $IMAGE"
docker run --rm -v "$HERE:/spike:ro" --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
