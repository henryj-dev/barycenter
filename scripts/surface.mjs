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
 *   node scripts/surface.mjs --freeze   3 회차 이상이면 A 표면을 동결한다
 *   node scripts/surface.mjs --freeze-check  동결 상태와 현재 표면을 대조한다
 *   node scripts/surface.mjs --unfreeze "<근거>"  동결을 푼다 — 근거가 파일에 남는다
 *
 * **`--unfreeze` 는 왜 따로인가.** 원래 여기엔 해제 경로가 아예 없었고, 그건 의도였다 —
 * 동결을 푸는 것은 계측기가 낼 수 있는 판단이 아니라 사람이 지는 결정이다. 그런데 없는
 * 것과 못 하는 것은 다르다: 결정이 실제로 나자 `SURFACE.txt` 를 손으로 고치는 것 말고는
 * 길이 없었고, 그 파일 머리에는 *"손으로 고치지 않는다"* 가 적혀 있다. **막다른 길은
 * 규칙을 지키는 게 아니라 규칙을 어기게 만든다.**
 *
 * 그래서 길을 내되 **싸지 않게** 낸다. `--write` 는 동결 상태에서 여전히 하드 차단이다 —
 * 계약을 옮기다가 실수로 동결까지 함께 풀리는 일이 없어야 하므로 해제는 **별도의 행위**다.
 * 그리고 근거 문자열을 **요구한다**: 근거 없는 해제는 다음 사람이 "왜 풀렸지" 를 물을 때
 * 답이 없고, 답이 없으면 이 게이트가 쌓아 온 것이 조용히 사라진다. 근거는 파일에 남는다.
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
const BASELINE = process.env.BARYCENTER_SURFACE_BASELINE ?? join(ROOT, 'SURFACE.txt');
const FREEZE_ROUNDS = 3;

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

  /**
   * **private 멤버는 표면이 아니다** (14차 검수).
   *
   * `.d.ts` 는 `private tmpCounter;` 같은 줄을 남긴다 — 배치를 보존해야 하기 때문이다.
   * 그런데 소비자는 그걸 부를 수 없다. 해시에 넣으면 **이름만 바꿔도 동결 카운터가
   * 0 으로 리셋된다.** 실제 호환성 비용을 과대평가하는 것이고, 그러면 이 숫자가 재는
   * 것이 계약이 아니라 리팩터링 빈도가 된다.
   */
  const strip = (declaration) => {
    if (!ts.isClassDeclaration(declaration)) return declaration;
    const visible = declaration.members.filter((m) => {
      const mods = ts.canHaveModifiers(m) ? (ts.getModifiers(m) ?? []) : [];
      if (mods.some((mod) => mod.kind === ts.SyntaxKind.PrivateKeyword)) return false;
      // `#name` 형태도 부를 수 없다.
      return !(m.name !== undefined && ts.isPrivateIdentifier(m.name));
    });
    return ts.factory.updateClassDeclaration(
      declaration,
      declaration.modifiers,
      declaration.name,
      declaration.typeParameters,
      declaration.heritageClauses,
      visible,
    );
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

      const text = printer.printNode(ts.EmitHint.Unspecified, strip(declaration), file);
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
    if (at < 0) return undefined;
    const header = raw.slice(0, at);
    const lines = header.split('\n');
    const exactlyOne = (pattern) => {
      const matches = lines.map((line) => pattern.exec(line)).filter((match) => match !== null);
      return matches.length === 1 ? matches[0] : undefined;
    };
    const rounds = exactlyOne(/^# 동결 카운터: (\d+) 회차 \(표면이 안 움직인 검수 회차 수\)$/)?.[1];
    const claimed = exactlyOne(/^# (\d+) 심볼 · (sha256:[0-9a-f]{64})$/);
    const freeze = exactlyOne(/^# A 동결: (선언|미선언) \(선언 기준 (\d+) 회차\)$/);
    if (rounds === undefined || claimed === undefined || freeze === undefined
      || Number(freeze[2]) !== FREEZE_ROUNDS) return undefined;
    // 해제 근거는 **선택**이다 — 동결된 적 없는 기준에는 없는 것이 정상이고,
    // 없다고 파일을 못 읽는 것으로 치면 첫 `--write` 가 막힌다.
    const released = exactlyOne(/^# 해제 근거: (.+)$/)?.[1];
    // **회차 근거는 여럿이다** (검수 2026-08-29(3) · C). 카운터가 세는 것이 무엇이었는지
    // 파일이 스스로 말해야 한다 — 안 그러면 그 숫자는 `--round` 를 부른 횟수일 뿐이다.
    const roundLog = lines
      .map((line) => /^# 회차 (\d+): (.+)$/.exec(line))
      .filter((m) => m !== null)
      .map((m) => m[2]);
    return {
      body: raw.slice(at + MARK.length), rounds: Number(rounds), frozen: freeze[1] === '선언',
      released, roundLog,
      claimedSymbols: claimed === null ? undefined : Number(claimed[1]), claimedDigest: claimed?.[2],
    };
  };
  const stamp = (rounds, frozen = false, released = undefined, roundLog = []) =>
    `# barycenter v0.1 공개 표면\n`
    + `# ${symbols} 심볼 · ${digest}\n`
    + `# 동결 카운터: ${rounds} 회차 (표면이 안 움직인 검수 회차 수)\n`
    + `# A 동결: ${frozen ? '선언' : '미선언'} (선언 기준 ${FREEZE_ROUNDS} 회차)\n`
    // **회차마다 한 줄.** 이 줄들이 카운터의 근거다 — 없으면 숫자가 혼자 서 있고,
    // 혼자 선 숫자는 다음 사람이 믿을 근거가 없다 (`--unfreeze` 와 같은 규칙).
    // **번호는 카운터에 맞춘다.** 목록의 자리(i+1)로 매기면, 기록이 없는 회차가 앞에
    // 있을 때 파일이 "3 회차" 와 "회차 1" 을 동시에 말한다 — 마지막 줄이 카운터와
    // 같아야 읽는 사람이 둘을 같은 것으로 셀 수 있다.
    + roundLog.map((why, i) => `# 회차 ${rounds - roundLog.length + i + 1}: ${why}\n`).join('')
    // **지난 해제를 지우지 않는다.** 다시 동결해도 남는다 — "한 번 풀린 적 있다" 는
    // 다음 사람이 이 숫자를 얼마나 믿을지 정할 때 쓰는 사실이다.
    + (released === undefined ? '' : `# 해제 근거: ${released}\n`)
    + `#\n`
    + `# 이 파일은 scripts/surface.mjs 가 만든다. 손으로 고치지 않는다.\n`
    + `# 13차 검수가 준 동결 기준: 여러 적대적 회차 동안 이 파일이 변하지 않을 것.\n`
    + `# 계약이 움직이면 카운터는 0 부터 다시 센다.\n\n${body}`;

  const previous = readBaseline();
  const baselineMatches = previous !== undefined && previous.body === body
    && previous.claimedSymbols === symbols && previous.claimedDigest === digest;

  if (mode === '--unfreeze') {
    /**
     * **동결을 푼다 — 사람의 결정을 기록으로 남긴다.**
     *
     * 기준 자체는 안 옮긴다. 푸는 것과 옮기는 것은 다른 일이고, 한 번에 하면 "무엇을
     * 결정했는가" 가 두 개가 된다. 풀고 나서 `--write` 로 옮긴다.
     */
    if (previous === undefined) {
      console.error('SURFACE.txt 가 없다 — 풀 동결이 없다');
      process.exit(1);
    }
    if (!previous.frozen) {
      console.error('A 표면은 동결돼 있지 않다 — 풀 것이 없다');
      process.exit(1);
    }
    const why = (process.argv[3] ?? '').trim();
    if (why === '') {
      console.error(
        '해제에는 근거가 필요하다 — `node scripts/surface.mjs --unfreeze "<근거>"`\n'
        + '\n'
        + '  근거 없는 해제는 다음 사람이 "왜 풀렸지" 를 물을 때 답이 없다.\n'
        + '  이 파일이 쌓아 온 회차 수는 그 답이 있을 때만 뜻이 있다.',
      );
      process.exit(1);
    }
    /**
     * **한 줄이어야 한다.**
     *
     * 헤더는 `#` 로 시작하는 줄들이고 파서는 `^# 해제 근거: (.+)$` 를 정확히 하나
     * 요구한다. 개행이 든 근거를 그대로 쓰면 둘째 줄이 `#` 없이 남아 **헤더가 깨지고**,
     * 그 뒤로는 `--check` 가 파일을 아예 못 읽는다 — 게이트를 무력화하는 입력이다.
     * 잘라 붙이면 근거가 조용히 반쪽이 되므로 자르지 않고 **거부한다.**
     */
    if (/[\r\n]/.test(why)) {
      console.error(
        '해제 근거는 한 줄이어야 한다 — 헤더가 한 줄에 살고, 개행이 들어가면 그 파일을\n'
        + '다음부터 아무도 못 읽는다. 긴 사연은 커밋 메시지에 적고 여기에는 한 줄을 남긴다.',
      );
      process.exit(1);
    }
    // **기준 본문은 손대지 않는다.** 지금 트리의 표면이 기준과 다를 수 있고(그래서 푸는
    // 것이다), 여기서 함께 옮기면 해제와 계약 변경이 한 줄에 섞인다. 머리만 고친다.
    const raw = readFileSync(BASELINE, 'utf8');
    const at = raw.indexOf(MARK);
    const head = raw.slice(0, at)
      .replace(/^# A 동결: 선언 .*$/m, `# A 동결: 미선언 (선언 기준 ${FREEZE_ROUNDS} 회차)`)
      .replace(/^# 동결 카운터: \d+ /m, '# 동결 카운터: 0 ')
      // **회차 기록도 함께 지운다.** 카운터가 0 이 되는데 그 근거만 남으면 파일이
      // "세 회차를 쌓았다" 와 "0 회차다" 를 동시에 말한다 — 다음 사람이 어느 쪽을
      // 믿을지 알 수 없다. 카운터와 그 근거는 짝이다.
      .replace(/^# 회차 \d+: .*\n/gm, '');
    const withWhy = /^# 해제 근거: /m.test(head)
      ? head.replace(/^# 해제 근거: .*$/m, `# 해제 근거: ${why}`)
      : head.replace(/^# A 동결: .*$/m, (l) => `${l}\n# 해제 근거: ${why}`);
    writeFileSync(BASELINE, withWhy + raw.slice(at));
    console.log(
      `A 동결을 풀었다 — 카운터 ${previous.rounds} → 0 · 근거: ${why}\n`
      + '기준을 옮기려면 이어서 `node scripts/surface.mjs --write` 를 돌린다.',
    );
  } else if (mode === '--write') {
    // 계약을 옮겼다. 카운터는 0 부터 다시 센다.
    if (previous?.frozen === true) {
      console.error(
        'A 표면은 이미 동결됐다 — 해제·버전 전환 결정 없이 기준을 옮길 수 없다\n'
        + '\n'
        + '  결정이 났다면: node scripts/surface.mjs --unfreeze "<근거>"',
      );
      process.exit(1);
    }
    writeFileSync(BASELINE, stamp(0, false, previous?.released));
    console.log(`SURFACE.txt 를 갱신했다 — ${symbols} 심볼 · ${digest} · 동결 카운터 0 으로 되돌림`);
  } else if (mode === '--round') {
    /**
     * 검수 한 회차가 표면을 안 건드리고 지나갔다.
     *
     * **근거를 요구한다** (검수 2026-08-29(3) · C). 전에는 아무것도 안 요구했고, 그래서
     * 이 카운터가 세는 것은 「적대적 회차」가 아니라 **「`--round` 를 부른 횟수」** 였다 —
     * 한 자리에서 세 번 부르면 동결 기준을 채운다. 13차 검수가 준 기준이 *"여러 적대적
     * 회차 동안 이 파일이 변하지 않을 것"* 이므로, 그 회차가 무엇이었는지가 파일에
     * 남아야 센 것이 뜻을 갖는다.
     *
     * `--unfreeze` 가 이미 같은 규칙이다. 푸는 데 근거가 필요하면 **채우는 데도** 필요하다.
     */
    const why = (process.argv[3] ?? '').trim();
    if (why === '') {
      console.error('회차에는 근거가 필요하다 — `node scripts/surface.mjs --round "<근거>"`');
      console.error('  이 줄이 없으면 카운터는 「부른 횟수」이지 「회차」가 아니다.');
      process.exit(1);
    }
    if (why.includes('\n')) {
      console.error('근거는 한 줄이어야 한다 — 헤더가 한 줄에 산다');
      process.exit(1);
    }
    if (!baselineMatches) {
      console.error('표면이 움직인 상태다 — 먼저 --check 로 확인한다');
      process.exit(1);
    }
    writeFileSync(BASELINE, stamp(previous.rounds + 1, previous.frozen, previous.released,
      [...previous.roundLog, why]));
    console.log(`동결 카운터: ${previous.rounds} → ${previous.rounds + 1} 회차 — ${why}`);
  } else if (mode === '--freeze') {
    if (!baselineMatches) {
      console.error('표면이 기준과 다르다 — 동결할 수 없다');
      process.exit(1);
    }
    if (previous.rounds < FREEZE_ROUNDS) {
      console.error(`동결 카운터 ${previous.rounds} 회차 — 선언 기준 ${FREEZE_ROUNDS} 회차에 못 미친다`);
      process.exit(1);
    }
    writeFileSync(BASELINE, stamp(previous.rounds, true, previous.released));
    console.log(`A 타입·DP ABI 동결 선언 — ${symbols} 심볼 · ${digest} · ${previous.rounds} 회차`);
  } else if (mode === '--freeze-check') {
    if (!baselineMatches || !previous.frozen || previous.rounds < FREEZE_ROUNDS) {
      console.error('A 타입·DP ABI 동결 게이트 실패');
      process.exit(1);
    }
    console.log(`ok  A freeze  ${symbols} symbols · ${previous.rounds} rounds`);
  } else if (mode === '--check') {
    if (previous === undefined) {
      console.error('SURFACE.txt 가 없다 — `node scripts/surface.mjs --write` 로 기준을 만든다');
      process.exit(1);
    }
    if (baselineMatches) {
      console.log(`표면 그대로 — ${symbols} 심볼 · ${digest} · 동결 카운터 ${previous.rounds} 회차 · A ${previous.frozen ? '동결' : '미선언'}`);
    } else {
      if (previous.claimedSymbols !== symbols || previous.claimedDigest !== digest) {
        console.error(`표면 헤더가 다르다 — 기준 ${previous.claimedSymbols ?? '?'} 심볼 · ${previous.claimedDigest ?? '?'} / 현재 ${symbols} 심볼 · ${digest}`);
      }
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
    process.stdout.write(stamp(previous?.rounds ?? 0, previous?.frozen ?? false));
  }
} finally {
  if (dtsDir !== undefined) rmSync(dtsDir, { recursive: true, force: true });
}
