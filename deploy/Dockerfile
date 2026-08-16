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
FROM node:24-alpine AS deps
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:24-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
# 빌드에는 devDependency(typescript)가 필요하다.
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY scripts ./scripts
COPY src ./src
RUN ./scripts/build.sh

FROM openresty/openresty:alpine

# 엔진 이미지 위에 Node 를 얹는다. 반대로(node 이미지에 openresty 를 얹기) 하면
# OpenResty 를 소스에서 빌드해야 한다 — alpine 저장소에 패키지가 없다.
RUN apk add --no-cache nodejs tini

WORKDIR /app
COPY package.json ./
# **런타임 의존성만.** `pg` 하나다 (§11.2).
COPY --from=deps /src/node_modules ./node_modules
COPY --from=build /src/dist ./dist

# `/prefix` 가 §7.2 의 `/etc/barycenter` 다. **볼륨으로 빼지 말 것** — 세대와 `current`
# 링크는 에이전트가 이 컨테이너 안에서만 다뤄야 한다.
ENV BARY_PREFIX=/prefix \
    BARY_LISTEN=0.0.0.0:8088 \
    BARY_ADMIN_PORT=19999 \
    BARY_RELOAD_CMD="kill -HUP \$(cat /prefix/logs/nginx.pid)" \
    BARY_CONFIGTEST_CMD="/usr/local/openresty/bin/openresty -p /prefix -c /prefix/generations/{generation}/nginx.conf -t"

COPY deploy/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

EXPOSE 8088

# tini 를 pid 1 로 둔다. 좀비 수거도 이유지만, 여기서는 **에이전트가 pid 1 이 아니게
# 하는 것**이 더 중요하다 — pid 1 은 재기동마다 확실히 재사용되고, 그러면 durable
# store 의 락 판정이 pid 만으로는 갈리지 않는다. (락 레코드에 프로세스 시작 시각을
# 넣어 그 경우도 갈리게 해 뒀지만, 굳이 그 경계에 기대지 않는다.)
ENTRYPOINT ["/sbin/tini", "--", "/usr/local/bin/entrypoint.sh"]
