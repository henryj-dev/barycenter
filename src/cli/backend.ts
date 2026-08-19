/**
 * CLI 백엔드 쓰기 — DESIGN.md §5.6
 *
 * put · delete · drain. apply 는 안 한다. 드레인 숫자는 안 짓는다.
 */
import { deletePatch, putBackendPatch } from '../web/edit.js';

import { commitPatch, unwrap, type Http } from './flow.js';

export type BackendPutInput = {
  name: string;
  pool: string;
  host: string;
  port: number;
  weight?: number;
};

export function backendPutPatch(input: BackendPutInput): ReturnType<typeof putBackendPatch> | undefined {
  if (input.name === '' || input.pool === '' || input.host === '') return undefined;
  if (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535) return undefined;
  if (input.weight !== undefined && (!Number.isInteger(input.weight) || input.weight < 1)) {
    return undefined;
  }
  return putBackendPatch(
    input.name,
    input.weight === undefined
      ? { pool: input.pool, host: input.host, port: input.port }
      : { pool: input.pool, host: input.host, port: input.port, weight: input.weight },
  );
}

export function backendDeletePatch(key: string): ReturnType<typeof deletePatch> | undefined {
  if (key === '') return undefined;
  return deletePatch('backend', key);
}

export async function backendPut(
  http: Http,
  input: BackendPutInput,
): Promise<{ revision: string; planId: string }> {
  const patch = backendPutPatch(input);
  if (patch === undefined) throw new Error('백엔드 put 은 pool·host·포트가 필요하다');
  return commitPatch(http, patch);
}

export async function backendDelete(
  http: Http,
  key: string,
): Promise<{ revision: string; planId: string }> {
  const patch = backendDeletePatch(key);
  if (patch === undefined) throw new Error('백엔드 키가 비어 있다');
  return commitPatch(http, patch);
}

export async function backendDrain(
  http: Http,
  key: string,
  deadlineSeconds?: number,
): Promise<unknown> {
  if (key === '') throw new Error('백엔드 키가 비어 있다');
  const body = deadlineSeconds === undefined ? {} : { deadline_s: deadlineSeconds };
  return unwrap(await http('POST', `/api/v1/backends/${encodeURIComponent(key)}/drain`, body), 'drain');
}

export async function backendDrainStatus(http: Http, key: string): Promise<unknown> {
  if (key === '') throw new Error('백엔드 키가 비어 있다');
  return unwrap(
    await http('GET', `/api/v1/backends/${encodeURIComponent(key)}/drain-status`),
    'drain-status',
  );
}
