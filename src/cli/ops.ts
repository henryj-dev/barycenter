/**
 * CLI 운영 명령 (2026-11-21) — 화면에만 있던 것을 명령줄에도 둔다.
 *
 *   bary apply retry              실패한 head 를 다시 계획해 적용한다
 *   bary history <종류> <이름>     그 리소스를 바꾼 리비전들
 *   bary revisions [개수]          리비전 목록 (롤백 대상 고르기)
 *   bary pending                  head 와 활성 리비전이 다른 리소스
 *   bary acme account create|list
 *   bary engine set               엔진 전역 설정 (`put engine`)
 *   bary account-audit [개수]      계정 감사 (admin)
 *
 * 몸체와 검사는 GUI 와 같은 모듈에서 온다 — 엔진 범위는 `web/engine-settings`, CA 표는 `web/acme-directories`.
 */
import { acmeDirectoryOf } from '../web/acme-directories.js';
import { engineBody, engineErrors, engineFormOf, type EngineForm } from '../web/engine-settings.js';
import { RESOURCE_KEY_RULE, RESOURCE_KEY_SYNTAX } from '../validate/syntax.js';

import { commitPatch, unwrap, type Http } from './flow.js';
import { renameKindOf } from './rename.js';

const q = (n: string | undefined, def: number): string => {
  const v = n === undefined ? def : Number(n);
  if (!Number.isInteger(v) || v < 1) throw new Error(`개수는 1 이상의 정수다: ${JSON.stringify(n)}`);
  return String(v);
};

/** 실패한 head 를 다시 계획해 적용한다. 실패한 적용이 없으면 서버가 409 `nothing_to_retry` 를 준다. */
export async function applyRetry(http: Http): Promise<{ phase: string; generation?: string; detail?: { failure?: string } }> {
  return unwrap(await http('POST', '/api/v1/apply/retry'), 'apply retry') as {
    phase: string; generation?: string; detail?: { failure?: string };
  };
}

/** 그 리소스를 바꾼 리비전들. 종류는 `bary rename` 과 같은 말이다(`http-route` · `tls-policy` …). */
export async function resourceHistory(http: Http, word: string, key: string, limit?: string): Promise<unknown> {
  const kind = renameKindOf(word);
  const p = new URLSearchParams({ kind, key, limit: q(limit, 50) });
  return unwrap(await http('GET', `/api/v1/config/history?${p.toString()}`), 'history');
}

export async function revisions(http: Http, limit?: string): Promise<unknown> {
  return unwrap(await http('GET', `/api/v1/config/revisions?limit=${q(limit, 20)}`), 'revisions');
}

export async function pendingResources(http: Http): Promise<unknown> {
  return unwrap(await http('GET', '/api/v1/config/pending-resources'), 'pending');
}

export type AcmeAccountInput = { name: string; ca: string; contact: readonly string[] };

/** ACME 계정을 만든다. CA 등록은 첫 주문 때 한다. 계정 키는 서버가 만들어 시크릿 저장소에 둔다. */
export async function acmeAccountCreate(http: Http, a: AcmeAccountInput): Promise<unknown> {
  if (!RESOURCE_KEY_SYNTAX.test(a.name)) throw new Error(`계정 이름이 규칙에 안 맞는다: ${JSON.stringify(a.name)} — ${RESOURCE_KEY_RULE}`);
  const contact = a.contact.map((c) => (c.startsWith('mailto:') ? c : `mailto:${c}`));
  return unwrap(await http('POST', '/api/v1/acme/accounts', {
    key: a.name, directoryUrl: acmeDirectoryOf(a.ca), contact,
  }), 'acme account create');
}

export async function acmeAccountList(http: Http): Promise<unknown> {
  return unwrap(await http('GET', '/api/v1/acme/accounts'), 'acme account list');
}

export type EngineFlags = { shutdown?: string; membership?: string; acme?: string; clear: readonly ('shutdown' | 'membership' | 'acme')[] };

/**
 * 엔진 설정을 바꾼다 — 주지 않은 칸은 head 값을 그대로 둔다. `--clear-*` 는 그 칸을 비워 기본값으로 돌린다.
 * commit 까지다. apply 는 아니다.
 */
export async function engineSet(http: Http, f: EngineFlags): Promise<{ revision: string; planId: string }> {
  const now = (unwrap(await http('GET', '/api/v1/engine'), 'engine') as { settings?: unknown }).settings;
  const form: EngineForm = engineFormOf(now);
  if (f.shutdown !== undefined) form.shutdown = f.shutdown;
  if (f.membership !== undefined) form.membership = f.membership;
  if (f.acme !== undefined) form.acme = f.acme;
  for (const c of f.clear) form[c] = '';
  const errs = Object.entries(engineErrors(form));
  if (errs.length > 0) throw new Error(errs.map(([k, v]) => `${k}: ${v}`).join(' · '));
  return commitPatch(http, [{ op: 'put', kind: 'engine', key: 'engine', body: engineBody(form) }]);
}

export async function accountAudit(http: Http, limit?: string): Promise<unknown> {
  return unwrap(await http('GET', `/api/v1/account-audit?limit=${q(limit, 50)}`), 'account-audit');
}
