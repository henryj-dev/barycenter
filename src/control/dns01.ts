/**
 * dns-01 프로바이더 — 최소 place/cleanup 이음새 (DESIGN.md §8.2 · ADR-ACME).
 *
 * 벤더 API 를 제품 계약으로 얼리지 않는다. 파일이 정본이다. 운영자가 그 파일을
 * nsupdate/외부 훅으로 밀어 올리는 것은 이 모듈 밖이다.
 *
 * TXT 이름은 RFC 8555 §8.4: `_acme-challenge.<도메인>`. 와일드카드는 `*.` 를 뗀다.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const dns01TxtName = (domain: string): string => {
  const apex = domain.startsWith('*.') ? domain.slice(2) : domain;
  return `_acme-challenge.${apex}`;
};

export class FileDns01 {
  readonly type = 'dns-01' as const;

  constructor(private readonly dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  async place(domain: string, _token: string, value: string): Promise<void> {
    writeFileSync(join(this.dir, dns01TxtName(domain)), `${value}\n`, 'utf8');
  }

  async remove(domain: string, _token: string): Promise<void> {
    rmSync(join(this.dir, dns01TxtName(domain)), { force: true });
  }
}

/** 와일드카드 authz 는 dns-01 만 고른다 (S18). */
export function challengeTypeWanted(
  identifier: { value: string; wildcard?: boolean },
  httpAvailable: boolean,
): 'http-01' | 'dns-01' {
  if (identifier.wildcard === true || identifier.value.startsWith('*.')) return 'dns-01';
  return httpAvailable ? 'http-01' : 'dns-01';
}
