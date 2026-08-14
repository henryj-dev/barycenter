#!/usr/bin/env node
/**
 * 공개 표면 계측기 — "계약이 움직였는가" 에 의견 대신 숫자로 답한다.
 *
 * 13차 검수가 동결 기준을 줬다: **여러 적대적 회차 동안 `.d.ts` 가 변하지 않을 것.**
 * 그런데 그걸 재는 도구가 없어서 매번 손으로 diff 했고, 그러다 보니 "표면이 안정적인가"
 * 가 인상 비평이 됐다. 여기서 기계가 답하게 한다.
 *
 * 재는 것은 **`src/index.ts` 가 내보내는 것의 폐포(closure)** 다. 내부 상태기계가 아니라
 * 소비자가 실제로 보는 모양이다 — `DpAgent` 의 메서드가 하나 늘어도 표면은 그대로다.
 * 5차에 세운 "불투명 payload + CAS" 경계가 그걸 위한 것이었다.
 *
 *   node scripts/surface.mjs            표면을 찍고 해시를 낸다
 *   node scripts/surface.mjs --check    SURFACE.txt 와 대조한다 (다르면 exit 1)
 *   node scripts/surface.mjs --write    계약을 옮겼다 — 기준을 갱신하고 카운터를 0 으로
 *   node scripts/surface.mjs --round    검수 한 회차가 표면을 안 건드리고 지나갔다
 *
 * 주석은 뺀다. 문서를 고쳤다고 계약이 움직인 것은 아니다.
 *
 * 계측기 자체도 뮤테이션으로 확인했다 — 표면 타입에 필드를 넣으면 잡고, 중첩 타입만
 * 바꿔도 잡고(폐포), 내부 `DpAgent` 에 메서드를 넣으면 **안 잡는다.** 셋 다 맞아야
 * 이 숫자가 뜻을 갖는다.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'SURFACE.txt');

/** tsconfig 를 그대로 쓴다 — 표면은 컴파일러 설정에 따라 달라진다 (`exactOptionalPropertyTypes` 등). */
function compilerOptions() {
  const found = ts.findConfigFile(ROOT, ts.sys.fileExists, 'tsconfig.json');
  const raw = ts.readConfigFile(found, ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, ROOT);
  return parsed.options;
}

/** `.d.ts` 를 낸다. 구현체가 아니라 선언만 봐야 표면이 구현 변경에 흔들리지 않는다. */
function emitDeclarations() {
  const out = mkdtempSync(join(tmpdir(), 'barycenter-surface-'));
  const program = ts.createProgram([join(ROOT, 'src/index.ts')], {
    ...compilerOptions(),
    declaration: true,
    emitDeclarationOnly: true,
    outDir: out,
    noEmit: false,
  });
  const result = program.emit();
  const errors = result.diagnostics.filter((d) => d.category === ts.DiagnosticCategory.Error);
  if (errors.length > 0) {
    const first = ts.flattenDiagnosticMessageText(errors[0].messageText, ' ');
    throw new Error(`선언을 낼 수 없다: ${first}`);
  }
  return out;
}

/**
 * `index.d.ts` 에서 시작해 **닿는 선언을 전부** 모은다.
 *
 * 폐포를 잡지 않으면 중첩 타입이 바뀐 것을 놓친다 — `ApplyOperation` 은 그대로인데
 * 그 안의 `PlaneTarget` 이 바뀌는 경우가 그렇다. 소비자에게는 계약이 바뀐 것이다.
 */
function collectSurface(dtsDir) {
  const entry = join(dtsDir, 'index.d.ts');
  const program = ts.createProgram([entry], { ...compilerOptions(), noEmit: true });
  const checker = program.getTypeChecker();
  const entrySource = program.getSourceFile(entry);
  const moduleSymbol = checker.getSymbolAtLocation(entrySource);
  if (moduleSymbol === undefined) throw new Error('index.d.ts 를 모듈로 읽지 못했다');

  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed });
  /** 이름 → 선언 텍스트. 같은 이름이 여러 선언을 가질 수 있어 배열로 모은다. */
  const collected = new Map();
  const seen = new Set();

  const declarationsOf = (symbol) => {
    const target = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
    return target.getDeclarations() ?? [];
  };

  /** 선언 안에서 참조하는 타입 이름을 따라간다 — 우리 소스에 있는 것만. */
  const walkReferences = (node, visit) => {
    const inner = (n) => {
      if (ts.isTypeReferenceNode(n) || ts.isExpressionWithTypeArguments(n)) {
        const name = ts.isTypeReferenceNode(n) ? n.typeName : n.expression;
        const symbol = checker.getSymbolAtLocation(name);
        if (symbol !== undefined) visit(symbol);
      }
      ts.forEachChild(n, inner);
    };
    ts.forEachChild(node, inner);
  };

  const take = (name, symbol) => {
    const declarations = declarationsOf(symbol);
    for (const declaration of declarations) {
      const file = declaration.getSourceFile();
      // 우리 소스에서 온 것만 본다. lib.d.ts 와 @types 는 표면이 아니다.
      if (!file.fileName.startsWith(dtsDir)) continue;
      const key = `${file.fileName}:${declaration.pos}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const text = printer.printNode(ts.EmitHint.Unspecified, declaration, file);
      const bucket = collected.get(name) ?? [];
      bucket.push(text);
      collected.set(name, bucket);

      // 폐포: 이 선언이 참조하는 것도 표면이다.
      walkReferences(declaration, (referenced) => {
        const referencedName = referenced.getName();
        take(referencedName, referenced);
      });
    }
  };

  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    take(exported.getName(), exported);
  }
  return collected;
}

/** 정렬해 정규화한다 — export 순서를 바꿨다고 계약이 움직인 것은 아니다. */
function render(collected) {
  const lines = [];
  for (const name of [...collected.keys()].sort()) {
    for (const text of collected.get(name).sort()) {
      lines.push(`── ${name}`);
      // 들여쓰기 폭 같은 것으로 흔들리지 않게 다듬는다.
      for (const line of text.split('\n')) {
        const trimmed = line.replace(/\s+$/, '');
        if (trimmed !== '') lines.push(trimmed);
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

const mode = process.argv[2];
let dtsDir;
try {
  dtsDir = emitDeclarations();
  const body = render(collectSurface(dtsDir));
  const digest = `sha256:${createHash('sha256').update(body).digest('hex')}`;
  const symbols = body.split('\n').filter((l) => l.startsWith('── ')).length;

  /** 헤더에 카운터가 산다. 대조는 **본문만** 한다 — 카운터가 자기 자신을 흔들면 안 된다. */
  const MARK = '\n\n';
  const readBaseline = () => {
    let raw;
    try {
      raw = readFileSync(BASELINE, 'utf8');
    } catch {
      return undefined;
    }
    const at = raw.indexOf(MARK);
    const header = raw.slice(0, at);
    const rounds = /동결 카운터: (\d+)/.exec(header)?.[1];
    return { body: raw.slice(at + MARK.length), rounds: rounds === undefined ? 0 : Number(rounds) };
  };
  const stamp = (rounds) =>
    `# barycenter v0.1 공개 표면\n`
    + `# ${symbols} 심볼 · ${digest}\n`
    + `# 동결 카운터: ${rounds} 회차 (표면이 안 움직인 검수 회차 수)\n`
    + `#\n`
    + `# 이 파일은 scripts/surface.mjs 가 만든다. 손으로 고치지 않는다.\n`
    + `# 13차 검수가 준 동결 기준: 여러 적대적 회차 동안 이 파일이 변하지 않을 것.\n`
    + `# 계약이 움직이면 카운터는 0 부터 다시 센다.\n\n${body}`;

  const previous = readBaseline();

  if (mode === '--write') {
    // 계약을 옮겼다. 카운터는 0 부터 다시 센다.
    writeFileSync(BASELINE, stamp(0));
    console.log(`SURFACE.txt 를 갱신했다 — ${symbols} 심볼 · ${digest} · 동결 카운터 0 으로 되돌림`);
  } else if (mode === '--round') {
    // 검수 한 회차가 표면을 안 건드리고 지나갔다.
    if (previous === undefined || previous.body !== body) {
      console.error('표면이 움직인 상태다 — 먼저 --check 로 확인한다');
      process.exit(1);
    }
    writeFileSync(BASELINE, stamp(previous.rounds + 1));
    console.log(`동결 카운터: ${previous.rounds} → ${previous.rounds + 1} 회차`);
  } else if (mode === '--check') {
    if (previous === undefined) {
      console.error('SURFACE.txt 가 없다 — `node scripts/surface.mjs --write` 로 기준을 만든다');
      process.exit(1);
    }
    if (previous.body === body) {
      console.log(`표면 그대로 — ${symbols} 심볼 · ${digest} · 동결 카운터 ${previous.rounds} 회차`);
    } else {
      const before = previous.body.split('\n');
      const after = body.split('\n');
      const moved = after.filter((l) => l.startsWith('── ') && !before.includes(l));
      const gone = before.filter((l) => l.startsWith('── ') && !after.includes(l));
      console.error('표면이 움직였다.');
      for (const l of gone) console.error(`  - ${l.slice(3)}`);
      for (const l of moved) console.error(`  + ${l.slice(3)}`);
      if (moved.length === 0 && gone.length === 0) {
        console.error('  (심볼 목록은 같고 모양이 바뀌었다 — `git diff SURFACE.txt` 로 본다)');
      }
      console.error('\n계약을 바꾼 것이 맞으면 `node scripts/surface.mjs --write` 로 기준을 옮긴다.');
      console.error('그러면 동결 카운터는 0 부터 다시 센다.');
      process.exit(1);
    }
  } else {
    process.stdout.write(stamp(previous?.rounds ?? 0));
  }
} finally {
  if (dtsDir !== undefined) rmSync(dtsDir, { recursive: true, force: true });
}
