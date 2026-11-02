/**
 * 방금 커밋이 **바로 활성으로 올라갔나** (2026-11-02).
 *
 * 인증서 의도만 바꾼 커밋은 트래픽이 안 바뀌어서 서버가 바로 올린다(커밋 응답의 `applied`). 그때 「적용 대기에
 * 들어갔어요」 는 거짓이다. `commitPatch` 가 적고 `after` 가 한 번 읽고 지운다. 의존이 없는 모듈로 둔다 —
 * desk 가 `$app/navigation` 을 끌어오지 않게.
 */
let applied = false;

export const noteCommit = (v: boolean): void => { applied = v; };

export const takeCommitNote = (): boolean => {
  const v = applied;
  applied = false;
  return v;
};
