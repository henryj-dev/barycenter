#!/usr/bin/env bash
# 저장소별 commit-msg 훅을 이 클론에 연결한다. **머신마다 한 번** 실행한다.
#
# `.git/hooks/` 는 커밋되지 않으므로 훅을 추적되는 `scripts/git-hooks/` 에 두고
# `core.hooksPath` 로 가리킨다.
set -euo pipefail

COMMON="$(git rev-parse --path-format=absolute --git-common-dir)"
MAIN="$(dirname "$COMMON")"

git -C "$MAIN" config core.hooksPath scripts/git-hooks
chmod +x "$MAIN/scripts/git-hooks/commit-msg"

echo "core.hooksPath = $(git -C "$MAIN" config core.hooksPath)"
echo "설치됨: $MAIN/scripts/git-hooks/commit-msg"
echo "`src/` 커밋은 Pinned-by: 표식이 필요합니다."
