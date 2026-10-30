/**
 * 앱 셸의 메뉴와 화면 머리 (#126, 디자인 시안 「App Shell」 · 「Console」).
 *
 * 사이드바 그룹 · 항목 · 아이콘 · 화면 제목과 설명이 여기 한 자리다. 주소는 `page.ts` 가 정본이고,
 * 테스트가 둘을 맞춰 본다 — 메뉴가 없는 주소를 가리키거나, 화면에 제목이 빠지면 깨진다.
 */
import type { Place } from './page.js';

export type NavItem = { place: Place; label: string; icon: string; href: string };
export type NavGroup = { title: string; items: readonly NavItem[] };

/** 시안의 `GROUPS` 순서 그대로. 전역 모드는 클러스터를 숨긴다(지역마다 따로다). */
export const NAV_GROUPS: readonly NavGroup[] = [
  { title: '', items: [{ place: 'dashboard', label: '대시보드', icon: '▦', href: '/' }] },
  { title: '변경', items: [{ place: 'impact', label: '적용 대기', icon: '◐', href: '/change/pending' }] },
  {
    title: '트래픽',
    items: [
      { place: 'listeners', label: '리스너', icon: '⇄', href: '/traffic/listener' },
      { place: 'routes', label: '라우트', icon: '⑂', href: '/traffic/route/http' },
      { place: 'pools', label: '풀', icon: '▤', href: '/traffic/pool' },
      { place: 'backends', label: '백엔드', icon: '▣', href: '/traffic/backend' },
      { place: 'addressSets', label: '주소 집합', icon: '⊞', href: '/traffic/address-set' },
    ],
  },
  {
    title: 'TLS',
    items: [
      { place: 'certificates', label: '인증서', icon: '◈', href: '/tls/certificate' },
      { place: 'tlsPolicies', label: 'TLS 정책', icon: '⛨', href: '/tls/policy' },
      { place: 'sniBindings', label: 'SNI 바인딩', icon: '⊕', href: '/tls/sni' },
    ],
  },
  {
    title: '운영',
    items: [
      { place: 'status', label: '상태', icon: '◉', href: '/ops/status' },
      { place: 'cluster', label: '클러스터', icon: '◫', href: '/ops/cluster' },
      { place: 'rendered', label: '렌더된 설정', icon: '❯', href: '/ops/rendered' },
      { place: 'audit', label: '기록', icon: '◷', href: '/ops/audit' },
    ],
  },
  {
    title: '관리',
    items: [
      { place: 'users', label: '사람', icon: '☺', href: '/admin/user' },
      { place: 'account', label: '내 계정', icon: '⚙', href: '/account' },
    ],
  },
];

/** 사이드바 없이 혼자 서는 화면 — 로그인 · 초대 수락 · 비밀번호 재설정 · 이메일 확인(시안). */
export const STANDALONE: readonly Place[] = ['login', 'invite', 'reset', 'email'];

/** 화면 제목과 한 줄 설명 — 시안 문구(ASD-STE100 · 해요체) 그대로. */
export const PAGE_META: Readonly<Record<Place, { title: string; desc: string }>> = {
  dashboard: { title: '대시보드', desc: '이 인스턴스의 상태를 확인해요.' },
  impact: { title: '적용 대기', desc: '커밋한 변경의 영향을 확인하고 적용해요.' },
  listeners: { title: '리스너', desc: '사용할 프로토콜과 경로, 기본 동작을 정해요.' },
  routes: { title: '라우트', desc: '호스트와 경로에 따라 요청을 풀이나 동작으로 보내요.' },
  pools: { title: '풀', desc: '백엔드를 묶고 알고리즘과 헬스체크를 정해요.' },
  backends: { title: '백엔드', desc: '풀에 속한 서버와 실시간 헬스를 확인해요.' },
  addressSets: { title: '주소 집합', desc: '출발지 제한과 신뢰 대역에 쓰는 대역 묶음이에요.' },
  certificates: { title: '인증서', desc: 'TLS 인증서를 발급하거나 업로드해요.' },
  tlsPolicies: { title: 'TLS 정책', desc: 'TLS 버전, 암호군, HSTS를 정해요.' },
  sniBindings: { title: 'SNI 바인딩', desc: '호스트별로 인증서를 연결해요.' },
  status: { title: '상태', desc: 'head 리비전, 리더, 게시 세대, 엔진 정보를 확인해요.' },
  cluster: { title: '클러스터', desc: '노드별 활성 세대와 상태를 확인해요.' },
  rendered: { title: '렌더된 설정', desc: '리비전별 nginx.conf를 확인해요.' },
  audit: { title: '기록', desc: '변경 기록을 묶음 단위로 확인해요.' },
  users: { title: '사람', desc: '사용자와 초대를 관리해요.' },
  account: { title: '내 계정', desc: '비밀번호, 인증 앱, 복구 코드, SSO를 관리해요.' },
  regions: { title: '지역', desc: '전역 화면은 읽기만 해요. 설정은 그 지역의 GUI에서 바꿔요.' },
  design: { title: '디자인 시스템', desc: '공통 컴포넌트를 상태별로 늘어놓았어요. 데이터는 예시예요.' },
  login: { title: '로그인', desc: '계정이나 IdP로 들어오거나, 토큰으로 연결해요.' },
  invite: { title: '초대 수락', desc: '초대·첫 관리자·복구 링크는 한 번만 써요.' },
  reset: { title: '비밀번호 재설정', desc: '계정 이메일로 링크를 받아요.' },
  email: { title: '이메일 확인', desc: '새 주소로 간 링크를 열면 바뀌어요.' },
};

/** 이 자리가 속한 메뉴 그룹과 항목. 메뉴에 없는 자리(로그인 · 지역 · 디자인)는 undefined. */
export function navOf(place: Place): { group: NavGroup; item: NavItem } | undefined {
  for (const group of NAV_GROUPS) {
    const item = group.items.find((i) => i.place === place);
    if (item !== undefined) return { group, item };
  }
  return undefined;
}

/** 상단 바 브레드크럼 — 그룹 / 화면 / (상세면 key). 마지막 칸은 링크가 아니다. */
export function crumbsOf(place: Place, detail?: string): { label: string; href?: string }[] {
  const nav = navOf(place);
  const title = PAGE_META[place].title;
  const out: { label: string; href?: string }[] = [];
  if (nav !== undefined && nav.group.title !== '') out.push({ label: nav.group.title });
  if (detail === undefined) {
    out.push({ label: title });
  } else {
    out.push({ label: title, href: nav?.item.href ?? '/' }, { label: detail });
  }
  return out;
}
