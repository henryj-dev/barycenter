/**
 * Rendered 화면이 읽는 값 — DESIGN.md §5.5 · §10
 *
 * GET /api/v1/config/rendered 는 **head 리비전**의 산출물이다.
 * nginx.conf 는 정본이 아니다. 폴링하지 않는다.
 */
export type RenderedFact = {
  revision?: unknown;
  digest?: unknown;
  planes?: unknown;
  conf?: unknown;
};

export type RenderedView = {
  revision: string | undefined;
  digest: string | undefined;
  planes: string[];
  conf: string;
};

const text = (v: unknown): string | undefined =>
  (typeof v === 'string' && v !== '' ? v : undefined);

export function viewOfRendered(body: unknown): RenderedView {
  const rec = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {};
  const planes = Array.isArray(rec['planes'])
    ? rec['planes'].filter((p): p is string => typeof p === 'string' && p !== '')
    : [];
  return {
    revision: text(rec['revision']),
    digest: text(rec['digest']),
    planes,
    conf: typeof rec['conf'] === 'string' ? rec['conf'] : '',
  };
}
