/**
 * CLI: 주소 집합 (#114).
 *
 *   bary address-set create --name N (--cidr a,b … | --cidr-file f | --cloudflare)
 *   bary address-set delete --name N
 *
 * `--cloudflare` 는 Cloudflare 공개 목록(ips-v4 · ips-v6)을 받아 집합을 만들거나 **바꾼다.**
 * 바로 적용하지 않는다 — 다른 쓰기와 같이 commit 까지이고, 적용은 영향을 보고 사람이 한다.
 * 목록이 바뀌면 이 명령을 다시 돌린다. 그 집합을 쓰는 리스너가 영향 목록에 오른다.
 */
import { deletePatch, putAddressSetPatch } from '../web/edit.js';

import { commitPatch, type Http } from './flow.js';

export const CLOUDFLARE_LISTS = ['https://www.cloudflare.com/ips-v4/', 'https://www.cloudflare.com/ips-v6/'];

/**
 * Cloudflare 목록을 받는다. **하나라도 실패하거나 비면 던진다** — 반쪽 목록(예: v6 만 빠짐)으로
 * 집합을 바꾸면 그 절반에서 오는 Cloudflare 연결이 조용히 막힌다.
 */
export async function fetchCloudflareCidrs(
  get: (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }> = (u) => fetch(u),
): Promise<string[]> {
  const out: string[] = [];
  for (const url of CLOUDFLARE_LISTS) {
    const r = await get(url);
    if (!r.ok) throw new Error(`${url} 가 ${r.status} 를 줬다 — 집합을 바꾸지 않는다`);
    const lines = (await r.text()).split('\n').map((l) => l.trim()).filter((l) => l !== '');
    if (lines.length === 0) throw new Error(`${url} 가 비었다 — 집합을 바꾸지 않는다`);
    out.push(...lines);
  }
  return out;
}

export async function addressSetCreate(
  http: Http,
  input: { name: string; cidrs?: string[]; cloudflare?: boolean },
  fetchCloudflare: () => Promise<string[]> = () => fetchCloudflareCidrs(),
): Promise<{ revision: string; planId: string; count: number }> {
  const cidrs = input.cloudflare === true ? await fetchCloudflare() : (input.cidrs ?? []);
  const ops = putAddressSetPatch(input.name, {
    cidrs, ...(input.cloudflare === true ? { source: 'cloudflare' as const } : {}),
  });
  const out = await commitPatch(http, ops);
  return { ...out, count: ops[0]!.body.cidrs.length };
}

export async function addressSetDelete(http: Http, name: string): Promise<{ revision: string; planId: string }> {
  return commitPatch(http, deletePatch('addressSet', name));
}
