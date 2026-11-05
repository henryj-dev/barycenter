/**
 * 파일 출처 — `BARY_DISCOVERY_FILE_DIR` 안의 JSON 파일 (2026-11-05). 시험 · 수동용이다.
 *
 * `query` 는 **파일 이름만**이다(해독기가 `/` · `..` 를 막는다 — 모델을 쓰는 사람이 데몬이 읽을 파일을 고르지
 * 못하게). 폴링마다 다시 읽는다 — 파일을 바꾸면 다음 주기에 들어간다.
 *
 * 모양: `[{"host":"10.0.0.1","port":8080}, …]` 또는 `{"endpoints":[…]}`. 없는 파일은 `not-found`.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type { DiscoveredAddress, DiscoverySource } from './source.js';
import { MAX_DISCOVERY_RESPONSE_BYTES, normalizeEndpoints } from './source.js';

export type FileSourceOptions = { dir: string };

export function fileSource(o: FileSourceOptions): DiscoverySource {
  return {
    kind: 'file',
    resolve: async (query) => {
      if (query.includes('/') || query.includes('\\') || query.startsWith('.')) {
        return { ok: false, reason: 'invalid', detail: `파일 이름만 받는다: ${query}` };
      }
      const path = join(o.dir, query);
      let text: string;
      try {
        const st = await stat(path);
        if (st.size > MAX_DISCOVERY_RESPONSE_BYTES) {
          return { ok: false, reason: 'too-large', detail: `${query} 가 ${MAX_DISCOVERY_RESPONSE_BYTES}바이트를 넘는다` };
        }
        text = await readFile(path, 'utf8');
      } catch (e) {
        const code = String((e as { code?: unknown }).code ?? '');
        if (code === 'ENOENT') return { ok: false, reason: 'not-found', detail: `${query} 가 없다` };
        return { ok: false, reason: 'unavailable', detail: `${query} 를 읽지 못했다 (${code || String(e)})` };
      }
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch (e) {
        return { ok: false, reason: 'invalid', detail: `${query} 가 JSON 이 아니다: ${e instanceof Error ? e.message : String(e)}` };
      }
      const list = Array.isArray(json) ? json : (json as { endpoints?: unknown } | null)?.endpoints;
      if (!Array.isArray(list)) return { ok: false, reason: 'invalid', detail: `${query}: 배열이나 {endpoints:[…]} 가 아니다` };
      const out: DiscoveredAddress[] = (list as unknown[]).map((x) => {
        const e = (x ?? {}) as { host?: unknown; port?: unknown };
        return { host: typeof e.host === 'string' ? e.host : '', port: typeof e.port === 'number' ? e.port : Number.NaN };
      });
      return normalizeEndpoints(out, `파일 ${query}`);
    },
  };
}
