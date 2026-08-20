#!/usr/bin/env bash
# S7 스파이크 러너 — 활성화 판정 (DESIGN.md §12.0, §6.3)
#
#   ./spike/s7/run.sh [image]
#
# 합격 기준: 오탐/미탐 0, 판정 시간 < 3s.
# 실패 시 → 판정 절차 재설계. ApplyOperation 스키마 freeze 는 계속 block.
set -euo pipefail
IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "image: $IMAGE"
docker run --rm -v "$HERE:/spike:ro" --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
