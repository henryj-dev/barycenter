/**
 * CLI 이름 바꾸기 (2026-11-20) — `bary rename <종류> <옛 이름> <새 이름>`.
 *
 * commit 까지다. apply 는 안 한다. 이것을 쓰는 리소스는 서버가 함께 새 이름으로 옮긴다.
 * 종류는 `bary get` 과 같은 말을 쓴다(`http-route` · `tls-policy` …).
 */
import { renamePatch, type EditKind } from '../web/edit.js';

import { commitPatch, type Http } from './flow.js';

export const RENAME_KINDS: Readonly<Record<string, EditKind>> = {
  listener: 'listener', pool: 'pool', backend: 'backend',
  'http-route': 'httpRoute', 'passthrough-route': 'passthroughRoute',
  certificate: 'certificate', 'tls-policy': 'tlsPolicy', 'sni-binding': 'sniBinding', 'address-set': 'addressSet',
};

/** CLI 의 종류 이름 → patch 의 종류. 모르면 던진다(쓸 수 있는 것을 함께 말한다). */
export function renameKindOf(word: string): EditKind {
  const kind = Object.hasOwn(RENAME_KINDS, word) ? RENAME_KINDS[word] : undefined;
  if (kind === undefined) {
    throw new Error(`이름을 바꿀 수 없는 종류다: ${JSON.stringify(word)} — ${Object.keys(RENAME_KINDS).join(' · ')}`);
  }
  return kind;
}

export async function renameResource(
  http: Http, word: string, from: string, to: string,
): Promise<{ revision: string; planId: string }> {
  return commitPatch(http, renamePatch(renameKindOf(word), from, to));
}
