# 런북 — 알림 (웹훅 · Slack · 메일)

운영자가 봐야 할 사건을 바깥으로 보낸다. **설정이 없으면 꺼져 있다(지금과 같다).** 알림은 부가 기능이다 —
보내기가 실패하거나 느려도 적용 · 발급은 멈추지 않는다.

## 사건

| 종류(`kind`) | 언제 | 누가 낸다 | 사건 키 |
|---|---|---|---|
| `acme.failed` | ACME 발급 · 갱신 주문이 실패했다(백오프 뒤 다시 한다). 포기(`abandoned`)는 critical | 리더 | 주문 + 상태 |
| `cert.expiring` | 인증서 만료가 `BARY_NOTIFY_CERT_DAYS` 일 안이다. 3일 안 · 만료는 critical | 리더 | 인증서 + 만료 시각(갱신되면 새 사건) |
| `apply.failed` | head 의 마지막 적용이 실패로 끝났다 | 리더 | plan |
| `transition.incomplete` | 시작했지만 끝나지 않은 전환이 2주기(기본 2분) 넘게 같은 것으로 남았다 | 리더 | 오퍼레이션 |
| `leader.changed` | 이 노드가 리더가 됐다(info) · 잃었다(warning). 기동 때 처음 잡은 것은 사건이 아니다 | 모든 노드 | 됐다/잃었다 |
| `region.unreachable` | 전역 화면이 한 지역에 2주기 넘게 닿지 못한다(인증 거절 포함). 다시 닿으면 키를 잊는다 | 전역 화면이 켜진 리더 | 지역 |
| `backup.failed` | **지금은 아무도 내지 않는다** — 데몬 안에 백업 작업이 없다(백업은 `bary backup` · `GET /api/v1/backup` 을 바깥에서 부른다). 형식만 정해 두었다 | — | — |

**같은 사건 키는 `BARY_NOTIFY_REPEAT_S`(기본 6시간) 안에 다시 보내지 않는다.** 문제가 계속되면 그 간격마다 한 번씩
다시 온다(인증서 만료 임박은 6시간마다 다시 알린다).

## 설정

비밀은 **파일로만** 받는다(`chmod 600`, 데몬 사용자만). 기동 때 한 번 읽는다 — 바꾸면 다시 띄운다.

| 변수 | 뜻 |
|---|---|
| `BARY_NOTIFY` | 통로 목록, 쉼표로: `webhook` · `slack` · `mail` (예: `webhook,slack`) |
| `BARY_NOTIFY_WEBHOOK_URL` | 웹훅 주소(**https**) |
| `BARY_NOTIFY_WEBHOOK_SECRET_FILE` | 서명 비밀 파일(HMAC-SHA256). 무작위 32바이트 이상: `openssl rand -hex 32` |
| `BARY_NOTIFY_SLACK_URL_FILE` | Slack incoming webhook URL 을 담은 파일 — URL 자체가 비밀이다 |
| `BARY_NOTIFY_MAIL_TO` | 받는 주소(쉼표, 20개까지). 전송은 계정 메일과 같은 `BARY_MAIL_KIND` · `BARY_MAIL_FROM` …(`runbook-accounts.md` 「메일」) |
| `BARY_NOTIFY_REPEAT_S` | 같은 사건 재알림 간격(초). 기본 21600 |
| `BARY_NOTIFY_CERT_DAYS` | 만료 며칠 전부터 알리나. 기본 14 |
| `BARY_NOTIFY_INTERVAL_S` | 상태를 보는 주기(초). 기본 60. 미완 전환 · 지역 끊김의 유예는 이것의 2배 |
| `BARY_NOTIFY_QUEUE` | 보내기를 기다리는 큐 상한. 기본 100. 넘으면 가장 오래된 것을 버린다 |

**반만 설정하면 기동을 거부한다** — 통로를 안 골랐는데 알림 변수가 있다 · 고른 통로에 필요한 값이 없다 · 고르지 않은
통로의 변수가 있다 · 주소가 https 가 아니다 · 비밀 파일이 없거나 비었다 · `mail` 인데 메일 전송 설정이 없다 · 모르는
통로 이름. 기동 로그 `notify.enabled {notifiers, certDays}` 로 켜진 것을 확인한다.

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

- **켠 뒤 확인** — 시험 사건을 내는 명령은 없다. 스테이징에서 `BARY_NOTIFY_CERT_DAYS=365` 로 잠깐 띄우면 인증서마다
  `cert.expiring` 이 한 번 온다(1분 안). 확인한 뒤 되돌린다.
- **비밀 교체** — 받는 쪽이 옛 비밀 · 새 비밀을 둘 다 받게 한 뒤, 파일을 바꾸고 데몬을 다시 띄우고, 옛 비밀을 지운다.
- **알림이 너무 많다** — `BARY_NOTIFY_REPEAT_S` 를 늘린다. 같은 사건이 키만 달라 반복되면(예: 주문이 계속 새로 열린다)
  원인 쪽을 고친다.
- **노드가 여럿** — 리더 교체 말고는 리더만 낸다. 리더가 바뀌면 새 리더의 중복 억제 표는 비어 있으므로 계속되는 사건이
  한 번 더 올 수 있다.
