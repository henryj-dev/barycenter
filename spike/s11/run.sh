#!/usr/bin/env bash
# S11 스파이크 러너 — activation_epoch 경합 (DESIGN.md §12.0)
#
#   ./spike/s11/run.sh [image]
#
# 합격 기준: P1(ABA) · P7(staging) · P8(다중 serving epoch) · P15(리더 토큰) 전부에서
#            잘못된 peer 선택 0회. 실패 시 → 설계 재작업 (S11 은 프로젝트 block).
set -euo pipefail
IMAGE="${1:-${BARY_ENGINE_IMAGE:-openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "image: $IMAGE"
docker run --rm -v "$HERE:/spike:ro" --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
