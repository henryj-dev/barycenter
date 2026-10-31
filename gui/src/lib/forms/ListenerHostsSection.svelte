<script lang="ts">
  /**
   * 「호스트」 구획 — HTTP · HTTPS 리스너의 server_name (ADR-VHOST). 만들기와 수정이 같이 쓴다.
   *
   * 비우면 그 포트의 기본 리스너다(모르는 이름도 받는다). 넣으면 이 이름들만 받고, 같은 포트를 다른 호스트
   * 리스너와 함께 쓸 수 있다 — 서비스마다 인증서 · 출발지 제한 · 기본 동작을 따로 둔다.
   */
  import { FormRow, FormSection, ListInput } from '#lib/ui';
  import { hostLine } from './checks';

  let { value = $bindable() }: { value: string } = $props();
</script>

<FormSection title="호스트" hint="server_name">
  <FormRow
    label="호스트"
    help="한 줄에 하나씩 넣어요. 넣으면 이 이름들만 받고, 같은 포트를 다른 리스너와 함께 쓸 수 있어요(서비스마다 인증서 · 출발지 제한 · 기본 동작을 따로 둬요). 비우면 이 포트의 기본 리스너가 돼요 — 맞는 이름이 없는 요청도 받아요."
  >
    <ListInput label="호스트" bind:value check={hostLine} minRows={2} placeholder={'app.example.com\n*.example.com'} />
  </FormRow>
</FormSection>
