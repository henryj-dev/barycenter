#!/usr/bin/env bash
# S17 스파이크 러너 — TLS 인증서 선택 (DESIGN.md §12.0, §4.6, §8.1)
#
#   ./spike/s17/run.sh [image]
#
# 합격 기준: exact / 1라벨 와일드카드 / default_server 조합에서 **SAN 미커버 인증서
# 제시 0회**. 실패 시 → v0 은 exact host 만 지원한다.
#
# 이 스파이크가 모델의 `https` 를 되살리는 전제다 — 렌더러가 TLS 를 못 내는데 타입만
# 주면 v3 처럼 `protocol: 'https'` 가 평문 `listen 443;` 으로 나간다.
set -euo pipefail
IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "image: $IMAGE"
docker run --rm -v "$HERE:/spike:ro" --entrypoint /bin/sh "$IMAGE" /spike/probe.sh
