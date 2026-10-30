<script lang="ts">
  /**
   * 디자인 시스템 — 컴포넌트를 상태별로 늘어놓은 스타일 가이드 (Claude Design 「Barycenter Design System」 §1–§8).
   * 화면을 만들기 전에 여기서 컴포넌트를 눌러 본다. 데이터는 예시다 — API 를 부르지 않는다.
   */
  import {
    Badge, Banner, Button, Card, Checkbox, Chip, CodeViewer, Combobox, ConfirmDialog, ConnectionStatus, DataTable,
    DescriptionList, DetailHeader, Disclosure, Form, FormRow, FormSection, ImpactCard, KeyValueEditor, ListInput,
    NumberInput, RadioGroup, Select, Skeleton, SplitView, StepList, Switch, Tabs, TextInput, Timeline, toast,
    type Column, type FilterChip, type KvRow, type StepState, type Tone,
  } from '#lib/ui';
  import { parseSourceAllow } from '@web/edit';

  // ── 토큰 ──
  const core = ['--bg-page', '--bg-panel', '--bg-input', '--bg-hover', '--bg-sel', '--bd', '--bd-strong', '--tx', '--tx2', '--tx3', '--accent', '--focus'];
  const sem: { k: Tone; n: string; i: string }[] = [
    { k: 'ok', n: '정상', i: '●' }, { k: 'warn', n: '경고', i: '▲' }, { k: 'danger', n: '위험', i: '✕' }, { k: 'info', n: '정보', i: '↻' },
    { k: 'neutral', n: '중립', i: '○' }, { k: 'pending', n: '적용 대기', i: '◐' }, { k: 'drain', n: '드레인 중', i: '⇣' },
  ];

  // ── 버튼 ──
  let saving = $state(false);
  let failing = $state(false);
  let failed = $state(false);
  const doSave = (): void => { saving = true; setTimeout(() => { saving = false; toast.ok('저장했어요', '커밋했어요. 적용 대기 중이에요.'); }, 1200); };
  const doFail = (): void => { failing = true; setTimeout(() => { failing = false; failed = true; toast.fail('저장하지 못했어요', 'plan 이 거절됐어요: 풀 web-pool 이 없어요.'); }, 1200); };

  // ── 입력 ──
  let ip = $state('10.20.0.14');
  let port = $state('8443');
  const ipBad = $derived(!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip) || ip.split('.').some((o) => Number(o) > 255));
  const portBad = $derived(!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535);
  let t1 = $state(60); let t2 = $state(500); let t3 = $state(5);
  let alg = $state<'round_robin' | 'least_conn' | 'ip_hash' | 'hash'>('round_robin');
  let pool = $state('');
  let h2 = $state(true); let pp = $state(false); let active = $state(true); let tls = $state(false);
  let act = $state<'pool' | 'reject'>('pool');
  let cidrs = $state('173.245.48.0/20\n103.21.244.0/22\n10.0.0.300/8\n2400:cb00::/32');
  const cidrCheck = (l: string): string | undefined => {
    try { parseSourceAllow(l); return undefined; } catch { return 'CIDR 이나 IP 주소가 아니에요'; }
  };
  let kv = $state<KvRow[]>([{ op: 'set', name: 'X-Forwarded-Proto', value: '$scheme' }, { op: 'del', name: 'Server', value: '' }]);
  let fname = $state('web-https'); let fbind = $state('0.0.0.0'); let fport = $state('443'); let body = $state(10);
  let formBusy = $state(false);

  // ── 테이블 ──
  type Be = { name: string; pool: string; addr: string; w: number; state: 'ok' | 'danger' | 'drain' | 'info' | 'neutral'; seen: string };
  const health: Record<Be['state'], string> = { ok: '정상', danger: '비정상', drain: '드레인 중', info: '확인 중', neutral: '관측 없음' };
  const backends: Be[] = [
    { name: 'demo-1', pool: 'web-pool', addr: '10.20.0.14:8443', w: 1, state: 'ok', seen: '3초 전' },
    { name: 'demo-2', pool: 'web-pool', addr: '10.20.0.15:8443', w: 1, state: 'danger', seen: '2초 전' },
    { name: 'demo-3', pool: 'web-pool', addr: '10.20.0.16:8443', w: 2, state: 'drain', seen: '5초 전' },
    { name: 'api-1', pool: 'api-pool', addr: '10.20.1.10:9000', w: 1, state: 'ok', seen: '1초 전' },
    { name: 'api-2', pool: 'api-pool', addr: '10.20.1.11:9000', w: 1, state: 'info', seen: '—' },
    { name: 'dns-1', pool: 'dns-pool', addr: '10.0.0.53:53', w: 1, state: 'neutral', seen: '—' },
    { name: 'db-1', pool: 'db-pool', addr: '10.0.0.9:5432', w: 3, state: 'ok', seen: '4초 전' },
  ];
  const cols: Column<Be>[] = [
    { key: 'name', label: '이름', mono: true, sort: (r) => r.name },
    { key: 'pool', label: '풀', mono: true, muted: true, sort: (r) => r.pool },
    { key: 'addr', label: '호스트:포트', mono: true, sort: (r) => r.addr },
    { key: 'w', label: '가중치', mono: true, align: 'right', sort: (r) => r.w },
    { key: 'state', label: '헬스', sort: (r) => r.state },
    { key: 'seen', label: '마지막 관측', muted: true, hidden: true },
  ];
  const chips: FilterChip<Be>[] = (['ok', 'danger', 'drain', 'info', 'neutral'] as const)
    .map((k) => ({ key: k, label: health[k], tone: k, match: (r: Be) => r.state === k }));
  let tmode = $state<'ok' | 'loading' | 'empty' | 'error'>('ok');
  let sel = $state<string[]>([]);

  // ── 분할 · 상세 ──
  let tab = $state('ov');
  let splitSel = $state<string[]>([]);
  const listeners = [
    { name: 'web-http', proto: 'http', bind: '0.0.0.0:80', status: '서빙 중' },
    { name: 'web-https', proto: 'https', bind: '0.0.0.0:443', status: '적용하면 열림' },
    { name: 'dns-udp', proto: 'udp', bind: '10.0.0.5:53', status: '서빙 중' },
  ];

  // ── 알림 ──
  let bannerOn = $state(true);
  let conn = $state<'live' | 'reconnecting' | 'down'>('live');
  let dlg = $state<'none' | 'apply' | 'rollback' | 'delete'>('none');

  // ── 영향 · 적용 ──
  const STEPS = ['렌더', '검증', '게시', 'reload', '활성화 확인'];
  let phase = $state<'idle' | 'running' | 'ok' | 'fail'>('idle');
  let step = $state(0);
  let simFail = $state(false);
  const steps = $derived(STEPS.map((name, i): { name: string; state: StepState } => ({
    name,
    state: phase === 'ok' ? 'done' : phase === 'idle' ? 'todo' : i < step ? 'done' : i === step ? (phase === 'fail' ? 'failed' : 'running') : 'todo',
  })));
  const runApply = (): void => {
    dlg = 'none'; phase = 'running'; step = 0;
    const tick = (): void => {
      if (simFail && step === 1) { phase = 'fail'; return; }
      if (step >= STEPS.length - 1) { phase = 'ok'; return; }
      step += 1; setTimeout(tick, 600);
    };
    setTimeout(tick, 600);
  };
  const conf = `# r9 — head
upstream web_pool {
    server 10.20.0.14:8443 weight=1;
    server 10.20.0.15:8443 weight=1 down;
    keepalive 32;
}
server {
    listen 443 ssl http2;
    server_name "api.example.com";
    ssl_certificate /etc/barycenter/certs/api.pem;
    location /api/ {
        proxy_pass http://web_pool;
        proxy_read_timeout 60s;
    }
}`;
</script>

<div class="ds">
  <p class="note">테마는 오른쪽 위 사용자 메뉴에서 바꿔요.</p>

  <section>
    <h2>1. 토큰</h2>
    <div class="swatches">
      {#each core as v (v)}<div class="sw"><div class="chip" style:background="var({v})"></div><code>{v}</code></div>{/each}
    </div>
    <div class="swatches">
      {#each sem as s (s.k)}
        <div class="sem" style:background="var(--{s.k}-bg)"><b style:color="var(--{s.k})">{s.i} {s.n}</b><code>--{s.k} / --{s.k}-bg</code></div>
      {/each}
    </div>
    <Card title="타이포 · 6단계">
      <div class="type">
        <span style:font="var(--t-title)">적용 대기 중인 변경</span>
        <span style:font="var(--t-h)">리스너 이벤트 목록</span>
        <span style:font="var(--t-body)">reload가 필요해요. 진행 중인 세션은 옛 워커가 마무리해요.</span>
        <span style:font="var(--t-small)" style:color="var(--tx2)">저장하면 커밋해요. 적용 대기 상태가 돼요.</span>
        <span style:font="var(--t-cap)" style:color="var(--tx3)">마지막 관측 3초 전</span>
        <span style:font="var(--t-mono)">10.20.0.14:8443 · 203.0.113.0/24 · r9-e8</span>
      </div>
    </Card>
  </section>

  <section>
    <h2>2. 버튼</h2>
    <Card>
      <div class="row">
        <Button variant="primary" loading={saving} onclick={doSave}>{saving ? '저장 중' : '저장'}</Button>
        <Button loading={failing} error={failed} onclick={doFail}>{failing ? '확인 중' : failed ? '다시 시도해요' : '실패를 재현해요'}</Button>
        <Button variant="danger" onclick={() => { dlg = 'delete'; }}>삭제…</Button>
        <Button variant="text">자세히 봐요</Button>
        <Button variant="icon" label="행 메뉴">⋯</Button>
        <Button variant="primary" disabled>비활성</Button>
        <Button size="sm">작은 버튼</Button>
        <Button href="/design">링크 버튼</Button>
      </div>
    </Card>
  </section>

  <section>
    <h2>3. 입력과 폼</h2>
    <div class="grid2">
      <Card title="텍스트 입력 · 상태">
        <FormSection>
          <FormRow label="주소" for="ds-ip" error={ipBad ? '주소가 틀렸어요. IPv4 형식으로 넣어요.' : undefined}><TextInput id="ds-ip" bind:value={ip} invalid={ipBad} placeholder="10.20.0.14" /></FormRow>
          <FormRow label="포트" for="ds-port" error={portBad ? '포트는 1–65535 사이여야 해요.' : undefined}><TextInput id="ds-port" bind:value={port} invalid={portBad} /></FormRow>
          <FormRow label="비활성"><TextInput value="web-https" disabled /></FormRow>
          <FormRow label="로딩"><Skeleton /></FormRow>
        </FormSection>
      </Card>
      <Card title="숫자(단위) · 셀렉트 · 콤보박스">
        <div class="col">
          <div class="row"><NumberInput label="초" unit="s" bind:value={t1} /><NumberInput label="밀리초" unit="ms" bind:value={t2} /><NumberInput label="분" unit="m" bind:value={t3} /></div>
          <div class="row">
            <Select label="알고리즘" bind:value={alg} options={[{ value: 'round_robin' }, { value: 'least_conn' }, { value: 'ip_hash' }, { value: 'hash' }]} />
            <Combobox label="풀 검색" placeholder="풀 검색" bind:value={pool}
              items={[{ value: 'web-pool', hint: 'http' }, { value: 'api-pool', hint: 'http' }, { value: 'api-canary', hint: 'http' }, { value: 'dns-pool', hint: 'udp' }, { value: 'db-pool', hint: 'tcp' }]} />
          </div>
          <div class="note">고른 풀: <code>{pool || '—'}</code> · ↑↓ Enter Esc를 써요</div>
          <div class="row wide">
            <Checkbox bind:checked={h2}>HTTP/2</Checkbox>
            <Checkbox bind:checked={pp}>PROXY 수신</Checkbox>
            <Checkbox disabled>비활성</Checkbox>
            <Switch bind:checked={active}>활성화</Switch>
            <Switch bind:checked={tls}>TLS</Switch>
            <RadioGroup label="기본 동작" bind:value={act} options={[{ value: 'pool' }, { value: 'reject' }]} />
          </div>
        </div>
      </Card>
      <Card title="여러 줄 목록 입력" sub="CIDR을 한 줄에 하나씩 붙여 넣어요. 항목 수와 틀린 줄을 바로 보여 줘요.">
        <ListInput label="CIDR 목록" bind:value={cidrs} check={cidrCheck} />
      </Card>
      <Card title="키-값 행 편집기 · 헤더 규칙" sub="동작(설정 / 추가 / 제거) · 이름 · 값">
        <KeyValueEditor bind:rows={kv} />
      </Card>
    </div>
    <Card title="폼 레이아웃" sub="라벨 200px, 입력 최대 560px의 2열이에요. 입력 폭을 늘리지 않아요.">
      <Form note="저장하면 커밋해요. 적용은 따로 해요." onsubmit={() => { formBusy = true; setTimeout(() => { formBusy = false; toast.ok('저장했어요', '적용 대기가 됐어요.'); }, 900); }}>
        <FormSection title="기본">
          <FormRow label="이름" for="fm-name" required help="소문자, 숫자, - 만 써요."><TextInput id="fm-name" bind:value={fname} /></FormRow>
          <FormRow label="바인드 주소" for="fm-bind" required help={fbind === '0.0.0.0' ? '모든 인터페이스에서 받아요.' : undefined}>
            <div class="row nowrap"><TextInput id="fm-bind" bind:value={fbind} /><TextInput aria-label="포트" bind:value={fport} width="80px" /></div>
          </FormRow>
        </FormSection>
        <Disclosure title="고급 옵션" hint="타임아웃, 본문 크기">
          <FormSection><FormRow label="요청 본문 최대"><NumberInput label="본문 크기" unit="MB" bind:value={body} width="80px" /></FormRow></FormSection>
        </Disclosure>
        {#snippet actions()}
          <Button variant="primary" type="submit" loading={formBusy}>{formBusy ? '저장 중' : '저장'}</Button>
          <Button onclick={() => { fname = 'web-https'; fbind = '0.0.0.0'; fport = '443'; }}>되돌리기</Button>
        {/snippet}
      </Form>
    </Card>
  </section>

  <section>
    <h2>4. 데이터 테이블</h2>
    <RadioGroup label="표시 상태" bind:value={tmode} options={[{ value: 'ok', label: '정상' }, { value: 'loading', label: '로딩' }, { value: 'empty', label: '빈 상태' }, { value: 'error', label: '오류' }]} />
    <DataTable label="백엔드 목록" rows={tmode === 'empty' ? [] : backends} rowKey={(r) => r.name} columns={cols}
      search={{ placeholder: '이름·풀·주소로 찾기', match: (r, q) => `${r.name} ${r.pool} ${r.addr}`.toLowerCase().includes(q) }}
      {chips} selectable bind:selected={sel} pageSize={5}
      loading={tmode === 'loading'} error={tmode === 'error' ? 'API 응답 502 · 요청 id a91f3c' : undefined} onretry={() => { tmode = 'ok'; }}
      emptyTitle="등록된 백엔드가 없어요" emptyBody="백엔드를 더하면 풀이 트래픽을 받아요."
      onopen={(r) => toast.info('상세를 열어요', r.name)}
      rowMenu={(r) => [
        { label: '상세를 봐요', onselect: () => toast.info('상세를 열어요', r.name) },
        { label: r.state === 'drain' ? '드레인 해제' : '드레인', onselect: () => toast.ok(r.state === 'drain' ? '드레인을 풀었어요' : '드레인했어요', r.name) },
        { label: '풀에서 빼기…', danger: true, onselect: () => { dlg = 'delete'; } },
      ]}>
      {#snippet cell(r, c)}
        {#if c.key === 'state'}<Badge tone={r.state}>{health[r.state]}</Badge>
        {:else if c.key === 'w'}{r.w}
        {:else}{String(r[c.key as keyof Be])}{/if}
      {/snippet}
      {#snippet bulk()}
        <Button size="sm" onclick={() => toast.ok('드레인했어요', `${sel.length}개`)}>드레인</Button>
        <Button size="sm">드레인 해제</Button>
        <Button size="sm" error onclick={() => { dlg = 'delete'; }}>풀에서 빼기</Button>
      {/snippet}
      {#snippet emptyAction()}<Button variant="primary">백엔드를 더해요</Button>{/snippet}
    </DataTable>
    <p class="note">행을 누르면 하나를 골라요. 체크박스는 여러 개를 골라요. 표에 초점을 두고 ↑↓로 움직이고, Space로 고르고, Enter로 상세를 열고, Esc로 선택을 풀어요. 헤더를 누르면 정렬해요(오름, 내림, 해제).</p>
  </section>

  <section>
    <h2>5. 분할 뷰 · 상세 페이지 골격</h2>
    <div class="grid2">
      <SplitView open={splitSel.length > 0} title={splitSel[0]} onclose={() => { splitSel = []; }} height="440px" initialTop={200}>
        {#snippet top()}
          <DataTable label="리스너" rows={listeners} rowKey={(r) => r.name} bind:selected={splitSel}
            columns={[{ key: 'name', label: '이름', mono: true }, { key: 'proto', label: '프로토콜', mono: true }, { key: 'bind', label: '바인드:포트', mono: true }, { key: 'status', label: '상태' }]}
            minHeight="0">
            {#snippet cell(r, c)}
              {#if c.key === 'status'}<Badge tone={r.status === '서빙 중' ? 'ok' : 'pending'}>{r.status}</Badge>{:else}{String(r[c.key as keyof typeof r])}{/if}
            {/snippet}
          </DataTable>
        {/snippet}
        {#snippet badges()}{#if splitSel[0] === 'web-https'}<Badge tone="pending">적용 대기</Badge>{/if}{/snippet}
        {#snippet detail()}
          <FormSection>
            <FormRow label="바인드 주소"><code>{listeners.find((l) => l.name === splitSel[0])?.bind}</code></FormRow>
            <FormRow label="기본 풀"><Select label="기본 풀" options={[{ value: 'web-pool' }, { value: 'api-pool' }]} value="web-pool" /></FormRow>
          </FormSection>
        {/snippet}
      </SplitView>
      <div class="detail">
        <DetailHeader crumbs={[{ label: '인증서', href: '/design' }, { label: 'api.example.com' }]} title="api.example.com"
          meta={[{ label: '발급자', value: 'ACME' }, { label: '만료', value: '2026-11-10', mono: true }, { label: '사용처', value: '리스너 2 · SNI 3' }]}
          tabs={[{ key: 'ov', label: '개요' }, { key: 'cfg', label: '설정' }, { key: 'rel', label: '연결된 리소스', count: 3 }, { key: 'log', label: '기록' }]}
          currentTab={tab}>
          {#snippet badges()}<Badge tone="warn">만료 12일 전</Badge>{/snippet}
          {#snippet actions()}<Button>자료를 교체해요</Button><Button error>삭제…</Button>{/snippet}
        </DetailHeader>
        <div class="panel">
          <Tabs label="탭 버튼 견본" items={[{ key: 'ov', label: '개요' }, { key: 'cfg', label: '설정' }, { key: 'rel', label: '연결된 리소스', count: 3 }, { key: 'log', label: '기록' }]} current={tab} onselect={(k) => { tab = k; }} />
          <div class="tp">
            <DescriptionList items={[{ label: '주체', value: 'CN=api.example.com', mono: true }, { label: 'SAN', value: 'api.example.com, *.api.example.com', mono: true }, { label: 'ACME 주문', value: '● 유효 · 자동 갱신 켜짐', tone: 'ok' }]} />
          </div>
        </div>
      </div>
    </div>
  </section>

  <section>
    <h2>6. 상태 배지 · 연결 표시</h2>
    <Card>
      <div class="col">
        <div class="row"><span class="lbl">헬스</span><Badge tone="ok">정상</Badge><Badge tone="danger">비정상</Badge><Badge tone="info">확인 중</Badge><Badge tone="neutral">관측 없음</Badge></div>
        <div class="row"><span class="lbl">드레인</span><Badge tone="drain">드레인 중</Badge></div>
        <div class="row"><span class="lbl">리스너</span><Badge tone="ok">서빙 중</Badge><Badge tone="pending">적용하면 열림</Badge><Badge tone="pending" icon="◑">적용하면 닫힘</Badge></div>
        <div class="row"><span class="lbl">리더</span><Badge tone="accent">리더</Badge><Badge tone="neutral" icon="☆">스탠바이</Badge></div>
        <div class="row"><span class="lbl">인증서</span><Badge tone="warn">만료 12일 전</Badge><Badge tone="danger">만료됨</Badge></div>
        <div class="row"><span class="lbl">연결</span><ConnectionStatus state="live" /><ConnectionStatus state="reconnecting" /><ConnectionStatus state="down" /></div>
        <div class="row"><span class="lbl">필터 칩</span><Chip tone="ok" pressed>정상</Chip><Chip tone="danger">비정상</Chip></div>
      </div>
    </Card>
  </section>

  <section>
    <h2>7. 알림 · 확인 대화상자</h2>
    <div class="grid2">
      <div class="col">
        {#if bannerOn}
          <Banner tone="pending" ondismiss={() => { bannerOn = false; }}>
            적용 대기 중인 변경이 <b>2건</b> 있어요.
            {#snippet action()}<a class="banner-action" href="/change/pending">영향을 봐요</a>{/snippet}
          </Banner>
        {/if}
        {#if conn === 'down'}
          <Banner tone="danger">
            실시간 연결이 끊겼어요. 헬스가 최신이 아닐 수 있어요.
            {#snippet action()}<button class="banner-action" onclick={() => { conn = 'reconnecting'; setTimeout(() => { conn = 'live'; }, 1200); }}>다시 연결해요</button>{/snippet}
          </Banner>
        {/if}
        <div class="row">
          <RadioGroup label="연결 상태" bind:value={conn} options={[{ value: 'live', label: '수신 중' }, { value: 'reconnecting', label: '재연결 중' }, { value: 'down', label: '끊김' }]} />
        </div>
        <div class="row">
          <Button size="sm" onclick={() => { bannerOn = true; }}>배너를 다시 띄워요</Button>
          <Button size="sm" onclick={() => toast.ok('적용했어요', 'r9-e8 활성화를 확인했어요.')}>성공 토스트</Button>
          <Button size="sm" onclick={() => toast.fail('적용하지 못했어요', '검증에서 실패했어요.')}>실패 토스트</Button>
          <Button size="sm" onclick={() => { const id = toast.progress('적용 중', '렌더해요'); setTimeout(() => toast.done(id, { tone: 'ok', title: '적용했어요', body: 'r9' }), 2000); }}>진행 토스트</Button>
        </div>
        <p class="note">토스트는 우측 하단에 쌓여요. 5초 뒤 사라져요. 진행 중 토스트는 끝날 때까지 남아요.</p>
      </div>
      <Card title="확인 대화상자" sub="제목에 결과를 먼저 써요. 확인 버튼은 동작 이름이에요. 위험 작업은 빨강 버튼이에요. Esc로 취소해요. 포커스는 취소 버튼에 먼저 가요.">
        <div class="row">
          <Button variant="danger" onclick={() => { dlg = 'apply'; }}>적용해요…</Button>
          <Button error onclick={() => { dlg = 'rollback'; }}>롤백해요…</Button>
          <Button error onclick={() => { dlg = 'delete'; }}>삭제해요(이름 입력)…</Button>
        </div>
      </Card>
    </div>
  </section>

  <section>
    <h2>8. 영향 요약 카드 · 코드 뷰어 · 타임라인</h2>
    <div class="grid2">
      <ImpactCard tone="warn" title="reload가 필요해요"
        breaking={[
          { tone: 'danger', icon: '✕', text: '소켓 0.0.0.0:8080 을 닫아요. 새 연결을 거절해요. 기존 TCP 세션은 유지해요.' },
          { tone: 'warn', icon: '▲', text: '인증서 api.example.com 을 교체해요. 새 핸드셰이크부터 적용해요.' },
          { tone: 'warn', icon: '▲', text: '라우트 순서 경고: /api/* 가 /api/v2/* 를 가려요.' },
        ]}
        quiet={['＋ 소켓 0.0.0.0:8443 을 열어요.', '백엔드 demo-2 를 추가해요. 기존 세션은 그대로예요.', '헤더 규칙 1건을 바꿔요. 새 요청부터 적용해요.', '풀 web-pool 가중치를 바꿔요.']}
        quietLabel="영향 없음 · 소켓 1개 열림 포함 4건">
        {#snippet sub()}진행 중 세션은 옛 워커가 끝내요. 리비전 <code>r8 → r9</code>{/snippet}
        {#snippet progress()}{#if phase !== 'idle'}<div class="note">적용 단계</div><StepList steps={steps} />{/if}{/snippet}
        {#snippet result()}
          {#if phase === 'ok'}<Banner tone="ok" ondismiss={() => { phase = 'idle'; }}>적용했어요: r9. 세대 r9-e8을 확인했어요.</Banner>{/if}
          {#if phase === 'fail'}<Banner tone="danger" ondismiss={() => { phase = 'idle'; }}>검증에서 실패했어요. 자동으로 롤백했어요. r8을 유지해요.</Banner>{/if}
        {/snippet}
        {#snippet footer()}
          <Checkbox bind:checked={simFail}>실패를 재현해요</Checkbox>
          <Button variant="danger" loading={phase === 'running'} onclick={() => { dlg = 'apply'; }}>트래픽에 적용해요</Button>
        {/snippet}
      </ImpactCard>
      <div class="col">
        <CodeViewer code={conf}>{#snippet head()}<code>nginx.conf</code><span class="note">· r9 (head)</span>{/snippet}</CodeViewer>
        <Timeline groups={[
          { key: '1', time: '10-30 09:14', title: '백엔드 demo-2 추가', who: 'alice', rev: 'r9', steps: [
            { time: '09:14:02', name: 'changeset create', ok: true }, { time: '09:14:03', name: 'patch', ok: true },
            { time: '09:14:03', name: 'plan', ok: true }, { time: '09:14:04', name: 'commit', ok: true }, { time: '09:14:20', name: 'apply', ok: true },
          ] },
          { key: '2', time: '10-29 18:02', title: '인증서 api.example.com 교체', who: 'acme', rev: 'r8' },
        ]} />
      </div>
    </div>
  </section>
</div>

<ConfirmDialog open={dlg === 'apply'} title="적용: r9 를 트래픽에 걸어요" sub="reload 가 한 번 일어나요." confirmLabel="적용해요" requireCheck
  lines={[{ tone: 'danger', icon: '✕', text: '소켓 0.0.0.0:8080 을 닫아요' }, { tone: 'warn', icon: '▲', text: '인증서 1개를 교체해요' }]}
  onconfirm={runApply} oncancel={() => { dlg = 'none'; }} />
<ConfirmDialog open={dlg === 'rollback'} title="롤백: r8 의 내용으로 새 리비전을 만들어요" sub="커밋까지예요. 적용은 따로 해요." confirmLabel="롤백해요"
  lines={[{ tone: 'warn', icon: '▲', text: '백엔드 demo-2 가 빠져요' }]} onconfirm={() => { dlg = 'none'; toast.ok('롤백했어요', 'r10 을 만들었어요.'); }} oncancel={() => { dlg = 'none'; }} />
<ConfirmDialog open={dlg === 'delete'} title="삭제: 백엔드 demo-2 를 풀에서 빼요" confirmLabel="삭제해요" requireName="demo-2"
  lines={[{ tone: 'danger', icon: '✕', text: '풀 web-pool 의 백엔드가 2개로 줄어요' }]} onconfirm={() => { dlg = 'none'; toast.ok('뺐어요', 'demo-2'); }} oncancel={() => { dlg = 'none'; }} />

<style>
  .ds { display: flex; flex-direction: column; gap: 40px; padding-bottom: 80px; }
  section { display: flex; flex-direction: column; gap: 16px; }
  h2 { margin: 0; font: 700 20px/28px var(--font); }
  .swatches { display: grid; grid-template-columns: repeat(auto-fill, minmax(176px, 1fr)); gap: 10px; }
  .sw { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; }
  .sw .chip { height: 44px; border-bottom: 1px solid var(--bd); }
  .sw code { display: block; padding: 8px 10px; font-size: 12px; }
  .sem { border: 1px solid var(--bd); border-radius: var(--r-md); padding: 12px; display: flex; flex-direction: column; gap: 6px; }
  .sem code { font-size: 11px; color: var(--tx3); }
  .type { display: flex; flex-direction: column; gap: 10px; }
  .grid2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 460px), 1fr)); gap: 20px; align-items: start; }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
  .row.wide { gap: 20px; }
  .row.nowrap { flex-wrap: nowrap; }
  .col { display: flex; flex-direction: column; gap: 14px; }
  .lbl { width: 72px; color: var(--tx3); font: var(--t-cap); }
  .note { color: var(--tx3); font: var(--t-cap); margin: 0; }
  code { font-family: var(--mono); }
  .detail { border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; background: var(--bg-page); }
  .panel { padding: 0 20px 16px; }
  .tp { padding-top: 16px; }
</style>
