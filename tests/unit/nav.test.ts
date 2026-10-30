/**
 * 앱 셸의 메뉴 (#126) — 사이드바 · 상단 바 브레드크럼 · 페이지 머리.
 *
 * 메뉴는 `nav.ts`, 주소는 `page.ts` 가 정본이다. 둘이 갈리면 메뉴가 404 를 가리키거나, 고른 메뉴에
 * 불이 안 들어오거나, 화면 제목이 빈다. 그것을 잰다.
 */
import { describe, expect, it } from 'vitest';

import { NAV_GROUPS, PAGE_META, STANDALONE, crumbsOf, navOf } from '../../src/web/nav.js';
import { KIT_ROUTES, pageOf } from '../../src/web/page.js';

const items = NAV_GROUPS.flatMap((g) => g.items);

describe('사이드바 메뉴', () => {
  it('시안의 그룹 순서 그대로다', () => {
    expect(NAV_GROUPS.map((g) => g.title)).toEqual(['', '변경', '트래픽', 'TLS', '운영', '관리']);
    expect(items.map((i) => i.label)).toEqual([
      '대시보드', '적용 대기', '리스너', '라우트', '풀', '백엔드', '주소 집합',
      '인증서', 'TLS 정책', 'SNI 바인딩', '상태', '클러스터', '렌더된 설정', '기록', '사람', '내 계정',
    ]);
  });

  it('모든 메뉴가 미리 만든 화면을 가리키고, 그 주소에서 자기 메뉴에 불이 들어온다', () => {
    const paths = new Set(KIT_ROUTES.map((r) => r.path));
    for (const it of items) {
      expect(paths.has(it.href), it.href).toBe(true);
      expect(pageOf(it.href), it.href).toBe(it.place);
      expect(it.icon, it.label).not.toBe('');
    }
    expect(new Set(items.map((i) => i.place)).size).toBe(items.length);
  });

  it('메뉴가 없는 자리는 혼자 서는 화면 · 지역 · 디자인 견본뿐이다', () => {
    const places = new Set(KIT_ROUTES.map((r) => r.place));
    const unlisted = [...places].filter((p) => navOf(p) === undefined).sort();
    expect(unlisted).toEqual([...STANDALONE, 'regions', 'design'].sort());
  });

  it('모든 자리에 제목과 설명이 있다', () => {
    for (const r of KIT_ROUTES) {
      expect(PAGE_META[r.place].title, r.path).not.toBe('');
      expect(PAGE_META[r.place].desc, r.path).not.toBe('');
    }
  });
});

describe('브레드크럼', () => {
  it('그룹 / 화면 — 마지막 칸은 링크가 아니다', () => {
    expect(crumbsOf('listeners')).toEqual([{ label: '트래픽' }, { label: '리스너' }]);
    expect(crumbsOf('dashboard')).toEqual([{ label: '대시보드' }]);
  });

  it('상세면 화면 이름이 목록으로 가는 링크가 되고 key 가 붙는다', () => {
    expect(crumbsOf('routes', 'api')).toEqual([
      { label: '트래픽' }, { label: '라우트', href: '/traffic/route/http' }, { label: 'api' },
    ]);
  });
});
