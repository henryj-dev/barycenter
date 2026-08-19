/**
 * 도커가 쓴 /tmp 접두사를 호스트가 지울 수 있게 한다.
 *
 * Linux 바인드 마운트에서 컨테이너(uid 0)가 만든 파일은 호스트 러너가
 * 못 지운다. mac virtiofs 는 그걸 가린다. CI 의 EACCES 가 이것이다.
 */
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine';

export function dropScratch(dir: string): void {
  if (dir === '') return;
  try {
    execFileSync(
      'docker',
      [
        'run', '--rm', '-v', `${dir}:/p`,
        '--entrypoint', '/bin/sh', IMAGE,
        '-c', 'chmod -R a+rwx /p 2>/dev/null; rm -rf /p/logs /p/conf /p/generations /p/state /p/* 2>/dev/null; true',
      ],
      { stdio: 'ignore', timeout: 60_000 },
    );
  } catch {
    /* 도커가 없으면 호스트만으로 지운다 */
  }
  rmSync(dir, { recursive: true, force: true });
}
