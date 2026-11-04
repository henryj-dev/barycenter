<script lang="ts" module>
  /** 원본 IP 를 어디서 얻나 — 없음 · PROXY protocol 수신(`acceptProxyProtocol`) · HTTP 헤더(`realIpFromHeader`). */
  export type RealIpSource = 'none' | 'proxy' | 'header';
  /** 해독기가 받는 헤더 셋(`REAL_IP_HEADERS`). 오타가 realip 을 조용히 끄지 않게 고르는 값이다. */
  export const REAL_IP_HEADERS = ['CF-Connecting-IP', 'X-Forwarded-For', 'X-Real-IP'] as const;
  export type RealIpHeader = (typeof REAL_IP_HEADERS)[number];

  /** 리스너 모델 → 폼 값. */
  export function realIpOf(m: Readonly<Record<string, unknown>> | undefined): { source: RealIpSource; header: RealIpHeader; trusted: string } {
    const rh = m?.['realIpFromHeader'] as { header?: unknown; trustedCidrs?: unknown } | undefined;
    const pp = m?.['acceptProxyProtocol'] as { trustedCidrs?: unknown } | undefined;
    const list = (v: unknown): string => (Array.isArray(v) ? (v as string[]).join('\n') : '');
    if (rh !== undefined) {
      const h = REAL_IP_HEADERS.find((x) => x === rh.header) ?? 'CF-Connecting-IP';
      return { source: 'header', header: h, trusted: list(rh.trustedCidrs) };
    }
    if (pp !== undefined) return { source: 'proxy', header: 'CF-Connecting-IP', trusted: list(pp.trustedCidrs) };
    return { source: 'none', header: 'CF-Connecting-IP', trusted: '' };
  }
</script>

<script lang="ts">
  /**
   * 「원본 IP」 구획 (시안 · DESIGN §4.7) — 앞단 프록시 뒤에서 방문자 주소를 어디서 꺼내나.
   *
   * 출처는 하나만이다 — `real_ip_header` 는 server 마다 하나라 둘이면 어느 쪽이 이기는지가 렌더 순서에 달린다(검증기가 막는다).
   * 신뢰 대역 없이는 못 켠다 — 없으면 클라이언트가 자기 IP 를 정한다. UDP 는 PROXY 수신이 없어서 이 구획을 안 그린다.
   * HTTP 헤더는 http · https 만이다. tcp · 패스스루의 PROXY 수신은 출발지 제한과 함께 못 쓴다(stream 에 `if` 가 없다).
   */
  import { FormRow, FormSection, RadioGroup, Select } from '#lib/ui';
  import SourceRows from '#lib/forms/SourceRows.svelte';

  let { source = $bindable('none'), header = $bindable('CF-Connecting-IP'), trusted = $bindable(''), http, invalid = $bindable(false) }: {
    source: RealIpSource;
    header: RealIpHeader;
    trusted: string;
    /** http · https 면 HTTP 헤더를 고를 수 있다. */
    http: boolean;
    /** 신뢰 대역이 비었거나 틀린 행이 있는가(출처가 없음이면 거짓). */
    invalid?: boolean;
  } = $props();

  // 시안 `realipSrc` 라디오: 없음 · PROXY protocol · HTTP 헤더(http 계열만), 세로로.
  const options = $derived<{ value: RealIpSource; label: string }[]>([
    { value: 'none', label: '없음' },
    { value: 'proxy', label: 'PROXY protocol' },
    ...(http ? [{ value: 'header' as const, label: 'HTTP 헤더' }] : []),
  ]);
  const headers = REAL_IP_HEADERS.map((h) => ({ value: h }));
  let rowsBad = $state(false);
  const trustedErr = $derived(source === 'none' ? undefined : trusted.trim() === '' ? '신뢰 대역을 하나 이상 입력해요.' : rowsBad ? '잘못된 대역이 있어요. 표시된 행을 고쳐요.' : undefined);
  $effect(() => { invalid = trustedErr !== undefined; });
</script>

<FormSection title="원본 IP">
  <FormRow label="출처" help="출처는 하나만 선택할 수 있어요.">
    <RadioGroup label="출처" bind:value={source} {options} direction="column" />
  </FormRow>
  {#if http && source === 'header'}
    <FormRow label="헤더">
      <Select label="헤더" bind:value={header} options={headers} width="100%" mono />
    </FormRow>
  {/if}
  {#if source !== 'none'}
    <FormRow label="신뢰 대역" error={trustedErr} help={source === 'header' ? '신뢰 대역 밖에서 온 헤더는 무시해요.' : '신뢰 대역에서 온 PROXY 헤더만 받아요.'}>
      <SourceRows label="신뢰 대역" bind:value={trusted} bind:invalid={rowsBad} />
    </FormRow>
  {/if}
</FormSection>
