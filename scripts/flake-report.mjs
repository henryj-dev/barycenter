#!/usr/bin/env node
/**
 * 흔들림 장부를 **사람이 읽는 표**로 낸다.
 *
 *   node scripts/flake-report.mjs <이름>
 *
 * ── 왜 있나
 *
 * `scripts/lib/flake.sh` 가 흔들린 스위트를 `.flakes.jsonl` 에 적는다. 그 파일의
 * 머리말은 *"회차를 가로질러 쌓여야 세는 뜻이 있다"* 고 말하는데, **CI 에서는 그 파일이
 * 워크스페이스와 함께 사라진다** — `.gitignore` 되어 있고 아무도 안 챙긴다.
 *
 * 그래서 흔들림이 실제로 제일 많이 일어나는 자리(부하 걸린 러너)의 기록이 매번 0 이
 * 된다. 이 회차에 e2e 활성화 흔들림을 **두 번 보고도** 남은 것은 사람의 인상뿐이었다.
 *
 * ── 무엇을 하고, 무엇을 못 하나
 *
 * 하는 것: **한 실행 안에서** 무엇이 흔들렸는지를 실행 요약에 올린다. 게이트가 빨간
 * 이유가 「진짜 실패」인지 「흔들림」인지를 조각 로그를 열지 않고 알 수 있다.
 *
 * ⚠️ **못 하는 것: 실행을 가로질러 세는 것.** 그러려면 저장소 밖에 두는 곳이 있어야
 * 하고, 그건 쓰기 자격증명이나 새 액션을 뜻한다 — 이 저장소는 둘 다 일부러 안 늘린다
 * (`persist-credentials: false`, *"핀으로 고정한 액션만"*). 아티팩트로 90일 남기는
 * 것까지가 지금의 답이고, **그 한계를 여기 적어 둔다** — 조용한 상한을 안 만든다.
 *
 * ── 출력
 *
 * 흔들린 것이 없으면 **아무것도 안 낸다**(exit 0). 그래야 호출하는 쪽이
 * `>> "$GITHUB_STEP_SUMMARY"` 로 무심코 붙여도 빈 실행에 잡음이 안 남는다.
 */
import { readFileSync } from 'node:fs';

const LOG = process.env['BARY_FLAKE_LOG'] ?? '.flakes.jsonl';
const label = process.argv[2] ?? '';

let raw;
try {
  raw = readFileSync(LOG, 'utf8');
} catch {
  process.exit(0); // 장부가 없다 = 흔들린 것이 없다
}

/**
 * **못 읽은 줄을 조용히 버리지 않는다.** 장부가 깨졌으면 그 사실이 흔들림 자체보다
 * 중요하다 — 세는 도구가 조용히 0 을 말하면 그건 「없다」로 읽힌다.
 */
const rows = [];
const broken = [];
for (const line of raw.split('\n')) {
  const t = line.trim();
  if (t === '') continue;
  try {
    const o = JSON.parse(t);
    rows.push({ at: o.at ?? '?', suite: o.suite ?? '?', seconds: o.seconds ?? '?' });
  } catch {
    broken.push(t);
  }
}

if (rows.length === 0 && broken.length === 0) process.exit(0);

const out = [];
out.push(label === '' ? '### 흔들린 스위트' : `### 흔들린 스위트 — ${label}`);
out.push('');
out.push('재실행은 초록이었다. **그래도 게이트는 빨갛다** — 간헐적으로 깨지는 게이트는');
out.push('없느니만 못하기 때문이다 (`scripts/lib/flake.sh`).');
out.push('');
if (rows.length > 0) {
  out.push('| 스위트 | 초 | 시각 |');
  out.push('|---|---|---|');
  for (const r of rows) out.push(`| ${r.suite} | ${r.seconds} | ${r.at} |`);
}
if (broken.length > 0) {
  out.push('');
  out.push(`⚠️ 장부에서 못 읽은 줄 ${broken.length} 개 — 세는 도구가 깨졌다는 뜻이다.`);
}
console.log(out.join('\n'));
