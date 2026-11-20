# 런북 — 알림 (웹훅 · Slack · 메일)

운영자가 봐야 할 사건을 바깥으로 보낸다. **켜진 통로가 없으면 꺼져 있다.** 알림은 부가 기능이다 —
보내기가 실패하거나 느려도 적용 · 발급은 멈추지 않는다.

## 사건

| 종류(`kind`) | 언제 | 누가 낸다 | 사건 키 |
|---|---|---|---|
| `acme.failed` | ACME 발급 · 갱신 주문이 실패했다(백오프 뒤 다시 한다). 포기(`abandoned`)는 critical | 리더 | 주문 + 상태 |
| `cert.expiring` | 인증서 만료가 「만료 임박 기준」(기본 14) 일 안이다. 3일 안 · 만료는 critical | 리더 | 인증서 + 만료 시각(갱신되면 새 사건) |
| `apply.failed` | head 의 마지막 적용이 실패로 끝났다 | 리더 | plan |
| `transition.incomplete` | 시작했지만 끝나지 않은 전환이 2주기(기본 2분) 넘게 같은 것으로 남았다 | 리더 | 오퍼레이션 |
| `leader.changed` | 이 노드가 리더가 됐다(info) · 잃었다(warning). 기동 때 처음 잡은 것은 사건이 아니다 | 모든 노드 | 됐다/잃었다 |
| `region.unreachable` | 전역 화면이 한 지역에 2주기 넘게 닿지 못한다(인증 거절 포함). 다시 닿으면 키를 잊는다 | 전역 화면이 켜진 리더 | 지역 |
| `backup.failed` | **지금은 아무도 내지 않는다** — 데몬 안에 백업 작업이 없다(백업은 `bary backup` · `GET /api/v1/backup` 을 바깥에서 부른다). 형식만 정해 두었다 | — | — |

**같은 사건 키는 재알림 간격(기본 6시간) 안에 다시 보내지 않는다.** 문제가 계속되면 그 간격마다 한 번씩
다시 온다(인증서 만료 임박은 6시간마다 다시 알린다).

## 설정 — 화면이 정본이다 (2026-11-20)

**설정은 설정 DB 에 있다**(`notify_settings` · `notify_channels`, 마이그레이션 036). 화면 **관리 › 알림**에서 고친다.
저장하면 곧바로 쓰인다 — 데몬을 다시 띄우지 않는다. 다른 노드는 30초 안에 따라온다(`version` 을 본다).

- **통로** — 이름이 있는 행이다. 종류(`webhook` · `slack` · `mail`) · 켜짐 · 받을 사건 종류(없으면 전부) · 최소 심각도
  (`info` · `warning` · `critical`) · 대상(웹훅 URL · 받는 메일 주소). 같은 종류를 여럿 둘 수 있다(예: `ops-slack` · `dev-slack`).
- **비밀** — 웹훅 서명 비밀과 Slack 웹훅 URL 은 **시크릿 저장소**에 둔다(`opaque://notify.<통로>@<버전>`, 035). `pg` 저장소면
  KEK 로 감싼다. 화면 · API 는 넣기만 하고 다시 보이지 않는다(`secretSet: true`). 비밀을 바꾸면 옛 버전을 지운다.
  비밀을 바꾸거나 통로를 지울 때 사람 세션이면 MFA 를 다시 묻는다.
- **공통 값** — 재알림 간격 · 만료 임박 기준 · 상태 보기 주기 · 큐 상한. 범위는 아래 표와 같다.
- **메일** — 전송은 계정 메일과 같은 `BARY_MAIL_*` 설정을 쓴다(환경 변수 그대로). 없으면 메일 통로는 「못 보냄」 으로 보인다.
- **지역마다 따로다.** 전역 화면은 이 설정을 중계하지 않는다 — 비밀이 전역을 지나지 않게. 지역 GUI 에서 고친다.
- **권한** — 전부 `admin` 이다. CLI 는 읽기만: `bary get notify` · `bary get notify/deliveries`.

### 첫 기동 — 환경 변수를 옮긴다

DB 에 설정 행이 **없으면** 데몬이 아래 환경 변수를 한 번 옮겨 넣는다(통로 이름은 종류와 같다: `webhook` · `slack` · `mail`).
그 뒤로는 **DB 가 이긴다** — 환경 변수를 바꿔도 반영되지 않고, 다르면 기동 로그에 `notify.env_ignored` 가 남는다.
환경 변수가 없으면 기본 공통 값과 빈 통로 목록으로 만든다. 업그레이드도 같다 — 이미 쓰던 설정이 그대로 옮겨진다.

비밀 파일은 옮긴 뒤에는 읽지 않는다. 지워도 된다(그 전에 화면에서 시험 전송으로 확인한다).

| 변수 | 뜻 |
|---|---|
| `BARY_NOTIFY` | 통로 목록, 쉼표로: `webhook` · `slack` · `mail` (예: `webhook,slack`) |
| `BARY_NOTIFY_WEBHOOK_URL` | 웹훅 주소(**https**) |
| `BARY_NOTIFY_WEBHOOK_SECRET_FILE` | 서명 비밀 파일(HMAC-SHA256). 무작위 32바이트 이상: `openssl rand -hex 32` |
| `BARY_NOTIFY_SLACK_URL_FILE` | Slack incoming webhook URL 을 담은 파일 — URL 자체가 비밀이다 |
| `BARY_NOTIFY_MAIL_TO` | 받는 주소(쉼표, 20개까지) |
| `BARY_NOTIFY_REPEAT_S` | 같은 사건 재알림 간격(초). 기본 21600, 60~2592000 |
| `BARY_NOTIFY_CERT_DAYS` | 만료 며칠 전부터 알리나. 기본 14, 1~365 |
| `BARY_NOTIFY_INTERVAL_S` | 상태를 보는 주기(초). 기본 60, 5~86400. 미완 전환 · 지역 끊김의 유예는 이것의 2배 |
| `BARY_NOTIFY_QUEUE` | 보내기를 기다리는 큐 상한. 기본 100, 1~10000. 넘으면 가장 오래된 것을 버린다 |
| `BARY_NOTIFY_DELIVERY_RETENTION_DAYS` | 보낸 기록을 며칠 남기나. 기본 30. **첫 기동만이 아니라 언제나** 환경 변수다 |

**첫 기동에 반만 설정하면 기동을 거부한다**(전과 같다) — 통로를 안 골랐는데 알림 변수가 있다 · 고른 통로에 필요한 값이
없다 · 고르지 않은 통로의 변수가 있다 · 주소가 https 가 아니다 · 비밀 파일이 없거나 비었다 · `mail` 인데 메일 전송
설정이 없다 · 모르는 통로 이름. 기동 로그 `notify.seeded {from, channels}` · `notify.configured {version, channels}` 로 확인한다.

### 보낸 기록

화면의 「보낸 기록」 · `GET /api/v1/notify/deliveries` 가 보낸 결과 · 시험 전송 · 큐에서 버린 것을 보인다. 사유 문장에 비밀
값이 섞이면 `***` 로 가린다. **되풀이로 거른 것은 남기지 않는다** — 상태 보기가 1분마다 같은 사건을 다시 내므로, 남기면
기록이 그것으로 찬다(계측 `bary_notify_total{outcome="suppressed"}` 에는 남는다). 오래된 기록은 DB 보존이 지운다(기본 30일).

## 웹훅 형식 · 서명 확인

`POST <BARY_NOTIFY_WEBHOOK_URL>`, `content-type: application/json`:

```json
{"version":1,"kind":"apply.failed","severity":"critical","key":"apply.failed:<plan>",
 "title":"리비전 r42 적용이 실패했다","detail":"…","facts":{"revision":"r42","plan":"…"},
 "at":"2026-11-05T01:00:00.000Z","node":"bary-1"}
```

머리글:

- `x-barycenter-event: <kind>`
- `x-barycenter-signature: t=<유닉스초>,v1=<hex>` — `hex = HMAC-SHA256(비밀, "<t>.<본문 바이트 그대로>")`

받는 쪽은 **본문을 해석하기 전에** 같은 값을 계산해 상수시간으로 비교하고, `t` 가 5분보다 오래됐으면 버린다(재전송 방지).
리다이렉트는 따라가지 않는다(3xx 는 실패다). 2xx 면 성공이다.

## 실패의 뜻

보내기가 실패하면 **로그 · 계측만** 남긴다. 다시 보내지 않는다(사건이 계속되면 재알림 간격 뒤에 다시 온다).

- 로그 `notify.send_failed {notifier, kind, key, reason, detail}`
- 계측 `bary_notify_total{notifier,outcome}` — `outcome` 은 `sent` 또는 아래 사유. `bary_notify_total{outcome="suppressed"}` 는
  되풀이로 거른 것, `{outcome="dropped"}` 는 큐가 넘쳐 버린 것(로그 `notify.queue_overflow`)
- 상태 출처를 못 읽었으면 `notify.watch.source_failed {source, error}` — 그 출처만 건너뛰고 나머지는 본다

| 사유 | 뜻 | 할 일 |
|---|---|---|
| `auth` | 받는 쪽이 거절했다(401 · 403). Slack 은 404 · 410(웹훅이 지워졌다)도 여기 | 웹훅 비밀 · Slack URL 을 새로 만든다 |
| `rejected` | 형식 · 정책 거절(그 밖의 4xx) | 받는 쪽 로그를 본다 |
| `rate-limited` | 429 | 재알림 간격을 늘린다 |
| `unavailable` | 닿지 못했다 · 5xx · 타임아웃(10초) · 답이 너무 크다 · 메일 일부 실패 | 받는 쪽 상태를 본다 |
| `insecure` | https 가 아니다 | 기동에서 이미 막힌다 |

## 운영 절차

- **켠 뒤 확인** — 화면의 통로 줄에서 「시험 전송」 을 누른다(`POST /api/v1/notify/channels/<이름>/test`). 꺼진 통로에도
  보낸다 — 켜기 전에 확인하는 자리다. 사건 종류는 `notify.test` 이고 받을 사건 거르기를 지나지 않는다.
- **비밀 교체** — 받는 쪽이 옛 비밀 · 새 비밀을 둘 다 받게 한 뒤, 화면에서 새 비밀을 넣고 저장하고(곧바로 쓰인다),
  시험 전송으로 확인하고, 받는 쪽에서 옛 비밀을 지운다.
- **알림이 너무 많다** — 화면의 재알림 간격을 늘리거나, 통로의 받을 사건 · 최소 심각도를 좁힌다. 같은 사건이 키만 달라 반복되면(예: 주문이 계속 새로 열린다)
  원인 쪽을 고친다.
- **노드가 여럿** — 리더 교체 말고는 리더만 낸다. 리더가 바뀌면 새 리더의 중복 억제 표는 비어 있으므로 계속되는 사건이
  한 번 더 올 수 있다.
