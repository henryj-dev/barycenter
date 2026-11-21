/**
 * 「백업·복원」 화면의 순수 함수 (2026-11-21) — 올린 파일 읽기 · 바뀌는 줄 · 영향 줄 · 파일 이름.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { changeLines, changeSummary, downloadName, impactLines, parseUpload } from '../../src/web/backup-view.js';
import { NAV_GROUPS, PAGE_META } from '../../src/web/nav.js';

describe('올린 파일', () => {
  it('내보내기 매니페스트와 백업 묶음을 둘 다 받는다', () => {
    const manifest = { schemaVersion: '1', resources: [{ kind: 'pool', key: 'a', spec: {} }] };
    expect(parseUpload(JSON.stringify(manifest))).toEqual({ manifest, resources: 1 });
    expect(parseUpload(JSON.stringify({ revision: '12', manifest }))).toEqual({ manifest, resources: 1, fromRevision: '12' });
  });

  it('JSON 이 아니거나 resources 가 없으면 이유를 준다', () => {
    expect(parseUpload('nope')).toHaveProperty('error');
    expect(parseUpload('[]')).toHaveProperty('error');
    expect(parseUpload('{"manifest":{}}')).toHaveProperty('error');
  });
});

describe('바뀌는 줄', () => {
  const changes = [
    { change: 'added' as const, kind: 'pool', key: 'new' },
    { change: 'removed' as const, kind: 'backend', key: 'old' },
    { change: 'changed' as const, kind: 'listener', key: 'web' },
  ];

  it('지우는 것을 먼저 둔다', () => {
    expect(changeLines(changes).map((l) => l.text)).toEqual(['지움: 백엔드 old', '바뀜: 리스너 web', '추가: 풀 new']);
    expect(changeLines(changes)[0]!.tone).toBe('danger');
  });

  it('요약은 있는 것만 센다', () => {
    expect(changeSummary(changes)).toBe('추가 1 · 바뀜 1 · 지움 1');
    expect(changeSummary([changes[0]!])).toBe('추가 1');
    expect(changeSummary([])).toBe('');
  });
});

describe('영향 줄', () => {
  it('커밋만 한다는 것과 reload 를 말하고, 끊기는 세션을 위험으로 둔다', () => {
    const lines = impactLines({
      unchanged: false, preview: true, revision: '5', changes: [],
      impact: {
        requiresReload: true, affectedListeners: [], socketChanges: { added: ['tcp 0.0.0.0:81'], removed: [] }, planes: ['http'],
        sessionImpact: [{ protocol: 'tcp', effect: 'may_reset', why: 'stream 은 reload 에 끊긴다' }],
      },
    });
    expect(lines[0]!.text).toContain('적용 대기 화면에서 적용해야');
    expect(lines[1]!.tone).toBe('warn');
    expect(lines.some((l) => l.tone === 'danger' && l.text.includes('끊길 수 있다'))).toBe(true);
    expect(lines.some((l) => l.text === '열리는 소켓 tcp 0.0.0.0:81')).toBe(true);
  });

  it('같으면 줄이 없다', () => {
    expect(impactLines({ unchanged: true, revision: '5', changes: [] })).toEqual([]);
  });
});

describe('파일 이름', () => {
  it('지역과 리비전을 넣고, 파일 이름에 못 쓰는 글자는 바꾼다', () => {
    expect(downloadName('backup', '42')).toBe('barycenter-backup-r42.json');
    expect(downloadName('export', '7', 'icn 01/a')).toBe('barycenter-icn-01-a-export-r7.json');
  });
});

describe('화면 자리', () => {
  it('운영 메뉴에 「백업·복원」 이 있고 제목이 있다', () => {
    const ops = NAV_GROUPS.find((g) => g.title === '운영')!;
    expect(ops.items.some((i) => i.place === 'backup' && i.href === '/ops/backup')).toBe(true);
    expect(PAGE_META.backup.title).toBe('백업·복원');
  });

  it('가져오기 · 복원은 미리 본 뒤에만 커밋하고, 복원은 관리자만 · 「복원」 을 넣어야 연다', () => {
    const src = readFileSync(join(import.meta.dirname, '../../gui/src/lib/ops/BackupRestore.svelte'), 'utf8');
    expect(src).toContain('desk.importPreview(');
    expect(src).toContain('flow.preview.revision');
    expect(src).toContain('{#if !admin}');
    expect(src).toContain('requireName="복원"');
  });
});
