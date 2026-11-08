#!/bin/sh
# 배포 뒤 점검 — 설치한 서버에서 root 로 돈다. 읽기만 한다(설정 · 적용 · 삭제 없음).
#
#   sudo sh deploy/check.sh --region <지역 호스트> [--region-name <지역 이름>] \
#        [--global <전역 호스트>] [--ip <엔진 주소>] [--token-file <ops 토큰 파일>]
#
# 원격에서 돌릴 때:  ssh <서버> 'sudo sh -s -- --region … --global …' < deploy/check.sh
#
# 토큰은 파일에서만 읽고 화면 · 인자 · 로그에 싣지 않는다(curl 에는 설정 파일로 넘긴다).
# 끝 줄이 「합계: OK n · FAIL m」 이고, FAIL 이 있으면 종료 코드 1 이다.
set -u

REGION=''; REGION_NAME=''; GLOBAL=''; IP='127.0.0.1'; TOKEN_FILE='/root/barycenter-ops.token'
while [ $# -gt 0 ]; do
  case "$1" in
    --region) REGION=$2; shift 2 ;;
    --region-name) REGION_NAME=$2; shift 2 ;;
    --global) GLOBAL=$2; shift 2 ;;
    --ip) IP=$2; shift 2 ;;
    --token-file) TOKEN_FILE=$2; shift 2 ;;
    *) echo "모르는 인자: $1" >&2; exit 2 ;;
  esac
done
[ -n "$REGION" ] || { echo "--region 이 필요하다" >&2; exit 2; }
[ -r "$TOKEN_FILE" ] || { echo "토큰 파일을 못 읽는다: $TOKEN_FILE" >&2; exit 2; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/body"; HDR="$WORK/headers"; AUTH="$WORK/auth"
# 토큰을 argv 에 싣지 않는다 — curl 설정 파일(0600)로 넘긴다.
(umask 077; printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TOKEN_FILE")" > "$AUTH")

ok=0; bad=0
chk() { # 이름 기대 실제
  if [ "$2" = "$3" ]; then ok=$((ok+1)); echo "  OK    $1 ($3)"; else bad=$((bad+1)); echo "  FAIL  $1 (기대 $2, 실제 $3)"; fi
}
code() { # host path [추가 curl 인자...]
  h=$1; p=$2; shift 2
  curl -s -o "$OUT" -D "$HDR" -w '%{http_code}' --max-time 15 --resolve "$h:443:$IP" "$@" "https://$h$p"
}
authed() { code "$@" -K "$AUTH"; }

echo "== 판과 서비스"
[ -r /etc/barycenter/version ] && echo "  $(tr '\n' ' ' < /etc/barycenter/version)"
chk "engine" active "$(systemctl is-active barycenter-engine)"
chk "barycenterd" active "$(systemctl is-active barycenterd)"
chk "경고 로그(3분)" 0 "$(journalctl -u barycenterd --since '-3 min' -p warning -q --no-pager | wc -l | tr -d ' ')"
# 데몬 사용자가 버전을 읽을 수 있어야 Server 헤더에 버전이 실린다 (#214).
PKG=/opt/barycenter/package.json
VER=$(sed -n 's/^ *"version": "\(.*\)".*/\1/p' "$PKG" 2>/dev/null | head -1)
chk "package.json 모드" 644 "$(stat -c %a "$PKG" 2>/dev/null || echo 없음)"

echo "== 지역 ($REGION)"
chk "readyz" 200 "$(code "$REGION" /readyz)"
chk "GUI /" 200 "$(code "$REGION" /)"
chk "Server 헤더" "barycenter/$VER" "$(sed -n 's/^[Ss]erver: *//p' "$HDR" | tr -d '\r' | head -1)"
chk "토큰 없이 status → 401" 401 "$(code "$REGION" /api/v1/status)"
chk "ops 토큰 status" 200 "$(authed "$REGION" /api/v1/status)"
chk "ops 토큰 config/head" 200 "$(authed "$REGION" /api/v1/config/head)"
echo "    head: $(python3 -c 'import json,sys;d=json.load(open(sys.argv[1]));print(d.get("revision","?"))' "$OUT" 2>/dev/null)"
chk "ops 토큰 listeners" 200 "$(authed "$REGION" /api/v1/listeners)"
chk "ops 토큰 certificates" 200 "$(authed "$REGION" /api/v1/certificates)"
# 엔진이 만든 오류는 자체 페이지로 나간다 (#212). TRACE 는 nginx 가 405 로 직접 거절한다.
chk "엔진 오류 상태(TRACE)" 405 "$(code "$REGION" / -X TRACE)"
chk "엔진 오류 페이지" 1 "$(grep -c 'Request ID' "$OUT" 2>/dev/null | head -1)"

if [ -n "$GLOBAL" ]; then
  echo "== 전역 ($GLOBAL)"
  chk "readyz" 200 "$(code "$GLOBAL" /readyz)"
  chk "GUI /" 200 "$(code "$GLOBAL" /)"
  chk "지역 목록" 200 "$(authed "$GLOBAL" /api/v1/regions)"
  python3 - "$OUT" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
for r in (d if isinstance(d, list) else d.get('regions', [])):
    st = r.get('status') if isinstance(r.get('status'), dict) else {}
    print('    지역', r.get('name'), 'head', st.get('head', '?'), '리더', (st.get('leader') or {}).get('holder', '?'),
          '판', (st.get('build') or {}).get('commit', '?'))
PY
  if [ -n "$REGION_NAME" ]; then
    chk "전역→지역 status" 200 "$(authed "$GLOBAL" "/api/v1/regions/$REGION_NAME/status")"
    chk "전역→지역 config/head" 200 "$(authed "$GLOBAL" "/api/v1/regions/$REGION_NAME/config/head")"
    chk "전역→지역 listeners" 200 "$(authed "$GLOBAL" "/api/v1/regions/$REGION_NAME/listeners")"
    chk "자격 없는 쓰기 → 401" 401 "$(code "$GLOBAL" "/api/v1/regions/$REGION_NAME/apply" -X POST -H 'Content-Type: application/json' -d '{}')"
  fi
  chk "전역에 지역 전용 경로 → 404" 404 "$(authed "$GLOBAL" /api/v1/status)"
fi

echo "== 합계: OK $ok · FAIL $bad"
[ "$bad" -eq 0 ]
