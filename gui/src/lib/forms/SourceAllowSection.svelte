<script lang="ts">
  /**
   * 「접근 제한」 구획 — 리스너 출발지 제한(`sourceAllow`). 다섯 리스너 폼과 빠른 프록시가 같이 쓴다.
   *
   * 값은 붙여 넣은 문자열 그대로 올린다. 끊기·검사는 `parseSourceAllow` 한 자리다(CLI `--allow` 와 같다).
   * 줄마다 같은 검사를 미리 돌려 틀린 줄을 표시한다.
   */
  import { FormRow, FormSection, ListInput } from '#lib/ui';
  import { sourceAllowLine } from './checks';

  let { value = $bindable(), port, http = false, title = '접근 제한' }: {
    value: string;
    /** :80 에 걸면 ACME http-01 이 막힌다 — 그때 경고한다. */
    port?: string;
    /** HTTP 계열이면 「응답 없이 끊는다」 를 덧붙인다. */
    http?: boolean;
    title?: string;
  } = $props();

  const any = $derived(value.trim() !== '');
  const help = $derived(
    (port?.trim() === '80' && any ? '▲ :80 리스너에 걸면 ACME http-01 인증서 발급이 막혀요. ' : '')
    + '한 줄에 하나씩 CIDR, IP, @주소집합을 넣어요. 비우면 누구나 받아요. 연결한 상대(바로 앞 홉)를 기준으로 해요. '
    + 'Cloudflare 뒤라면 Cloudflare 대역이나 그 주소 집합을 넣어요.'
    + (http ? ' 목록 밖에서 오면 응답 없이 연결을 끊어요.' : ''),
  );
</script>

<FormSection {title}>
  <FormRow label="출발지 제한" {help}>
    <ListInput label="출발지 제한" bind:value check={sourceAllowLine} minRows={3} placeholder={'173.245.48.0/20\n@cloudflare'} />
  </FormRow>
</FormSection>
