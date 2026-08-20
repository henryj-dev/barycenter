/**
 * GUI 정적 파일. API 와 같은 출처에서 내보낸다 — 브라우저 CORS 를 열지 않기 위해.
 */
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { extname, join, relative, resolve, sep } from 'node:path';

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
  const type = MIME[extname(target)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
  createReadStream(target).pipe(res);
  return true;
}
