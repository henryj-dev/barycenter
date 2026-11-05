/**
 * 옛 자리 — 봉인은 `sealer/` 의 어댑터로 옮겼다(`provider.ts` · `local.ts` · `vault-transit.ts` · `registry.ts`).
 *
 * `new Sealer(<base64 키>)` 는 **로컬 봉인기**다. 예전처럼 키를 base64 로 받고, 길이가 틀리면 던진다.
 * 시험과 다른 담당의 코드가 이 이름을 쓰므로 남긴다. 동기 `seal` · `open` 은 `sealSync` · `openSync` 로 옮겼다.
 */
import { LocalSealer, parseAccountsKek } from './sealer/local.js';

export class Sealer extends LocalSealer {
  constructor(keyB64: string) {
    super(parseAccountsKek(keyB64));
  }
}
