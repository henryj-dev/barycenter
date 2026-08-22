/**
 * 세대 materializer — DESIGN.md §7.2 · §6.2 #2
 *
 * 6차 검수: **오퍼레이션과 활성화할 artifact 가 결박돼 있지 않다.**
 *
 *   · `publish()` 는 디렉토리와 `nginx.conf` 의 **존재만** 확인했다.
 *   · `payloadDigest` 를 실제 바이트와 대조하지 않았다.
 *   · 세대 디렉토리를 원자적으로 만드는 코드가 아예 없었다 — 테스트가 미리 써 뒀다.
 *
 * 그래서 같은 세대 이름 아래 **임의의 바이트를 활성화하고 좌표까지 commit** 할 수 있었다.
 *
 * 여기서 세 가지를 세운다.
 *
 *   1. **원자적 게시.** `.tmp-<이름>-<nonce>/` 에 전부 쓰고 fsync 한 뒤 통째로 rename.
 *      반쯤 쓰인 세대 디렉토리가 `generations/` 에 보이는 순간이 없다.
 *   2. **manifest.** 파일별 digest 와 세대 digest 를 함께 적는다. 활성화 직전에 대조한다.
 *   3. **같은 이름에 다른 내용은 거부.** 세대는 불변이다. 이름이 같은데 바이트가 다르면
 *      둘 중 하나는 거짓말이고, 어느 쪽인지 알 방법이 없다.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join, relative, resolve, sep } from 'node:path';

export const MANIFEST_NAME = 'manifest.json';
export const MANIFEST_SCHEMA = 1;

export class GenerationError extends Error {
  constructor(
    readonly kind:
      | 'generation_conflict'
      | 'manifest_missing'
      | 'digest_mismatch'
      | 'incomplete'
      /** 세대가 구성하는 평면과 오퍼레이션이 선언한 평면이 다르다 (10차 반례 ②). */
      | 'plane_mismatch'
      /**
       * 세대 안의 상대경로가 세대 밖을 가리킨다 (검수 S-01).
       *
       * 인증서 경로가 리소스 key 에서 오므로 key 하나로 세대를 벗어날 수 있었다.
       * 처음엔 일반 `Error` 로 막았다 — 이 유니온이 공개 표면이라 종류를 늘리면 동결
       * 카운터가 리셋되기 때문이다. 표면 회차에 함께 올린다: 호출자가 이 실패를
       * `digest_mismatch` 나 `incomplete` 와 **구분해서** 다룰 수 있어야 한다.
       */
      | 'path_escape',
    message: string,
  ) {
    super(message);
    this.name = 'GenerationError';
  }
}

export type GenerationManifest = {
  schema: number;
  generation: string;
  /** 파일 경로 → sha256. 경로는 세대 디렉토리 기준 상대경로다. */
  files: Record<string, string>;
  /** 세대 전체의 digest. `files` 를 정렬해 이어 붙인 것의 sha256. */
  digest: string;
  /**
   * 이 세대가 구성하는 평면들 (10차 반례 ②).
   *
   * 활성화하면 이 평면들이 **함께** 바뀐다. 오퍼레이션이 그중 일부만 선언하면 나머지
   * 평면의 좌표가 옛 값으로 남는다 — 그건 조용한 갈라짐이다.
   */
  planes: ('http' | 'stream')[];
};

const sha256 = (buf: Buffer | string): string =>
  `sha256:${createHash('sha256').update(buf).digest('hex')}`;

/**
 * 세대 안의 상대경로가 **정말 세대 안인가.**
 *
 * 세대의 파일 이름은 모델에서 온다 — 인증서 경로가 `certs/<key>/<version>/...` 이므로
 * **리소스 key 가 그대로 경로가 된다** (`certPaths`). 그런데 `join` 은 `..` 을 정규화하므로
 * key 하나로 세대 밖에 파일을 쓸 수 있었다. 검수에서 실행으로 재현했다:
 * `key='../../../../pwned'` 가 prefix 밖에 개인키를 남겼고 `verifyGeneration` 도 통과했다.
 *
 * **문법 검사만으로는 부족하다.** 저장 경계(`shapeCheck`)가 앞으로 들어올 key 를 막아도
 * *이미 저장된* 것은 못 막는다. 그리고 세대 파일 이름이 언젠가 다른 곳에서도 오게 되면
 * 그때 이 방어가 다시 필요해진다 — 값이 아니라 **경계**에 거는 것이 맞다.
 *
 * `GenerationError('path_escape')` 다. 호출자가 이 실패를 `digest_mismatch` 나
 * `incomplete` 와 구분해서 다룰 수 있어야 한다 — 앞엣것은 "바이트가 다르다" 이고
 * 이건 "애초에 여기 있으면 안 되는 것" 이다.
 */
function assertInside(base: string, rel: string): void {
  const target = resolve(base, rel);
  const root = resolve(base);
  const inside = target !== root && relative(root, target).split(sep)[0] !== '..';
  if (!inside) {
    throw new GenerationError(
      'path_escape',
      `세대 밖을 가리키는 경로다: ${JSON.stringify(rel)} — 세대는 자기완결적이어야 한다`,
    );
  }
}

/**
 * 세대 digest. **파일 목록과 내용을 모두 덮는다.**
 *
 * 내용만 해싱하면 파일이 하나 빠져도 같은 값이 나올 수 있다. 경로를 함께 넣는다.
 */
export function digestOfFiles(
  files: Record<string, string>,
  planes: readonly ('http' | 'stream')[] = [],
): string {
  const canonical = Object.keys(files)
    .sort()
    .map((k) => `${k} ${files[k]}`)
    .join('');
  // **평면도 digest 에 들어간다** (11차 검수). 안 그러면 manifest 의 planes 만 변조해도
  // 검증을 통과한다 — 내용은 그대로인데 "무엇을 바꾸는가" 만 거짓이 된다.
  return sha256(`${canonical}|planes=${[...planes].sort().join(',')}`);
}

function writeFileDurable(path: string, body: string, mode?: number): void {
  const fd = openSync(path, 'wx', mode);
  try {
    writeSync(fd, body, 0, 'utf8');
    // 파일 내용을 먼저 내린다. rename 이 먼저 보이면 빈 파일이 정본이 된다.
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDir(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * 세대를 만든다. **전부 쓰이거나 하나도 안 보이거나** 둘 중 하나다.
 *
 * 이미 같은 이름이 있으면 digest 를 대조한다. 같으면 멱등이고, 다르면 거부다 —
 * 세대는 불변이라 같은 이름에 다른 바이트가 있을 수 없다.
 */
export function materializeGeneration(opts: {
  prefix: string;
  generation: string;
  files: Record<string, string>;
  /** 이 세대가 구성하는 평면들. 렌더러가 답한다 (`RenderedConfig.planes`). */
  planes: ('http' | 'stream')[];
  /**
   * 파일별 퍼미션. 안 적으면 프로세스 umask 를 따른다.
   *
   * **개인키 때문에 생겼다.** §7.2 는 인증서를 세대 **안**에 두라고 하고(S8), 그러면
   * 개인키가 세대 디렉토리에 앉는다. 기본 umask 로 쓰면 0644 가 되어, `SecretStore` 가
   * 0400 으로 지킨 것을 세대가 도로 푸는 셈이 된다.
   *
   * digest 에는 안 들어간다 — 같은 바이트면 같은 세대다. 퍼미션은 내용이 아니다.
   */
  modes?: Record<string, number>;
}): GenerationManifest {
  const { prefix, generation, files, planes } = opts;
  const modes = opts.modes ?? {};
  const root = join(prefix, 'generations');
  const target = join(root, generation);
  // **아무것도 만들기 전에 본다.** 뒤에서 걸러도 이미 쓴 파일은 남는다.
  for (const rel of Object.keys(files)) assertInside(target, rel);
  mkdirSync(root, { recursive: true });

  const fileDigests: Record<string, string> = {};
  for (const [rel, body] of Object.entries(files)) fileDigests[rel] = sha256(body);
  const manifest: GenerationManifest = {
    schema: MANIFEST_SCHEMA,
    generation,
    files: fileDigests,
    digest: digestOfFiles(fileDigests, planes),
    planes: [...planes].sort(),
  };

  if (existsSync(target)) {
    const existing = readManifest(prefix, generation);
    if (existing.digest !== manifest.digest) {
      throw new GenerationError(
        'generation_conflict',
        `세대 '${generation}' 가 이미 있고 내용이 다르다 (${existing.digest} ≠ ${manifest.digest}). ` +
          `세대는 불변이다`,
      );
    }
    return existing;
  }

  // `.tmp-` 로 시작하는 이름은 세대 이름 규칙상 나올 수 없다 — 조회에서 건너뛴다.
  const tmp = join(root, `.tmp-${generation}-${randomBytes(8).toString('hex')}`);
  try {
    mkdirSync(tmp, { recursive: true });
    for (const [rel, body] of Object.entries(files)) {
      const dest = join(tmp, rel);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileDurable(dest, body, modes[rel]);
    }
    // manifest 를 **마지막에** 쓴다. 이게 있으면 나머지도 있다는 뜻이 된다.
    writeFileDurable(join(tmp, MANIFEST_NAME), JSON.stringify(manifest));
    fsyncDir(tmp);
    renameSync(tmp, target);
    fsyncDir(root);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  return manifest;
}

export function readManifest(prefix: string, generation: string): GenerationManifest {
  const path = join(prefix, 'generations', generation, MANIFEST_NAME);
  if (!existsSync(path)) {
    throw new GenerationError(
      'manifest_missing',
      `세대 '${generation}' 에 ${MANIFEST_NAME} 이 없다 — 완성되지 않았거나 우리가 만든 것이 아니다`,
    );
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as GenerationManifest;
  if (parsed.schema !== MANIFEST_SCHEMA) {
    throw new GenerationError('manifest_missing', `모르는 manifest 스키마 ${parsed.schema}`);
  }
  return parsed;
}

/**
 * 활성화 직전 검사. **디스크의 바이트를 실제로 다시 읽어 대조한다.**
 *
 * manifest 를 믿고 넘어가면 manifest 만 맞고 내용이 바뀐 세대를 활성화한다.
 */
/**
 * 세대 디렉토리 안의 **모든 파일**을 상대경로로 훑는다.
 *
 * 빈 디렉토리는 나오지 않는다 — manifest 가 파일만 담으므로 대조 단위도 파일이어야
 * 한다. 디렉토리를 대조 단위로 삼았다가 `admin/` 을 "모르는 파일" 로 오판했다.
 */
function walkFiles(dir: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out;
}

export function verifyGeneration(
  prefix: string,
  generation: string,
  expectedDigest?: string,
  expectedPlanes?: readonly ('http' | 'stream')[],
): GenerationManifest {
  const manifest = readManifest(prefix, generation);
  if (expectedPlanes !== undefined) {
    // **포함 관계다** (11차 반례 ②). 설정 apply 는 항상 두 평면을 선언하고, 세대는
    // 그중 일부만 구성할 수 있다 — 비는 평면도 전환이기 때문이다. 반대로 세대가
    // 구성하는데 선언하지 않은 평면이 있으면 그 좌표가 옛 값으로 남는다.
    const declared = new Set(expectedPlanes);
    const missing = manifest.planes.filter((p) => !declared.has(p));
    if (missing.length > 0) {
      throw new GenerationError(
        'plane_mismatch',
        `세대 '${generation}' 는 [${manifest.planes.join(',')}] 를 구성하는데 오퍼레이션은 ` +
          `[${[...expectedPlanes].join(',')}] 만 말한다 — [${missing.join(',')}] 의 좌표가 옛 값으로 남는다`,
      );
    }
  }
  if (expectedDigest !== undefined && manifest.digest !== expectedDigest) {
    throw new GenerationError(
      'digest_mismatch',
      `세대 '${generation}' 의 digest 가 오퍼레이션과 다르다 ` +
        `(${manifest.digest} ≠ ${expectedDigest}) — 같은 이름, 다른 바이트다`,
    );
  }

  const dir = join(prefix, 'generations', generation);
  const actual: Record<string, string> = {};
  for (const rel of Object.keys(manifest.files)) {
    // **digest 검사로는 안 걸린다.** 세대 밖 파일을 읽어 해싱하면 값은 맞아떨어진다 —
    // manifest 가 무엇을 가리키는지는 내용과 별개의 물음이다.
    assertInside(dir, rel);
    const path = join(dir, rel);
    if (!existsSync(path)) {
      throw new GenerationError('incomplete', `세대 '${generation}' 에 '${rel}' 이 없다`);
    }
    actual[rel] = sha256(readFileSync(path));
  }
  // manifest 에 없는 파일이 디렉토리에 있으면 그것도 불일치다.
  //
  // **하위 디렉토리까지 내려간다.** 처음엔 `readdirSync(dir)` 한 겹만 봤고, 그건 세대가
  // 평평할 때만 맞는다. §7.2 의 레이아웃은 처음부터 중첩이다 —
  // `http/`, `stream/`, `lua/`, `certs/<certificate_id>/`. v0.1 이 `admin/marker.conf`
  // 하나를 넣자마자 걸렸다:
  //
  //   세대 'r3-e2' 에 manifest 에 없는 'admin' 가 있다
  //
  // 디렉토리 이름을 파일 이름과 대조하고 있었으니 당연히 안 맞는다. **설계가 이미 말한
  // 모양을 검사기가 못 읽고 있었다.**
  const known = new Set(Object.keys(manifest.files));
  for (const rel of walkFiles(dir)) {
    if (rel === MANIFEST_NAME) continue;
    if (!known.has(rel)) {
      throw new GenerationError('digest_mismatch', `세대 '${generation}' 에 manifest 에 없는 '${rel}' 이 있다`);
    }
  }

  const recomputed = digestOfFiles(actual, manifest.planes);
  if (recomputed !== manifest.digest) {
    throw new GenerationError(
      'digest_mismatch',
      `세대 '${generation}' 의 내용이 manifest 와 다르다 (${recomputed} ≠ ${manifest.digest})`,
    );
  }
  return manifest;
}
