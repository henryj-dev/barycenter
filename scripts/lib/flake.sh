# shellcheck shell=sh
#
# **게이트가 자기 흔들림을 센다** — 검수 2026-08-24 W4-9
#
# ── 왜 필요한가
#
# 한 회차에 게이트가 **우리 코드와 무관하게 빨간 적이 셋**이었다:
#
#   골든 `ciphers`        파일 병렬로 부하가 몰려 TLS 협상이 늦었다
#   스파이크 S18          Pebble 의 nonce 20% 거부 × 요청 수백 개
#   `store` config-store  PG 컨테이너 `read ECONNRESET`
#
# 셋 다 **단독으로 다시 돌리면 초록**이었다. 앞의 둘은 원인을 찾아 없앴지만, 그 사실
# 자체 — 「이 스위트가 흔들렸다」 — 는 **어디에도 안 남았다.** 그래서 다음 사람은
# 「가끔 깨진다」를 인상으로만 알고, 인상은 회차를 가로질러 안 쌓인다.
#
# ── 「흔들림」인지 아는 순간은 그때뿐이다
#
# 같은 컨테이너·같은 부하에서 **바로** 다시 돌려야 알 수 있다. 하루 뒤에는 아무도 재현
# 못 한다. 그래서 기록만 하는 길(재실행 없이 빨간 것만 적기)은 값이 거의 없다 — 이미
# 화면에 보이는 것을 파일로 옮길 뿐, flake 인지 진짜인지 못 가른다.
#
# ── ⚠️ 그런데 재실행은 위험한 도구다
#
# 이 저장소가 적어 뒀다: *"단독으로 돌리면 초록이라 원인을 찾기 전에 「가끔 깨진다」로
# 넘어가기 쉽다"*, *"간헐적으로 깨지는 게이트는 없느니만 못하다"*.
#
# **그래서 재실행이 판정을 안 바꾼다.** 두 번째가 초록이어도 그 스위트는 여전히 실패로
# 세고 게이트의 exit 코드는 빨갛다. 재실행이 사는 이유는 **「흔들렸다」를 「깨졌다」와
# 구분해서 적기 위해서**이지 통과시키기 위해서가 아니다.
#
# 자동 재시도로 초록을 만드는 길은 **일부러 안 만들었다.** 그 길이 있으면 언젠가 쓰인다 —
# 이 저장소가 `rejectUnauthorized` 를 끄는 옵션을 안 만든 것과 같은 판단이다
# (*"옵션으로 두면 「개발 중이라」로 켜지고 그대로 배포된다"*).

# 흔들림 장부. 회차를 가로질러 쌓여야 세는 뜻이 있다.
: "${BARY_FLAKE_LOG:=.flakes.jsonl}"

# `bary_run_twice <command...>`
#
# 돌린다. 실패하면 **한 번만** 더 돌린다.
#
# 결과를 전역으로 낸다 — POSIX sh 에는 여러 값을 돌려주는 길이 없고, 여기서 필요한
# 것은 출력·종료코드·흔들림 셋이다.
#
#   BARY_RUN_OUT    진단에 쓸 출력. **실패한 실행의 것**이다 — 초록인 두 번째 출력에는
#                   원인이 없다
#   BARY_RUN_RC     최종 종료 코드. 흔들림이어도 **0 이 아니다**
#   BARY_RUN_FLAKE  1 이면 두 번째가 초록이었다
bary_run_twice() {
  BARY_RUN_FLAKE=0
  BARY_RUN_OUT=$("$@" 2>&1)
  BARY_RUN_RC=$?
  [ "$BARY_RUN_RC" -eq 0 ] && return 0

  # 첫 출력을 지킨다. 아래 재실행이 초록이면 그 출력에는 아무 단서가 없다.
  _bary_first_out=$BARY_RUN_OUT
  _bary_second_out=$("$@" 2>&1)
  _bary_second_rc=$?

  if [ "$_bary_second_rc" -eq 0 ]; then
    # **흔들렸다.** 판정은 안 바꾼다 — `BARY_RUN_RC` 를 그대로 둔다.
    BARY_RUN_FLAKE=1
    BARY_RUN_OUT=$_bary_first_out
  else
    # 두 번 다 빨갛다. **두 번째 출력을 쓴다** — 더 최근이고, 두 실행이 다른 이유로
    # 죽었다면 그 차이 자체가 단서다.
    BARY_RUN_OUT=$_bary_second_out
    BARY_RUN_RC=$_bary_second_rc
  fi
  return 0
}

# `bary_record_flake <label> <seconds>`
#
# 장부에 한 줄 적는다. **JSON Lines** 라 나중에 세는 것이 `grep | wc` 로 된다 —
# 세는 도구를 따로 만들지 않으려는 선택이다.
#
# 시각은 UTC ISO8601 이다. 회차 간 비교가 이 값으로 서므로 지역시로 적으면 안 된다.
bary_record_flake() {
  _bary_label=$(printf '%s' "$1" | sed 's/[[:space:]]*$//')
  printf '{"at":"%s","suite":"%s","seconds":%s}\n' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$_bary_label" "$2" >> "$BARY_FLAKE_LOG"
}
