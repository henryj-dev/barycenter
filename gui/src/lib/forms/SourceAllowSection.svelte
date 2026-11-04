<script lang="ts">
  /**
   * 「접근 제한」 구획 — 리스너 출발지 제한(`sourceAllow`). 다섯 리스너 폼 · 설정 탭 · 빠른 프록시가 같이 쓴다.
   * 칸은 콘솔 시안 `fieldsFor` 의 `src` 칸 그대로 — 대역 행(`SourceRows`: 대역 · 주소 집합 · ＋ 행 추가 · 여러 줄 붙여넣기 · 요약).
   * 도움말은 시안 글 그대로이고, :80 리스너에 걸면 경고 색이다(ACME http-01 이 막힌다).
   *
   * 값은 한 줄에 하나인 글 그대로 올린다. 끊기·검사는 `parseSourceAllow` 한 자리다(CLI `--allow` 와 같다).
   * PROXY protocol 로 원본 IP 를 받는 tcp · 패스스루는 출발지 제한을 못 쓴다 — 칸이 잠기고 그렇게 말한다(시안 `noSrc`).
   */
  import { FormRow, FormSection } from '#lib/ui';
  import { LISTENER_ERR, srcHelp, srcWarn } from './checks';
  import SourceRows from './SourceRows.svelte';

  let { value = $bindable(), port, http = false, title = '접근 제한', noSrc = false, conflict = false, invalid = $bindable(false) }: {
    value: string;
    /** :80 에 걸면 ACME http-01 이 막힌다 — 그때 도움말이 경고 색이다. */
    port?: string;
    /** HTTP 계열이면 「응답 없이 끊는다」 를 덧붙인다. */
    http?: boolean;
    title?: string;
    /** PROXY protocol 수신이 켜져 있어 출발지 제한을 쓸 수 없다(tcp · 패스스루). */
    noSrc?: boolean;
    /** 출발지 제한과 PROXY 수신이 함께 켜졌다 — 시안 「PROXY protocol과 출발지 제한은 함께 쓸 수 없어요.」 */
    conflict?: boolean;
    /** 틀린 행이 있거나 함께 못 쓰는 설정이다. */
    invalid?: boolean;
  } = $props();
  let bad = $state(false);
  const error = $derived(conflict ? LISTENER_ERR.proxySrc : bad ? LISTENER_ERR.src : undefined);
  $effect(() => { invalid = error !== undefined; });
  const warn = $derived(srcWarn(port ?? '', value));
</script>

<FormSection {title}>
  <!-- 시안: :80 리스너에 출발지 제한을 걸면 도움말이 경고 색(`f.hc = var(--warn)`). -->
  <FormRow label="출발지 제한" {error} {warn} help={noSrc && !conflict ? 'PROXY protocol을 쓰면 출발지 제한을 쓸 수 없어요.' : srcHelp(http)}>
    <SourceRows label="출발지 제한" bind:value bind:invalid={bad} disabled={noSrc && !conflict} />
  </FormRow>
</FormSection>
