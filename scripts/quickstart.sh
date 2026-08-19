#!/usr/bin/env bash
# README 의 Quickstart 를 **그대로** 돌리고 결과를 확인한다.
#
# 문서에 적힌 명령이 정말 도는지는 문서를 읽어서는 알 수 없다. 손으로 확인하는 한
# 반드시 썩는다 — 이 저장소는 "문서와 코드가 갈라졌다" 는 지적을 이미 받아 봤다(6차 검수).
# 그래서 문서의 절차를 실행 가능한 형태로 한 번 더 둔다.
#
#   ./scripts/quickstart.sh          띄우고 확인하고 **그대로 둔다**
#   ./scripts/quickstart.sh --clean  확인한 뒤 치운다
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLEAN=0
[ "${1:-}" = "--clean" ] && CLEAN=1

# **필요한 도구를 먼저 확인한다.**
#
# 없으면 엉뚱한 곳에서 엉뚱한 말로 죽는다 — 실제로 `curl` 이 없는 환경에서
# "데몬이 안 떴다" 고 보고했다. 데몬은 멀쩡히 떠 있었고 못 물어본 것뿐이었다.
# **없는 것을 없다고 말하지 못하는 진단은 진단이 아니다.**
missing=""
for tool in docker curl node; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  echo "  FAIL  필요한 도구가 없다:$missing"
  exit 1
fi

export BARY_URL=http://127.0.0.1:8088
export BARY_TOKEN=dev-token

echo "① 배포를 띄운다"
docker compose -f deploy/docker-compose.yml up -d --build

echo "② 빌드"
./scripts/build.sh

echo "③ 데몬이 응답할 때까지 기다린다"
# 고정 sleep 은 느린 머신에서 거짓 실패를 만든다.
deadline=$(( $(date +%s) + 120 ))
until curl -sf --max-time 2 "$BARY_URL/healthz" >/dev/null 2>&1; do
  if [ "$(date +%s)" -gt "$deadline" ]; then
    echo "  FAIL  데몬이 안 떴다"
    docker compose -f deploy/docker-compose.yml logs --tail 30 dataplane
    exit 1
  fi
  sleep 1
done

echo "④ 아직 아무것도 게시되지 않았다"
node dist/bin/bary.js status | head -5

echo "⑤ 매니페스트를 적용한다"
node dist/bin/bary.js apply examples/hello.json

echo "⑥ 판정 — curl 이 백엔드에 닿는가"
got=""
deadline=$(( $(date +%s) + 30 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  got=$(curl -s --max-time 3 http://127.0.0.1:8999/ 2>/dev/null || true)
  [ "$got" = "hello from A:11" ] && break
  sleep 1
done

if [ "$got" = "hello from A:11" ]; then
  echo ""
  echo "  ok    Quickstart 가 README 대로 동작한다 — curl → '$got'"
  [ $CLEAN -eq 1 ] && docker compose -f deploy/docker-compose.yml down -v >/dev/null 2>&1
else
  echo ""
  echo "  FAIL  기대 'hello from A:11', 실제 '$got'"
  docker compose -f deploy/docker-compose.yml logs --tail 80 dataplane || true
  [ $CLEAN -eq 1 ] && docker compose -f deploy/docker-compose.yml down -v >/dev/null 2>&1
  exit 1
fi
