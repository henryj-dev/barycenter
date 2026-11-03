#!/bin/sh
# **문서만 바뀌었나** — CI 가 비싼 잡을 건너뛸지 정한다.
#
#   git diff --name-only "$BASE"...HEAD | scripts/docs-only.sh
#
# 종료코드 0 = 바뀐 파일이 전부 문서다. 1 = 코드(또는 문서가 아닌 무엇)가 바뀌었다.
# **빈 입력은 1 이다** — 무엇이 바뀌었는지 모르면 다 돌린다. 건너뛰는 쪽이 틀리면
# 검증 없는 초록이 되고, 도는 쪽이 틀리면 몇 분을 더 쓸 뿐이다.
#
# 문서는 `.md` 뿐이다. 문서만 바뀌어도 `verify.sh --quick` 은 돈다 — conformance 시험이
# DESIGN.md · STATUS.md · 런북을 직접 읽어 코드와 대조하기 때문이다. 건너뛰는 것은 도커
# 조각 · quickstart 다 (`.github/workflows/verify.yml`). CodeQL 은 언제나 돈다 — Scorecard
# SAST 가 커밋마다 분석을 보기 때문이다 (`codeql.yml` 머리말).
#
# 정의는 여기 한 군데다. verify.yml 이 이 스크립트를 부르고,
# `tests/unit/docs-only.test.ts` 가 이 스크립트를 그대로 돌린다.
set -eu

DOCS='\.md$'

files="$(cat)"
if [ -z "$files" ]; then
  echo "바뀐 파일 목록이 비었다 — 전부 돌린다"
  exit 1
fi
if printf '%s\n' "$files" | grep -Evq "$DOCS"; then
  echo "문서가 아닌 파일이 바뀌었다:"
  printf '%s\n' "$files" | grep -Ev "$DOCS" | sed 's/^/  /' | head -20
  exit 1
fi
echo "문서만 바뀌었다:"
printf '%s\n' "$files" | sed 's/^/  /' | head -20
exit 0
