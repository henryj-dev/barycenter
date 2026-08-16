#!/usr/bin/env bash
# S19 스파이크 러너 — 롤백 경로 합성 (DESIGN.md §12.0, §3.3, §6.5, §7.2, §8.4)
#
#   ./spike/s19/run.sh [image]
#
# 합격 기준: 옛 topology·TLS 자료를 새 세대로 clone 하고 새 epoch 리터럴을 구워
#            활성화했을 때, S8(세대 결박)과 S11(새 epoch)이 **함께** 성립한다.
# 실패 시 → 설계 재작업 (S19 는 프로젝트 block).
set -euo pipefail
IMAGE="${1:-${BARY_ENGINE_IMAGE:-openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "image: $IMAGE"
docker run --rm -v "$HERE:/spike:ro" --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
