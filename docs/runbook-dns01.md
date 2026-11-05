# 런북 — dns-01 공급자 (와일드카드 인증서)

와일드카드(`*.example.com`) 인증서는 dns-01 로만 받는다. barycenter 가 `_acme-challenge.<도메인>` TXT 를 놓고,
CA 가 그것을 본 뒤 치운다. 어느 DNS 에 놓을지는 `BARY_DNS01_KIND` 로 고른다.

**설정이 없으면 지금과 같다.** `BARY_DNS01_KIND` 가 없고 `BARY_DNS01_DIR` 이 있으면 `file`, 둘 다 없으면 dns-01 이
꺼진다(와일드카드 주문은 「dns-01 프로바이더가 없다」 로 실패한다).

## 설정

비밀은 **파일로만** 받는다(`*_FILE`). 파일은 데몬 사용자만 읽게 둔다(`chmod 600`). 값은 기동 때 한 번 읽는다 —
바꾸면 데몬을 다시 띄운다.

| 변수 | 종류 | 뜻 |
|---|---|---|
| `BARY_DNS01_KIND` | 공통 | `file` · `cloudflare` · `powerdns` · `route53` · `rfc2136` |
| `BARY_DNS01_DIR` | file | TXT 값을 쓸 디렉터리(`_acme-challenge.<도메인>` 파일). 실제 DNS 반영은 운영자 몫 |
| `BARY_DNS01_ZONE` | cloudflare · powerdns · rfc2136 (선택), route53 (필수) | 영역. cloudflare 는 id(32자 hex) 또는 이름, route53 은 호스팅 영역 id(`Z…`). 안 주면 TXT 이름의 위쪽 이름을 차례로 찾는다 |
| `BARY_DNS01_CLOUDFLARE_TOKEN_FILE` | cloudflare | API 토큰 파일. 권한은 그 영역의 「Zone · DNS · Edit」 (+ 이름으로 찾으면 「Zone · Zone · Read」) |
| `BARY_DNS01_POWERDNS_URL` | powerdns | API 주소(**https**), 예: `https://pdns.internal:8081` |
| `BARY_DNS01_POWERDNS_API_KEY_FILE` | powerdns | `X-API-Key` 값 파일 |
| `BARY_DNS01_POWERDNS_SERVER` | powerdns | 서버 id. 기본 `localhost` |
| `BARY_DNS01_AWS_ACCESS_KEY_ID` | route53 | 접근 키 id(비밀이 아니다) |
| `BARY_DNS01_AWS_SECRET_ACCESS_KEY_FILE` | route53 | 비밀 접근 키 파일. IAM 권한은 `route53:ListResourceRecordSets` · `route53:ChangeResourceRecordSets` (그 영역만) |
| `BARY_DNS01_RFC2136_SERVER` | rfc2136 | 이름서버 — `ns1.example.com` · `192.0.2.1` · `[2001:db8::1]:5353` |
| `BARY_DNS01_RFC2136_KEY_FILE` | rfc2136 | BIND 형식 TSIG 키 파일(`nsupdate -k` 가 읽는다) |
| `BARY_DNS01_RFC2136_NSUPDATE` | rfc2136 | `nsupdate` 경로. 기본 `nsupdate`(PATH) |
| `BARY_DNS01_PROPAGATION_TIMEOUT_S` | API 종류 | 전파 대기 상한(초). 기본 60, `0` 이면 기다리지 않는다 |
| `BARY_DNS01_PROPAGATION_INTERVAL_S` | API 종류 | 전파 확인 간격(초). 기본 5 |

**반만 설정하면 기동을 거부한다.** 예: 종류를 안 고르고 공급자 변수만 적었다 · 고른 종류에 필요한 값이 없다 ·
다른 종류의 변수가 섞였다(`cloudflare` 인데 `BARY_DNS01_DIR` 도 있다) · API 주소가 https 가 아니다 · 비밀 파일이
없거나 비었다. 기동 로그에 어느 변수가 문제인지 나온다.

예(Cloudflare):

```sh
install -m 600 -o barycenter /dev/stdin /etc/barycenter/cf-token <<<'(토큰)'
sudo deploy/install.sh ... \
  --env BARY_DNS01_KIND=cloudflare \
  --env BARY_DNS01_ZONE=example.com \
  --env BARY_DNS01_CLOUDFLARE_TOKEN_FILE=/etc/barycenter/cf-token
```

기동 로그 `acme.dns01.enabled {provider, propagationS}` 로 켜진 것을 확인한다.

### rfc2136 — 왜 `nsupdate` 인가

DNS UPDATE + TSIG 를 직접 구현하지 않고 BIND 의 `nsupdate` 를 부른다. 서명 · 시각 검사가 얽힌 보안 프로토콜이고,
진짜 이름서버 없이 맞는지 확인할 수 없기 때문이다. 쉘을 거치지 않고(`spawn`), 명령은 표준입력으로 주며, 이름 · 값 ·
서버는 미리 걸러서 줄바꿈이 섞일 수 없다. 키는 파일 경로만 넘긴다. 호스트에 `bind-utils`(RHEL) 또는
`dnsutils`(Debian)가 있어야 한다.

## 동작

1. **놓기** — 공급자에 TXT 를 **더한다**(같은 이름의 다른 값은 그대로 둔다. `example.com` 과 `*.example.com` 을 한
   주문에 넣으면 두 값이 같은 이름에 선다). 실패하면 그 주문이 실패로 적히고 백오프 뒤 다시 한다.
2. **전파 대기**(API 종류) — 그 영역의 **권한 이름서버 전부**가 값을 답할 때까지 기다린다(재귀 해석기 캐시를 묻지
   않는다). 상한이 지나면 경고 `acme.dns01.propagation_timeout` 를 남기고 **수락은 진행한다** — CA 가 끝내 못 보면
   주문이 `invalid` 가 되고 그 사유가 주문에 남는다.
3. **치우기** — 발급 성공 · 실패와 무관하게 **그 값만** 지운다. 실패해도 **발급은 실패가 아니다**. 경고
   `acme.dns01.remove_failed {name, provider, reason, detail}` 를 남기고, 원장에 「안 치웠다」 가 남아 고아 스캔(1시간
   주기)이 다시 지운다.

러너가 한 주문을 쥐는 실행권은 120초다. 도메인이 여럿이면 전파 대기가 도메인마다 붙으므로, 상한 × 도메인 수가 이를
크게 넘지 않게 둔다(기본 60초면 도메인 둘까지 넉넉하다).

## 실패의 뜻

주문 실패 사유는 `dns-01 TXT 를 놓지 못했다 (<공급자> · <사유>): <상대의 말>` 꼴이다. 화면의 주문 상세와 로그
`acme.order.failed` 에 나온다.

| 사유 | 뜻 | 할 일 |
|---|---|---|
| `auth` | 공급자가 자격증명을 거절했다(401 · 403 · TSIG 서명 오류) | 토큰 · 키 파일 내용과 권한 범위를 본다. 바꾸면 데몬 재시작 |
| `zone-not-found` | TXT 이름을 담는 영역을 못 찾았다 | `BARY_DNS01_ZONE` 을 적거나, 그 영역이 이 계정에 있는지 본다 |
| `rejected` | 공급자가 요청을 거절했다(형식 · 정책 · REFUSED) | 상대의 말을 본다. rfc2136 이면 이름서버의 `update-policy` 가 이 키에 `_acme-challenge` TXT 를 허용하는지 |
| `unavailable` | 닿지 못했다 · 시도 제한 · 5xx · 너무 큰 답 · `nsupdate` 없음 | 다시 하면 될 수 있다. 계속되면 망 · 공급자 상태를 본다 |
| `insecure` | API 주소가 https 가 아니다 | 기동에서 이미 막힌다 |
| `propagation-timeout` | 놓았지만 권한 이름서버에 상한 안에 안 보였다(경고만) | 상한을 늘리거나 이름서버 동기화(보조 서버의 NOTIFY/AXFR)를 본다 |

계측: `bary_acme_dns01_total{op="place|remove|propagation",outcome=…}`.

## 운영 절차

- **처음 켤 때** — 스테이징 CA 계정(Let's Encrypt staging)으로 와일드카드 인증서 하나를 받아 본 뒤 운영 계정으로
  바꾼다(계정만 바꾸면 만료를 기다리지 않고 다시 받는다).
- **토큰 교체** — 새 토큰을 파일에 쓰고 데몬을 다시 띄운다. 옛 토큰은 그 뒤에 폐기한다.
- **남은 TXT** — `acme.dns01.remove_failed` 가 계속되면 공급자 화면에서 `_acme-challenge.*` TXT 를 직접 지워도 된다
  (값이 남아도 해는 없다 — 다음 검증 값과 다를 뿐이다).
- **공급자 바꾸기** — 진행 중인 주문이 없을 때(화면의 ACME 주문이 모두 끝났을 때) 바꾼다. 옛 공급자에 놓인 TXT 는
  새 공급자가 치우지 못하므로 옛 쪽에서 손으로 지운다.
