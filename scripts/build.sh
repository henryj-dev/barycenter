#!/usr/bin/env bash
# 배포 산출물을 만든다 — `dist/`.
#
# **SQL 을 손으로 복사한다.** tsc 는 `.ts` 만 옮기므로 마이그레이션이 빠지고, 그러면
# 데몬이 기동 시점에 "migrations 디렉토리가 없다" 로 죽는다. 빌드가 조용히 반쪽짜리
# 산출물을 내는 것보다 여기서 명시적으로 챙기는 편이 낫다.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
rm -rf dist
npx tsc -p tsconfig.build.json
mkdir -p dist/store/migrations
cp src/store/migrations/*.sql dist/store/migrations/
chmod +x dist/bin/barycenterd.js
echo "dist/ 준비됨 — $(find dist -name '*.js' | wc -l | tr -d ' ') 개 모듈, $(ls dist/store/migrations | wc -l | tr -d ' ') 개 마이그레이션"
