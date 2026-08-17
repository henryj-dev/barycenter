# 새 워크트리에서 먼저 할 것

`node_modules` 는 `.claude/settings.json` 의 `worktree.symlinkDirectories` 로 메인 트리에서
심링크된다. **실측으로 안 걸린 적이 있으니** 없으면 아래를 손으로 건다.

```sh
ls -d node_modules || ln -s /Users/henry/github/mack-erel/barycenter/node_modules node_modules
```

의존성이 메인과 어긋나면(package-lock.json 을 건드리는 작업) 심링크 대신 자기 것을 만든다:

```sh
rm -f node_modules && npm ci
```

검증:

```sh
npm run verify:quick     # 단위 + 타입 — 도커 불필요
npm run verify           # 전부 — 도커 필요 (골든·엔진·스파이크)
```

`dist/` 가 필요하면 `npm run build`. 도커가 필요한 묶음은 `deploy/` 의 compose 를 쓴다.
