# 새 워크트리에서 먼저 할 것

`node_modules` 는 `.claude/settings.json` 의 `worktree.symlinkDirectories` 로 메인 트리에서
심링크된다. **실측으로 안 걸린 적이 있으니** 없으면 아래를 손으로 건다.

```sh
# 메인 트리 경로는 워크트리 안에서 git 에게 묻는다 — 사람마다 다르고,
# 적어 두면 그 사람의 홈 디렉터리 구조가 문서에 박힌다.
main=$(git worktree list --porcelain | awk '/^worktree /{print $2; exit}')
ls -d node_modules || ln -s "$main/node_modules" node_modules
```

## ⚠️ e2e 를 돌 거면 심링크로는 안 된다

`rm -f node_modules && npm ci` **를 먼저 한다.**

e2e 는 워크트리를 컨테이너에 통째로 마운트하고(`-v $(pwd):/app:ro`) 그 안에서
`node /app/dist/bin/barycenterd.js` 를 돌린다. 심링크는 **호스트 절대경로**를 가리키므로
컨테이너 안에서 끊긴다. 증상은 원인을 안 가리킨다:

```
Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'pg' imported from /app/dist/control/leader.js
```

그리고 러너가 보는 것은 그 오류가 아니라 `데몬이 안 떴다` **한 줄**이다 (컨테이너가
이미 죽어서 `docker logs` 도 비어 있다). 2026-08-23 에 이걸로 e2e 5 파일이 빨갰고,
**도커 자원 경합으로 오진했다** — 아래 두 줄을 안 읽었기 때문이다.

의존성이 메인과 어긋날 때(package-lock.json 을 건드리는 작업)도 마찬가지로 자기 것을
만든다.

검증:

```sh
npm run verify:quick     # 단위 + 타입 — 도커 불필요
npm run verify           # 전부 — 도커 필요 (골든·엔진·스파이크)
```

`dist/` 가 필요하면 `npm run build`. 도커가 필요한 묶음은 `deploy/` 의 compose 를 쓴다.
