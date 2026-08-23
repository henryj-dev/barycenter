#!/usr/bin/env bash
# S9 스파이크 러너 — SNI 결과 3분기 관측성 (DESIGN.md §12.0, §4.1)
#
#   ./spike/s9/run.sh [image]
#
# 합격 기준(§12.0): **TLS-no-SNI / malformed / preread timeout 구분 가능 여부.**
#                   비-TLS 는 E26.1 이 이미 확인했다.
# 실패 시 규칙: 기능 축소 — 부재·파싱실패는 계속 `reject` 고정. 설계는 다시 안 한다.
#
# ── 왜 지금 재는가 ──────────────────────────────────────────────────────
#
# `tests/engine/engine_facts.sh` 의 E26.2 가 **스킵으로 남아 있다**:
#
#     skip E26.2 "TLS-no-SNI 경로는 백엔드가 평문 HTTP 라 완결 검증 불가 — S9 에서
#                 TLS 백엔드로 재실행"
#
# 그 스킵이 이 스파이크에 남긴 일이 정확히 하나 있다. 그리고 스킵을 남겨 둔 채
# STATUS 에 "구분 불가" 라고 적으면 그건 **측정이 아니라 추정**이다. 이 저장소는
# 그 차이를 게이트(`design-status-drift`)로 지키기로 했으므로, 여기서 사실로 바꾼다.
#
# ── 왜 "TLS 백엔드" 가 아닌가 ───────────────────────────────────────────
#
# E26.2 는 해법을 TLS 백엔드로 적었지만, 그러면 계측기가 하나 더 붙는다 — 핸드셰이크가
# 실패하면 "분기가 틀렸다" 와 "인증서가 틀렸다" 가 구분되지 않는다. 재려는 것은
# 핸드셰이크가 아니라 **어느 분기로 갔는가** 다. 백엔드를 stream-lua 로 두어 연결
# 즉시 표식 한 줄을 뱉게 하면 클라이언트는 TLS 를 말할 필요가 없다.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

IMAGE="${1:-${BARY_ENGINE_IMAGE:-docker.io/openresty/openresty:alpine}}"
NAME=bary-s9-engine
PORT=19900

PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf "  PASS  %-22s %s\n" "$1" "$2"; }
bad()  { FAIL=$((FAIL+1)); printf "  FAIL  %-22s %s\n" "$1" "$2"; }
skip() { SKIP=$((SKIP+1)); printf "  SKIP  %-22s %s\n" "$1" "$2"; }

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1; }
trap cleanup EXIT
# 겹쳐 돌면 서로를 지운다 — S14 가 배운 것과 같다.
if docker ps -a --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "  이미 S9 가 돌고 있다 ($NAME 이 있다). 끝나고 다시 돌린다."
  echo "  정말 찌꺼기라면: docker rm -f $NAME"
  exit 2
fi
cleanup >/dev/null 2>&1

echo ""
echo "=============================================================="
echo " S9 spike — SNI 결과 분기의 관측성"
echo " image: $IMAGE"
echo "=============================================================="
echo ""

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:$PORT" \
  -v "$HERE/nginx.conf:/usr/local/openresty/nginx/conf/nginx.conf:ro" \
  "$IMAGE" >/dev/null || { echo "  기동 실패"; exit 1; }

# **떴는지 확인하고 나서 잰다.** 안 그러면 첫 케이스가 경합으로 빨개지고, 그걸
# 엔진 사실로 읽게 된다 — e2e 에서 이미 한 번 당했다.
for _ in $(seq 1 40); do
  if docker exec "$NAME" sh -c "echo > /dev/tcp/127.0.0.1/$PORT" 2>/dev/null; then break; fi
  sleep 0.25
done
if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  echo "  엔진이 죽었다:"; docker logs "$NAME" 2>&1 | tail -20; exit 1
fi

R="$(node "$HERE/probe.mjs" "$PORT" 127.0.0.1)" || { echo "  프로브 실패"; exit 1; }
echo "$R" | sed 's/^/    /'
echo ""

v() { printf '%s' "$R" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const o = JSON.parse(s)[process.argv[1]];
    process.stdout.write(o === undefined ? "?" : String(o.verdict));
  });' "$1"; }
ms() { printf '%s' "$R" | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    const o = JSON.parse(s)[process.argv[1]];
    process.stdout.write(o === undefined ? "0" : String(o.ms));
  });' "$1"; }

plain=$(v plain); sni=$(v sni)
noext=$(v no_sni_no_ext); emptyext=$(v no_sni_empty_ext)
mal=$(v malformed); trunc=$(v truncated_hold); silent=$(v silent_hold)

# ── S9.1 비-TLS (E26.1 재확인, 이번엔 완결 경로로) ──────────────────────
[ "$plain" = NON_TLS ] \
  && ok S9.1 "비-TLS 는 \$ssl_preread_protocol 이 비어 별도 분기로 간다" \
  || bad S9.1 "비-TLS 분기 실패: '$plain'"

# ── S9.2 SNI 있음 ───────────────────────────────────────────────────────
[ "$sni" = TLS_SNI ] \
  && ok S9.2 "SNI 가 있으면 이름으로 간다" \
  || bad S9.2 "SNI 분기 실패: '$sni'"

# ── S9.3 **E26.2 가 남긴 일** — TLS 인데 SNI 가 없다 ────────────────────
#
# 확장 블록이 아예 없는 것과, 확장 목록은 있는데 SNI 만 없는 것을 **따로** 잰다.
# 실물에서 흔한 쪽은 후자다.
if [ "$noext" = TLS_NO_SNI ] && [ "$emptyext" = TLS_NO_SNI ]; then
  ok S9.3 "TLS-no-SNI 를 비-TLS 와 **가를 수 있다** (E26.2 해소, 확장 유무 둘 다)"
elif [ "$noext" = TLS_NO_SNI ] || [ "$emptyext" = TLS_NO_SNI ]; then
  bad S9.3 "확장 형태에 따라 갈린다 — no_ext='$noext' empty_ext='$emptyext'"
else
  bad S9.3 "TLS-no-SNI 를 못 가른다: no_ext='$noext' empty_ext='$emptyext'"
fi

# ── S9.4 malformed ──────────────────────────────────────────────────────
#
# 여기가 3분기의 핵심이다. malformed 가 TLS-no-SNI 와 **같은 곳으로 가면**
# 3분기는 불가능하고, §4.1 의 `reject` 고정이 유지된다.
if [ "$mal" = TLS_NO_SNI ]; then
  bad S9.4 "malformed 가 TLS-no-SNI 와 같은 분기로 간다 — 3분기 불가"
elif [ "$mal" = "$plain" ]; then
  skip S9.4 "malformed 가 비-TLS 와 같은 분기다('$mal') — no-SNI 와는 갈리지만 별도 분기는 아니다"
else
  ok S9.4 "malformed 가 자기 결과를 낸다: '$mal'"
fi

# ── S9.5 preread timeout ────────────────────────────────────────────────
#
# `preread_timeout 2s` 다. 2초 부근에서 끝나면 그 경로를 탄 것이고, 즉시 끝나면
# 다른 이유로 끝난 것이다 — 그 둘을 시간으로 가른다.
t_silent=$(ms silent_hold); t_trunc=$(ms truncated_hold)
if [ "$silent" != "$noext" ] && [ "$silent" != TLS_SNI ] && [ "${t_silent:-0}" -ge 1500 ]; then
  ok S9.5 "preread timeout 이 TLS-no-SNI 와 다른 결과다: '$silent' (${t_silent}ms)"
elif [ "$silent" = "$noext" ]; then
  bad S9.5 "timeout 이 TLS-no-SNI 와 같은 분기로 간다 — 3분기 불가"
else
  bad S9.5 "timeout 결과가 예상 밖: '$silent' (${t_silent}ms)"
fi
printf "  ----  %-22s %s\n" "truncated_hold" "'$trunc' (${t_trunc}ms) — TLS 처럼 시작하고 멈춘 경우"

# ── S9.6 판정: 3분기가 되는가 ───────────────────────────────────────────
#
# 세 값이 **서로 다르면** 관측 가능하다. 하나라도 겹치면 §4.1 이 `on_no_sni` 를
# 설정 가능으로 승격할 수 없다 — 승격해 봐야 사용자가 고른 분기가 다른 원인에도
# 걸리기 때문이다. 그게 §12.0 의 "구분 가능 여부" 가 묻는 것 전부다.
echo ""
if [ "$noext" != "$mal" ] && [ "$noext" != "$silent" ] && [ "$mal" != "$silent" ]; then
  ok S9.6 "3분기 관측 **가능** — no_sni='$noext' malformed='$mal' timeout='$silent'"
else
  bad S9.6 "3분기 관측 불가 — no_sni='$noext' malformed='$mal' timeout='$silent'"
fi

echo ""
echo "  PASS=$PASS FAIL=$FAIL SKIP=$SKIP"
[ "$FAIL" -eq 0 ]
