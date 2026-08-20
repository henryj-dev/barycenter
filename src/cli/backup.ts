/**
 * 백업·복구 리허설 — DESIGN.md §11.4
 *
 * spec-only 매니페스트 + head 리비전. 시크릿 바이트는 안 싣는다.
 * 적용은 restore 가 아니라 apply 다.
 */
import { unwrap, type Http } from './flow.js';

export type BackupBundle = {
  revision: string;
  manifest: unknown;
};

export async function backupNow(http: Http): Promise<BackupBundle> {
  const body = unwrap(await http('GET', '/api/v1/backup'), 'backup') as Record<string, unknown>;
  const revision = body['revision'];
  if (typeof revision !== 'string' || revision === '') {
    throw new Error('백업에 리비전이 없다');
  }
  return { revision, manifest: body['manifest'] };
}

export async function restoreNow(
  http: Http, bundle: BackupBundle,
): Promise<{ revision: string }> {
  const out = unwrap(
    await http('POST', '/api/v1/restore', { manifest: bundle.manifest }),
    'restore',
  ) as Record<string, unknown>;
  const revision = out['revision'];
  if (typeof revision !== 'string' || revision === '') {
    throw new Error('복구 응답에 리비전이 없다');
  }
  return { revision };
}

/** export 매니페스트에서 시크릿 참조만 모은다. 키 바이트는 없다. */
export function secretRefsIn(manifest: unknown): string[] {
  const text = JSON.stringify(manifest);
  const refs = text.match(/store:\/\/[^\s"]+/g) ?? [];
  return [...new Set(refs)].sort();
}
