# barycenter UX/UI

barycenter 화면을 새로 만드는 작업 공간이다. main 과 이력을 나누지 않는다.

| 폴더 | 맡는 일 |
|---|---|
| `api/` | 백엔드 — Hono 서버, 설정 DB(Drizzle · Postgres) |
| `web/` | 화면만 — SvelteKit 정적 빌드(SPA). DB 에 직접 붙지 않고 `api` 만 부른다 |

## 처음

```sh
pnpm install
cp api/.env.example api/.env   # DATABASE_URL 을 채운다
pnpm dev                       # api :4000 · web :5173 (web 의 /api 는 api 로 넘긴다)
```

## 검사

```sh
pnpm check    # 타입
pnpm lint     # web: prettier · eslint
pnpm test
pnpm build
```
