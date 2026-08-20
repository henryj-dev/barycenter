#!/usr/bin/env bash
# S18 스파이크 러너 — ACME 상태기계 (DESIGN.md §12.0, §8.2)
#
#   ./spike/s18/run.sh
#
# 합격 기준: 오더·챌린지·재시도·고아 정리. 실패 시 규칙: **ACME 범위 축소**.
#
# §8.2 는 규범이 아니다 — *"ADR-ACME 가 확정하기 전까지 구속력이 없다"*. 이 스파이크가
# 그 ADR 이 딛고 설 사실을 만든다.
#
# ── 왜 Pebble 인가 ─────────────────────────────────────────────────────
#
# Let's Encrypt staging 은 네트워크·레이트리밋·실제 DNS 가 필요하고, 무엇보다
# **badNonce 를 일부러 낼 수 없다.** Pebble 은 못되게 구는 것이 기능이다:
# `PEBBLE_WFE_NONCEREJECT` 로 nonce 를 정해진 비율로 거절한다. RFC 8555 §6.5 가 "한 번은
# 반드시 재시도" 라고 한 그 경로를 실제로 밟게 하는 유일한 방법이다.
#
# **DNS 는 도커 네트워크 별칭에 기댄다.** Pebble 이 `happy.test` 를 찾으면 도커 내장
# DNS 가 클라이언트 컨테이너를 준다 — 별도 DNS 서버를 안 띄운다.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
[ -d "$ROOT/dist" ] || { echo "dist/ 가 없다 — ./scripts/build.sh 를 먼저 돌린다"; exit 1; }

NET=bary-s18-net
PEBBLE=bary-s18-pebble
PEBBLE_IMAGE="${PEBBLE_IMAGE:-ghcr.io/letsencrypt/pebble:latest}"
NODE_IMAGE="${NODE_IMAGE:-docker.io/library/node:24-alpine}"

cleanup() {
  docker rm -f "$PEBBLE" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT
cleanup
docker network create "$NET" >/dev/null

docker run -d --name "$PEBBLE" --network "$NET" \
  -e PEBBLE_VA_NOSLEEP=1 \
  -e PEBBLE_WFE_NONCEREJECT=20 \
  "$PEBBLE_IMAGE" >/dev/null

echo ""
echo "=============================================================="
echo " S18 spike — ACME 상태기계"
echo " $PEBBLE_IMAGE  (NONCEREJECT=20%)"
echo "=============================================================="
echo ""
sleep 2

TMP=$(mktemp -d)
for s in happy nonce nonce_norety fail orphan wildcard dns; do
  docker run --rm --network "$NET" \
    --network-alias happy.test --network-alias broken.test --network-alias orphan.test \
    -v "$ROOT:/app:ro" -v "$HERE:/spike:ro" \
    -e "ACME_DIRECTORY=https://$PEBBLE:14000/dir" \
    --entrypoint node "$NODE_IMAGE" /spike/runner.mjs "$s" > "$TMP/$s.out" 2>&1 || true
  # `head` 가 파이프를 닫으면 앞쪽 grep 이 SIGPIPE 로 죽고, `pipefail` 이 그걸 실패로
  # 올려 `set -e` 가 루프를 끝낸다 — 첫 시나리오만 돌고 조용히 끝났다. 묶어서 무해화한다.
  { grep '^RESULT ' "$TMP/$s.out" || true; } | while read -r _ name verdict rest; do
    printf "  %-4s  %-16s %s\n" "$verdict" "$name" "$rest"
  done
  # NODE_TLS_REJECT_UNAUTHORIZED 경고는 우리가 일부러 켠 것이다 — 소음이라 걷어낸다.
  { grep -v '^RESULT ' "$TMP/$s.out" \
    | grep -vE '^$|NODE_TLS_REJECT_UNAUTHORIZED|trace-warnings' \
    | head -3 | sed 's/^/        /'; } || true
done

PASS=$(cat "$TMP"/*.out | grep -c '^RESULT [^ ]* PASS ' || true)
FAIL=$(cat "$TMP"/*.out | grep -c '^RESULT [^ ]* FAIL ' || true)
rm -rf "$TMP"

echo ""
echo "=============================================================="
echo " PASS=$PASS  FAIL=$FAIL"
if [ "$FAIL" -eq 0 ]; then
  echo " → ACME 상태기계가 성립한다. ADR-ACME 를 쓸 근거가 생겼다."
else
  echo " → §12.0 규칙에 따라 **ACME 범위 축소**를 검토한다."
fi
echo "=============================================================="
[ "$FAIL" -eq 0 ]
