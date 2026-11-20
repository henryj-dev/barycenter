<script lang="ts">
  /**
   * SNI 바인딩의 「TLS 버전 덮어쓰기」(`override`) — 이 호스트들에만 리스너 정책의 버전을 좁힌다.
   * 비운 쪽은 리스너의 TLS 정책을 따른다(렌더러 규칙 `override ?? policy`). 만들기 드로어와 설정 탭이 함께 쓴다.
   */
  import { FormRow, FormSection, Select } from '#lib/ui';
  import { overrideError, type OverrideText } from './policy-edit.ts';

  let { value = $bindable(), policy, invalid = $bindable(false) }: {
    value: OverrideText;
    /** 리스너 정책의 이름과 버전. 리스너를 고르지 않았으면 비어 있다. */
    policy: { name?: string; min?: string; max?: string };
    invalid?: boolean;
  } = $props();

  const follow = (v: string | undefined): string => (v === undefined ? '정책을 따라요' : `정책을 따라요 (TLS ${v})`);
  const minOptions = $derived([{ value: '', label: follow(policy.min) }, { value: '1.2', label: 'TLS 1.2' }, { value: '1.3', label: 'TLS 1.3' }]);
  const maxOptions = $derived([{ value: '', label: policy.name === undefined || policy.max !== undefined ? follow(policy.max) : '정책을 따라요 (상한 없음)' },
    { value: '1.2', label: 'TLS 1.2' }, { value: '1.3', label: 'TLS 1.3' }]);
  const error = $derived(overrideError(value, policy));
  $effect(() => { invalid = error !== undefined; });
</script>

<FormSection title="TLS 버전 덮어쓰기" hint="이 호스트들에만">
  <FormRow label="최소 버전" help={policy.name === undefined ? '리스너를 고르면 그 TLS 정책 값을 보여요.' : `비우면 정책 ${policy.name} 을 따라요.`}>
    <Select label="최소 버전" bind:value={value.min} options={minOptions} mono={false} width="100%" />
  </FormRow>
  <FormRow label="최대 버전" {error}>
    <Select label="최대 버전" bind:value={value.max} options={maxOptions} mono={false} width="100%" />
  </FormRow>
</FormSection>
