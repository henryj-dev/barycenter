#!/usr/bin/env node
/**
 * **재현물 게이트 — 규칙을 산문에서 기계로 옮긴다** (48차 처방 B)
 *
 * 39차에 "근거를 재는 규칙" 을, 40차에 "검증물은 커밋된 산출물이어야 한다" 를 세웠다.
 * **그런데 46차에 또 어겼다** — 런타임 수정 둘을 재현물 없이 커밋했고, 47차 검수가
 * 그것을 만들어 줬다. 그리고 45차의 계약 핀은 **재발급을 실행하지 않는 픽스처 통과**
 * 였다(48차 CE-48-A).
 *
 * **규칙이 산문이라서 안 지켜진다.** 그래서 게이트로 옮긴다.
 *
 *   node scripts/pinned.mjs <baseRef>
 *
 * `src/` 를 바꾼 커밋은 커밋 메시지에 **재현물 표식**을 적어야 한다:
 *
 *   Pinned-by: tests/conformance/foo.test.ts -t "이름"
 *   Pinned-by: none — <왜 없어도 되는지>
 *
 * 표식이 `none` 이 아니면 **그 테스트를 부모 트리(수정 전)에 대고 돌려 빨간지 확인**한다.
 * 초록이면 그 테스트는 아무것도 안 지키는 것이고, 게이트가 막는다.
 *
 * **이 게이트가 못 잡는 것**: 산문의 정확성("이주는 불가능하다" 같은 전칭 서술).
 * 그건 원래 검수로만 잡히는 축이고, 카운터와 분리한 현행 구조가 맞다 — 48차 판정이다.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import ts from 'typescript';

import { markerArgv, verdictOf } from './pinned-lib.mjs';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

const base = process.argv[2] ?? 'HEAD~1';
const head = git('rev-parse', 'HEAD');

/**
 * **커밋을 하나씩 본다.**
 *
 * 처음엔 `base..head` 를 통째로 diff 하고 **HEAD 의 메시지만** 읽었다. 로컬에서 커밋
 * 하나씩 검사할 때는 맞았지만, CI 가 푸시나 PR 을 볼 때는 거짓이다 —
 * 커밋 셋을 밀면서 **가운데 것만 `src/` 를 재현물 없이 고쳐도 그냥 지나간다.**
 * 마지막 커밋이 문서 수정이면 diff 는 여전히 `src/` 를 포함하고, 메시지는 마지막 것만
 * 읽으니 표식이 없다고 걸리거나 있다고 통과하거나 **둘 다 엉뚱한 커밋 기준**이다.
 *
 * 게이트를 CI 에 걸면서 드러났다. 범위를 받는 도구는 범위를 봐야 한다.
 *
 * 머지 커밋은 건너뛴다 — 두 부모에 대한 diff 는 "이 커밋이 무엇을 바꿨나" 를 말하지 않고,
 * 실제 변경은 이미 각 커밋에서 검사된다.
 */
const commits = git('rev-list', '--reverse', '--no-merges', `${base}..${head}`)
  .split('\n').map((x) => x.trim()).filter(Boolean);

if (commits.length === 0) {
  console.log('검사할 커밋이 없다.');
  process.exit(0);
}

let failed = 0;
for (const sha of commits) {
  if (!checkCommit(sha)) failed = 1;
}
process.exit(failed);

/** 커밋 하나를 검사한다. 통과면 true. */
function checkCommit(sha) {
  const short = sha.slice(0, 8);
  const parent = `${sha}^`;
  const subject = git('log', '-1', '--format=%s', sha);

  if (!hasSemanticSrcChange(parent, sha)) {
    console.log(`건너뜀 ${short} — src 변경 없음 (${subject})`);
    return true;
  }

  const message = git('log', '-1', '--format=%B', sha);
  const marks = [...message.matchAll(/^Pinned-by:\s*(.+)$/gm)].map((m) => m[1].trim());

  if (marks.length === 0) {
    console.error(
      `FAIL  ${short} — src 를 바꿨는데 \`Pinned-by:\` 가 없다 (${subject})\n\n`
      + '  Pinned-by: tests/conformance/foo.test.ts -t "이름"   재현물이 있다\n'
      + '  Pinned-by: none — <근거>                              없어도 되는 이유를 적는다\n\n'
      + '40차 규칙: **검증물은 커밋된 산출물이어야 한다.** 46차에 그것을 어겼고 47차가\n'
      + '재현물을 대신 만들어 줬다. 규칙이 산문이라 안 지켜졌으므로 게이트로 옮겼다.',
    );
    return false;
  }
  return checkMarks(sha, parent, marks, short);
}

/**
 * src 경로의 주석/공백만 바꾼 커밋은 동작 재현물 핀 대상이 아니다.
 *
 * `src/` 아래 문서 주석을 보강하는 커밋도 게이트의 범위에는 잡혔는데, 실제
 * 실행 토큰은 바뀌지 않았으므로 그 커밋에 이미 통과하던 테스트를 억지로
 * 연결하게 됐다. TypeScript scanner는 trivia(공백·주석)를 건너뛰므로 토큰
 * 흐름을 비교하면 이 경계를 기계적으로 확인할 수 있다.
 */
function hasSemanticSrcChange(parent, sha) {
  const files = git('diff', '--name-only', `${parent}..${sha}`, '--', 'src/')
    .split('\n').map((x) => x.trim()).filter(Boolean);
  return files.some((file) => {
    const before = sourceTokens(parent, file);
    const after = sourceTokens(sha, file);
    return before !== after;
  });
}

function sourceTokens(ref, file) {
  let source = '';
  try {
    source = execFileSync('git', ['show', `${ref}:${file}`], { encoding: 'utf8' });
  } catch {
    return '<missing>';
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') || file.endsWith('.jsx')
      ? ts.LanguageVariant.JSX : ts.LanguageVariant.Standard,
    source,
  );
  const tokens = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    tokens.push(`${kind}:${scanner.getTokenText()}`);
  }
  return tokens.join('\u0000');
}

/**
 * **본체를 건드리지 않는다** (49차 — 게이트 자신의 결함 넷 중 둘).
 *
 * 첫 판은 `git checkout base -- src/` 로 **작업 트리를 덮었다.** 49차 검수가 실측했다:
 *   · 미커밋 src 수정이 **소리 없이 사라진다** — `verify.sh` 가 기본으로 이걸 돌린다
 *   · 지운 파일이 **작업 트리와 인덱스에 부활**한다 (`checkout head` 는 못 지운다)
 *   · 새 파일이 안 지워져 "부모" 실행이 부모가 아니게 되고, **정당한 커밋을 오차단**한다
 *
 * **13차에 스윕이 정확히 이 사고를 냈다** — 본체를 제자리에서 변이시키다 커밋에 뮤턴트가
 * 섞였고, 그때 배운 것이 *"도구가 본체를 건드리는 한 사고는 반드시 난다"* 였다.
 * **그 교훈을 알면서 같은 모양을 만들었다.** 별도 worktree 로 옮긴다 — 스윕이 그랬듯이.
 */
function makeWorktree(ref) {
  const dir = mkdtempSync(join(tmpdir(), 'barycenter-pinned-'));
  const tree = join(dir, 'tree');
  execFileSync('git', ['worktree', 'add', '--detach', '--quiet', tree, ref], { stdio: 'pipe' });
  symlinkSync(join(process.cwd(), 'node_modules'), join(tree, 'node_modules'), 'dir');
  return { dir, tree };
}

function dropWorktree(w) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', w.tree], { stdio: 'pipe' });
  } catch {
    // 이미 사라졌으면 그만이다.
  }
  rmSync(w.dir, { recursive: true, force: true });
}

function checkMarks(sha, parent, marks, short) {
  let ok = true;
    for (const mark of marks) {
    if (mark.startsWith('none')) {
      // **근거를 요구한다** (49차 ⓐ). 맨 `none` 도 통과했다 — 문서가 요구하는 형식조차
      // 기계가 안 봤다. 근거의 질은 여전히 사람이 봐야 한다.
      if (!/^none\s+[—-]\s+\S/.test(mark)) {
        console.error(`FAIL  ${short} ${mark} — \`none\` 뒤에 근거를 적어라 (\`none — <근거>\`).`);
        ok = false;
        continue;
      }
      console.log(`건너뜀 ${short} — ${mark}`);
      continue;
    }
    // **판정과 표식 해석은 `pinned-lib.mjs` 가 진다** — 그쪽만 순수 함수라 잴 수 있다.
    // 여기 안에 두면 게이트를 재는 테스트를 못 쓰고, 실제로 못 써서 구멍 둘을 오래 안고 있었다.
    const { argv } = markerArgv(mark);

    // **부모 트리 전체**를 별도 worktree 에 세우고, 지금의 테스트만 얹는다.
    // 파일 삭제·추가도 그대로 반영된다 — `checkout -- src/` 가 못 하던 것이다.
    const w = makeWorktree(parent);
    try {
      // 테스트 **하네스**를 얹는다 — `tests/` 와 러너 설정.
      //
      // 처음엔 `tests/` 만 얹었다. 그랬더니 **새 테스트 디렉토리를 만든 커밋에서 게이트가
      // "고른 테스트가 0 건" 으로 오차단했다** — 부모의 `vitest.config.ts` 는 그 디렉토리를
      // 모르니 파일을 아예 못 찾는다. 게이트의 계약은 *"지금의 테스트를 부모의 `src/` 에
      // 대고 돌린다"* 이고, 러너 설정은 재는 대상이 아니라 **재는 도구** 쪽이다.
      // 대상(`src/`)은 부모 것을 그대로 둔다.
      execFileSync('git', ['checkout', sha, '--', 'tests/', 'vitest.config.ts'],
        { cwd: w.tree, stdio: 'pipe' });
      let threw = false;
      let text = '';
      const result = spawnSync('npx', ['vitest', 'run', ...argv], {
        cwd: w.tree, encoding: 'utf8',
      });
      threw = result.status !== 0;
      text = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const verdict = verdictOf({ threw, text });
      if (verdict === 'red') {
        console.log(`ok    ${short} ${mark} — 수정 전에 빨갛다`);
      } else if (verdict === 'empty') {
        console.error(`FAIL  ${short} ${mark} — 고른 테스트가 0 건이다. 표식이 틀렸다.`);
        ok = false;
      } else if (verdict === 'crashed') {
        // **던진 것을 전부 빨강으로 세면 안 된다.** 러너가 기동에서 죽으면 테스트가
        // 한 건도 안 돈 것이고, 그걸 "수정 전에 빨갛다" 로 세는 것은 통과 신호를
        // 위조하는 것이다. 게이트가 자기 실패를 성공으로 읽으면 없느니만 못하다.
        console.error(
          `FAIL  ${short} ${mark} — **러너가 기동에서 죽었다. 아무 테스트도 안 돌았다.**\n`
          + `${text.split('\n').slice(0, 6).join('\n')}`);
        ok = false;
      } else {
        console.error(`FAIL  ${short} ${mark} — **수정 전에도 초록이다. 아무것도 안 지킨다.**`);
        ok = false;
      }
    } finally {
      dropWorktree(w);
    }
  }
  return ok;
}
