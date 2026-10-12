import { useSearchParams } from 'react-router';

/**
 * Page tab kept in the URL (?tab=…) so a tab can be bookmarked or shared and Back returns to it.
 * Unknown values fall back to `fallback`.
 */
export function useTabParam<T extends string>(fallback: T, allowed?: readonly T[]): [T, (t: T) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get('tab') as T | null;
  const tab = raw && (!allowed || allowed.includes(raw)) ? raw : fallback;
  const setTab = (t: T) =>
    setParams(
      (p) => {
        const next = new URLSearchParams(p);
        if (t === fallback) next.delete('tab');
        else next.set('tab', t);
        return next;
      },
      { replace: false },
    );
  return [tab, setTab];
}
