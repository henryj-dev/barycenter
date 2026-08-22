# barycenter 데이터 플레인 이미지 — 엔진과 에이전트가 **한 컨테이너**에 있다.
#
# 나누고 싶어지는 모양이지만 나눌 수 없다. §3.2 · §11.1 이 "DP Agent 는
# `/etc/barycenter` 의 유일한 writer 이고 DP 와 같은 호스트에 산다" 고 한 것은 규범이
# 아니라 **실측 결과**다. 호스트(또는 다른 컨테이너)에서 `current` 심볼릭 링크를 바꾸면
# 엔진이 있는 쪽에서는 그 교체가 보이지 않는다:
#
#   호스트에서  ln -sfn generations/g2 current  + HUP
#   컨테이너 안 readlink current  →  generations/g1   (그리고 트래픽도 g1)
#
# 세대 게시는 원자적 링크 교체이고(§7.2) 그게 안 보이면 아무것도 성립하지 않는다.
# 그래서 사이드카로 쪼개는 구성은 이 설계에 없다.

# 런타임 의존성만 따로 준비한다. 런타임 이미지에 `npm` 을 넣지 않기 위해서다 —
# 처음엔 거기서 `npm ci` 를 돌리려다 `exit 127` 로 죽었다(openresty 이미지에는 `nodejs`
# 는 넣어도 `npm` 은 없다). 도구를 프로덕션 이미지에 끌어들이지 않는 편이 낫다.
FROM docker.io/library/node:24-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM docker.io/library/node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
# 빌드에는 devDependency(typescript)가 필요하다.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN ./scripts/build.sh

FROM docker.io/openresty/openresty:alpine

# 엔진 이미지 위에 Node 를 얹는다. 반대로(node 이미지에 openresty 를 얹기) 하면
# OpenResty 를 소스에서 빌드해야 한다 — alpine 저장소에 패키지가 없다.
RUN apk add --no-cache nodejs tini libcap

# ── 비-root 로 돈다 (검수 S-10b) ──────────────────────────────────────────
#
# **`USER` 한 줄로는 안 된다.** nginx 마스터가 80·443 같은 특권 포트를 bind 해야 하는데,
# 비-root 는 그걸 못 해서 리스너를 만드는 순간 죽는다. 그래서 포트 권한만 파일
# capability 로 따로 준다 — 프로세스는 비-root 이고 **낮은 포트를 여는 능력 하나만**
# 갖는다. root 전체를 주는 것과 다르다.
#
# `openresty` 는 심볼릭 링크라 실제 ELF 에 건다. 링크에 걸면 조용히 아무 일도 안 난다.
#
# nginx 의 임시 경로(`client_body_temp` 등)는 컴파일 기본값이 **상대 경로**이고
# `-p /prefix` 로 풀리므로 `/prefix` 밑에 생긴다 — 그래서 이 사용자가 쓸 수 있다.
# (`nginx -V` 에 `--http-*-temp-path` 가 없다는 것을 확인했다. 절대 경로였다면
# `/usr/local/openresty` 밑이라 비-root 가 못 쓴다.)
RUN addgroup -g 10001 bary  && adduser -D -H -u 10001 -G bary bary  && setcap cap_net_bind_service=+ep /usr/local/openresty/nginx/sbin/nginx  && mkdir -p /prefix  && chown bary:bary /prefix

WORKDIR /app
COPY package.json ./
# **런타임 의존성만.** `pg` 하나다 (§11.2).
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist

# `/prefix` 가 §7.2 의 `/etc/barycenter` 다. **볼륨으로 빼지 말 것** — 세대와 `current`
# 링크는 에이전트가 이 컨테이너 안에서만 다뤄야 한다.
# ⚠️ **`BARY_LISTEN` 이 0.0.0.0 인 것은 의도다 — 되돌리지 말 것** (검수 S-05a).
#
# 컨테이너 안에서 `127.0.0.1` 에 묶으면 도커의 포트 퍼블리시가 그 소켓에 닿지 못해
# API 가 아예 안 열린다. 애플리케이션 기본값은 루프백이고(그건 맨 호스트에서 맞다),
# 여기서만 넓힌다.
#
# **대신 밖에서 좁힌다.** compose 는 `127.0.0.1:8088:8088` 로 퍼블리시한다. 이 API 로
# 개인키와 Bearer 토큰이 지나가므로 **8088 을 0.0.0.0 으로 퍼블리시하지 말 것.**
# 데몬이 기동할 때 `listen.exposed` 로 그 사실을 경고한다.
#
# 서버 TLS 는 이제 있다 (검수 S-05b) — `BARY_TLS_CERT_FILE` 과 `BARY_TLS_KEY_FILE` 을
# 주면 https 로 뜬다. 그래도 이 이미지의 기본은 평문이다: 인증서를 이미지에 굽지
# 않기 때문이다. 넓은 인터페이스로 퍼블리시하려면 TLS 를 먼저 켠다.
ENV BARY_PREFIX=/prefix \
    BARY_LISTEN=0.0.0.0:8088 \
    BARY_ADMIN_PORT=19999 \
    BARY_RELOAD_CMD="kill -HUP \$(cat /prefix/logs/nginx.pid)" \
    BARY_CONFIGTEST_CMD="/usr/local/openresty/bin/openresty -p /prefix -c /prefix/generations/{generation}/nginx.conf -t"

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8088

# **`/prefix` 볼륨은 이 사용자 소유여야 한다.**
#
# compose 의 named volume 은 **처음 만들어질 때** 이미지의 경로 내용과 소유권을 가져간다.
# 그래서 새 배포는 그냥 된다. 그런데 **이 변경 전에 만들어진 볼륨은 root 소유**라
# 그대로 올리면 에이전트가 아무것도 못 쓴다. 엔트리포인트가 그 상태를 이름 지어
# 죽는다 — 권한 오류로 엉뚱한 데서 죽는 것보다 낫다.
USER bary

# tini 를 pid 1 로 둔다. 좀비 수거도 이유지만, 여기서는 **에이전트가 pid 1 이 아니게
# 하는 것**이 더 중요하다 — pid 1 은 재기동마다 확실히 재사용되고, 그러면 durable
# store 의 락 판정이 pid 만으로는 갈리지 않는다. (락 레코드에 프로세스 시작 시각을
# 넣어 그 경우도 갈리게 해 뒀지만, 굳이 그 경계에 기대지 않는다.)
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
