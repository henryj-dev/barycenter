/**
 * 검수 2026-08-22 · S-01 — **세대 파일이 세대 밖으로 나가지 못한다**
 *
 * 인증서 `key` 는 `certs/<key>/<version>/privkey.pem` 이라는 **파일 경로**가 된다
 * (`certPaths` · `certificateFiles`). 그런데 리소스 key 에는 형식 검증이 없었고,
 * `materializeGeneration` 은 `join(tmp, rel)` 을 그대로 썼다 — `join` 이 `..` 을
 * 정규화하므로 세대 디렉토리를 벗어난다.
 *
 * 검수에서 실행으로 재현했다: `key='../../../../pwned'` 로 prefix 밖에 개인키가 쓰였고
 * `verifyGeneration` 도 그것을 통과시켰다.
 *
 * **문법 검사(`shapeCheck`)는 앞으로 들어올 것만 막는다.** 이미 저장된 나쁜 키는 못
 * 막고, 그래서 이 층이 따로 있어야 한다 — 방어는 두 겹이다.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  digestOfFiles,
  materializeGeneration,
  verifyGeneration,
  MANIFEST_NAME,
} from '../../src/dp/materialize.js';
import { certPaths } from '../../src/conf/render.js';

/**
 * **prefix 를 샌드박스 안에 둔다.**
 *
 * 이탈이 성공하면 파일은 prefix *밖*에 생긴다. 그 자리를 `tmpdir()` 로 두면 단언이
 * 이 저장소 밖의 상태에 걸린다 — 실제로 검수 때의 재현 실험이 남긴 디렉토리 때문에
 * 처음 이 테스트가 엉뚱하게 빨갰다. 이탈 목적지까지 우리가 만든 디렉토리 안이어야
 * 테스트가 자기 안에서 닫힌다.
 */
let sandbox: string;
let prefix: string;

beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'bary-escape-'));
  prefix = join(sandbox, 'prefix');
  mkdirSync(prefix, { recursive: true });
});

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const sha = (s: string): string =>
  `sha256:${createHash('sha256').update(s).digest('hex')}`;

describe('세대 경로 이탈 (검수 S-01)', () => {
  it('세대 밖 경로는 만들지도 검증하지도 않는다', () => {
    // `certPaths` 가 실제로 만들어 내는 모양 그대로 쓴다 — 손으로 지어낸 경로로
    // 재면 진짜 경로가 바뀌었을 때 이 테스트가 조용히 무의미해진다.
    const escaping = certPaths('../../../../pwned', 'a'.repeat(32));
    expect(escaping.chain).toContain('..');

    expect(() => materializeGeneration({
      prefix,
      generation: 'r1-e1',
      planes: ['http'],
      files: {
        'nginx.conf': 'events {}\n',
        [escaping.chain]: 'CHAIN',
        [escaping.key]: 'KEY',
      },
      modes: { [escaping.key]: 0o400 },
    })).toThrow(/세대 밖|경로/);

    // **던지는 것만으로는 부족하다.** 던지기 전에 이미 썼으면 소용없다.
    // `certs/../../../../pwned` 는 certs → r1-e1 → generations → prefix 를 거슬러
    // 샌드박스 바로 아래에 떨어진다.
    const outside = join(prefix, 'generations', 'r1-e1', escaping.chain);
    expect(outside.startsWith(join(sandbox, 'pwned'))).toBe(true);
    expect(existsSync(outside)).toBe(false);
    expect(existsSync(join(sandbox, 'pwned'))).toBe(false);
  });

  it('manifest 에 `..` 이 있으면 검증이 거부한다', () => {
    // 정상 세대를 만든 뒤 manifest 만 갈아 끼운다. digest 는 맞게 계산해서,
    // **digest 검사로는 안 걸리는** 경로라는 것을 분명히 한다.
    const dir = join(prefix, 'generations', 'g1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nginx.conf'), 'events {}\n');

    // 세대 밖에 진짜 파일을 둔다 — 검증기가 그것을 읽어 "있다" 고 답하는 경로다.
    const outsideDir = join(prefix, 'generations');
    writeFileSync(join(outsideDir, 'escape.txt'), 'OUTSIDE');

    const files = {
      'nginx.conf': sha('events {}\n'),
      '../escape.txt': sha('OUTSIDE'),
    };
    writeFileSync(join(dir, MANIFEST_NAME), JSON.stringify({
      schema: 1,
      generation: 'g1',
      files,
      digest: digestOfFiles(files, ['http']),
      planes: ['http'],
    }));

    expect(() => verifyGeneration(prefix, 'g1', undefined, ['http']))
      .toThrow(/세대 밖|경로/);
  });
});
