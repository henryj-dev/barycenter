/**
 * CLI: 주소 집합 (#114).
 *
 *   bary address-set create --name N (--cidr a,b … | --cidr-file f | --cloudflare | --source S [옵션])
 *   bary address-set refresh --name N
 *   bary address-set delete --name N
 *
 * `--source` 는 출처 레지스트리의 이름이다(cloudflare · aws · gcp · fastly · url — 2026-11-05). 만들 때 이 CLI 가 목록을
 * 한 번 받아 처음 대역으로 넣고, 그 뒤로는 데몬(주기 갱신) · `refresh` · 화면의 「목록 다시 받기」 가 받는다.
 * `--cloudflare` 는 `--source cloudflare` 와 같다(옛 이름).
 *
 * `--cloudflare` 는 Cloudflare 공개 목록(ips-v4 · ips-v6)을 받아 집합을 만들거나 **바꾼다.**
 * 바로 적용하지 않는다 — 다른 쓰기와 같이 commit 까지이고, 적용은 영향을 보고 사람이 한다.
 * 목록이 바뀌면 이 명령을 다시 돌린다. 그 집합을 쓰는 리스너가 영향 목록에 오른다.
 */
import { addressSource } from '../control/address-sources/registry.js';
import type { AddressSourceKind, AddressSourceOptions } from '../model/provisional.js';
import { deletePatch, putAddressSetPatch } from '../web/edit.js';

import { commitPatch, unwrap, type Http } from './flow.js';

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

/** 출처에서 한 번 받는다(만들 때의 처음 목록). 실패하면 던진다 — 집합을 만들지 않는다. */
export async function fetchFromSource(kind: AddressSourceKind, options: AddressSourceOptions): Promise<string[]> {
  const r = await addressSource(kind).fetch(options);
  if (!r.ok) throw new Error(`${kind} 출처에서 받지 못했다 [${r.reason}]: ${r.detail} — 집합을 만들지 않는다`);
  return r.cidrs;
}

export async function addressSetCreate(
  http: Http,
  input: {
    name: string; cidrs?: string[]; cloudflare?: boolean;
    source?: AddressSourceKind; sourceOptions?: AddressSourceOptions;
  },
  fetchCloudflare: () => Promise<string[]> = () => fetchCloudflareCidrs(),
  fetchSource: typeof fetchFromSource = fetchFromSource,
): Promise<{ revision: string; planId: string; count: number }> {
  const source = input.cloudflare === true ? 'cloudflare' as const : input.source;
  const options = input.sourceOptions ?? {};
  const cidrs = input.cloudflare === true
    ? await fetchCloudflare()
    : source !== undefined ? await fetchSource(source, options) : (input.cidrs ?? []);
  const ops = putAddressSetPatch(input.name, {
    cidrs,
    ...(source === undefined ? {} : { source }),
    ...(source === undefined || Object.keys(options).length === 0 ? {} : { sourceOptions: options }),
  });
  const out = await commitPatch(http, ops);
  return { ...out, count: ops[0]!.body.cidrs.length };
}

export async function addressSetDelete(http: Http, name: string): Promise<{ revision: string; planId: string }> {
  return commitPatch(http, deletePatch('addressSet', name));
}

/** 출처에서 다시 받는다 — 데몬이 받고, 바뀌었으면 커밋까지 한다(적용은 사람이). */
export async function addressSetRefresh(http: Http, name: string): Promise<{
  key: string; outcome: 'unchanged' | 'committed'; count: number; revision?: string; planId?: string;
}> {
  return unwrap(await http('POST', `/api/v1/address-sets/${encodeURIComponent(name)}/refresh`, {}), 'address-set refresh') as {
    key: string; outcome: 'unchanged' | 'committed'; count: number; revision?: string; planId?: string;
  };
}
