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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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
  ['src/dp/apply.ts:FakeEffects', '주입 가능한 Effects 계약의 참조 구현'],
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

const files = walk(SRC).sort();
const rel = (p) => relative(ROOT, p);

/** 파일별 { exports, imports, used } */
const info = new Map();

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

  const collectName = (node) => {
    if (ts.isIdentifier(node.name ?? {})) exports.add(node.name.text);
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

    if (ts.isIdentifier(node)) bump(node.text);
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  info.set(rel(path), { exports, imports, used });
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
