# 검수 — `deploy/install.sh` (2026-08-29, 둘째 회차)

`deploy/install.sh` 는 지난 전수 점검(`39fe68b`) 이후 들어온 **1051 줄짜리 새 코드**이고,
한 번도 적대적으로 읽히지 않았다. §11.3 의 **v1 권장 배포 경로**라 권한·비밀·초기화
시스템이 전부 여기에 걸려 있다.

- **범위** — `deploy/install.sh` 전량. 곁가지로 `tests/install/run.sh` 의 게이트 편입 여부
- **기준선** — `51ef84e` (origin/main)
- **집계** — Medium 3 · Low 2

> 다섯 중 셋이 **"도는 것을 보면 안 보이는" 부류**다. 설치 하네스는 다섯 배포판에서
> 서비스가 실제로 서는 것을 확인하는데, A 는 유닛이 뜨고 서비스도 살기 때문에, B 는
> 경합이기 때문에, C 는 성공 경로가 아니기 때문에 **전부 초록인 채로 지나간다.**
> 이 회차의 값은 대부분 거기에 있다.

---

## A. [Medium] 재시도 상한 해제가 systemd 에 안 먹었다

유닛의 `[Service]` 섹션에 이렇게 있었다:

```ini
[Service]
Restart=on-failure
RestartSec=5
# **재시도 상한을 끈다.** 기본값(10초에 5번)이면 PG 가 늦게 뜨는 부팅에서 다섯 번
# 만에 포기하고 failed 로 남는다 — 트래픽은 흐르는데 제어가 없는 그 상태다.
StartLimitIntervalSec=0
```

**`StartLimitIntervalSec` 은 `[Unit]` 옵션이다.** `[Service]` 에 두면 systemd 가 버린다.
주장이 아니라 실측이다:

```
$ systemd-analyze verify /probe/probe.service      # [Service] 에 둔 판
/probe/probe.service:9: Unknown key 'StartLimitIntervalSec' in section [Service], ignoring.

$ systemd-analyze verify /probe/fixed.service      # [Unit] 로 옮긴 판
(경고 없음)
```

(debian:12 컨테이너의 systemd 252. 두 유닛의 차이는 그 한 줄의 섹션뿐이다.)

그래서 **주석이 막았다고 적은 실패가 그대로 산다** — PG 가 늦게 뜨는 부팅에서 데몬이
DSN 에서 죽고, 기본 상한(10초에 5번)에 걸려 `failed` 로 남는다. 유닛 자신이 `After=` 에서
`systemd-networkd-wait-online` 을 안 기다리기로 하고 *"네트워크가 늦으면 데몬이 DSN 에서
죽고 아래 Restart= 가 다시 세운다 — 그쪽이 기다림보다 낫다"* 고 적었으므로, **이 상한
해제는 그 결정의 전제**다. 전제가 없는 채로 결정만 서 있었다.

**설치 하네스가 못 잡는다.** 유닛은 정상적으로 뜨고 서비스도 산다 — 무시된 키는
`journalctl` 에 경고 한 줄을 남길 뿐이고, 하네스는 `/readyz` 와 `bary status` 를 본다.

**고쳤다.** `[Unit]` 로 옮겼다.

## B. [Medium] 비밀이 든 파일이 잠깐 넓게 열린 채로 태어난다

```sh
printf '...' > "$TOKENS_FILE"     # ← umask 로 만들어진다
chown root:"$SVC_USER" "$TOKENS_FILE"
chmod 0640 "$TOKENS_FILE"         # ← 이미 열린 뒤다
```

스크립트 어디에도 `umask` 가 없다. sudo 의 기본값은 보통 022 라 파일은 **0644 로
태어나고**, `$PREFIX` 가 0755(`install -d -m 0755`)라 그 순간 **로컬의 아무 유저나 읽는다.**
뒤따르는 `chmod` 는 창을 닫지만 이미 열린 fd 는 못 닫는다.

안에 든 것:

| 파일 | 내용 |
|---|---|
| `$PREFIX/tokens.json` | ops 토큰 해시 |
| `$PREFIX/env` | `BARY_DSN` — **외부 PG 를 쓰면 비밀번호가 든다** |
| 〃 | `--env` 로 넣은 값 전부 — **`pg` 시크릿 백엔드면 `BARY_SECRET_KEK`** (§4.8.1) |

마지막 줄이 이 발견의 무게를 바꾼다. KEK 는 어제 회차가 *"덤프와 다른 곳에 둔다"* 고
런북에 적은 그 값이고, 여기서 잠깐이지만 world-readable 한 파일에 들어간다.

**고쳤다.** 두 쓰기를 `(umask 077; ...)` 서브셸로 감쌌다. 서브셸인 것은 이 블록 밖의
umask 를 안 건드리기 위해서다 — 유닛 파일까지 0600 이 되면 그건 다른 문제를 만든다.

## C. [Low] 가드의 오류 경로 자체가 깨져 있었다

`env_line` 은 값에 작은따옴표가 있으면 안내와 함께 죽는다. 그 안내가 `$ENV_FILE` 을
넣는데, **이 함수는 인자 파싱 중에 `extra_env_add` 를 거쳐 불린다** — `ENV_FILE` 은
⑩ 에서야 정해진다. `set -eu` 라 안내 대신 셸 오류가 난다:

```
$ sh deploy/install.sh --env "BARY_X=a'b"
deploy/install.sh: line 101: ENV_FILE: unbound variable
```

막는 것은 막았지만 **왜 막혔는지를 안 말한다.** 그리고 이 안내는 *"설치 뒤 $ENV_FILE 을
직접 고친다"* 라는 우회로를 알려 주는 유일한 자리였다.

**고쳤다.** `ENV_FILE` 을 기본값과 함께 위에서 정하고, `--prefix` 가 바뀔 수 있으므로
⑩ 에서 다시 정한다.

## D. [Medium] 설치 하네스가 게이트에도 CI 에도 없다

`tests/install/run.sh` 는 다섯 배포판의 실물 컨테이너에서 설치·기동·재기동·비-root
nginx·특권 포트 apply 까지 본다. **그런데 아무것도 그것을 부르지 않는다:**

```
$ grep -n install scripts/verify.sh          # 없음
$ grep -rn "test:install" .github/workflows/ # 없음
```

`package.json` 의 `test:install` 뿐이고, 그건 사람이 기억해야 도는 것이다. 이 저장소가
CI 에 대해 세운 규칙 — *"CI 는 `scripts/verify.sh` 를 그대로 돌린다. 갈라지면 어느 쪽이
계약인지 아무도 모른다"* — 의 반대쪽 구멍이다: **계약에 아예 안 들어간 하네스.**

정직하게 적어 둔다: **이 회차의 A·B·C 는 그 하네스가 돌았어도 못 잡았다**(A 는 서비스가
살고, B 는 경합이고, C 는 성공 경로가 아니다). 문제는 다른 데 있다 — 설치 스크립트를
고치면 **happy path 회귀조차 자동으로는 안 잡힌다.** 이번 수정도 그래서 손으로 돌려야 했다.

### 그리고 그 손이 실제로 필요했다

B 를 고치면서 **다섯 판 전부를 죽이는 회귀를 냈다.** 하네스가 잡았다:

```
FAIL debian · FAIL ubuntu · FAIL rocky · FAIL amazon · FAIL alpine
   — 전부 "== ⑩ 설정" 에서 멈췄다
```

원인은 `set -e` 의 AND-OR 면제다. env 블록의 마지막 명령이
`[ -n "$EXTRA_ENV" ] && printf ...` 인데, `EXTRA_ENV` 가 비면 이 리스트가 **상태 1** 로
끝난다. 브레이스 그룹일 때는 POSIX 의 *"AND-OR 리스트의 마지막이 아닌 명령에는 -e 를
적용하지 않는다"* 가 걸려 안 죽었는데, **서브셸로 감싸는 순간 부모가 보기엔 실패한 명령
하나**가 되어 거기서 죽는다. `if` 로 바꿨다.

이 사건이 D 의 근거를 바꾼다. 원래는 *"하네스가 있는데 안 돈다"* 였다. 이제는 **실측이
붙는다** — 이 회차의 수정이 다섯 판을 전부 깨뜨렸고, 게이트는 초록이었고
(`tests/unit/install-script.test.ts` 는 텍스트만 읽으므로 통과했다), 잡은 것은
**사람이 기억해서 손으로 돌린 하네스**였다. 다음 사람이 그것을 기억 못 하면 이 회귀는
그대로 나간다.

### 결정 (2026-08-29, 사람)

**`deploy/` 가 바뀔 때만 PR 에서 돌린다.** `verify.yml` 의 `install` 잡이 기준과 비교해
`deploy/` · `tests/install/` · **그 워크플로 자신**이 바뀌었을 때만 다섯 판을 돈다.

셋 중 하나를 고른 것이다:

| 후보 | 왜 아닌가 |
|---|---|
| 모든 PR | 다섯 컨테이너가 임계 경로를 크게 늘린다 — #15 가 873초를 254초로 줄인 직후다 |
| nightly | *"머지 뒤에 안다"* 가 된다. 이 회차의 회귀가 정확히 머지 앞에서 잡혀야 했던 것이다 |
| **바뀔 때만** | 늘어나는 것은 `deploy/` 를 만지는 PR 뿐이고, 그때는 재는 것이 값이다 |

워크플로 자신을 경로에 넣는 이유는 순환을 끊기 위해서다 — 이 잡을 고치는 PR 이 이 잡을
안 돌리면 고친 것이 도는지 알 수 없다.

## E. [Low] 재설치가 `env` 를 조용히 덮는다

`$PREFIX/env` 는 매 실행 무조건 다시 쓰인다. 그런데 C 의 안내가 *"설치 뒤 $ENV_FILE 을
직접 고친다"* 라고 말한다 — **스크립트가 권한 우회로를 알려 주고, 다음 실행이 그것을
말없이 지운다.** 토큰도 매번 새로 나므로 옛 토큰을 쓰던 자동화가 조용히 끊긴다(새 토큰은
화면에 나오므로 사람은 안다).

`tests/install/run.sh` 는 한 배포판에서 `--dsn` 재설치를 재지만, 그건 *"다시 서는가"* 이지
*"무엇을 잃는가"* 가 아니다.

**안 고친다 — 경고만 더한다.** 보존하는 쪽이 더 나쁘다: 옛 파일에 남은 관리 키와 새로
계산한 값이 섞이면 어느 쪽이 이기는지가 형식마다 달라진다(스크립트가 `MANAGED_ENV_KEYS`
로 막으려던 바로 그 상태). **덮되 덮는다고 말한다.**

---

## 이 회차가 표면을 안 건드렸나

건드리지 않았다 — `src/` 를 한 줄도 안 고쳤다(`deploy/` 와 `tests/` 뿐). 표면 A 도
DDL B 도 그대로다.

`node scripts/surface.mjs --round` 로 **동결 카운터를 1 → 2** 로 올린다.
