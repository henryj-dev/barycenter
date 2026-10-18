/**
 * **민감 작업 앞의 재확인** — 서버가 403 `mfa_step_up_required` 를 주면 화면이 코드를 받아
 * `/session/step-up` 하고 같은 요청을 **한 번** 다시 보낸다.
 *
 * 묻는 창은 하나다(`StepUpDialog`, 레이아웃). 여러 요청이 동시에 걸려도 한 번만 묻고 같이 기다린다.
 */
let pending = $state<{ resolve: (ok: boolean) => void } | undefined>();
let waiting: Promise<boolean> | undefined;

export const stepUp = {
  get asking() { return pending !== undefined; },
  /** 코드를 받을 때까지 기다린다. 사용자가 그만두면 false. */
  request(): Promise<boolean> {
    waiting ??= new Promise<boolean>((resolve) => {
      pending = { resolve: (ok) => { pending = undefined; waiting = undefined; resolve(ok); } };
    });
    return waiting;
  },
  answer(ok: boolean): void { pending?.resolve(ok); },
};

/** 응답이 step-up 요구인가. 본문은 이미 읽었을 수 있으므로 code 만 본다. */
export const needsStepUp = (status: number, code: unknown): boolean => status === 403 && code === 'mfa_step_up_required';
