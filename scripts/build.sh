#!/bin/sh
# 배포 산출물을 만든다 — `dist/`.
#
# **POSIX sh 다.** alpine 기반 빌드 이미지에는 bash 가 없어서 `#!/usr/bin/env bash` 로
# 두면 `exit 127`(command not found)로 죽는다 — Dockerfile 을 처음 돌릴 때 실제로 그랬다.
# 저장소 안에서만 돌리는 스크립트가 아니라 **이미지 안에서도 돌므로** 최소 셸을 가정한다.
#
# **SQL 을 손으로 복사한다.** tsc 는 `.ts` 만 옮기므로 마이그레이션이 빠지고, 그러면
# 데몬이 기동 시점에 "migrations 디렉토리가 없다" 로 죽는다. 빌드가 조용히 반쪽짜리
# 산출물을 내는 것보다 여기서 명시적으로 챙기는 편이 낫다.
set -eu
cd "$(dirname "$0")/.."
rm -rf dist
npx tsc -p tsconfig.build.json
mkdir -p dist/store/migrations
cp src/store/migrations/*.sql dist/store/migrations/
chmod +x dist/bin/barycenterd.js dist/bin/bary.js
echo "dist/ 준비됨 — $(find dist -name '*.js' | wc -l | tr -d ' ') 개 모듈, $(ls dist/store/migrations | wc -l | tr -d ' ') 개 마이그레이션"

# ── 화면도 산출물이다 ────────────────────────────────────────────────────
#
# **여기 없으면 아무 데도 없다.** 데몬은 `gui/build` 가 없으면 조용히 GUI 없이 뜨고
# (`barycenterd.ts` 의 `serveRoot`), `verify.sh` 는 이 스크립트를 부르는 것 말고는
# 화면을 재는 자리가 없었다. 그래서 브라우저 번들이 한동안 안 서는데도 초록이었다.
#
# 의존성은 **없을 때만** 받는다. 매번 `npm ci` 를 돌리면 로컬 빌드가 분 단위로
# 길어지고, 길어지면 사람이 빌드를 건너뛴다.
[ -d gui/node_modules ] || (cd gui && npm ci --no-audit --no-fund >/dev/null)
(cd gui && npx vite build >/dev/null)
echo "gui/build 준비됨 — $(find gui/build -name '*.html' | wc -l | tr -d ' ') 개 화면"
