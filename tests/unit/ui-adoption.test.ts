/**
 * 화면이 디자인 시스템 컴포넌트를 쓰는가 (#126).
 *
 * 공통 컴포넌트(`#lib/ui`)를 만들어 두고 화면이 자기 마크업을 계속 그리면, 시안을 고칠 때 두 벌을
 * 고쳐야 하고 한 벌은 반드시 낡는다. 그래서 「이 화면은 공통 컴포넌트로 옮겼다」 를 기계로 지킨다.
 * 단계마다 아래 표에 화면을 더한다.
 *
 *   1단계(이 파일의 첫 판) — 리소스 목록 9개는 `DataTable` 이다.
 *   2단계 — 만들기 폼 14개는 `CreateForm`(공통 `Form`) 위의 `FormSection` · `FormRow` 다. 날 입력을 안 그린다.
 *   3단계 — 상세 탭 10개와 리스너 수정 폼은 `#lib/ui` 를 쓰고, 옛 `d-*` 클래스와 날 입력을 안 쓴다.
 *   4단계 — 운영 화면 8개(대시보드 · 적용 대기 · 롤백 · 상태 · 렌더 결과 · 감사 · 클러스터 둘)도 그렇다.
 *           옛 상세 공통 스타일(`detail/style.css`)을 지웠다.
 *   5단계 — 계정 · 로그인 · 초대 · 재설정 · 사람 관리 · 지역 화면도 그렇다. 옛 변수 별칭(`--plate` …)을 지웠다.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src');
const read = (p: string): string => readFileSync(join(GUI, p), 'utf8');
/**
 * 스크립트 · 스타일을 뺀 마크업 — 마지막 스크립트 닫는 태그 뒤부터 스타일 여는 태그 앞까지.
 * 정규식으로 태그를 지우지 않는다(코드 스캔이 그것을 불완전한 정화로 본다). 우리 파일의 모양은
 * 언제나 「스크립트들 → 마크업 → 스타일」 이다.
 */
const markup = (src: string): string => {
  const close = '</' + 'script>';
  const start = src.lastIndexOf(close);
  const body = start < 0 ? src : src.slice(start + close.length);
  const style = body.indexOf('<' + 'style');
  return style < 0 ? body : body.slice(0, style);
};

const LISTS: readonly [route: string, component: string][] = [
  ['routes/traffic/listener/+page.svelte', 'ListenerList'],
  ['routes/traffic/route/http/+page.svelte', 'HttpRouteList'],
  ['routes/traffic/route/passthrough/+page.svelte', 'PassthroughRouteList'],
  ['routes/traffic/pool/+page.svelte', 'PoolList'],
  ['routes/traffic/backend/+page.svelte', 'BackendList'],
  ['routes/traffic/address-set/+page.svelte', 'AddressSetList'],
  ['routes/tls/certificate/+page.svelte', 'CertificateList'],
  ['routes/tls/policy/+page.svelte', 'TlsPolicyList'],
  ['routes/tls/sni/+page.svelte', 'SniBindingList'],
];

describe('리소스 목록은 공통 데이터 테이블이다', () => {
  for (const [route, component] of LISTS) {
    it(`${route} → ${component} → DataTable`, () => {
      expect(read(route)).toContain(`from '#lib/lists/${component}.svelte'`);
      const src = read(`lib/lists/${component}.svelte`);
      expect(src).toMatch(/import \{[^}]*\bDataTable\b[^}]*\} from '#lib\/ui'/);
      expect(markup(src)).toContain('<DataTable');
      // 자기 표·목록을 그리지 않는다 — 그건 DataTable 의 몫이다.
      expect(markup(src)).not.toMatch(/<(table|ul|ol)\b/);
      // 「만들기」 는 페이지 머리 오른쪽이다(시안). 전역 모드면 안 그린다.
      expect(src).toContain('usePageActions(');
    });
  }

  it('목록의 삭제는 이름을 넣는 확인 대화상자를 거친다', () => {
    const dlg = read('lib/lists/DeleteConfirm.svelte');
    expect(dlg).toMatch(/requireName=\{target\.key\}/);
    for (const [, component] of LISTS) {
      const src = read(`lib/lists/${component}.svelte`);
      if (src.includes("'삭제…'")) expect(src, component).toContain('<DeleteConfirm');
    }
  });
});

const FORMS: readonly [route: string, component: string][] = [
  ['routes/traffic/listener/new/http/+page.svelte', 'HttpListenerForm'],
  ['routes/traffic/listener/new/https/+page.svelte', 'HttpListenerForm'],
  ['routes/traffic/listener/new/tcp/+page.svelte', 'TcpListenerForm'],
  ['routes/traffic/listener/new/udp/+page.svelte', 'UdpListenerForm'],
  ['routes/traffic/listener/new/tls_passthrough/+page.svelte', 'PassthroughListenerForm'],
  ['routes/traffic/listener/new/quick/+page.svelte', 'QuickProxyForm'],
  ['routes/traffic/route/http/new/+page.svelte', 'HttpRouteForm'],
  ['routes/traffic/route/passthrough/new/+page.svelte', 'PassthroughRouteForm'],
  ['routes/traffic/pool/new/+page.svelte', 'PoolForm'],
  ['routes/traffic/backend/new/+page.svelte', 'BackendForm'],
  ['routes/traffic/address-set/new/+page.svelte', 'AddressSetForm'],
  ['routes/tls/certificate/new/+page.svelte', 'CertificateForm'],
  ['routes/tls/policy/new/+page.svelte', 'TlsPolicyForm'],
  ['routes/tls/sni/new/+page.svelte', 'SniBindingForm'],
];

/** 날 입력 요소 — 그리는 것은 `#lib/ui` 의 몫이다. */
const RAW_INPUT = /<(input|select|textarea|button)\b/;

describe('만들기 폼은 공통 폼 컴포넌트다', () => {
  for (const [route, component] of FORMS) {
    it(`${route} → ${component} → CreateForm · FormSection · FormRow`, () => {
      expect(read(route)).toContain(`from '#lib/forms/${component}.svelte'`);
      const src = read(`lib/forms/${component}.svelte`);
      expect(src).toContain("from './CreateForm.svelte'");
      expect(markup(src)).toContain('<CreateForm');
      // 구획과 줄은 직접 쓰거나(대개) 공유 조각(`ListenerBasics`)이 쓴다.
      expect(markup(src)).toMatch(/<(FormSection|ListenerBasics)\b/);
      expect(markup(src), '날 입력을 그린다').not.toMatch(RAW_INPUT);
    });
  }

  it('폼 틀은 공통 Form 위에 있고, 공유 조각도 날 입력을 안 그린다', () => {
    const frame = read('lib/forms/CreateForm.svelte');
    expect(frame).toMatch(/import \{[^}]*\bForm\b[^}]*\} from '#lib\/ui'/);
    expect(markup(frame)).toContain('<Form');
    for (const part of ['ListenerBasics', 'ListenerOptions', 'SourceAllowSection', 'ProtocolPicker']) {
      expect(markup(read(`lib/forms/${part}.svelte`)), part).not.toMatch(RAW_INPUT);
    }
    expect(read('routes/traffic/listener/new/+page.svelte')).toContain("from '#lib/forms/ProtocolPicker.svelte'");
  });

  it('옛 만들기 컴포넌트가 남아 있지 않다 — 두 벌이면 한 벌은 낡는다', () => {
    const old = [
      'AddBackend', 'AddCert', 'AddHashPool', 'AddHttpsListener', 'AddListener', 'AddPassthroughListener',
      'AddPassthroughReject', 'AddPassthroughRoute', 'AddPool', 'AddRedirect', 'AddReject', 'AddRoute',
      'AddSniBinding', 'AddSourceIpHashPool', 'AddTcpListener', 'AddTlsPolicy', 'AddUdpListener',
      'Listeners', 'Pools', 'Routes', 'Certs', 'ListenerOptions',
    ];
    for (const name of old) expect(existsSync(join(GUI, `lib/${name}.svelte`)), name).toBe(false);
  });
});

const DETAIL = [
  'detail/Overview', 'detail/Settings', 'detail/Relations', 'detail/Traffic', 'detail/History',
  'detail/Acme', 'detail/BackendHealth', 'detail/PoolBackends', 'detail/JsonEdit', 'detail/Rebuild',
  'listener/ListenerForm',
] as const;

describe('상세 탭은 공통 컴포넌트다', () => {
  for (const name of DETAIL) {
    it(`${name} → #lib/ui · d-* 없음 · 날 입력 없음`, () => {
      const src = read(`lib/${name}.svelte`);
      expect(src).toMatch(/import \{[^}]*\} from '#lib\/ui'/);
      // 옛 상세 공통 클래스(`detail/style.css`)는 디자인 토큰 이전의 것이다.
      expect(markup(src), '옛 d-* 클래스를 쓴다').not.toMatch(/class="[^"]*\bd-[a-z0-9]+/);
      expect(markup(src), '날 입력을 그린다').not.toMatch(RAW_INPUT);
    });
  }

  it('출발지 제한 칸은 한 벌이다 — 수정 폼도 만들기 폼의 구획을 쓴다', () => {
    expect(read('lib/listener/ListenerForm.svelte')).toContain("from '#lib/forms/SourceAllowSection.svelte'");
    expect(existsSync(join(GUI, 'lib/SourceAllow.svelte'))).toBe(false);
  });
});

const OPS: readonly [route: string, components: readonly string[]][] = [
  ['routes/+page.svelte', ['Dashboard']],
  ['routes/change/pending/+page.svelte', ['PendingImpact', 'RevisionRollback']],
  ['routes/ops/status/+page.svelte', ['StatusPanel']],
  ['routes/ops/rendered/+page.svelte', ['RenderedConf']],
  ['routes/ops/audit/+page.svelte', ['AuditLog']],
  ['routes/ops/cluster/+page.svelte', ['ClusterNodes']],
  ['routes/ops/cluster/[node]/+page.svelte', ['ClusterNodeView']],
];

describe('운영 화면은 공통 컴포넌트다', () => {
  for (const [route, components] of OPS) {
    it(`${route} → ${components.join(' · ')}`, () => {
      const page = read(route);
      for (const c of components) {
        expect(page).toContain(`from '#lib/ops/${c}.svelte'`);
        const src = read(`lib/ops/${c}.svelte`);
        expect(src).toMatch(/import \{[^}]*\} from '#lib\/ui'/);
        expect(markup(src), `${c} 가 옛 d-* 클래스를 쓴다`).not.toMatch(/class="[^"]*\bd-[a-z0-9]+/);
        expect(markup(src), `${c} 가 날 입력을 그린다`).not.toMatch(RAW_INPUT);
      }
    });
  }

  it('적용 대기는 영향 요약 카드다 — 끊기는 것을 먼저 쓴다', () => {
    const src = read('lib/ops/PendingImpact.svelte');
    expect(markup(src)).toContain('<ImpactCard');
    expect(src.indexOf('socketsRemoved'), '닫히는 소켓이 열리는 소켓보다 먼저다').toBeLessThan(src.indexOf('socketsAdded.map'));
  });

  it('옛 운영 컴포넌트와 상세 공통 스타일이 남아 있지 않다', () => {
    for (const name of ['Impact', 'Rollback', 'Status', 'Audit', 'Rendered']) {
      expect(existsSync(join(GUI, `lib/${name}.svelte`)), name).toBe(false);
    }
    expect(existsSync(join(GUI, 'lib/detail/style.css'))).toBe(false);
    expect(read('routes/+layout.svelte')).not.toContain('detail/style.css');
  });
});

const ACCOUNT = [
  'lib/account/PasswordStep.svelte', 'lib/account/MfaStep.svelte', 'lib/account/StepUpDialog.svelte',
  'lib/account/ChangePassword.svelte', 'lib/account/ChangeEmail.svelte', 'lib/account/RecoveryCodes.svelte',
  'lib/account/TotpSetup.svelte', 'lib/account/TotpManage.svelte', 'lib/account/SsoIdentities.svelte',
  'lib/account/SsoJit.svelte', 'routes/account/+page.svelte', 'routes/admin/user/+page.svelte',
  'routes/email/+page.svelte', 'routes/reset/+page.svelte', 'routes/invite/+page.svelte',
  'routes/regions/+page.svelte', 'routes/login/+page.svelte',
] as const;

/** `gui/src` 아래 화면 파일 전부. */
const allSources = (dir = GUI): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? allSources(join(dir, e.name)) : /\.(svelte|css|ts)$/.test(e.name) ? [join(dir, e.name)] : []));

describe('계정 화면은 공통 컴포넌트다', () => {
  for (const f of ACCOUNT) {
    it(`${f} → #lib/ui · 날 입력 없음`, () => {
      const src = read(f);
      expect(src).toMatch(/import \{[^}]*\} from '#lib\/ui'/);
      expect(markup(src), '날 입력을 그린다').not.toMatch(RAW_INPUT);
    });
  }

  it('삭제는 브라우저 대화상자가 아니라 확인 대화상자다', () => {
    const src = read('routes/admin/user/+page.svelte');
    expect(src).not.toMatch(/\bconfirm\(/);
    expect(markup(src)).toContain('<ConfirmDialog');
  });

  it('옛 변수 별칭이 없다 — 화면이 디자인 토큰만 쓴다', () => {
    const OLD = /var\(--(void|plate|rule|ink|mute|ember|moss|amber|display|ui|data|paper)\)/;
    const tokens = read('lib/ui/tokens.css');
    expect(tokens, '별칭 블록이 남았다').not.toMatch(/--plate\s*:/);
    for (const file of allSources()) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(OLD);
    }
  });
});
