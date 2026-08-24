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
rm -rf dist dist-testing
npx tsc -p tsconfig.build.json
mkdir -p dist/store/migrations
cp src/store/migrations/*.sql dist/store/migrations/
# **진입점 전부에 건다** (검수 N1). 전에는 이름을 손으로 들고 있었고, `bary-dp-agent`
# 가 `package.json` 의 `bin` 에 들어온 회차에 이 줄이 안 따라왔다 — 선언은 있는데
# 실행 권한이 없는 산출물이 나갔다. 이 파일 머리말이 *"빌드가 조용히 반쪽짜리
# 산출물을 내는 것보다 여기서 명시적으로 챙기는 편이 낫다"* 고 적어 놓고, 챙기는
# 방법이 목록이라 진입점이 늘 때마다 빠뜨릴 자리가 하나 늘었다. 목록을 없앤다.
chmod +x dist/bin/*.js

# ── 스파이크용 산출물 (검수 G5) ──────────────────────────────────────────
#
# 테스트용 가짜(`CrashClock`·`FaultStore`·`FakeEffects`)는 `dist/` 에서 뺐다 —
# 배포 이미지가 `dist/` 를 통째로 복사하므로 실서비스 컨테이너에 크래시 주입 기계가
# 실리기 때문이다.
#
# **그런데 S12 는 그것들을 쓴다.** 컨테이너 안에서 도는 빌드 산출물을 쓰기 때문이고
# (소스를 직접 못 돌린다), 그러니 어딘가로는 빌드돼야 한다. `dist-testing/` 이다.
npx tsc -p tsconfig.testing.json
echo "dist-testing/ 준비됨 — 스파이크용 (배포 이미지에 안 들어간다)"
echo "dist/ 준비됨 — $(find dist -name '*.js' | wc -l | tr -d ' ') 개 모듈, $(ls dist/store/migrations | wc -l | tr -d ' ') 개 마이그레이션"

# ── 화면도 산출물이다 ────────────────────────────────────────────────────
#
# **여기 없으면 아무 데도 없다.** 데몬은 `gui/build` 가 없으면 조용히 GUI 없이 뜨고
# (`barycenterd.ts` 의 `serveRoot`), `verify.sh` 는 이 스크립트를 부르는 것 말고는
# 화면을 재는 자리가 없었다. 그래서 브라우저 번들이 한동안 안 서는데도 초록이었다.
#
# 의존성은 **없을 때만** 받는다. 매번 `npm ci` 를 돌리면 로컬 빌드가 분 단위로
# 길어지고, 길어지면 사람이 빌드를 건너뛴다.
# **lock 이 바뀌면 다시 받는다** (검수 G7). 전에는 디렉토리 유무만 봤다 — 그래서
# `gui/package-lock.json` 이 바뀌어도 옛 의존성으로 빌드했고, 그 차이는 "내 컴퓨터에선
# 되는데" 로만 드러난다. 해시를 옆에 적어 두고 대조한다.
#
# **해시 도구가 기계마다 다르다** (검수 2026-08-24 CI-3). alpine(빌드 이미지)에는
# `shasum` 이 없고 `sha256sum` 만 있다. macOS 는 그 반대다. 처음엔 `shasum` 만 불렀고,
# `2>/dev/null` 이 그 실패를 삼켜 **이미지 안에서는 해시가 늘 빈 문자열**이었다 —
# 빈 문자열끼리 비교하니 항상 같고, lock 이 바뀌어도 다시 안 받는다. 즉 이 검사 전체가
# 조용히 죽어 있었다. 이 저장소가 세는 자리다: *"필드는 있는데 아무도 안 읽는다."*
# 그래서 **둘 다 없으면 빌드를 세운다** — 감시를 못 하는 채로 지나가지 않는다.
gui_lock_stamp=gui/node_modules/.bary-lock
if command -v sha256sum >/dev/null 2>&1; then
  gui_lock_now=$(sha256sum gui/package-lock.json | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  gui_lock_now=$(shasum -a 256 gui/package-lock.json | cut -d' ' -f1)
else
  echo "sha256 도구가 없다 (sha256sum·shasum 둘 다) — gui lock 감시를 못 한다" >&2
  exit 1
fi
if [ ! -d gui/node_modules ] || [ "$(cat "$gui_lock_stamp" 2>/dev/null)" != "$gui_lock_now" ]; then
  (cd gui && npm ci --no-audit --no-fund >/dev/null)
  printf '%s' "$gui_lock_now" > "$gui_lock_stamp"
fi
(cd gui && npx vite build >/dev/null)
echo "gui/build 준비됨 — $(find gui/build -name '*.html' | wc -l | tr -d ' ') 개 화면"
