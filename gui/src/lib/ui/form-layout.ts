/**
 * 폼 배치 — 자리마다 시안의 격자가 다르다.
 *   · `page`(기본, 디자인 시스템 §3 「폼 레이아웃」) — 라벨 200px · 입력 최대 560px · 간격 12px 24px.
 *   · `compact`(콘솔의 드로어 · 분할 인라인 수정 · 설정 탭, 시안 `fieldsFor` 마크업) — 라벨 150px · 입력 최대 480px ·
 *     간격 4px 16px · 줄 사이 10px · 구획 사이 16px.
 * `Drawer` 와 `InlineEdit` 가 `compact` 를 정한다. 안쪽의 `Form` · `FormSection` · `FormRow` 가 읽는다.
 */
import { getContext, setContext } from 'svelte';

export type FormLayout = 'page' | 'compact';
const KEY = Symbol('bc-form-layout');

export const setFormLayout = (layout: FormLayout): void => { setContext(KEY, layout); };
export const formLayout = (): FormLayout => getContext<FormLayout | undefined>(KEY) ?? 'page';
