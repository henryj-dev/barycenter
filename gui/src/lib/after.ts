import { goto } from '$app/navigation';

export const after = (ok: boolean): void => {
  if (ok) void goto('/');
};
