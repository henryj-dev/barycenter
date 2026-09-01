#!/usr/bin/env node
/**
 * KEK 회전 — **DEK 를 다시 감싼다. 자료는 안 읽는다** (§4.8.1 · §4.8.3).
 *
 *   node scripts/rotate-kek.mjs --to <새-kek-id> [--check] [--verify]
 *
 * ── 왜 필요한가
 *
 * `023_secret_materials.sql` 이 `kek_id` 열을 처음부터 들면서 적어 뒀다:
 * *"회전 절차 자체는 아직 없다."* 그래서 지금까지 **유출과 분실이 같은 대가**를 치렀다 —
 * 남는 길이 「인증서를 전부 다시 올린다」 하나뿐이었다.
 *
 * 그리고 그 길이 전부에게 열려 있지도 않다. `secrets-pg.ts` 가 적어 둔 그대로다:
 *
 * > 고칠 수 있는 것은 운영자가 **자료를 아직 들고 있는** 인증서뿐이다. ACME 가 발급한
 * > 것은 개인키가 이 저장소에만 있으므로 재업로드할 자료가 없다.
 *
 * **ACME 인증서에는 회전이 유일한 길이다.**
 *
 * ── 무엇을 하나
 *
 * 봉투가 두 층이라 바깥만 갈아 끼우면 된다:
 *
 *     wrapped_dek = kekNonce(12) || kekTag(16) || KEK 로 감싼 DEK   ← 이것만 바꾼다
 *     ciphertext  = tag(16) || DEK 로 감싼 자료                      ← 안 건드린다
 *
 * 그래서 **자료 바이트를 복호화하지 않는다.** DEK 한 겹만 풀었다 다시 감싼다.
 * AAD 는 두 층 모두 `<scheme>://<name>@<version>` 이라 행에서 그대로 세운다.
 *
 * ── 중간에 죽어도 된다
 *
 * `kek_id` 가 곧 진행 상황이다. 한 행씩 트랜잭션으로 처리하고, 다시 돌리면 **아직 옛
 * id 인 행만** 집는다. 그래서 새 id 는 옛 id 와 **달라야 한다** — 같으면 어디까지 했는지
 * 알 방법이 사라진다.
 *
 * ── ⚠️ 데몬은 이 스크립트를 모른다
 *
 * 돌고 있는 데몬은 기동 때 받은 **옛 KEK 를 메모리에 들고 있다.** 회전이 끝나면 그
 * 데몬은 자료를 못 연다. 순서는 이렇다:
 *
 *     ① 이 스크립트를 돌린다 (--check 로 먼저 본다)
 *     ② KEK 출처를 새 것으로 바꾼다 (env 또는 KMS)
 *     ③ 데몬을 재기동한다
 *
 * ①~③ 사이에 **제어 평면이 인증서를 못 읽는다.** 데이터 평면은 멀쩡하다 — nginx 는
 * 이미 구워진 세대를 서빙하고 있고 거기엔 자료가 파일로 있다. 그 창을 없애려면 데몬이
 * 두 KEK 를 동시에 들어야 하는데, 그건 이 회차의 범위가 아니다.
 */
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * **산출물을 어디서 찾나.**
 *
 * 처음엔 `../dist` 를 정적으로 import 했다. **실배포에서 안 돌았다** —
 * `install.sh` 는 저장소를 **읽기만** 하고 빌드는 임시 디렉터리에서 해서
 * `$APP_DIR/dist` 에 놓는다. 그래서 설치된 호스트의 체크아웃에는 `dist` 가 없고,
 * 런북이 시킨 명령이 `ERR_MODULE_NOT_FOUND` 로 죽었다 (2026-09-01 실측).
 *
 * 그래서 셋을 순서대로 본다. 개발 체크아웃과 설치된 호스트에서 **같은 명령**이 돌아야
 * 하고, 못 찾으면 **어디를 봤는지 말하고** 죽는다 — 모듈 스택을 던지는 것보다 낫다.
 */
const HERE = dirname(fileURLToPath(import.meta.url));
// **빈 문자열을 「안 준 것」으로 본다.** `??` 만 쓰면 `BARY_APP_DIR=""` 이 그대로 통과해
// `join("", "dist")` = 상대 경로 `dist` 가 되고, 그러면 **cwd 에 있는 아무 dist** 를
// 집는다. 재현물이 그 자리를 잡았다.
const appDir = (process.env['BARY_APP_DIR'] ?? '').trim() || '/opt/barycenter';
const CANDIDATES = [
  resolve(HERE, '..', 'dist'),        // 개발 체크아웃
  resolve(appDir, 'dist'),            // 설치된 호스트
];
const DIST = CANDIDATES.find((d) => existsSync(join(d, 'store', 'pg.js')));
if (DIST === undefined) {
  console.error('  FAIL  산출물(dist)을 못 찾았다 — 본 곳:');
  for (const c of CANDIDATES) console.error(`          ${c}`);
  console.error('        설치된 호스트면 BARY_APP_DIR 를 준다 (기본 /opt/barycenter).');
  console.error('        저장소에서 돌리려면 ./scripts/build.sh 를 먼저 돌린다.');
  process.exit(1);
}

const { Db } = await import(`${DIST}/store/pg.js`);
const { resolveKek } = await import(`${DIST}/dp/kek-source.js`);

const NONCE = 12;
const TAG = 16;

const die = (m) => { console.error(`  FAIL  ${m}`); process.exit(1); };

// ── 인자 ────────────────────────────────────────────────────────────────
let toId = '';
let checkOnly = false;
let verify = false;
for (let i = 2; i < process.argv.length; i += 1) {
  const a = process.argv[i];
  if (a === '--to') { toId = process.argv[i + 1] ?? ''; i += 1; }
  else if (a === '--check') checkOnly = true;
  else if (a === '--verify') verify = true;
  else if (a === '-h' || a === '--help') {
    console.log(`KEK 회전 — DEK 를 다시 감싼다. 자료는 안 읽는다

  node scripts/rotate-kek.mjs --to <새-kek-id> [--check] [--verify]

  --to <이름>    새 KEK 의 이름. **옛 것과 달라야 한다** — 그것이 진행 상황이다
  --check        무엇을 바꿀지 보기만 한다. 아무것도 안 쓴다
  --verify       다시 감싼 뒤 **자료까지 열어** key_digest 를 대조한다.
                 자료를 복호화한다(메모리에서만) — 기본은 안 한다

환경
  BARY_DSN                                   PostgreSQL
  BARY_APP_DIR                               산출물이 있는 곳 (기본 /opt/barycenter).
                                             저장소에 dist 가 있으면 그것을 먼저 쓴다
  BARY_SECRET_KEK      | BARY_SECRET_KEK_CMD          지금 쓰는 KEK
  BARY_SECRET_KEK_NEW  | BARY_SECRET_KEK_NEW_CMD      새 KEK

⚠️ 끝나면 KEK 출처를 새 것으로 바꾸고 **데몬을 재기동해야 한다.** 그 사이 제어 평면은
   인증서를 못 읽는다 (데이터 평면은 멀쩡하다).`);
    process.exit(0);
  } else die(`모르는 인자: ${a}`);
}
if (toId === '') die('--to <새-kek-id> 가 필요하다 (--help)');

const dsn = process.env['BARY_DSN'] ?? '';
if (dsn === '') die('BARY_DSN 이 필요하다');

// ── KEK 둘 ──────────────────────────────────────────────────────────────
//
// **읽는 규칙은 `resolveKek` 한 자리다.** 새 KEK 도 같은 함수에 태운다 — 이름만 바꿔
// 끼운다. 그러면 「값과 명령을 둘 다 주면 거절」·「32 바이트가 아니면 거절」 같은 규칙이
// 공짜로 따라온다. 여기서 다시 짜면 두 규칙이 갈라지는 날이 온다.
const oldKek = await resolveKek(process.env).catch((e) => die(`옛 KEK: ${e.message}`));
const newKek = await resolveKek({
  BARY_SECRET_KEK: process.env['BARY_SECRET_KEK_NEW'],
  BARY_SECRET_KEK_CMD: process.env['BARY_SECRET_KEK_NEW_CMD'],
  BARY_SECRET_KEK_CMD_TIMEOUT_MS: process.env['BARY_SECRET_KEK_CMD_TIMEOUT_MS'],
}).catch((e) => die(`새 KEK: ${e.message.replace(/BARY_SECRET_KEK/g, 'BARY_SECRET_KEK_NEW')}`));

// **같은 키로의 회전은 막는다.** 아무 일도 안 하면서 `kek_id` 만 바꾸면, 다음 회전이
// 「어디까지 했나」를 물을 때 대답이 거짓이 된다.
if (oldKek.length === newKek.length && timingSafeEqual(oldKek, newKek)) {
  die('옛 KEK 와 새 KEK 가 같다 — 회전이 아니다');
}

// ── 봉투 ────────────────────────────────────────────────────────────────

/** 바깥 층만 푼다. **자료는 안 만진다.** */
function unwrapDek(wrapped, ref, kek) {
  const u = createDecipheriv('aes-256-gcm', kek, wrapped.subarray(0, NONCE));
  u.setAAD(Buffer.from(ref, 'utf8'));
  u.setAuthTag(wrapped.subarray(NONCE, NONCE + TAG));
  return Buffer.concat([u.update(wrapped.subarray(NONCE + TAG)), u.final()]);
}

/** `secrets-pg.ts` 의 `#seal` 바깥 층과 **같은 모양**이어야 한다. */
function wrapDek(dek, ref, kek) {
  const nonce = randomBytes(NONCE);
  const w = createCipheriv('aes-256-gcm', kek, nonce);
  w.setAAD(Buffer.from(ref, 'utf8'));
  const body = Buffer.concat([w.update(dek), w.final()]);
  return Buffer.concat([nonce, w.getAuthTag(), body]);
}

// ── 돈다 ────────────────────────────────────────────────────────────────
const db = new Db(dsn);
const rows = (await db.query(
  `SELECT scheme, name, version, kek_id, wrapped_dek FROM secret_materials
    WHERE kek_id <> $1 ORDER BY created_at, scheme, name, version`,
  [toId],
)).rows;

const done = (await db.query(
  'SELECT count(*)::int AS n FROM secret_materials WHERE kek_id = $1', [toId],
)).rows[0]?.['n'] ?? 0;

console.log(`대상 ${rows.length} 행 · 이미 ${toId} 인 행 ${done} 개`);
if (rows.length === 0) {
  console.log('바꿀 것이 없다.');
  process.exit(0);
}

let ok = 0;
const failed = [];
for (const r of rows) {
  const ref = `${r['scheme']}://${r['name']}@${r['version']}`;
  if (checkOnly) {
    console.log(`  would  ${ref}  (${r['kek_id']} → ${toId})`);
    ok += 1;
    continue;
  }
  try {
    const wrapped = Buffer.from(r['wrapped_dek']);
    const dek = unwrapDek(wrapped, ref, oldKek);
    const rewrapped = wrapDek(dek, ref, newKek);

    // **자기 일을 자기가 검산한다.** 새 KEK 로 도로 풀어 DEK 가 같은지 본다.
    // 자료를 안 건드렸으므로(같은 바이트·같은 nonce·같은 AAD) 이것이 서면 자료도 열린다.
    const back = unwrapDek(rewrapped, ref, newKek);
    if (back.length !== dek.length || !timingSafeEqual(back, dek)) {
      throw new Error('다시 감싼 DEK 가 도로 안 풀린다');
    }

    await db.tx(async (c) => {
      // `kek_id` 를 조건에 둔다 — 그 사이 누가 바꿨으면 안 덮는다.
      const u = await c.query(
        `UPDATE secret_materials SET wrapped_dek = $1, kek_id = $2
          WHERE scheme = $3 AND name = $4 AND version = $5 AND kek_id = $6`,
        [rewrapped, toId, r['scheme'], r['name'], r['version'], r['kek_id']],
      );
      if (u.rowCount !== 1) throw new Error(`행이 그 사이 바뀌었다 (rowCount=${u.rowCount})`);
    });
    ok += 1;
    console.log(`  ok     ${ref}`);
  } catch (e) {
    // **비밀을 안 싣는다.** 참조와 사유만 낸다.
    failed.push({ ref, why: e.message });
    console.error(`  FAIL   ${ref} — ${e.message}`);
  }
}

// ── 자료까지 열어 본다 (선택) ───────────────────────────────────────────
//
// 기본은 안 한다 — 회전의 요점이 **자료를 안 읽는 것**이라서다. 그래도 재기동 앞에서
// 한 번 확인하고 싶은 운영자를 위해 문을 둔다. 여는 것은 메모리에서뿐이고 아무 데도 안 쓴다.
if (verify && !checkOnly && failed.length === 0) {
  const { PgSecretStore } = await import(`${DIST}/dp/secrets-pg.js`);
  const store = new PgSecretStore({ db, kek: newKek, kekId: toId });
  let checked = 0;
  for (const r of rows) {
    const ref = `${r['scheme']}://${r['name']}@${r['version']}`;
    try {
      if (r['scheme'] === 'store') await store.get(ref); else await store.getKey(ref);
      checked += 1;
    } catch (e) {
      failed.push({ ref, why: `열어 보니 안 열린다: ${e.message}` });
      console.error(`  FAIL   ${ref} — 열어 보니 안 열린다`);
    }
  }
  console.log(`  검산   ${checked}/${rows.length} 행을 새 KEK 로 열었다`);
}

console.log('');
if (checkOnly) {
  console.log(`${ok} 행을 바꾼다. 아무것도 안 썼다 (--check).`);
  process.exit(0);
}
console.log(`바꿈 ${ok} · 실패 ${failed.length}`);
if (failed.length > 0) {
  console.error('');
  console.error('⚠️ 못 바꾼 행이 있다. **다시 돌리면 남은 것만 집는다** — `kek_id` 가 진행');
  console.error('   상황이다. 계속 실패하면 그 행은 옛 KEK 로도 안 열리는 것이다 (다른 KEK');
  console.error('   환경의 덤프를 복원했거나 자료가 변조됐다).');
  process.exit(1);
}
console.log('');
console.log(`끝났다. 이제 KEK 출처를 새 것으로 바꾸고 **데몬을 재기동한다** —`);
console.log(`그 전까지 데몬은 옛 KEK 를 들고 있어 자료를 못 연다.`);
