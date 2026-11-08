/**
 * barycenter 자신의 버전 — **`package.json` 의 `version` 이다.** 새 출처를 두지 않는다.
 *
 * 소스(`src/version.ts`)와 산출물(`dist/version.js`) 모두 한 단계 위가 저장소 · 설치 루트다 —
 * 설치 스크립트와 배포 이미지가 `package.json` 을 `dist/` 옆에 둔다(`deploy/install.sh` ⑧ · `deploy/Dockerfile`).
 *
 * 못 읽으면 `undefined` 다. 지어낸 버전을 내보내지 않는다 — 쓰는 쪽(`Server` 헤더)이 버전 없이 이름만 낸다.
 */
import { readFileSync } from 'node:fs';

function read(): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown };
    return typeof pkg.version === 'string' && /^[0-9A-Za-z.+-]{1,64}$/.test(pkg.version) ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

export const BARYCENTER_VERSION: string | undefined = read();
