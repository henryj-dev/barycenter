#!/usr/bin/env bash
# S12 스파이크 러너 — 크래시 저널 (DESIGN.md §12.0, §6.2)
#
#   ./spike/s12/run.sh [image]
#
# 합격 기준: §6.2 표의 모든 지점에서 복구가 정확하고 중복 cycle 이 유계.
# 실패 시 규칙: **설계 재작업 (block 등급)**.
#
# `dist/` 를 마운트하므로 먼저 빌드해야 한다 — verify.sh 는 build 뒤에 부른다.
set -euo pipefail
IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
[ -d "$ROOT/dist" ] || { echo "dist/ 가 없다 — ./scripts/build.sh 를 먼저 돌린다"; exit 1; }
echo "image: $IMAGE"
docker run --rm \
  -v "$HERE:/spike:ro" -v "$ROOT:/app:ro" \
  --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
