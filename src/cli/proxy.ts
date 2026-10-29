/**
 * CLI: URL 하나로 프록시 만들기 (#112).
 *
 *   bary proxy create --name N --url https://example.com/v1/ (--listen 127.0.0.1:8080 | --listener KEY)
 *                     [--host a.example.com,b.example.com] [--path-prefix /api/] [--allow …] [--allow-file f]
 *
 * 펼치기는 `proxyFromUrlPatch` 한 자리다(GUI 와 같다). 여기서는 `--listen` 을 읽고
 * 변경 하나로 commit 한다. apply 는 안 한다 — 다른 create 명령과 같다.
 */
import { proxyFromUrlPatch, type ProxyFromUrlInput } from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

/** `127.0.0.1:8080` · `[::1]:8080` · `8080`(→ 0.0.0.0). */
export function parseListen(v: string): { bind: string; port: number } {
  const m = /^(?:\[([^\]]+)\]|([^:]+)):(\d+)$/.exec(v.trim()) ?? /^()()(\d+)$/.exec(v.trim());
  if (m === null) throw new Error(`--listen 이 주소:포트 가 아니다: ${JSON.stringify(v)} — 예: 127.0.0.1:8080`);
  const port = Number(m[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('포트가 1–65535 정수가 아니다');
  return { bind: m[1] || m[2] || '0.0.0.0', port };
}

export async function proxyCreate(
  http: Http, input: ProxyFromUrlInput,
): Promise<{ revision: string; planId: string; created: string[] }> {
  const ops = proxyFromUrlPatch(input);
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, ops);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id, created: ops.map((o) => `${o.kind} ${o.key}`) };
}
