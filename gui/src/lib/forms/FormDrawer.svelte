<script lang="ts" module>
  /**
   * 만들기 드로어의 제목 · 부제 · 폭 — 콘솔 시안 `drTitle` · `drSub` · `drW` 그대로.
   * 리소스 만들기는 「새 <이름>」 · 「설정」 · 500px. 리스너는 두 단계(1 / 2 · 프로토콜 고르기 → 2 / 2 · 설정).
   */
  export const DRAWERS = {
    listener: { title: '새 리스너', sub: '2 / 2 · 설정', width: 500 },
    listenerPick: { title: '새 리스너', sub: '1 / 2 · 프로토콜 고르기', width: 500 },
    quick: { title: '빠른 프록시 만들기', sub: '리스너, 풀, 백엔드를 한 번에 만들어요.', width: 560 },
    backend: { title: '새 백엔드', sub: '설정', width: 500 },
    certificate: { title: '새 인증서', sub: '설정', width: 500 },
    route: { title: '새 라우트', sub: '설정', width: 500 },
    routeGroup: { title: '경로별 묶음으로 만들기', sub: '호스트 하나의 규칙을 줄로 적어 라우트 여러 개를 만들어요.', width: 680 },
    pool: { title: '새 풀', sub: '설정', width: 500 },
    tlsPolicy: { title: '새 TLS 정책', sub: '설정', width: 500 },
    sni: { title: '새 SNI 바인딩', sub: '설정', width: 500 },
    addressSet: { title: '새 주소 집합', sub: '설정', width: 500 },
    rebuild: { title: 'URL로 다시 만들기', sub: '설정', width: 500 },
  } as const satisfies Record<string, { title: string; sub: string; width: number }>;
  export type DrawerKind = keyof typeof DRAWERS;
</script>

<script lang="ts">
  /**
   * 주소로 여는 드로어 — 목록 위에 만들기(또는 시안이 드로어로 하는 작업) 폼을 띄운다.
   *
   * 쓰는 법(라우트 `<목록>/new/+page.svelte`):
   * ```svelte
   * <BackendList />
   * <FormDrawer kind="backend" back="/traffic/backend"><BackendForm /></FormDrawer>
   * ```
   * 목록의 「＋ 만들기」 는 그대로 `href="/traffic/backend/new"` 다 — 주소가 바뀌어도 셸은 같은 목록 머리를 그리고
   * (`/new` 는 목록과 같은 자리다), 목록 위에 드로어가 열린다. 새로고침 · 북마크 · 링크도 같다.
   * 닫으면(✕ · 취소 · Esc · 바깥) 목록 주소로 간다 — 목록에서 왔으면 뒤로 가기라 목록의 주소 인자(`?region=` …)가 그대로다.
   * 안의 `CreateForm` 은 아래 줄(문구 · 취소 · 만들기)을 드로어 바닥에 둔다. 만들고 나면 폼이 다음 화면으로 간다(`after.ts`).
   *
   * 전역에서 지역을 골랐으면 머리에 「쓸 지역」 한 줄이 붙는다(시안 `wregD`). 지역은 셸이 정한 하나다 —
   * 시안의 고르기(select) 대신 「다른 지역 고르기」 링크다(쓰기는 한 번에 한 지역, 설계 §1.1).
   */
  import { getContext, type Snippet } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { Drawer } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';

  let { kind, title, sub, width, back, children }: {
    /** 시안의 제목 · 부제 · 폭 묶음. 따로 주면 그것이 이긴다. */
    kind?: DrawerKind;
    title?: string;
    sub?: string;
    width?: number;
    /** 닫으면 갈 주소 — 대개 목록. */
    back: string;
    children: Snippet;
  } = $props();

  const spec = $derived(kind === undefined ? undefined : DRAWERS[kind]);
  const scope = getContext<Scope | undefined>('scope');
  const region = $derived(scope?.mode === 'global' && scope.blocked !== true ? scope.region : undefined);
  let from: URL | undefined;
  afterNavigate((n) => { if (n.from !== null && n.type !== 'enter') from = n.from.url; });
  const close = (): void => {
    // 목록에서 열었으면 뒤로 — 목록 주소(인자 포함)와 스크롤이 돌아온다. 아니면(주소로 바로 왔다) 목록으로 간다.
    if (from !== undefined && from.pathname === back) history.back();
    else void goto(back);
  };
</script>

{#snippet regionLine()}
  <span>쓸 지역</span><code>{region?.name}</code><a href="/regions">다른 지역 고르기</a>
{/snippet}

<Drawer title={title ?? spec?.title ?? ''} sub={sub ?? spec?.sub} width={width ?? spec?.width ?? 500} onclose={close}
  region={region !== undefined ? regionLine : undefined}>
  {@render children()}
</Drawer>

<style>
  code { font-family: var(--mono); color: var(--tx); }
  a { color: var(--accent); }
</style>
