import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import type { Permission } from '@shared/permissions';
import { ApiError, get, post } from './api';

export interface BranchRef {
  id: string;
  code: string;
  name: string;
}

export interface Me {
  user: { id: string; name: string; email: string | null };
  organization: { id: string; name: string };
  branch: BranchRef | null;
  branches: BranchRef[];
  roles: string[];
  permissions: Permission[];
  sessionKind: 'PASSWORD' | 'PIN';
}

interface AuthCtx {
  me: Me | null;
  loading: boolean;
  can: (p: Permission) => boolean;
  canAny: (ps: Permission[]) => boolean;
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
  switchBranch: (branchId: string) => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children, initial }: { children: ReactNode; initial?: Me | null }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await get<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    initialData: initial,
    staleTime: 60_000,
    retry: false,
  });
  const me = q.data ?? null;
  const perms = useMemo(() => new Set(me?.permissions ?? []), [me]);
  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);
  const value = useMemo<AuthCtx>(
    () => ({
      me,
      loading: q.isLoading,
      can: (p) => perms.has(p),
      canAny: (ps) => ps.some((p) => perms.has(p)),
      refresh,
      logout: async () => {
        await post('/auth/logout').catch(() => undefined);
        // Do not leave the previous user's cached orders/menu on a shared device.
        if (typeof caches !== 'undefined') await caches.delete('rms-v1-data').catch(() => undefined);
        qc.clear();
        qc.setQueryData(['me'], null);
      },
      switchBranch: async (branchId) => {
        await post('/auth/branch', { branchId });
        qc.clear();
        await refresh();
      },
    }),
    [me, q.isLoading, perms, qc, refresh],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth must be used inside AuthProvider');
  return c;
}
