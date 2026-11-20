/**
 * 모델 안에서 리소스 하나의 이름(key)을 바꾼다 — 그 리소스와 **그것을 가리키는 모든 참조**를 함께.
 *
 * 저장소에서는 리소스끼리 id 로 이어져 있어 key 만 바꾸면 참조가 따라온다(`config-store` 의 `rename`).
 * 모델은 key 로 참조하므로 여기서 손으로 따라가야 한다. 두 곳이 쓴다:
 *
 *   - plan 의 영향 계산 — 이전 모델에 같은 이름 바꾸기를 먼저 적용해 둔다. 안 그러면 이름을 바꾼 리스너가
 *     「제거 + 추가」 로, 인증서가 「자료 추가」 로 보인다.
 *   - 주소 집합 이름 바꾸기 — `@이름` 참조는 FK 가 아니라 리스너 · 라우트의 대역 목록 안의 문자열이다.
 *     바뀐 모델의 그 리소스를 다시 저장해 참조를 옮긴다.
 *
 * **참조 목록은 `src/web/resources.ts` 의 `edgesOf` 와 같아야 한다.** 그 함수가 화면의 「연결된 리소스」 와
 * 삭제 확인을 그린다. 단위 시험이 모든 간선을 가진 모델로 두 함수를 맞대어 본다(`tests/unit/rename.test.ts`).
 */
import type { Model } from './provisional.js';

export type RenameKind =
  | 'pool' | 'backend' | 'listener' | 'httpRoute' | 'passthroughRoute'
  | 'certificate' | 'tlsPolicy' | 'sniBinding' | 'addressSet';

export type Rename = { kind: RenameKind; from: string; to: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

/** `{ pool }` 꼴의 자리(기본 동작 · 라우트 동작 · SNI 결과)에서 풀 이름을 바꾼다. */
const poolSlot = (v: unknown, from: string, to: string): void => {
  if (isObj(v) && v['pool'] === from) v['pool'] = to;
};

/** 대역 목록 안의 `@이름` 을 바꾼다. 순서와 다른 항목은 그대로 둔다. */
const setList = (list: unknown, from: string, to: string): void => {
  if (!Array.isArray(list)) return;
  for (let i = 0; i < list.length; i += 1) if (list[i] === `@${from}`) list[i] = `@${to}`;
};

const COLLECTION: Record<RenameKind, keyof Model> = {
  pool: 'pools', backend: 'backends', listener: 'listeners', httpRoute: 'httpRoutes',
  passthroughRoute: 'passthroughRoutes', certificate: 'certificates', tlsPolicy: 'tlsPolicies',
  sniBinding: 'sniBindings', addressSet: 'addressSets',
};

/** 새 모델을 돌려준다. 들어온 모델은 안 바꾼다. 이름이 없으면 그대로다(참조만 있어도 옮긴다). */
export function renameInModel(model: Model, r: Rename): Model {
  const m = structuredClone(model);
  const { kind, from, to } = r;
  for (const item of (m[COLLECTION[kind]] as Obj[] | undefined) ?? []) {
    if (item['key'] === from) item['key'] = to;
  }
  const listeners = m.listeners as unknown as Obj[];
  const routes = [...(m.httpRoutes as unknown as Obj[]), ...(m.passthroughRoutes as unknown as Obj[])];
  switch (kind) {
    case 'pool':
      for (const l of listeners) {
        poolSlot(isObj(l['http']) ? l['http']['defaultAction'] : undefined, from, to);
        if (l['defaultPool'] === from) l['defaultPool'] = to;
        poolSlot(l['onUnmatchedSni'], from, to);
        poolSlot(l['onNoSni'], from, to);
      }
      for (const rt of routes) {
        poolSlot(rt['action'], from, to);
        for (const rule of Array.isArray(rt['sourceRules']) ? rt['sourceRules'] : []) {
          if (isObj(rule)) poolSlot(rule['action'], from, to);
        }
      }
      for (const b of m.backends as unknown as Obj[]) if (b['pool'] === from) b['pool'] = to;
      break;
    case 'listener':
      for (const rt of routes) if (rt['listener'] === from) rt['listener'] = to;
      for (const s of m.sniBindings as unknown as Obj[]) if (s['listener'] === from) s['listener'] = to;
      break;
    case 'certificate':
      for (const l of listeners) {
        if (isObj(l['tls']) && l['tls']['defaultCertificate'] === from) l['tls']['defaultCertificate'] = to;
      }
      for (const s of m.sniBindings as unknown as Obj[]) if (s['certificate'] === from) s['certificate'] = to;
      for (const p of m.pools as unknown as Obj[]) {
        if (isObj(p['upstreamTls']) && p['upstreamTls']['caBundle'] === from) p['upstreamTls']['caBundle'] = to;
      }
      break;
    case 'tlsPolicy':
      for (const l of listeners) {
        if (isObj(l['tls']) && l['tls']['policy'] === from) l['tls']['policy'] = to;
      }
      break;
    case 'addressSet':
      for (const l of listeners) {
        setList(l['sourceAllow'], from, to);
        setList(isObj(l['acceptProxyProtocol']) ? l['acceptProxyProtocol']['trustedCidrs'] : undefined, from, to);
        setList(isObj(l['realIpFromHeader']) ? l['realIpFromHeader']['trustedCidrs'] : undefined, from, to);
      }
      for (const rt of routes) {
        for (const rule of Array.isArray(rt['sourceRules']) ? rt['sourceRules'] : []) {
          if (isObj(rule)) setList(rule['from'], from, to);
        }
      }
      break;
    // 백엔드 · 라우트 · SNI 바인딩은 아무도 key 로 가리키지 않는다.
    default:
      break;
  }
  return m;
}
