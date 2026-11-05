<script lang="ts">
  /**
   * 주소 집합의 「출처」 칸 (2026-11-05) — 직접 입력 · Cloudflare · AWS · Google Cloud · Fastly · URL.
   * 고른 출처가 받는 옵션 칸만 보인다(`ADDRESS_SOURCES[].options`, 해독기의 표와 같다).
   * 만들기 폼과 설정 탭이 같이 쓴다. 모양은 `addressSourceOf` 가 만든다.
   */
  import { ADDRESS_SOURCES, addressSourceIssue, type AddressSourceForm } from '@web/address-source';
  import { FormRow, Select, TextInput } from '#lib/ui';

  let { form = $bindable(), idPrefix = 'as' }: { form: AddressSourceForm; idPrefix?: string } = $props();

  const SOURCE_OPTIONS = [{ value: 'manual', label: '직접 입력' }, ...ADDRESS_SOURCES.map((s) => ({ value: s.value, label: s.label }))];
  const FAMILY_OPTIONS = [{ value: '', label: 'IPv4 · IPv6 둘 다' }, { value: 'ipv4', label: 'IPv4 만' }, { value: 'ipv6', label: 'IPv6 만' }];
  const takes = $derived(ADDRESS_SOURCES.find((s) => s.value === form.source)?.options ?? []);
  const issue = $derived(addressSourceIssue(form));
</script>

<FormRow label="출처" help={form.source === 'manual' ? '대역을 손으로 적어요.' : '데몬 · CLI · 화면이 이 출처에서 목록을 다시 받아요. 받은 목록은 손으로 고치지 않아요.'}>
  <Select label="출처" bind:value={form.source} options={SOURCE_OPTIONS} mono={false} width="100%" />
</FormRow>
{#if takes.includes('url')}
  <FormRow label="주소" for="{idPrefix}-url" error={issue} help="https 주소만 받아요. 예: https://example.com/ips.txt">
    <TextInput id="{idPrefix}-url" bind:value={form.url} invalid={issue !== undefined} autocomplete="off" />
  </FormRow>
{/if}
{#if takes.includes('jsonPath')}
  <FormRow label="JSON 경로" for="{idPrefix}-jp" help="JSON 이면 대역이 있는 자리를 점으로 이어 적어요(배열은 펼쳐요). 예: prefixes.ip_prefix. 비우면 한 줄에 하나예요.">
    <TextInput id="{idPrefix}-jp" bind:value={form.jsonPath} autocomplete="off" />
  </FormRow>
{/if}
{#if takes.includes('services')}
  <FormRow label="서비스" for="{idPrefix}-svc" help={form.source === 'aws' ? '쉼표로 여러 개. 비우면 전부예요. 예: CLOUDFRONT' : '쉼표로 여러 개. 비우면 전부예요. 예: Google Cloud'}>
    <TextInput id="{idPrefix}-svc" bind:value={form.services} autocomplete="off" />
  </FormRow>
{/if}
{#if takes.includes('regions')}
  <FormRow label="지역" for="{idPrefix}-rg" help={form.source === 'aws' ? '쉼표로 여러 개. 비우면 전부예요. 예: ap-northeast-2, GLOBAL' : '쉼표로 여러 개(scope). 비우면 전부예요. 예: asia-northeast3'}>
    <TextInput id="{idPrefix}-rg" bind:value={form.regions} autocomplete="off" />
  </FormRow>
{/if}
{#if takes.includes('family')}
  <FormRow label="주소 계열">
    <Select label="주소 계열" bind:value={form.family} options={FAMILY_OPTIONS} mono={false} width="100%" />
  </FormRow>
{/if}
