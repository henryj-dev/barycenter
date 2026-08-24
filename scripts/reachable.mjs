#!/usr/bin/env node
/**
 * **도달성 게이트 — "테스트는 초록인데 배선이 없다" 를 기계로 잡는다**
 *
 * 2026-08-22 검수가 같은 부류를 셋 찾았다. 전부 구현돼 있고 단위 테스트도 초록인데
 * **프로덕션 호출자가 0개**였다:
 *
 *   · `checkEngineConstraints` — PROXY 수신+송신 체인을 막는다고 적어 둔 방어
 *   · `certCoversHost`         — 인증서 SAN 이 호스트를 덮는지 (S17 이 겨눈 실패)
 *   · `validateHeaderValue`    — 변수 화이트리스트까지 구현된 문자열 검증
 *
 * 그리고 `poolsReachedBy` 는 두 파일에서 **import 만 되고 안 쓰였다.**
 *
 * 테스트가 초록이라 CI 에서 안 보인다. 표면 계측기(`surface.mjs`)도 못 잡는다 —
 * 그건 "무엇을 내보내는가" 를 재지 "그것을 누가 쓰는가" 를 재지 않는다.
 *
 * ── 무엇을 실패로 보는가 ────────────────────────────────────────────────
 *
 *   1. **미사용 import** — 가져와 놓고 안 쓴다. 계약이 옮겨 갔다는 신호다.
 *   2. **호출자 없는 export** — 공개 표면(`src/index.ts`)에도 없고, 다른 `src/` 파일이
 *      import 하지도 않는다. 테스트만 부르는 코드다.
 *   3. **호출자 없는 public 메서드** — 2026-08-24 검수(D1·G6)가 더했다. 아래 참조.
 *
 * ── 왜 메서드까지 세는가 (검수 G6)
 *
 * 2026-08-24 검수가 `FsSecretStore.versions()` 를 손으로 찾았다 — **호출자가 0 개인
 * public 메서드**였고, 그것이 시크릿 GC 의 root 수집이 필요로 하던 재료였다(D1).
 * 재료가 있는데 아무도 안 쓰고 있었다는 사실이 그 결함의 신호였는데, 이 게이트는
 * **export 된 이름만** 세느라 못 봤다.
 *
 * 이름을 세는 것과 **그 이름이 무엇을 하는 이름인지** 세는 것은 다르다. 클래스는
 * export 돼 있고 쓰이므로 ② 는 초록이다 — 죽은 것은 그 안의 메서드 하나다.
 *
 * 판정은 **속성 접근**으로 한다(`x.foo` · `x?.foo` · `x['foo']`). 선언은 속성 접근이
 * 아니므로 ② 가 한때 물렸던 함정("선언 자체가 사용으로 보인다")이 여기서는 없다.
 *
 * ── 무엇을 실패로 보지 않는가 ───────────────────────────────────────────
 *
 *   · 공개 표면의 폐포 — 소비자가 쓰라고 낸 것이다 (`surface.mjs` 가 따로 잰다)
 *   · 진입점(`src/bin/**`)의 export — 실행이 소비자다
 *   · 같은 파일 안에서만 쓰이는 export — 다른 파일이 import 하면 살아난다
 *
 * 예외가 필요하면 `ALLOW` 에 **이유와 함께** 적는다. 목록이 자라는 것 자체가 신호다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

/**
 * 저장소 루트. **테스트가 갈아 끼운다** (검수 G6).
 *
 * 게이트를 재는 방법은 픽스처 트리에 대고 돌려 보는 것뿐이다 — 이 저장소의 `src/` 는
 * 초록이어야 하므로 여기서는 아무 신호도 안 나온다. `pinned.mjs` 가 순수 로직을
 * `pinned-lib.mjs` 로 뽑아 잰 것과 같은 이유이고, 여기서는 파일시스템을 훑는 것이
 * 일의 전부라 **루트를 바꾸는 편**이 그 자리를 만든다.
 */
const ROOT = process.env['BARY_REACHABLE_ROOT'] !== undefined
  ? resolve(process.env['BARY_REACHABLE_ROOT'])
  : resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/**
 * 아는 예외. **이유를 적는다** — 이유를 못 적으면 그건 예외가 아니라 부채다.
 */
const ALLOW = new Map([
  // 진입점. 실행이 소비자이고, 테스트가 import 할 수 있어야 한다(파일 끝의 argv 가드).
  ['src/bin/barycenterd.ts:main', '진입점 — 실행이 소비자다'],
  ['src/bin/bary.ts:main', '진입점 — 실행이 소비자다'],

  // **의도된 테스트 이음새.** 이 설계는 store·effects·sink 를 주입으로 갈아 끼운다
  // (§9.2 가 `LocalDataplaneDriver.create({store, effects})` 로 고정한 그 모양이다).
  // 프로덕션 호출자가 없는 것이 정상이고, 없어지면 그 계약을 잴 방법이 사라진다.
  ['src/dp/agent.ts:MemoryStore', '주입 가능한 store 계약의 참조 구현'],
  ['src/dp/agent.ts:EvidenceRecord', '위 계약의 타입'],
  ['src/dp/apply.ts:FaultStore', '저장소 실패를 주입하는 이음새'],
  ['src/obs/log.ts:setSink', '로그 sink 주입 — 테스트가 한 줄씩 읽는다'],
  ['src/obs/metrics.ts:counterSnapshot', '카운터 관측 — 테스트가 증가를 잰다'],
  ['src/obs/metrics.ts:resetCounters', '카운터 되돌리기 — 테스트 간 격리'],

  // **동결 게이트의 중복.** `scripts/freeze-b.mjs` 가 같은 것을 정규식으로 다시 짰다 —
  // `.mjs` 에서 `.ts` 를 못 부르기 때문이다. 두 자리가 갈리면 동결이 거짓이 된다.
  // ⚠️ 아는 부채다: 스크립트를 `.ts` 로 옮기거나 이쪽을 지워야 한다.
  ['src/api/freeze.ts:openApiOf', '동결 게이트 중복 — scripts/freeze-b.mjs 와 한 쌍'],
  ['src/api/freeze.ts:ddlFromMigrations', '동결 게이트 중복 — 위와 같다'],
  ['src/api/freeze.ts:MIGRATIONS_DIR', '동결 게이트 중복 — 위와 같다'],
  ['src/api/server.ts:apiRouteTable', '동결 게이트가 소스를 정규식으로 읽는다 — 위와 같다'],

  // **코드로 적은 명세.** 테스트가 이 목록과 `gui/src/routes` 의 실제 디렉토리를
  // 대조한다 — 소비자가 GUI 빌드가 아니라 그 대조다.
  ['src/web/page.ts:KIT_ROUTES', 'Kit 라우트 명세 — 테스트가 실제 디렉토리와 대조한다'],

  // 순수 함수를 테스트가 직접 잰다. 모듈 안에서는 다른 조합으로 쓰인다.
  ['src/acme/der.ts:nullValue', 'DER 원시 — 테스트가 인코딩을 직접 잰다'],
  ['src/cli/backup.ts:secretRefsIn', '백업에 시크릿이 안 실리는지 테스트가 직접 잰다'],
  ['src/control/acme-store.ts:backoffSeconds', '백오프 곡선을 테스트가 직접 잰다'],

  // ── ③ 메서드 예외 (검수 G6) ─────────────────────────────────────────
  //
  // **관측 창구.** 상태를 바꾸지 않고 읽기만 하며, 프로덕션은 그 값으로 판정하지
  // 않는다(하면 그 자리가 배선이다). 테스트가 불변식을 재는 데 쓴다.
  ['src/dp/agent.ts:DpAgent.evidenceFor',
    '§6.3 근거 조회 — 사후 감사용이고 프로덕션 독자가 없다는 것이 agent.ts 의 `EVIDENCE_RETENTION` 에 적혀 있다'],
  ['src/dp/agent.ts:DpAgent.reservationOwner',
    '슬롯 주인 관측 — 판정은 `ownsSlot` 이 임계구역 안에서 한다. 밖에서 읽은 값으로 판정하면 그 사이가 벌어진다'],
  ['src/dp/apply.ts:ApplyRunner.phases',
    '지나온 단계 — 러너의 관측 창구다. §6.2 의 전이 순서를 테스트가 이것으로 잰다'],

  // **평면 단위 원시 연산** (§3.6). 러너는 `reserveAll` 로 전 평면을 한 임계구역에서
  // 잡는다 — 그것이 6차 반례 ③ 의 답이었다. 낱개 `reserve` 는 그 아래 계약이고,
  // 테스트가 평면 하나의 CAS 를 직접 재는 자리다.
  ['src/dp/agent.ts:DpAgent.reserve',
    '§3.6 평면 단위 예약 — 러너는 `reserveAll` 을 쓴다. 이것은 그 아래 계약을 테스트가 직접 재는 자리'],

  // ✅ **부채 칸이 비었다** (2026-08-24). `AcmeStore.upsertAccount` 가 여기 있었다 —
  // ACME 계정을 만드는 제품 경로가 없었고, 배선하려면 표면을 정해야 했다. W4-8 이
  // `POST /api/v1/acme/accounts` 로 정했고(DESIGN §8.2.1) 그 줄은 사라졌다.
  //
  // **이 칸을 비워 두는 것이 요점이다.** 예외와 부채를 한 목록에 섞어 두면 부채가
  // 예외처럼 읽히고, 그러면 아무도 안 갚는다.
]);

/**
 * `src/` 밖의 소비자. **GUI 가 `src/web/**` 를 쓴다** — 그걸 안 보면 뷰 모델 전부가
 * "호출자 없음" 으로 잡힌다(처음에 그랬다).
 *
 * 여기서는 "누가 이 이름을 import 하는가" 만 알면 되므로 정규식으로 충분하다.
 * `.svelte` 안의 `<script>` 도 같은 문법이다.
 */
const CONSUMER_DIRS = [join(ROOT, 'gui', 'src')];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (name.endsWith('.ts') || name.endsWith('.svelte')) out.push(path);
  }
  return out;
}

/**
 * **`src/testing/` 은 프로덕션이 아니다** (검수 G5).
 *
 * 이 게이트가 묻는 것은 「프로덕션 호출자가 있는가」인데, 저 디렉토리는 정의상 테스트와
 * 스파이크만 쓴다. 전에는 `FakeEffects` 하나를 `ALLOW` 에 심볼로 적어 뒀는데 —
 * **예외를 심볼로 적으면 그 옆에 형제가 생길 때마다 예외가 는다.** 실제로 그랬다:
 * 옮기고 나니 `FaultStore`·`CrashClock`·`publishedGeneration` 이 함께 걸렸다.
 *
 * 구조로 가른다. `tsconfig.build.json` 도 같은 경계를 쓰므로(배포 산출물에서 뺀다)
 * **한 사실을 두 곳이 같은 말로 말한다.**
 */
const NOT_PRODUCTION = [join(SRC, 'testing')];

const files = walk(SRC)
  .filter((f) => !NOT_PRODUCTION.some((d) => f.startsWith(`${d}/`)))
  .sort();
const rel = (p) => relative(ROOT, p);

/** 파일별 { exports, imports, used, members } */
const info = new Map();

/**
 * `src/` 전체에서 **속성으로 접근된** 이름들 (검수 G6).
 *
 * 파일별이 아니라 전역이다 — 메서드는 다른 파일에서 불리는 것이 정상이고,
 * `this.foo()` 도 같은 축에 든다(자기 클래스 안에서만 쓰이는 메서드는 살아 있다).
 */
const propertyUses = new Set();

for (const path of files) {
  const text = readFileSync(path, 'utf8');
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.ESNext, true);

  const exports = new Set();
  const imports = [];          // { name, from }
  /**
   * import 절 **밖**의 식별자 등장 횟수.
   *
   * 집합이 아니라 **횟수**여야 한다. 선언 자체도 식별자 노드 하나를 만들므로,
   * 집합으로 재면 `export function f()` 가 언제나 "쓰였다" 로 보인다 — 처음에
   * 그렇게 짰고 게이트가 아무것도 못 잡았다. 2 회 이상이라야 **자기 파일 안에서
   * 실제로 쓰이는** 것이다.
   */
  const used = new Map();
  const bump = (n) => used.set(n, (used.get(n) ?? 0) + 1);

  /**
   * 이 파일이 선언하는 **public 메서드** — `{ cls, name }`.
   *
   * `private` · `#이름` · `constructor` 는 뺀다. 앞의 둘은 밖에서 부를 수가 없고,
   * 생성자는 `new` 가 부르므로 속성 접근으로 안 잡힌다.
   */
  const members = [];

  const collectName = (node) => {
    if (ts.isIdentifier(node.name ?? {})) exports.add(node.name.text);
  };

  /**
   * public 메서드 하나를 모은다.
   *
   * **속성(필드)은 안 센다.** 필드는 초기화 자체가 값을 쓰는 일이라 「죽었다」의 뜻이
   * 메서드와 다르고, 여기서 겨누는 것은 *"부를 수 있는데 아무도 안 부르는 것"* 이다.
   */
  const collectMember = (cls, m) => {
    if (!ts.isMethodDeclaration(m) && !ts.isGetAccessor(m) && !ts.isSetAccessor(m)) return;
    if (!ts.isIdentifier(m.name)) return;        // `#private` · 계산된 이름
    const mods = ts.getModifiers(m) ?? [];
    if (mods.some((x) => x.kind === ts.SyntaxKind.PrivateKeyword)) return;
    members.push({ cls, name: m.name.text });
  };

  const visit = (node) => {
    // ── export 선언 ──
    const mods = ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
    const exported = mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (exported) {
      if (ts.isVariableStatement(node)) {
        for (const d of node.declarationList.declarations) collectName(d);
      } else if (
        ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)
        || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
        || ts.isEnumDeclaration(node)
      ) {
        collectName(node);
      }
      // export 된 클래스의 public 메서드를 모은다 (검수 G6).
      if (ts.isClassDeclaration(node) && ts.isIdentifier(node.name ?? {})) {
        for (const m of node.members) collectMember(node.name.text, m);
      }
    }
    // `export { A, B }` / `export { A } from '...'`
    if (ts.isExportDeclaration(node) && node.exportClause
        && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) exports.add(el.name.text);
      // 재수출은 **사용**이기도 하다 — index.ts 가 그렇게 표면을 만든다.
      if (node.moduleSpecifier) {
        for (const el of node.exportClause.elements) {
          bump((el.propertyName ?? el.name).text);
        }
      }
    }

    // ── import ──
    if (ts.isImportDeclaration(node) && node.importClause?.namedBindings
        && ts.isNamedImports(node.importClause.namedBindings)) {
      for (const el of node.importClause.namedBindings.elements) {
        imports.push({ name: el.name.text, from: node.moduleSpecifier.getText(sf) });
      }
      return;   // import 절 안의 식별자는 "사용" 이 아니다
    }
    if (ts.isImportDeclaration(node)) return;

    // ── 속성 접근 — 메서드 판정의 유일한 근거다 (검수 G6) ──
    //
    // `x.foo` · `x?.foo` 는 `PropertyAccessExpression`, `x['foo']` 는 문자열 리터럴이다.
    // **선언은 여기 안 걸린다** — 그것이 ② 가 한때 물렸던 함정을 피하는 방법이다.
    if (ts.isPropertyAccessExpression(node)) propertyUses.add(node.name.text);
    if (ts.isElementAccessExpression(node)
        && ts.isStringLiteralLike(node.argumentExpression)) {
      propertyUses.add(node.argumentExpression.text);
    }

    if (ts.isIdentifier(node)) bump(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  info.set(rel(path), { exports, imports, used, members });
}

// ── 공개 표면: index.ts 가 재수출하는 이름 ─────────────────────────────
const surface = new Set(info.get('src/index.ts')?.used.keys() ?? []);

// ── 누가 무엇을 import 하는가 ──────────────────────────────────────────
const importedSomewhere = new Set();
for (const [file, i] of info) {
  if (file === 'src/index.ts') continue;
  for (const imp of i.imports) importedSomewhere.add(imp.name);
}
for (const dir of CONSUMER_DIRS) {
  let consumers = [];
  try { consumers = walk(dir); } catch { continue; }   // GUI 가 없는 체크아웃도 있다
  for (const path of consumers) {
    const text = readFileSync(path, 'utf8');
    for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from/g)) {
      for (const piece of m[1].split(',')) {
        const name = piece.trim().split(/\s+as\s+/)[0].replace(/^type\s+/, '').trim();
        if (name !== '') importedSomewhere.add(name);
      }
    }
    // 소비자의 속성 접근도 센다 — 화면이 뷰 모델의 메서드를 부른다 (검수 G6).
    // 여기서는 "누가 이 이름을 만지는가" 만 알면 되므로 정규식으로 충분하다.
    for (const m of text.matchAll(/[?.]\s*([A-Za-z_$][\w$]*)/g)) propertyUses.add(m[1]);
  }
}

const problems = [];

// ① 미사용 import
for (const [file, i] of info) {
  for (const imp of i.imports) {
    if ((i.used.get(imp.name) ?? 0) === 0) {
      problems.push(`미사용 import  ${file}  ${imp.name}  ← ${imp.from}`);
    }
  }
}

// ② 호출자 없는 export
for (const [file, i] of info) {
  if (file === 'src/index.ts') continue;
  for (const name of i.exports) {
    if (ALLOW.has(`${file}:${name}`)) continue;
    if (surface.has(name)) continue;             // 공개 표면
    if (importedSomewhere.has(name)) continue;   // 다른 src 파일이 쓴다
    // **자기 파일 안에서 쓰이면 살아 있다.** 선언이 식별자 하나를 만드므로 2 회부터다 —
    // 모듈 안의 도우미를 테스트가 직접 부르려고 내보내는 것은 정당하다.
    if ((i.used.get(name) ?? 0) >= 2) continue;
    problems.push(`호출자 없음     ${file}  ${name}`);
  }
}

// ③ 호출자 없는 public 메서드 (검수 G6)
for (const [file, i] of info) {
  for (const { cls, name } of i.members ?? []) {
    if (ALLOW.has(`${file}:${cls}.${name}`)) continue;
    // **클래스가 이미 예외면 그 안도 예외다.** 주입 이음매(`MemoryStore`·`FakeEffects`)는
    // 프로덕션 호출자가 없는 것이 정상이고, 그 근거는 클래스 단위로 이미 적혀 있다.
    if (ALLOW.has(`${file}:${cls}`)) continue;
    // **공개 표면의 클래스는 안 센다.** 밖의 소비자가 부를 수 있고 그들은 여기 안 보인다.
    // 그 폐포는 `surface.mjs` 가 따로 잰다.
    if (surface.has(cls)) continue;
    if (propertyUses.has(name)) continue;
    problems.push(`부르는 데 없음  ${file}  ${cls}.${name}`);
  }
}

if (problems.length === 0) {
  console.log(`도달성 ok — ${files.length} 파일, 예외 ${ALLOW.size} 건`);
  process.exit(0);
}

console.error('도달하지 못하는 것이 있다:\n');
for (const p of problems.sort()) console.error(`  ${p}`);
console.error(
  '\n배선하거나 지운다. 정말 예외면 scripts/reachable.mjs 의 ALLOW 에 **이유와 함께** 적는다.',
);
process.exit(1);
