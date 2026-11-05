/**
 * 비밀은 파일로만 받는다 — env 값에는 비밀을 두지 않는다(`ps e` · 크래시 덤프 · 오케스트레이터 화면에 남는다).
 *
 * 기동 때 한 번 읽는다. 비었거나 읽을 수 없으면 **기동을 거부한다** — 빈 토큰으로 조용히 401 을 받는 상태를 만들지 않는다.
 * 값은 오류 문장에 싣지 않는다. 경로만 싣는다.
 */
import { readFileSync } from 'node:fs';

export type ReadFile = (path: string) => string;

export const readFileUtf8: ReadFile = (path) => readFileSync(path, 'utf8');

export function readSecretFile(name: string, path: string, read: ReadFile = readFileUtf8): string {
  let raw: string;
  try {
    raw = read(path);
  } catch (e) {
    throw new Error(`${name}(${path}) 를 읽지 못했다: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  const v = raw.trim();
  if (v === '') throw new Error(`${name}(${path}) 가 비었다`);
  return v;
}

/** env 묶음의 한 값 — 없거나 비면 undefined. */
export function envOf(source: NodeJS.ProcessEnv, name: string): string | undefined {
  const v = source[name];
  return v === undefined || v === '' ? undefined : v;
}

/** 꼭 있어야 하는 값. 없으면 사유와 함께 던진다(반만 설정 → 기동 거부). */
export function required(source: NodeJS.ProcessEnv, name: string, why: string): string {
  const v = envOf(source, name);
  if (v === undefined) throw new Error(`${why} — ${name} 이 필요하다`);
  return v;
}
