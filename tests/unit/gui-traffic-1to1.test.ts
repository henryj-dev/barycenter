/**
 * 트래픽 화면 넷(리스너 · 풀 · 백엔드 · 주소 집합) — 시안 1:1 (#126 후속).
 *
 * 재는 것(콘솔 시안 `colsOf` · `cells` · `INL` · `fieldsFor` · `drawer` · 상세 탭):
 *   · 목록 열의 라벨과 순서가 시안 `colsOf(page)` 와 같다 — 시안에 없는 열은 숨겨 둔다(「컬럼 ▾」)
 *   · 목록 칸은 링크가 아니다 — 행을 고르면 분할 상세, Enter · 두 번 누르기 · 「상세 페이지 ↗」 가 상세
 *   · 분할 상세는 인라인 수정(시안 `INL`)이다
 *   · 리스너 만들기 1 / 2 는 시안 글 그대로의 프로토콜 다섯이다
 *   · 상세 탭(개요 · 설정 · 트래픽 경로 · 연결된 리소스 · 기록)이 시안 블록을 그린다
 *
 * 파일은 테스트 안에서 읽는다(수정 전 트리에서 수집이 터지지 않고 빨강이 되도록).
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src');
const read = (p: string): string => readFileSync(join(GUI, p), 'utf8');
/** `label: '…'` 들을 나온 순서대로 — 숨긴 열은 뺀다. */
const labels = (block: string): string[] => [...block.matchAll(/\{ key: '[^']+', label: '([^']+)'([^\n]*)/g)].filter((m) => !m[2]!.includes('hidden: true')).map((m) => m[1]!);
const section = (src: string, start: string, end: string): string => src.slice(src.indexOf(start), src.indexOf(end, src.indexOf(start)));

describe('목록 열 (시안 colsOf)', () => {
  const cells = (): string => read('lib/lists/traffic-cells.ts');
  it.each([
    ['listenerColumns', 'backendRowsOf', ['이름', '프로토콜', '바인드:포트', '기본 풀 / 동작', '라우트', '출발지 제한', '상태', '활성화']],
    ['backendColumns', 'poolRowsOf', ['이름', '풀', '호스트:포트', '가중치', '헬스', '트래픽 수신', '드레인', '마지막 관측']],
    ['poolColumns', 'setSourceText', ['이름', '프로토콜 계열', '알고리즘', '백엔드(정상 / 전체)', '헬스체크', '업스트림 TLS']],
    ['addressSetColumns', 'cellOf', ['이름', '대역 수', '출처', '마지막 갱신', '사용하는 리스너']],
  ] as const)('%s', (start, end, want) => {
    expect(labels(section(cells(), `export const ${start}`, end))).toEqual(want);
  });

  it('리스너 상태 칸 — 시안 정상 · 적용 대기 · 반영대기, 활성화는 ● 켜짐 / ○ 꺼짐', () => {
    const c = cells();
    expect(c).toContain("b('pending', '◐', '반영대기')");
    expect(c).toContain("b('pending', '◐', '적용 대기')");
    expect(c).toContain("b('ok', '●', '정상')");
    expect(c).toContain("x(r.enabled ? '● 켜짐' : '○ 꺼짐')");
    // 시안에 없는 열(server_name)은 숨겨 둔다.
    expect(c).toMatch(/key: 'hosts', label: '호스트'.*hidden: true/);
  });

  it.each(['ListenerList', 'PoolList', 'BackendList', 'AddressSetList'])('%s — 칸은 링크가 아니고 분할 위쪽 표는 fill, 인라인 수정을 준다', (f) => {
    const s = read(`lib/lists/${f}.svelte`);
    expect(s).not.toMatch(/<a href=\{at\(r, resourcePath/);
    expect(s).toMatch(/bind:selected fill/);
    expect(s).toMatch(/\{#snippet inline\(\{ key, detailHref, pending \}\)\}<\w+Inline \{key\} \{detailHref\} \{pending\} \/>\{\/snippet\}/);
    // 시안 도구 줄은 찾기 · 「N개」 뿐이다 — 필터 칩이 없다.
    expect(s).not.toContain('{chips}');
  });
});

describe('분할 인라인 수정 (시안 INL)', () => {
  it('리스너: 기본(바인드 주소 · 포트 · 활성화) · 동작(기본 풀) · 접근 제한(출발지 제한)', () => {
    const s = read('lib/listener/ListenerInline.svelte');
    for (const t of ['<FormSection title="기본">', '<FormSection title="동작">', '<FormSection title="접근 제한">', 'label="포트"', 'label="활성화"', 'label="기본 풀"', 'label="출발지 제한"']) expect(s).toContain(t);
    expect(s).toContain('editListenerPatch(model, edit)');
  });
  it('백엔드: 호스트 · 포트 · 가중치 · 드레인 — 드레인은 바로 건다', () => {
    const s = read('lib/detail/BackendInline.svelte');
    for (const t of ['label="호스트"', 'label="포트"', 'label="가중치"', 'label="드레인"', 'desk.drain(key)', 'desk.undrain(key)']) expect(s).toContain(t);
  });
  it('풀: 알고리즘 · 주소 집합: 대역 목록', () => {
    expect(read('lib/pool/PoolInline.svelte')).toContain('label="알고리즘"');
    expect(read('lib/detail/AddressSetInline.svelte')).toContain('label="대역 목록"');
  });
});

describe('리스너 만들기 드로어 (시안 drawer)', () => {
  it('1 / 2 · 프로토콜 — 시안 글 그대로', () => {
    const s = read('lib/forms/ProtocolPicker.svelte');
    expect(s).toContain('프로토콜을 먼저 선택해요. 프로토콜마다 입력 항목이 달라요.');
    for (const d of ['HTTP 리버스 프록시예요. 호스트와 경로로 나눠요.', 'TLS를 종료하는 HTTP예요. 인증서와 TLS 정책이 필요해요.',
      'TCP 프록시예요. 트래픽을 풀로 그대로 보내요.', 'UDP 프록시예요. DNS, WireGuard, 게임에 쓰여요.', 'TLS를 종료하지 않고 SNI로만 나눠요.']) expect(s).toContain(d);
    const d = read('lib/forms/FormDrawer.svelte');
    expect(d).toContain("listenerPick: { title: '새 리스너', sub: '1 / 2 · 프로토콜 고르기', width: 500 }");
    expect(d).toContain("listener: { title: '새 리스너', sub: '2 / 2 · 설정', width: 500 }");
  });
  it('2 / 2 · 기본에 활성화, 끄면 같은 patch 본문에 enabled: false', () => {
    expect(read('lib/forms/ListenerBasics.svelte')).toContain('<FormRow label="활성화">');
    expect(read('lib/forms/listener-create.ts')).toContain("if (!s.enabled) body['enabled'] = false;");
  });
});

describe('상세 탭', () => {
  it.each(['listener', 'pool', 'backend', 'address-set'])('%s — 개요 · 설정 · 연결된 리소스 · 기록이 시안 블록을 쓴다', (d) => {
    expect(read(`routes/traffic/${d}/[key]/+page.svelte`)).toContain('<CellOverview kind=');
    expect(read(`routes/traffic/${d}/[key]/settings/+page.svelte`)).toContain('<TrafficSettings kind=');
    expect(read(`routes/traffic/${d}/[key]/resources/+page.svelte`)).toContain('<RelationRows kind=');
    expect(read(`routes/traffic/${d}/[key]/history/+page.svelte`)).toContain('<HistoryRows kind=');
  });
  it('트래픽 경로 — 리스너 · 풀은 시안 pathData 그림', () => {
    for (const d of ['listener', 'pool']) expect(read(`routes/traffic/${d}/[key]/traffic/+page.svelte`)).toContain('<TrafficPath kind=');
    const g = read('lib/detail/PathGraph.svelte');
    expect(g).toContain('{data.help} 노드를 누르면 상세로 가요.');
    expect(g).toContain('이 리소스로 이어지는 경로가 없어요.');
  });
  it('설정 탭의 안내 문구는 시안 hintTxt 그대로', () => {
    const f = read('lib/detail/SettingsFrame.svelte');
    for (const t of ['✕ 오류가 있는 항목을 고쳐요', '저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.', '◐ 적용 대기 중인 변경이 있어요.', '바뀐 값이 없어요.']) expect(f).toContain(t);
  });
});
