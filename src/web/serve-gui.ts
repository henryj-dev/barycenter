/**
 * GUI 정적 파일. API 와 같은 출처에서 내보낸다 — 브라우저 CORS 를 열지 않기 위해.
 */
import { createReadStream, existsSync, realpathSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

import { SECURITY_HEADERS } from '../api/headers.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

export function serveGui(res: ServerResponse, pathname: string, root: string): boolean {
  if (!existsSync(root) || !statSync(root).isDirectory()) return false;
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  let target = resolve(root, rel);
  const base = resolve(root);
  const inside = target === base || relative(base, target).split(sep)[0] !== '..';
  if (!inside) return false;
  if (existsSync(target) && statSync(target).isDirectory()) {
    const indexed = join(target, 'index.html');
    if (existsSync(indexed)) target = indexed;
  }
  if (!existsSync(target) || !statSync(target).isFile()) {
    const asHtml = resolve(root, `${rel}.html`);
    if (existsSync(asHtml) && statSync(asHtml).isFile()) {
      target = asHtml;
    } else {
      return false;
    }
  }
  /**
   * **심볼릭 링크까지 본다** (검수 S-10).
   *
   * 위의 `relative()` 검사는 `..` 만 막는다. 루트 **안에** 밖을 가리키는 링크가 있으면
   * 그 파일이 인증 없이 그대로 나간다 — 재현물이 `PRIVATE KEY` 를 받아 냈다.
   * 빌드 산출물에 링크가 생길 이유는 없으므로, 풀어서 다시 확인하는 값이 싸다.
   */
  let real: string;
  let realBase: string;
  try {
    real = realpathSync(target);
    realBase = realpathSync(base);
  } catch {
    return false;
  }
  if (real !== realBase && relative(realBase, real).split(sep)[0] === '..') return false;

  const type = MIME[extname(target)] ?? 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'cache-control': 'no-cache',
    ...SECURITY_HEADERS,
  });
  createReadStream(real).pipe(res);
  return true;
}
