<script lang="ts">
  /**
   * 민감 작업 앞에서 한 번 묻는다(인증 앱 코드). 레이아웃에 하나만 둔다.
   * 모양은 디자인 시스템 §7 확인 대화상자와 같다 — 입력 칸이 있어서 `ConfirmDialog` 를 그대로 쓰지 않는다.
   */
  import { Button, FieldMessage, FormRow, FormSection, TextInput } from '#lib/ui';
  import { accountApi } from './api';
  import { stepUp } from './step-up.svelte';

  let code = $state('');
  let error = $state<string | undefined>();
  let busy = $state(false);

  const submit = async (): Promise<void> => {
    if (code.trim() === '') return;
    busy = true;
    const r = await accountApi.stepUp(code.trim());
    busy = false;
    code = '';
    if (!r.ok) { error = r.message; return; }
    error = undefined;
    stepUp.answer(true);
  };
  const cancel = (): void => { error = undefined; code = ''; stepUp.answer(false); };
</script>

<svelte:window onkeydown={(e) => { if (stepUp.asking && e.key === 'Escape') cancel(); }} />

{#if stepUp.asking}
  <div class="veil">
    <div class="dlg" role="dialog" aria-modal="true" aria-labelledby="stepup-h">
    <form onsubmit={(e) => { e.preventDefault(); void submit(); }}>
      <div class="head">
        <h2 id="stepup-h">인증 앱으로 한 번 더 확인해요</h2>
        <p>이 작업은 최근 10분 안에 인증 앱 확인이 필요해요. 코드를 넣으면 바로 이어서 해요.</p>
      </div>
      <div class="body">
        <FormSection stack>
          <FormRow label="인증 코드" for="su-code" help="앱이 없으면 복구 코드를 넣어요.">
            <TextInput id="su-code" inputmode="numeric" autocomplete="one-time-code" bind:value={code} width="200px" required />
          </FormRow>
        </FormSection>
        {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
      </div>
      <div class="foot">
        <Button onclick={cancel}>취소</Button>
        <Button variant="primary" type="submit" loading={busy}>확인</Button>
      </div>
    </form>
    </div>
  </div>
{/if}

<style>
  .veil { position: fixed; inset: 0; z-index: 55; background: rgba(0, 0, 0, .55); display: grid; place-items: center; padding: 24px; }
  .dlg {
    width: 100%; max-width: 420px; background: var(--bg-panel); border: 1px solid var(--bd-strong);
    border-radius: var(--r-lg); box-shadow: var(--sh-pop);
  }
  .head { padding: 16px 20px 0; }
  h2 { margin: 0; font: 600 16px/24px var(--font); color: var(--tx); }
  .head p { margin: 4px 0 0; font: var(--t-small); color: var(--tx2); }
  .body { padding: 14px 20px; display: grid; gap: 8px; }
  .foot { padding: 12px 20px; border-top: 1px solid var(--bd); display: flex; justify-content: flex-end; gap: 8px; }
</style>
