/**
 * 「백업 · 복원」 화면이 읽는 값 (2026-11-21).
 *
 * 화면은 네 가지를 한다: 내보내기(리비전 하나의 매니페스트) · 가져오기(merge · replace) · 백업 받기 · 복원(admin).
 * 가져오기와 복원은 **먼저 미리 본다** — 서버가 커밋과 같은 경로로 바뀌는 것과 영향을 계산하고 changeset 을 버린다.
 * 이 모듈은 올린 파일을 읽고, 미리 본 결과를 화면 줄로 접는다. 렌더는 여기 없어서 시험이 브라우저를 열지 않는다.
 */
import { viewOfImpact, type Impact } from './impact-view.js';

/** 서버의 `ImportChange`. */
export type ImportChange = { change: 'added' | 'changed' | 'removed'; kind: string; key: string };

/** `POST /config/import` 의 미리 보기 응답(`preview: true`). */
export type ImportPreview = {
  unchanged: boolean;
  preview?: boolean;
  revision: string;
  changes: ImportChange[];
  impact?: Impact;
};

export type PreviewLine = { tone: 'ok' | 'warn' | 'danger' | 'info'; icon: string; text: string };

/**
 * 올린 파일 한 장. 두 모양을 받는다:
 * - 내보내기 매니페스트 `{ schemaVersion, resources }` (`bary export`, 이 화면의 「내보내기」)
 * - 백업 묶음 `{ revision, manifest }` (`bary backup`, 이 화면의 「백업 받기」)
 *
 * 모양이 아니면 이유를 준다. 안의 리소스는 서버가 검사한다 — 여기서 두 번 하지 않는다.
 */
export type UploadedConfig = { manifest: unknown; resources: number; fromRevision?: string };

export function parseUpload(text: string): UploadedConfig | { error: string } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { error: 'JSON 파일이 아니에요. 내보내기나 백업으로 받은 파일을 올려요.' };
  }
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) {
    return { error: '설정 파일 모양이 아니에요. 내보내기나 백업으로 받은 파일을 올려요.' };
  }
  const rec = doc as Record<string, unknown>;
  const bundle = 'manifest' in rec ? rec['manifest'] : doc;
  const resources = bundle !== null && typeof bundle === 'object' ? (bundle as Record<string, unknown>)['resources'] : undefined;
  if (!Array.isArray(resources)) {
    return { error: '파일에 resources 목록이 없어요. 내보내기나 백업으로 받은 파일을 올려요.' };
  }
  const from = rec['revision'];
  return {
    manifest: bundle,
    resources: resources.length,
    ...(typeof from === 'string' && from !== '' ? { fromRevision: from } : {}),
  };
}

const KIND_WORD: Readonly<Record<string, string>> = {
  engine: '엔진 설정', pool: '풀', backend: '백엔드', certificate: '인증서', tlsPolicy: 'TLS 정책',
  addressSet: '주소 집합', listener: '리스너', httpRoute: 'HTTP 라우트', passthroughRoute: '패스스루 라우트',
  sniBinding: 'SNI 바인딩',
};
export const kindWord = (kind: string): string => KIND_WORD[kind] ?? kind;

const CHANGE_MARK: Readonly<Record<ImportChange['change'], { icon: string; word: string; tone: PreviewLine['tone'] }>> = {
  added: { icon: '＋', word: '추가', tone: 'ok' },
  changed: { icon: '±', word: '바뀜', tone: 'info' },
  removed: { icon: '−', word: '지움', tone: 'danger' },
};

/** 「추가 3 · 바뀜 1 · 지움 2」. 바뀌는 것이 없으면 빈 문자열. */
export function changeSummary(changes: readonly ImportChange[]): string {
  const n = (c: ImportChange['change']): number => changes.filter((x) => x.change === c).length;
  return (['added', 'changed', 'removed'] as const)
    .filter((c) => n(c) > 0)
    .map((c) => `${CHANGE_MARK[c].word} ${n(c)}`)
    .join(' · ');
}

/** 바뀌는 리소스 한 줄씩. **지우는 것을 먼저** 둔다 — 읽는 순서가 곧 위험 순서다. */
export function changeLines(changes: readonly ImportChange[]): PreviewLine[] {
  const rank = { removed: 0, changed: 1, added: 2 } as const;
  return [...changes]
    .sort((a, b) => rank[a.change] - rank[b.change])
    .map((c) => ({
      tone: CHANGE_MARK[c.change].tone,
      icon: CHANGE_MARK[c.change].icon,
      text: `${CHANGE_MARK[c.change].word}: ${kindWord(c.kind)} ${c.key}`,
    }));
}

/**
 * 미리 본 영향 — 적용하면 일어날 일. 커밋 자체는 트래픽을 안 바꾼다는 것을 첫 줄로 말한다.
 * 끊기는 세션 · 막는 소켓을 경고로, 나머지는 정보로 둔다.
 */
export function impactLines(p: ImportPreview): PreviewLine[] {
  if (p.unchanged || p.impact === undefined) return [];
  const v = viewOfImpact({ planId: '', revision: p.revision }, p.impact);
  const out: PreviewLine[] = [
    { tone: 'info', icon: 'ⓘ', text: '커밋만 해요. 트래픽은 적용 대기 화면에서 적용해야 바뀌어요.' },
    { tone: v.requiresReload ? 'warn' : 'ok', icon: v.requiresReload ? '▲' : '●', text: `적용하면: ${v.headline}` },
  ];
  for (const s of v.sessions) out.push({ tone: s.includes('끊') ? 'danger' : 'warn', icon: '▲', text: s });
  for (const b of v.bindBlockers) out.push({ tone: 'danger', icon: '✕', text: b });
  for (const s of v.socketsAdded) out.push({ tone: 'info', icon: '＋', text: `열리는 소켓 ${s}` });
  for (const s of v.socketsRemoved) out.push({ tone: 'warn', icon: '−', text: `닫히는 소켓 ${s}` });
  for (const c of v.certificates) out.push({ tone: 'info', icon: '◈', text: c });
  for (const w of [...v.routeWarnings, ...v.capabilityWarnings]) out.push({ tone: 'warn', icon: '▲', text: w });
  return out;
}

/** 내려받을 파일 이름. 지역이 있으면 넣는다 — 여러 지역의 파일이 섞이지 않게. */
export function downloadName(what: 'export' | 'backup', revision: string, region?: string): string {
  const safe = (s: string): string => s.replace(/[^A-Za-z0-9._-]+/g, '-');
  return ['barycenter', ...(region === undefined ? [] : [safe(region)]), what, `r${safe(revision)}`].join('-') + '.json';
}
