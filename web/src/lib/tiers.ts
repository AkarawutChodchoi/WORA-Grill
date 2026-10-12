import { useQuery } from '@tanstack/react-query';
import { get } from './api';

/** Member tier code → display name (e.g. GOLD → "Gold"), falling back to the code. */
export function useTierName() {
  const q = useQuery({ queryKey: ['loyalty-tiers'], queryFn: () => get<{ tiers: { code: string; name: string }[] }>('/loyalty/tiers'), staleTime: 5 * 60_000 });
  const map = new Map((q.data?.tiers ?? []).map((t) => [t.code, t.name]));
  return (code: string | null | undefined) => (code ? (map.get(code) ?? code) : null);
}
