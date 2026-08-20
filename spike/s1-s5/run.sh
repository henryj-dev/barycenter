#!/usr/bin/env bash
# S1 / S5 스파이크 러너 — DESIGN.md §12.0
#
#   ./spike/s1-s5/run.sh [image]
#
# 합격 기준 (TESTS.md §2)
#   S1  HTTP·TCP·UDP 세 서브시스템 전부에서 reload 없이 백엔드가 바뀐다.
#       전환 후 **첫 요청부터** 반영된다.
#   S5  http/stream 양쪽을 갱신했을 때 **전 워커**가 500ms 안에 수렴한다.
#
# 실패 시 결정: 둘 중 하나라도 떨어지면 → 대안 B (순수 nginx + DNS resolve).
set -euo pipefail

IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "image: $IMAGE"
docker run --rm -v "$HERE:/spike:ro" --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
