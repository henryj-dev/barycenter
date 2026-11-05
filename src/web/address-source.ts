/**
 * 주소 집합의 「출처」 폼 (2026-11-05). GUI 만들기 · 설정 · CLI `bary address-set create --source` 가 같은 규칙을 쓴다.
 *
 * 모양 규칙(어느 출처가 어느 옵션을 받는가 · url 은 https)은 해독기가 진다. 여기서는 사람이 먼저 알게 할 뿐이다.
 */
import { ADDRESS_SOURCE_KINDS, type AddressSourceKind, type AddressSourceOptions } from '../model/provisional.js';

/** 폼 칸. `source: 'manual'` 은 손으로 적은 집합이다. 목록 칸은 쉼표 · 줄바꿈으로 끊는다. */
export type AddressSourceForm = {
  source: 'manual' | AddressSourceKind;
  family: '' | 'ipv4' | 'ipv6';
  services: string;
  regions: string;
  url: string;
  jsonPath: string;
};

export const ADDRESS_SOURCE_MANUAL: AddressSourceForm = {
  source: 'manual', family: '', services: '', regions: '', url: '', jsonPath: '',
};

/** 화면 · CLI 도움말에 쓰는 이름. `options` 는 그 출처가 받는 칸이다(해독기의 표와 같다). */
export const ADDRESS_SOURCES: readonly {
  value: AddressSourceKind; label: string; options: readonly (keyof AddressSourceOptions)[];
}[] = [
  { value: 'cloudflare', label: 'Cloudflare', options: ['family'] },
  { value: 'aws', label: 'AWS (ip-ranges.json)', options: ['family', 'services', 'regions'] },
  { value: 'gcp', label: 'Google Cloud (cloud.json)', options: ['family', 'services', 'regions'] },
  { value: 'fastly', label: 'Fastly', options: ['family'] },
  { value: 'url', label: '주소 (URL)', options: ['family', 'url', 'jsonPath'] },
];

/** 그 출처의 사람 이름. 모르는 이름이면 그대로. */
export function addressSourceLabel(source: unknown): string {
  return ADDRESS_SOURCES.find((s) => s.value === source)?.label ?? String(source ?? '');
}

const names = (t: string): string[] => t.split(/[,\n]/).map((x) => x.trim()).filter((x) => x !== '');

/** 모델의 집합 하나 → 폼 칸. */
export function addressSourceFormOf(set: Readonly<Record<string, unknown>> | undefined): AddressSourceForm {
  const source = set?.['source'];
  if (typeof source !== 'string' || !(ADDRESS_SOURCE_KINDS as readonly string[]).includes(source)) {
    return { ...ADDRESS_SOURCE_MANUAL };
  }
  const o = (set?.['sourceOptions'] ?? {}) as Record<string, unknown>;
  const list = (v: unknown): string => (Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(', ') : '');
  return {
    source: source as AddressSourceKind,
    family: o['family'] === 'ipv4' || o['family'] === 'ipv6' ? o['family'] : '',
    services: list(o['services']),
    regions: list(o['regions']),
    url: typeof o['url'] === 'string' ? o['url'] : '',
    jsonPath: typeof o['jsonPath'] === 'string' ? o['jsonPath'] : '',
  };
}

/** 폼이 저장을 막는 이유. 없으면 undefined. */
export function addressSourceIssue(f: AddressSourceForm): string | undefined {
  if (f.source !== 'url') return undefined;
  const u = f.url.trim();
  if (u === '') return '목록을 받을 주소를 입력해요.';
  let https = false;
  try { https = new URL(u).protocol === 'https:'; } catch { https = false; }
  if (!https) return 'https 주소만 받아요. 평문으로 받은 목록은 길 위에서 바뀔 수 있어요.';
  return undefined;
}

/** 폼 칸 → 모델의 `source` · `sourceOptions`. 손으로 적은 집합이면 둘 다 없다. 틀리면 던진다. */
export function addressSourceOf(f: AddressSourceForm): { source?: AddressSourceKind; sourceOptions?: AddressSourceOptions } {
  if (f.source === 'manual') return {};
  const issue = addressSourceIssue(f);
  if (issue !== undefined) throw new Error(issue);
  const takes = ADDRESS_SOURCES.find((s) => s.value === f.source)?.options ?? [];
  const o: AddressSourceOptions = {};
  if (takes.includes('family') && f.family !== '') o.family = f.family;
  if (takes.includes('services') && names(f.services).length > 0) o.services = names(f.services);
  if (takes.includes('regions') && names(f.regions).length > 0) o.regions = names(f.regions);
  if (takes.includes('url') && f.url.trim() !== '') o.url = f.url.trim();
  if (takes.includes('jsonPath') && f.jsonPath.trim() !== '') o.jsonPath = f.jsonPath.trim();
  return { source: f.source, ...(Object.keys(o).length === 0 ? {} : { sourceOptions: o }) };
}
