/**
 * 봉인 방식 등록부 — `BARY_ACCOUNTS_SEAL_KIND` 의 이름으로 **봉인할** 방식을 고른다. **열기는 값의 앞머리로** 고른다.
 *
 * 다른 방식을 붙이려면: `Sealer` 를 구현한 파일 하나 + 아래 표에 한 줄.
 *
 *   BARY_ACCOUNTS_SEAL_KIND         `local`(기본) · `vault-transit`
 *   BARY_ACCOUNTS_KEK[_FILE|_CMD]   로컬 키. `local` 이면 필수, `vault-transit` 이면 옛 `v1.` 값을 열 때만
 *   BARY_ACCOUNTS_VAULT_ADDR        https 주소
 *   BARY_ACCOUNTS_VAULT_KEY         transit 키 이름(`derived=true`)
 *   BARY_ACCOUNTS_VAULT_TOKEN_FILE  토큰 **파일**(env 값 `BARY_ACCOUNTS_VAULT_TOKEN` 은 거절)
 *   BARY_ACCOUNTS_VAULT_MOUNT       기본 `transit`
 *   BARY_ACCOUNTS_VAULT_NAMESPACE   Enterprise 네임스페이스(선택)
 *
 * **반만 있으면 기동을 거부한다.** 아무것도 안 주면 지금과 같다(`local` + `BARY_ACCOUNTS_KEK`).
 */
import { type KekRunner, type KeyFileReader, resolveKeyFrom } from '../../dp/kek-source.js';
import { ACCOUNTS_KEK_SOURCE, LocalSealer } from './local.js';
import type { OpenResult, SealResult, Sealer } from './provider.js';
import { VaultTransitSealer, type VaultTransitOptions } from './vault-transit.js';

export type SealerDeps = { run?: KekRunner; readFile?: KeyFileReader; fetch?: typeof fetch };

type Built = { kek?: Buffer; vault?: VaultTransitOptions };

const KINDS: Readonly<Record<string, (b: Built) => Sealer>> = {
  local: (b) => {
    if (b.kek === undefined) throw new Error(ACCOUNTS_KEK_SOURCE.missing ?? 'BARY_ACCOUNTS_KEK 가 없다');
    return new LocalSealer(b.kek);
  },
  'vault-transit': (b) => {
    if (b.vault === undefined) {
      throw new Error('BARY_ACCOUNTS_SEAL_KIND=vault-transit 이면 BARY_ACCOUNTS_VAULT_ADDR · _KEY · _TOKEN_FILE 이 모두 필요하다');
    }
    return new VaultTransitSealer(b.vault);
  },
};

export function sealerKinds(): string[] {
  return Object.keys(KINDS);
}

/** 모르는 이름이면 던진다 — 기동이 거부된다(조용히 로컬로 떨어지지 않게). */
export function sealerOf(kind: string, b: Built): Sealer {
  const make = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
  if (make === undefined) throw new Error(`모르는 봉인 방식: ${kind} (쓸 수 있는 것: ${sealerKinds().join(', ')})`);
  return make(b);
}

/**
 * 봉인은 `primary` 로, 열기는 **값의 앞머리**로 고른다. 그래서 방식을 바꿔도 옛 값이 열린다.
 * 그 앞머리의 방식이 설정에 없으면 `no-sealer` 다 — 어느 설정이 빠졌는지 말한다.
 */
export function routedSealer(primary: Sealer, others: readonly Sealer[] = []): Sealer {
  const all = [primary, ...others.filter((s) => s.prefix !== primary.prefix)];
  return {
    kind: primary.kind,
    prefix: primary.prefix,
    seal: (plain: Buffer, aad: string): Promise<SealResult> => primary.seal(plain, aad),
    open: async (sealed: string, aad: string): Promise<OpenResult> => {
      const s = all.find((x) => sealed.startsWith(x.prefix));
      if (s !== undefined) return s.open(sealed, aad);
      if (sealed.startsWith('vault:')) {
        return { ok: false, reason: 'no-sealer', detail: 'Vault 로 봉인된 값인데 BARY_ACCOUNTS_VAULT_* 설정이 없다' };
      }
      if (sealed.startsWith('v1.')) {
        return { ok: false, reason: 'no-sealer', detail: '로컬(v1.)로 봉인된 값인데 BARY_ACCOUNTS_KEK 가 없다' };
      }
      return { ok: false, reason: 'malformed', detail: '봉인값의 앞머리를 모른다' };
    },
  };
}

const VAULT_VARS = ['ADDR', 'KEY', 'TOKEN_FILE'] as const;

function vaultFrom(env: NodeJS.ProcessEnv, deps: SealerDeps): VaultTransitOptions | undefined {
  if ((env['BARY_ACCOUNTS_VAULT_TOKEN'] ?? '') !== '') {
    throw new Error('BARY_ACCOUNTS_VAULT_TOKEN 은 받지 않는다 — Vault 토큰은 BARY_ACCOUNTS_VAULT_TOKEN_FILE(파일)로만 준다');
  }
  const v = (k: string): string => (env[`BARY_ACCOUNTS_VAULT_${k}`] ?? '').trim();
  const given = [...VAULT_VARS, 'MOUNT', 'NAMESPACE'].filter((k) => v(k) !== '');
  if (given.length === 0) return undefined;
  const missing = VAULT_VARS.filter((k) => v(k) === '');
  if (missing.length > 0) {
    throw new Error(`Vault 봉인 설정이 반만 있다 — BARY_ACCOUNTS_VAULT_${missing.join(' · BARY_ACCOUNTS_VAULT_')} 이 없다`);
  }
  return {
    addr: v('ADDR'), key: v('KEY'), tokenFile: v('TOKEN_FILE'),
    ...(v('MOUNT') === '' ? {} : { mount: v('MOUNT') }),
    ...(v('NAMESPACE') === '' ? {} : { namespace: v('NAMESPACE') }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
  };
}

const kekGiven = (env: NodeJS.ProcessEnv): boolean =>
  ['', '_FILE', '_CMD'].some((s) => (env[`BARY_ACCOUNTS_KEK${s}`] ?? '').trim() !== '');

/**
 * env 로 봉인기를 만든다. **설정이 틀리면 던진다**(기동 거부). Vault 를 쓰면 기동 때 행 묶기를 잰다(`probe`).
 * 돌려주는 `openers` 는 로그용 — 어느 앞머리를 열 수 있는가.
 */
export async function sealerFromEnv(
  env: NodeJS.ProcessEnv, deps: SealerDeps = {},
): Promise<{ sealer: Sealer; kind: string; openers: string[] }> {
  const kind = (env['BARY_ACCOUNTS_SEAL_KIND'] ?? '').trim() || 'local';
  if (!sealerKinds().includes(kind)) {
    throw new Error(`BARY_ACCOUNTS_SEAL_KIND=${kind} 를 모른다 (쓸 수 있는 것: ${sealerKinds().join(', ')})`);
  }
  const vault = vaultFrom(env, deps);
  // `local` 은 키가 필수다 — 없으면 `resolveKeyFrom` 이 예전과 같은 안내로 던진다.
  const kek = kind === 'local' || kekGiven(env)
    ? await resolveKeyFrom(env, ACCOUNTS_KEK_SOURCE, deps)
    : undefined;
  const built: Built = { ...(kek === undefined ? {} : { kek }), ...(vault === undefined ? {} : { vault }) };
  const primary = sealerOf(kind, built);
  const others: Sealer[] = [];
  if (kind !== 'local' && kek !== undefined) others.push(new LocalSealer(kek));
  if (kind !== 'vault-transit' && vault !== undefined) others.push(new VaultTransitSealer(vault));
  for (const s of [primary, ...others]) {
    if (s instanceof VaultTransitSealer) {
      const p = await s.probe();
      if (!p.ok) throw new Error(`Vault transit 봉인을 쓸 수 없다 — ${p.detail}`);
    }
  }
  return { sealer: routedSealer(primary, others), kind, openers: [primary, ...others].map((s) => s.prefix) };
}
