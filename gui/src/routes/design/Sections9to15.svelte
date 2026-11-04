<script lang="ts">
  /**
   * 디자인 시스템 §9–§15 견본 (Claude Design 「Barycenter Design System」 #copy · #screens2 · #ext · #r3 · #r4 · #r5 · #r6).
   * `/design` 페이지가 §1–§8 뒤에 붙인다. 데이터는 예시다 — API 를 부르지 않는다.
   * 도메인 컴포넌트는 API 없이 그려지는 것만 쓴다(`RealIpSection` · `SourceRulesField`). 나머지는 `#lib/ui` 로 그린다.
   */
  import {
    Badge, Button, Card, ConfirmDialog, FieldMessage, FormRow, ImpactCard, KeyValueEditor, Menu, NumberInput,
    RadioGroup, Select, Switch, TextArea, TextInput, toast, type KvRow,
  } from '#lib/ui';
  import RealIpSection, { type RealIpHeader, type RealIpSource } from '#lib/listener/RealIpSection.svelte';
  import SourceRulesField, { emptyRule, type SourceRuleRow } from '#lib/forms/SourceRulesField.svelte';
  import { urlCheck } from '#lib/forms/url-check';
  import { rewritePath } from '#lib/forms/rewrite';
  import { nodeState, type ClusterNode } from '#lib/ops/cluster';
  import DesignDesk from './DesignDesk.svelte';

  const pathTip = (): void => { toast.info('상세로 가요', '노드를 누르면 그 리소스 상세가 열려요.'); };

  // ── §9 문구 규칙 ──
  const BAN = ['잠시', '간단히', '쉽게', '효과적으로', '매우', '한눈에', '편리하게', '원활하게', '빠르게'];
  const copyRules = [
    { n: 1, t: '결론을 맨 앞에 둬요', d: '결과나 동작을 먼저 써요. 이유와 조건은 뒤에 써요.' },
    { n: 2, t: '한 문장에 한 내용만 담아요', d: '설명은 짧게 써요. 길면 두 문장으로 나눠요.' },
    { n: 3, t: '능동태로 써요', d: '주어를 밝혀요. "~됩니다", "~되었습니다"를 쓰지 않아요.' },
    { n: 4, t: '꾸밈말을 빼요', d: '쉽고 단순한 단어만 써요. 같은 대상에는 같은 단어를 써요.' },
    { n: 5, t: '말투는 해요체, 버튼은 짧게', d: '문장은 "~해요"로 끝내요. 버튼과 라벨은 "저장", "취소"처럼 짧은 말로 써요.' },
  ];
  const copyEx = [
    { k: '수동태', bad: '변경 사항이 적용되었습니다.', good: 'r9를 적용했어요.' },
    { k: '버튼', bad: '저장하기 / 취소하기 / 저장한다', good: '저장 / 취소 / 풀에서 빼기' },
    { k: '오류', bad: '포트 값이 올바르지 않습니다.', good: '포트는 1–65535 사이여야 해요.' },
    { k: '확인 대화상자', bad: '정말로 이 리스너를 삭제하시겠습니까?', good: '트래픽이 끊겨요. 리스너 web을 빼요.' },
    { k: '꾸밈말', bad: '잠시 후 간단히 확인할 수 있어요.', good: '5초 뒤 상태를 확인해요.' },
    { k: '말투', bad: '설정을 저장합니다. / 설정을 저장한다.', good: '설정을 저장해요.' },
    { k: '결론 먼저', bad: '변경을 검토한 뒤, 영향이 없으면 적용할 수 있어요.', good: '적용해요. 먼저 영향을 확인해요.' },
  ];
  const GL: [string, string, string, string][] = [
    ['적용', 'apply', '커밋한 리비전을 실제 nginx에 반영해요.', '반영, 배포, 푸시'], ['커밋', 'commit', '초안을 리비전으로 확정해요.', '확정, 저장 확정'],
    ['저장', 'save', '폼 값을 서버에 보내요. 저장하면 커밋해요.', '반영'], ['적용 대기', 'pending', '커밋했지만 아직 적용하지 않은 상태.', '대기 중, 미적용, 반영 대기'],
    ['리비전', 'revision', '커밋마다 생기는 설정 버전. 예: r9.', '버전, 개정'], ['롤백', 'rollback', '이전 리비전으로 되돌려 적용해요.', '복구, 원복'],
    ['영향', 'impact', '적용이 세션과 소켓에 하는 일.', '파급, 효과'], ['리스너', 'listener', '포트를 열고 연결을 받는 진입점.', '수신기, 포트'],
    ['라우트', 'route', '호스트와 경로로 요청을 나누는 규칙.', '경로 규칙, 라우팅 규칙'], ['풀', 'pool', '백엔드 묶음.', '그룹, 클러스터, 업스트림'],
    ['백엔드', 'backend', '풀에 속한 서버.', '서버, 노드, 업스트림 서버'], ['드레인', 'drain', '새 연결을 막고 기존 연결만 끝내요.', '비우기, 제외 중'],
    ['빼기', 'remove', '백엔드를 풀에서 없애요.', '제거, 분리'], ['삭제', 'delete', '리소스를 없애요.', '지우기, 제거'],
    ['만들기', 'create', '새 리소스를 만들어요.', '추가, 생성, 등록'], ['추가', 'add', '목록에 행을 하나 넣어요. 예: 규칙을 더해요.', '추가해요'],
    ['헬스', 'health', '백엔드 상태. 정상, 비정상, 확인 중, 관측 없음.', '건강, 상태 체크'], ['소켓', 'socket', '열리거나 닫히는 주소와 포트.', '포트(모호함)'],
    ['세션', 'session', '진행 중인 연결.', '커넥션'], ['세대', 'generation', 'reload마다 생기는 워커 묶음. 예: r9-e8.', '에포크, 버전'],
    ['인증서', 'certificate', 'TLS 인증서.', '증명서'], ['지역', 'region', '인스턴스가 속한 리전.', '리전'],
    ['전역', 'global', '모든 지역을 합친 보기.', '글로벌'], ['리더', 'leader', '변경을 적용하는 인스턴스.', '마스터, 주 인스턴스'],
  ];
  let gq = $state('');
  const glossary = $derived(GL.filter((g) => gq.trim() === '' || g.join(' ').toLowerCase().includes(gq.trim().toLowerCase())));
  let ct = $state('변경 사항이 적용되었습니다.\n잠시 후 간단히 확인할 수 있습니다.\n포트는 1–65535 사이여야 해요.');
  /** 문구 검사 — 한 줄이나 한 문장마다 긴 문장 · 꾸밈말 · 격식체 · 사전체 · 수동태를 본다(시안 `ctRes`). */
  const ctRes = $derived(ct.split(/\n|(?<=[.!?])\s+/).map((x) => x.trim()).filter(Boolean).map((t) => {
    const m: string[] = [];
    if (t.replace(/\s/g, '').length > 30) m.push('문장이 길어요. 두 문장으로 나눠요.');
    for (const b of BAN) if (t.includes(b)) m.push(`꾸밈말 "${b}"을 빼요.`);
    if (/(습니다|합니다|입니다|십시오)[.?!]?$/.test(t)) m.push('격식체예요. "~해요"로 써요.');
    if (/(한다|된다|있다|없다|는다|이다)[.?!]?$/.test(t)) m.push('사전체예요. "~해요"로 써요.');
    if (/(되었|됐|됩니다|되어)/.test(t)) m.push('수동태예요. 주어를 밝혀 능동태로 써요.');
    return { t, m: m.join(' '), n: m.length };
  }));

  // ── §10 화면 컴포넌트 · 2차 리뷰 ──
  const SETS = ['Cloudflare', '사설망', '루프백'];
  const SET_N: Record<string, number> = { Cloudflare: 22, 사설망: 3, 루프백: 2 };
  type DsRow = { t: 'cidr' | 'set'; v: string };
  let dsRows = $state<DsRow[]>([{ t: 'set', v: 'Cloudflare' }, { t: 'cidr', v: '203.0.113.0/24' }]);
  let pasteOpen = $state(false);
  let pasteVal = $state('');
  /** 대역 칸 검사(시안 `ce`). 맞으면 빈 글. */
  const cidrErr = (v: string): string => {
    const t = v.trim();
    if (!t) return 'CIDR이나 IP를 입력해요.';
    const m = t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?:\/(\d+))?$/);
    return m && m.slice(1, 5).every((x) => Number(x) <= 255) && (m[5] === undefined || Number(m[5]) <= 32) ? '' : '형식이 맞지 않아요. 예: 10.0.0.0/8';
  };
  const rowSum = $derived.by(() => {
    const sets = [...new Set(dsRows.filter((r) => r.t === 'set').map((r) => r.v))];
    const cd = dsRows.filter((r) => r.t === 'cidr' && r.v.trim());
    return `요약: ${!dsRows.length ? '제한 없음'
      : !cd.length && sets.length === 1 ? `${sets[0]}만 (대역 ${SET_N[sets[0]!]}개)`
        : !cd.length ? sets.join(' + ') : [...sets, `대역 ${cd.length}개`].join(' + ')}`;
  });
  const setKind = (i: number, k: string): void => {
    dsRows = dsRows.map((x, j) => (j === i ? (k === 'set' ? { t: 'set', v: 'Cloudflare' } : { t: 'cidr', v: '' }) : x));
  };
  const doPaste = (): void => {
    const ls = pasteVal.split('\n').map((x) => x.trim()).filter(Boolean);
    if (!ls.length) return;
    dsRows = [...dsRows, ...ls.map((x): DsRow => {
      const st = SETS.find((n) => n.toLowerCase() === x.toLowerCase());
      return st ? { t: 'set', v: st } : { t: 'cidr', v: x };
    })];
    pasteOpen = false; pasteVal = '';
    toast.ok(`${ls.length}개 행을 추가했어요`, '잘못된 행은 빨간색으로 표시해요.');
  };

  let ipListener = $state<'http' | 'tcp'>('http');
  let ipSource = $state<RealIpSource>('header');
  let ipHeader = $state<RealIpHeader>('CF-Connecting-IP');
  let ipTrusted = $state('173.245.48.0/20');
  // TCP 로 바꾸면 HTTP 헤더는 고를 수 없다(시안: 출처가 「없음」 으로 돌아간다).
  $effect(() => { if (ipListener === 'tcp' && ipSource === 'header') ipSource = 'none'; });

  let inl = $state(false);
  let w = $state('5'); let we = $state('5');
  let dr = $state(false); let dre = $state(false);
  let hasPend = $state(false);
  const wOk = $derived(/^\d+$/.test(we));
  const inSave = (): void => {
    if (!wOk) { toast.fail('입력을 확인해요', '오류가 있는 항목을 고쳐요.'); return; }
    inl = false; w = we; dr = dre; hasPend = true;
    toast.ok('demo-1 수정', '커밋했어요. 적용 대기에 r11이 생겼어요.');
  };
  let coOpen = $state(false);
  let applyOpen = $state(false);

  // ── §11 외부 주소 ──
  let exUrl = $state('https://api.example.com/v1/');
  let exKeep = $state(false);
  let exReq = $state('/api/users?id=1');
  const PRE = '/api/';
  const exErr = $derived(urlCheck(exUrl));
  const exU = $derived.by(() => {
    if (exErr !== undefined) return undefined;
    const u = new URL(exUrl.trim());
    const tls = u.protocol === 'https:';
    const host = u.hostname.toLowerCase();
    const port = u.port === '' ? (tls ? 443 : 80) : Number(u.port);
    return { tls, host, port, path: u.pathname || '/', slug: host.replace(/\./g, '-') };
  });
  const exItems = $derived(exU === undefined ? [] : [
    ['풀', `${exU.slug} (HTTP, 업스트림 TLS ${exU.tls ? '켬' : '끔'})`],
    ['백엔드', `${exU.host}:${exU.port}`],
    ['SNI', exU.tls ? exU.host : '없음'],
    ['Host 헤더', `${exU.host} (이 라우트에만)`],
    ['경로', exKeep ? '접두사를 바꾸지 않아요' : `맞은 접두사 ${PRE} → ${exU.path} 로 바꿔 보내요`],
  ]);
  const exOut = $derived.by(() => {
    if (exU === undefined) return undefined;
    const origin = `${exU.tls ? 'https' : 'http'}://${exU.host}${(exU.tls && exU.port === 443) || (!exU.tls && exU.port === 80) ? '' : `:${exU.port}`}`;
    const to = exKeep ? '' : (exU.path.endsWith('/') ? exU.path : `${exU.path}/`);
    const p = rewritePath(PRE, to, exReq);
    return p === undefined ? undefined : origin + p;
  });
  const exNote = $derived(exU === undefined ? 'URL을 먼저 넣어요.'
    : exOut !== undefined ? (exKeep ? '경로를 그대로 보내요.' : `접두사 ${PRE}를 ${exU.path}로 바꿔 보내요.`)
      : '이 경로는 접두사와 맞지 않아요. 라우트에 걸리지 않아요.');

  // ── §12 프록시 설정 ──
  const CMD = 'bary proxy create --name api --url https://api.example.com/v1/ --listen 127.0.0.1:443 --host app.example.com --path-prefix /api/';
  const copy = async (text: string, title: string, body: string): Promise<void> => {
    try { await navigator.clipboard.writeText(text); } catch { /* 복사를 못 해도 알림은 띄운다(견본) */ }
    toast.ok(title, body);
  };
  let hdr = $state<KvRow[]>([{ name: 'X-Tenant', value: 'acme' }, { name: 'X-Forwarded-For', value: '10.0.0.1' }]);
  const BAD_HDR = ['x-forwarded-for', 'x-forwarded-proto', 'upgrade', 'connection'];
  /** 헤더 행 검사(시안 `hs`). */
  const hdrErr = (r: KvRow): string | undefined => {
    const n = r.name.trim();
    if (!n) return '헤더 이름을 입력해요.';
    if (!r.value.trim()) return '값을 입력해요.';
    return BAD_HDR.includes(n.toLowerCase()) ? `${n}는 barycenter가 넣어요. 다른 이름을 써요.` : undefined;
  };
  const hdrErrs = $derived(hdr.map((r, i) => ({ i, e: hdrErr(r) })).filter((x) => x.e !== undefined));
  let prx = $state(false);

  // ── §14 클러스터 ──
  const node = (p: Partial<ClusterNode>): ClusterNode => ({ name: 'web', role: 'follower', state: 'in_sync', behind: false, lastSeen: '', stale: false, ...p });
  const nodeBadges = [node({}), node({ state: 'following' }), node({ behind: true }), node({ state: 'failed' }), node({ stale: true })].map(nodeState);

  // ── §15 출발지별 동작 · 헬스체크 ──
  let rules = $state<SourceRuleRow[]>([
    { ...emptyRule(), from: '@private', kind: 'proxy', pool: 'web-pool' },
    { ...emptyRule(), from: '10.1.0.0/16', kind: 'proxy', pool: 'web-pool' },
  ]);
  let hcInterval = $state(5);
  let hcTimeout = $state(8);
  const hcBad = $derived(Number(hcTimeout) > Number(hcInterval));
</script>

<!-- §9 -->
<section>
  <h2>9. 문구 규칙 · ASD-STE100</h2>
  <p class="lead">모든 화면 문구에 단순 기술 문체를 써요. 대상은 제목, 설명, 버튼, 라벨, 도움말, 빈 상태, 오류, 확인 대화상자, 토스트예요.</p>
  <div class="tiles">
    {#each copyRules as r (r.n)}
      <div class="tile"><div class="rn">규칙 {r.n}</div><div class="rt">{r.t}</div><div class="rd">{r.d}</div></div>
    {/each}
  </div>
  <Card title="세부 기준 · 나쁨과 좋음" padded={false}>
    <div class="tbl ex" role="table" aria-label="세부 기준">
      <div class="th" role="row"><span role="columnheader">기준</span><span role="columnheader" class="bad">✕ 나쁨</span><span role="columnheader" class="good">● 좋음</span></div>
      {#each copyEx as e (e.k)}
        <div class="tr" role="row"><span role="cell" class="muted">{e.k}</span><span role="cell" class="tx2">{e.bad}</span><span role="cell">{e.good}</span></div>
      {/each}
    </div>
  </Card>
  <Card title="문구 검사기" sub="문구를 붙여 넣어요. 한 줄이나 한 문장마다 검사해요. 긴 문장, 꾸밈말, 존댓말, 수동태를 표시해요.">
    <div class="col">
      <TextArea aria-label="검사할 문구" rows={3} mono={false} bind:value={ct} />
      <div class="col tight">
        {#each ctRes as c, i (i)}
          <div class="ck">
            {#if c.n > 0}<Badge tone="warn">{c.n}건</Badge>{:else}<Badge tone="ok">통과</Badge>{/if}
            <span class="ckt">{c.t}{#if c.m}<span class="ckm">{c.m}</span>{/if}</span>
          </div>
        {/each}
      </div>
    </div>
  </Card>
  <Card title="용어집 · {glossary.length}개" padded={false}>
    {#snippet actions()}<TextInput aria-label="용어 찾기" placeholder="용어, 뜻, 금지어로 찾기" mono={false} width="240px" bind:value={gq} />{/snippet}
    <div class="tbl gl" role="table" aria-label="용어집">
      <div class="th" role="row"><span role="columnheader">쓰는 말</span><span role="columnheader">뜻</span><span role="columnheader">쓰지 않는 말</span></div>
      {#each glossary as g (g[0])}
        <div class="tr" role="row"><span role="cell"><b>{g[0]}</b> <code class="en">{g[1]}</code></span><span role="cell" class="tx2">{g[2]}</span><span role="cell" class="bad">{g[3]}</span></div>
      {/each}
    </div>
    {#if glossary.length === 0}<p class="empty">일치하는 용어가 없어요. 검색어를 지워요.</p>{/if}
  </Card>
  <Card title="쓰지 않는 꾸밈말" sub={'문체는 "~해요"로 통일해요. 존댓말과 섞지 않아요.'}>
    <div class="row">{#each BAN as b (b)}<span class="ban">{b}</span>{/each}</div>
  </Card>
</section>

<!-- §10 -->
<section>
  <h2>10. 화면 컴포넌트 · 2차 리뷰</h2>
  <p class="lead">모델에 맞춰 추가한 컴포넌트예요. 화면은 이 컴포넌트만 써요. 모두 동작해요.</p>
  <div class="grid2">
    <Card title="대역·주소 집합 행 편집기" sub="행마다 대역이나 주소 집합을 골라요. [＋]로 더하고 [−]로 빼요. 줄을 붙여 넣으면 행이 돼요.">
      <div class="col tight">
        {#each dsRows as r, i (i)}
          {@const err = r.t === 'set' ? '' : cidrErr(r.v)}
          <div class="col xs">
            <div class="row nowrap">
              <Select label="종류" width="112px" mono={false} value={r.t} onchange={(v) => setKind(i, v)} options={[{ value: 'cidr', label: '대역' }, { value: 'set', label: '주소 집합' }]} />
              {#if r.t === 'set'}
                <div class="grow"><Select label="주소 집합" width="100%" bind:value={r.v} options={SETS.map((n) => ({ value: n }))} /></div>
              {:else}
                <div class="grow"><TextInput aria-label="값" placeholder="10.0.0.0/8 또는 203.0.113.5" bind:value={r.v} invalid={err !== ''} /></div>
              {/if}
              <Button label="행 삭제" onclick={() => { dsRows = dsRows.filter((_, j) => j !== i); }}>−</Button>
            </div>
            {#if err}<FieldMessage tone="error">{err}</FieldMessage>{/if}
          </div>
        {/each}
        <div class="row">
          <Button size="sm" onclick={() => { dsRows = [...dsRows, { t: 'cidr', v: '' }]; }}>＋ 행 추가</Button>
          <Button size="sm" onclick={() => { pasteOpen = !pasteOpen; pasteVal = ''; }}>여러 줄 붙여넣기</Button>
        </div>
        {#if pasteOpen}
          <div class="paste">
            <TextArea aria-label="붙여 넣을 줄" rows={4} wrap="off" spellcheck={false} placeholder="한 줄에 하나씩 입력해요" bind:value={pasteVal} />
            <div class="row"><Button variant="primary" size="sm" onclick={doPaste}>행으로 변환</Button><Button size="sm" onclick={() => { pasteOpen = false; pasteVal = ''; }}>닫기</Button></div>
          </div>
        {/if}
        <div class="sum">{rowSum}</div>
      </div>
      <div class="specimen">
        <div class="note">상태 견본 · 오류 행 / 읽기 전용</div>
        <div class="row nowrap">
          <Select label="종류" width="112px" mono={false} value="cidr" options={[{ value: 'cidr', label: '대역' }]} />
          <div class="grow"><TextInput aria-label="값" value="10.0.0.0/33" invalid /></div>
        </div>
        <FieldMessage tone="error">형식이 맞지 않아요. 예: 10.0.0.0/8</FieldMessage>
        <div class="row nowrap">
          <Select label="종류" width="112px" mono={false} value="cidr" disabled options={[{ value: 'cidr', label: '대역' }]} />
          <div class="grow"><TextInput aria-label="값" value="173.245.48.0/20" disabled /></div>
        </div>
      </div>
    </Card>

    <Card title="원본 IP 출처 선택" sub="출처는 하나만 골라요. 고른 출처의 입력만 보여요. 신뢰 대역은 꼭 필요해요.">
      <div class="col">
        <RadioGroup label="리스너" dot={false} bind:value={ipListener} options={[{ value: 'http', label: 'HTTP·HTTPS' }, { value: 'tcp', label: 'TCP·패스스루' }]} />
        <RealIpSection bind:source={ipSource} bind:header={ipHeader} bind:trusted={ipTrusted} http={ipListener === 'http'} />
      </div>
    </Card>
  </div>

  <Card title="트래픽 경로 그림" sub="리스너 → 라우트 → 풀 → 백엔드. 라우트는 평가 순서대로 놓아요. 노드를 누르면 상세로 가요. 점선 노드는 기본 동작이에요.">
    <div class="path">
      <div class="flex"><button type="button" class="nd" onclick={pathTip}><span class="nk">리스너</span><span class="nn">web-https</span><span class="ns">HTTPS 0.0.0.0:443</span></button></div>
      <div class="lanes">
        <div class="lane" style:--n="3">
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">라우트 #1</span><span class="nn">api</span><span class="ns">api.example.com /api/</span></button></div>
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">풀</span><span class="nn">api-pool</span><span class="ns">least_conn · http /ready 5s</span></button></div>
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">백엔드 · 3개</span>
            <span class="be"><code>api-1</code><Badge tone="info">확인 중</Badge><span class="muted">수신 안 함</span></span>
            <span class="be"><code>api-2</code><Badge tone="neutral">관측 없음</Badge><span class="muted">수신 안 함</span></span>
            <span class="be"><code>api-3</code><Badge tone="ok">정상</Badge><span class="muted">수신 안 함</span></span></button></div>
        </div>
        <div class="lane" style:--n="2">
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">라우트 #2</span><span class="nn">api-v2</span><span class="ns">api.example.com /api/v2/</span><Badge tone="warn">가려짐</Badge></button></div>
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">풀</span><span class="nn">api-pool</span><span class="ns">least_conn · http /ready 5s</span></button></div>
        </div>
        <div class="lane" style:--n="2">
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">라우트 #3</span><span class="nn">http-to-https</span><span class="ns">* /</span></button></div>
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">결과</span><span class="nn">redirect 301</span><span class="ns">https://$host$request_uri</span><Badge tone="info">이동</Badge></button></div>
        </div>
        <div class="lane" style:--n="3">
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd dashed" onclick={pathTip}><span class="nk">라우트에 맞지 않는 요청</span><span class="nn">기본 동작</span><span class="ns">기본 풀로 보내기</span></button></div>
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">풀</span><span class="nn">web-pool</span><span class="ns">round_robin · http /healthz 5s</span></button></div>
          <div class="hop"><span class="arr" aria-hidden="true">→</span><button type="button" class="nd" onclick={pathTip}><span class="nk">백엔드 · 2개</span>
            <span class="be"><code>demo-1</code><Badge tone="ok">정상</Badge><span class="muted">수신 중</span></span>
            <span class="be"><code>demo-3</code><Badge tone="drain">드레인 중</Badge><span class="muted">수신 안 함</span></span></button></div>
        </div>
      </div>
    </div>
  </Card>

  <div class="grid2">
    <Card title="하단 패널 인라인 수정" padded={false}>
      <div class="ihead">
        <strong><code>demo-1</code></strong>
        {#if hasPend}<Badge tone="pending">적용 대기</Badge>{/if}
        <span class="grow"></span>
        {#if !inl}<Button size="sm" onclick={() => { inl = true; we = w; dre = dr; }}>수정</Button>{/if}
        <Button variant="text" size="sm" onclick={pathTip}>상세 페이지에서 모두 봐요 ↗</Button>
      </div>
      {#if !inl}
        <div class="iview">
          <div><div class="note">호스트:포트</div><code>10.20.0.14:8443</code></div>
          <div><div class="note">가중치</div><code>{w}</code></div>
          <div><div class="note">드레인</div><span>{dr ? '켜짐' : '꺼짐'}</span></div>
        </div>
      {:else}
        <div class="iedit">
          <FormRow label="가중치" for="ds9-w" error={wOk ? undefined : '0 이상의 정수를 입력해요.'}><TextInput id="ds9-w" width="100px" bind:value={we} invalid={!wOk} /></FormRow>
          <FormRow label="드레인"><Switch bind:checked={dre}>{dre ? '켜짐' : '꺼짐'}</Switch></FormRow>
          <div class="ifoot">
            <span class="note grow">저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.</span>
            <Button size="sm" onclick={() => { inl = false; }}>취소</Button>
            <Button variant="primary" size="sm" onclick={inSave}>저장</Button>
          </div>
        </div>
      {/if}
    </Card>

    <ImpactCard tone="warn" title="reload가 필요해요. 진행 중인 세션은 옛 워커가 마무리해요."
      breaking={[{ tone: 'danger', icon: '✕', text: '소켓 0.0.0.0:8080을 닫아요. 새 연결을 거절해요.' }]}>
      {#snippet sub()}리비전 r8 → r10 · 커밋 2건을 합친 영향{/snippet}
      {#snippet details()}
        <div class="sec">
          <button type="button" class="disc" aria-expanded={coOpen} onclick={() => { coOpen = !coOpen; }}>{coOpen ? '▾' : '▸'} 포함된 커밋 · 2</button>
          {#if coOpen}
            <div class="commits">
              <div class="cm"><code class="rev">r9</code><span>백엔드 demo-2 추가 · 리스너 소켓 변경</span><span class="who">alice</span></div>
              <div class="cm"><code class="rev">r10</code><span>리스너 web-https 타임아웃 60s → 90s</span><span class="who">ci-bot</span></div>
            </div>
          {/if}
        </div>
      {/snippet}
      {#snippet footer()}
        <span class="note">활성 리비전 r8 → r10 · 커밋 2건을 함께 적용해요.</span>
        <Button variant="danger" onclick={() => { applyOpen = true; }}>적용해요: r10</Button>
      {/snippet}
    </ImpactCard>
  </div>

  <Card>
    <div class="menu-row">
      <div class="grow"><h3>만들기 메뉴</h3><p class="note">대시보드와 리스너 목록의 [＋ 만들어요] 첫 항목은 빠른 프록시예요. 리스너, 풀, 백엔드를 한 번에 만들어요.</p></div>
      <Menu label="만들기" items={[
        { label: '빠른 프록시 만들기', onselect: () => toast.info('빠른 프록시', '드로어가 열려요. 프로토콜, 백엔드, 인증서를 한 번에 넣어요.') },
        { label: '리스너 만들기', onselect: () => toast.info('리스너', '프로토콜을 먼저 선택해요.') },
      ]}>
        {#snippet trigger({ open, toggle })}<Button variant="primary" aria-haspopup="true" aria-expanded={open} onclick={toggle}>＋ 만들어요 ▾</Button>{/snippet}
      </Menu>
    </div>
  </Card>
</section>

<!-- §11 -->
<section>
  <h2>11. 외부 주소 컴포넌트</h2>
  <p class="lead">URL 하나로 외부 HTTPS 대상을 만들어요. 입력하면 만들 리소스를 풀어 쓰고, 경로가 어떻게 바뀌는지 미리 보여 줘요.</p>
  <div class="grid2">
    <Card title="URL 입력과 풀어 쓴 결과">
      <div class="col">
        <div class="kv2">
          <FormRow label="URL" for="ds11-url" error={exErr} help={exErr === undefined ? 'http와 https만 받아요. 포트가 없으면 443 또는 80이에요.' : undefined}>
            <TextInput id="ds11-url" bind:value={exUrl} invalid={exErr !== undefined} />
          </FormRow>
          <FormRow label="풀어 쓴 결과">
            <div class="expand">
              {#each exItems as [k, v] (k)}<div class="ei"><span class="muted">{k}</span><code>{v}</code></div>{/each}
              {#if exItems.length === 0}<span class="note">URL을 입력하면 만들어질 리소스를 보여 줘요.</span>{/if}
            </div>
          </FormRow>
        </div>
        <p class="note">예: https://api.example.com/v1/ · 잘못된 값: api.example.com, ftp://x.com</p>
      </div>
    </Card>
    <Card title="경로 바꾸기 미리보기">
      <div class="col">
        <div class="kv2">
          <FormRow label="경로 접두사"><code>{PRE}</code></FormRow>
          <FormRow label="그대로 보내요"><Switch bind:checked={exKeep}>{exKeep ? '켜짐' : '꺼짐'}</Switch></FormRow>
          <FormRow label="예시 요청" for="ds11-req"><div class="row nowrap"><code class="muted">GET</code><div class="grow"><TextInput id="ds11-req" bind:value={exReq} /></div></div></FormRow>
        </div>
        <div class="out" class:warn={exOut === undefined}>→ {exOut ?? '—'}</div>
        <div class="note" class:warn={exU !== undefined && exOut === undefined}>{exNote}</div>
      </div>
    </Card>
  </div>
  <Card title="외부 노드" sub="트래픽 경로 그림에서 외부 대상은 둥근 파란 노드예요. 내부 백엔드 노드는 네모 중립 노드예요.">
    <div class="col">
      <div class="row top">
        <button type="button" class="nd wide" onclick={pathTip}><span class="nk">풀</span><span class="nn">api-example-com</span><span class="ns">round_robin · TLS 연결 검사</span></button>
        <span class="arr" aria-hidden="true">→</span>
        <button type="button" class="nd wide ext" onclick={pathTip}><span class="nk">외부 주소 ↗</span><span class="nn">api.example.com:443</span><span class="ns">IP 3개 해석</span><span><Badge tone="ok">정상</Badge></span></button>
        <span class="arr sep" aria-hidden="true">|</span>
        <button type="button" class="nd wide" onclick={pathTip}><span class="nk">백엔드 · 내부</span><span class="nn">demo-1</span><span class="ns">● 정상 · 수신 중</span></button>
      </div>
      <p class="note">도메인의 IP는 컨트롤 플레인이 갱신할 때 바뀌어요. IP가 자주 바뀌면 반영이 늦을 수 있어요.</p>
    </div>
  </Card>
</section>

<!-- §12 -->
<section>
  <h2>12. 프록시 설정 컴포넌트</h2>
  <p class="lead">구현된 프록시 기능에 맞춘 컴포넌트예요. 같은 결과를 만드는 CLI 명령, 이름: 값 헤더 편집기, 사유가 붙는 비활성 필드예요.</p>
  <div class="grid3">
    <Card title="CLI 명령 상자" sub={'"만들 리소스" 아래에 같은 결과를 만드는 명령을 보여 줘요.'}>
      <div class="row nowrap top"><code class="cmd">{CMD}</code><Button size="sm" onclick={() => { void copy(CMD, '명령을 복사했어요', '터미널에 붙여 넣어요.'); }}>복사</Button></div>
    </Card>
    <Card title="헤더 행 편집기 (이름: 값)" sub="설정만 있어요. 제거와 추가는 없어요. barycenter가 직접 넣는 이름은 막아요.">
      <div class="col tight">
        <KeyValueEditor bind:rows={hdr} ops={[]} addLabel="＋ 행 추가" />
        {#each hdrErrs as x (x.i)}<FieldMessage tone="error">{x.i + 1}행: {x.e}</FieldMessage>{/each}
        <p class="note">쓸 수 없는 이름: X-Forwarded-For, X-Forwarded-Proto, Upgrade, Connection</p>
      </div>
    </Card>
    <Card title="사유가 붙는 비활성 필드" sub="TCP 리스너에서 PROXY protocol을 켜면 출발지 제한을 쓸 수 없어요.">
      <div class="col tight">
        <Switch bind:checked={prx}>PROXY protocol {prx ? '켜짐' : '꺼짐'}</Switch>
        <div class="row nowrap">
          <Select label="종류" width="112px" mono={false} value="cidr" disabled={prx} options={[{ value: 'cidr', label: '대역' }]} />
          <div class="grow"><TextInput aria-label="출발지 제한" value="10.0.0.0/8" disabled={prx} /></div>
        </div>
        <FieldMessage>{prx ? 'PROXY protocol을 쓰면 출발지 제한을 쓸 수 없어요.' : '연결한 상대(바로 앞 홉)를 기준으로 해요.'}</FieldMessage>
      </div>
    </Card>
  </div>
</section>

<!-- §13 -->
<section>
  <h2>13. 전역 읽기 전용 · 토큰</h2>
  <p class="lead">전역 모드는 읽기만 해요. 쓰기 버튼 자리에는 "이 지역에서 열기"를 둬요. 토큰 값은 만들 때 한 번만 보여 줘요.</p>
  <div class="grid3">
    <Card title="이 지역에서 열기" sub="만들기, 수정, 삭제, 적용, 롤백 버튼 대신 써요. 누르면 그 지역 GUI의 같은 화면으로 가요.">
      <div class="row">
        <Button onclick={pathTip}>이 지역에서 열기 ↗</Button>
        <Button onclick={pathTip}>지역에서 열기 ↗ ▾</Button>
      </div>
    </Card>
    <Card title="토큰 값 상자" sub="토큰을 만들면 값을 한 번만 보여 줘요. 닫으면 다시 볼 수 없어요.">
      <div class="once">
        <b>토큰 값은 지금 한 번만 보여요. 따로 저장해요.</b>
        <div class="row nowrap">
          <div class="grow"><TextInput value="bary_k3j9x2m1q8w4n7p0z5" readonly aria-label="토큰 값" onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} /></div>
          <Button size="sm" onclick={() => { void copy('bary_k3j9x2m1q8w4n7p0z5', '토큰을 복사했어요', ''); }}>복사</Button>
        </div>
      </div>
    </Card>
  </div>
</section>

<!-- §14 -->
<section>
  <h2>14. 클러스터 컴포넌트</h2>
  <p class="lead">노드 상태 배지는 리더와 같은 활성 세대인지 보여 줘요. 수렴 목록은 적용 뒤 노드마다 한 줄로 보여 줘요.</p>
  <div class="grid4">
    <Card title="노드 상태 배지">
      <div class="col tight">
        <div class="row">{#each nodeBadges as b (b.text)}<Badge tone={b.tone}>{b.text}</Badge>{/each}</div>
        <p class="note">맞음: 리더와 같은 세대예요. 따라가는 중: 새 세대를 적용해요. 뒤처짐: 정해진 시간 안에 못 따라갔어요. 실패: 적용에 실패했어요. 연락 없음: 신호가 오래됐어요.</p>
      </div>
    </Card>
    <Card title="수렴 진행 목록">
      <div class="col tight">
        <div class="conv"><code>web-02</code><Badge tone="ok" icon="✓">2초</Badge></div>
        <div class="conv"><code>web-03</code><Badge tone="info">따라가는 중</Badge></div>
        <div class="conv"><code>web-04</code><Badge tone="danger">실패 · reload 거절</Badge></div>
        <div class="conv"><code>web-05</code><Badge tone="neutral">연락 없음</Badge></div>
      </div>
    </Card>
    <Card title="상단 바 노드 칩">
      <div class="col tight">
        <div class="row"><span class="nchip lead-node">web-01 · 리더</span><span class="nchip">web-02 · 팔로워</span></div>
        <p class="note">팔로워에서는 쓰기 버튼 자리에 "리더(web-01)에서 열기 ↗"를 둬요.</p>
      </div>
    </Card>
  </div>
</section>

<!-- §15 -->
<section>
  <h2>15. 출발지별 동작 · 헬스체크 폼</h2>
  <p class="lead">라우트의 출발지 규칙은 위에서부터 보고 처음 맞는 규칙을 써요. 앞 규칙이 덮은 대역은 오류로 보여 줘요.</p>
  <div class="grid3">
    <Card title="규칙 편집기">
      <DesignDesk addressSets={[{ key: 'private', cidrs: ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16'] }]}>
        <SourceRulesField bind:rules pools={[{ value: 'web-pool' }]} />
      </DesignDesk>
    </Card>
    <Card title="타임아웃 오류 상태">
      <div class="col tight">
        <div class="hc"><span class="hcl" aria-hidden="true">주기</span><NumberInput label="주기" unit="s" width="80px" bind:value={hcInterval} /></div>
        <div class="hc"><span class="hcl" aria-hidden="true">타임아웃</span><NumberInput label="타임아웃" unit="s" width="80px" bind:value={hcTimeout} invalid={hcBad} /></div>
        {#if hcBad}<FieldMessage tone="error">타임아웃이 주기보다 길어요. 주기 이하로 입력해요.</FieldMessage>{/if}
      </div>
    </Card>
  </div>
</section>

<ConfirmDialog open={applyOpen} title="적용해요: r9" sub="현재 활성 리비전은 r8이에요." confirmLabel="적용" requireCheck
  lines={[
    { tone: 'warn', icon: '▲', text: 'reload가 필요해요. 진행 중인 세션은 옛 워커가 마무리해요.' },
    { tone: 'ok', icon: '＋', text: '소켓 0.0.0.0:8443을 열어요.' },
    { tone: 'danger', icon: '✕', text: '소켓 0.0.0.0:8080을 닫아요.' },
  ]}
  onconfirm={() => { applyOpen = false; toast.ok('적용했어요: r9', '세대 r9-e8을 확인했어요.'); }} oncancel={() => { applyOpen = false; }} />

<style>
  section { display: flex; flex-direction: column; gap: 16px; }
  h2 { margin: 0; font: 700 20px/28px var(--font); }
  h3 { margin: 0 0 4px; font: 600 15px/22px var(--font); }
  .lead { margin: 0; color: var(--tx2); max-width: 760px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 20px; align-items: start; }
  .grid3 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 380px), 1fr)); gap: 20px; align-items: start; }
  .grid4 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr)); gap: 20px; align-items: start; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .row.nowrap { flex-wrap: nowrap; }
  .row.top { align-items: flex-start; }
  .col { display: flex; flex-direction: column; gap: 12px; }
  .col.tight { gap: 6px; }
  .col.xs { gap: 2px; }
  .grow { flex: 1; min-width: 0; }
  .note { color: var(--tx3); font: var(--t-cap); margin: 0; }
  .note.warn, .out.warn { color: var(--warn); }
  .muted { color: var(--tx3); }
  .tx2 { color: var(--tx2); }
  code { font-family: var(--mono); }

  /* §9 */
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 240px), 1fr)); gap: 12px; }
  .tile { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); padding: 14px 16px; }
  .rn { font: 400 12px/16px var(--mono); color: var(--accent); }
  .rt { font-weight: 600; margin: 2px 0 4px; }
  .rd { color: var(--tx2); font: var(--t-small); }
  .tbl { display: flex; flex-direction: column; font: var(--t-small); }
  .th, .tr { display: grid; gap: 12px; padding: 0 16px; }
  .ex .th, .ex .tr { grid-template-columns: 140px 1fr 1fr; }
  .gl .th, .gl .tr { grid-template-columns: 170px 1.6fr 1.2fr; align-items: start; }
  .th { height: 32px; align-items: center; background: var(--bg-hover); font: 600 12px/16px var(--font); color: var(--tx2); }
  .tr { padding-top: 10px; padding-bottom: 10px; border-top: 1px solid var(--bd); }
  .gl .tr { padding-top: 8px; padding-bottom: 8px; }
  .bad { color: var(--danger); }
  .good { color: var(--ok); }
  .en { font-size: 12px; color: var(--tx3); }
  .empty { margin: 0; padding: 20px; text-align: center; color: var(--tx3); font: var(--t-small); }
  .ck { display: flex; gap: 10px; align-items: flex-start; font: var(--t-small); }
  .ck > :global(.badge) { flex: none; }
  .ckt { flex: 1; }
  .ckm { display: block; font: var(--t-cap); color: var(--tx3); }
  .ban {
    height: 24px; padding: 0 10px; display: inline-flex; align-items: center; border-radius: 12px;
    border: 1px dashed var(--danger); color: var(--danger); font-size: 12px; text-decoration: line-through;
  }

  /* §10 */
  .paste { display: flex; flex-direction: column; gap: 6px; padding: 8px; border: 1px dashed var(--bd-strong); border-radius: var(--r-md); }
  .sum { font: var(--t-cap); color: var(--tx2); }
  .specimen { border-top: 1px solid var(--bd); margin-top: 10px; padding-top: 10px; display: flex; flex-direction: column; gap: 6px; }
  .path { display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: 12px; align-items: center; overflow-x: auto; }
  .flex { display: flex; }
  .lanes { display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .lane { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 6px; align-items: start; }
  .hop { display: flex; gap: 6px; align-items: flex-start; min-width: 0; }
  .arr { color: var(--tx3); padding-top: 10px; }
  .arr.sep { margin-left: 12px; }
  .nd {
    flex: 1; min-width: 0; text-align: left; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px 10px;
    border: 1px solid var(--bd-strong); border-radius: var(--r-md); background: var(--bg-input); color: var(--tx); cursor: pointer; font: inherit;
  }
  .nd:hover { border-color: var(--tx3); }
  .nd:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
  .nd.dashed { border-style: dashed; }
  .nd.wide { min-width: 200px; }
  .nd.ext { border-color: var(--info); border-radius: 18px; background: var(--info-bg); }
  .nk { font-size: 11px; color: var(--tx3); }
  .nn { font: 500 13px/18px var(--mono); }
  .ns { font-size: 12px; color: var(--tx2); }
  .be { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; font-size: 12px; }
  .ihead { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-bottom: 1px solid var(--bd); }
  .iview { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px 24px; padding: 12px 16px; font: var(--t-small); }
  .iedit { display: flex; flex-direction: column; gap: 10px; padding: 12px 16px; }
  .ifoot { display: flex; align-items: center; gap: 10px; padding-top: 10px; border-top: 1px solid var(--bd); }
  .sec { padding-top: 12px; border-top: 1px solid var(--bd); }
  .disc { border: 0; background: transparent; padding: 0; font: 600 12px/16px var(--font); color: var(--tx2); cursor: pointer; }
  .commits { display: flex; flex-direction: column; margin-top: 8px; border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; }
  .cm { display: grid; grid-template-columns: 48px minmax(0, 1fr) 90px; gap: 12px; padding: 8px 12px; }
  .cm + .cm { border-top: 1px solid var(--bd); }
  .rev { color: var(--accent); }
  .who { font: var(--t-cap); color: var(--tx3); text-align: right; }
  .menu-row { display: flex; align-items: flex-start; gap: 20px; flex-wrap: wrap; }
  .menu-row .grow { min-width: 260px; }

  /* §11 */
  .kv2 { display: flex; flex-direction: column; gap: 8px; }
  .expand { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); }
  .ei { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 8px; font-size: 12px; }
  .ei code { word-break: break-all; }
  .out { font: 400 13px/20px var(--mono); word-break: break-all; color: var(--tx); }

  /* §12 · §13 */
  .cmd {
    flex: 1; min-width: 0; font-size: 12px; line-height: 18px; word-break: break-all; padding: 6px 8px;
    background: var(--bg-input); border: 1px solid var(--bd); border-radius: var(--r-sm);
  }
  .once { display: flex; flex-direction: column; gap: 6px; padding: 12px 16px; background: var(--warn-bg); border: 1px solid var(--bd); border-radius: var(--r-md); font: var(--t-small); }

  /* §14 */
  .conv { display: flex; align-items: center; gap: 10px; font: var(--t-small); }
  .conv code { width: 84px; }
  .nchip { height: 26px; padding: 0 10px; display: inline-flex; align-items: center; border: 1px solid var(--bd-strong); border-radius: var(--r-sm); font: 400 12px/1 var(--mono); }
  .nchip.lead-node { color: var(--accent); }

  /* §15 */
  .hc { display: flex; gap: 8px; align-items: center; }
  .hcl { width: 60px; font: var(--t-cap); color: var(--tx2); }

  @media (max-width: 720px) {
    .path { grid-template-columns: minmax(0, 1fr); }
    .lane { grid-template-columns: minmax(0, 1fr); }
  }
</style>
