/**
 * 고를 수 있는 ACME CA (2026-11-21) — GUI 「＋ 새 계정」 과 `bary acme account create` 가 같이 쓴다.
 *
 * 처음에는 스테이징으로 확인하고, 되면 운영으로 바꾼다. 스테이징 인증서는 브라우저가 안 믿는다.
 */
export const ACME_DIRECTORIES = [
  { name: 'production', value: 'https://acme-v02.api.letsencrypt.org/directory', label: "Let's Encrypt", hint: '운영' },
  { name: 'staging', value: 'https://acme-staging-v02.api.letsencrypt.org/directory', label: "Let's Encrypt 스테이징", hint: '시험용 · 브라우저가 안 믿어요' },
] as const;

export const acmeDirectoryLabel = (url: string): string => ACME_DIRECTORIES.find((c) => c.value === url)?.label ?? url;

/** 스테이징 CA 인가 — 그 인증서는 브라우저가 안 믿는다. */
export const isStagingDirectory = (url: string): boolean => url.includes('staging');

/** `production` · `staging` · `https://…` → 디렉터리 URL. 모르는 말이면 던진다. */
export function acmeDirectoryOf(word: string): string {
  const named = ACME_DIRECTORIES.find((c) => c.name === word);
  if (named !== undefined) return named.value;
  if (word.startsWith('https://')) return word;
  throw new Error(`CA 를 모른다: ${JSON.stringify(word)} — production · staging · https://… 디렉터리 URL`);
}
