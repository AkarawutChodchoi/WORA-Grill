import { clsx } from 'clsx';
import { Lock, LogOut, Menu, Store, X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import type { Permission } from '@shared/permissions';
import { ROLE_LABELS, type SystemRole } from '@shared/permissions';
import { Button, EmptyState, Spinner, useToast } from '../components/ui';
import { errorMessage } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useRealtimeEvent } from '../lib/realtime';
import { OfflineIndicator } from '../lib/offline';
import { NotificationBell } from '../components/NotificationBell';
import { visibleNav } from '../nav';

export function FullPageSpinner() {
  return (
    <div className="flex min-h-dvh items-center justify-center text-ink-3" role="status" aria-label="กำลังโหลด">
      <Spinner className="size-8" />
    </div>
  );
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <FullPageSpinner />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

export function RequirePermission({ anyOf, children }: { anyOf: Permission[]; children: ReactNode }) {
  const { canAny } = useAuth();
  if (!canAny(anyOf)) return <Forbidden />;
  return <>{children}</>;
}

export function Forbidden() {
  return (
    <EmptyState icon={<Lock className="size-8" />} title="คุณไม่มีสิทธิ์เข้าหน้านี้">
      ติดต่อผู้จัดการเพื่อขอสิทธิ์ หรือสลับผู้ใช้ด้วย PIN
    </EmptyState>
  );
}

export function BranchSelect({ compact }: { compact?: boolean }) {
  const { me, switchBranch } = useAuth();
  const toast = useToast();
  if (!me || me.branches.length < 2) {
    return me?.branch ? (
      <span className="inline-flex items-center gap-1.5 text-sm text-ink-2">
        <Store className="size-4" />
        {me.branch.name}
      </span>
    ) : null;
  }
  return (
    <label className="inline-flex items-center gap-1.5 text-sm">
      <Store className="size-4 text-ink-3" />
      <span className="sr-only">สาขา</span>
      <select
        className={clsx('h-10 rounded-control border border-line-strong bg-surface px-2', compact && 'max-w-36')}
        value={me.branch?.id ?? ''}
        onChange={(e) => switchBranch(e.target.value).catch((err) => toast.error(errorMessage(err)))}
      >
        {me.branches.map((b) => (
          <option key={b.id} value={b.id}>
            {b.name}
          </option>
        ))}
      </select>
    </label>
  );
}

export function UserMenu() {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  if (!me) return null;
  const role = me.roles.map((r) => ROLE_LABELS[r as SystemRole] ?? r).join(', ');
  return (
    <div className="flex items-center gap-2">
      <div className="hidden text-right leading-tight sm:block">
        <div className="text-sm font-medium">{me.user.name}</div>
        <div className="text-xs text-ink-3">{role}</div>
      </div>
      <Button variant="ghost" size="sm" icon={<Lock className="size-4" />} onClick={() => nav('/pin')} title="สลับผู้ใช้ด้วย PIN" aria-label="สลับผู้ใช้">
        <span className="hidden md:inline">สลับผู้ใช้</span>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="ออกจากระบบ"
        icon={<LogOut className="size-4" />}
        onClick={async () => {
          await logout();
          nav('/login');
        }}
      >
        <span className="hidden md:inline">ออกจากระบบ</span>
      </Button>
    </div>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  const { can, me } = useAuth();
  const groups = visibleNav(can);
  return (
    <nav aria-label="เมนูหลัก" className="flex flex-col gap-5 px-3 py-4">
      <div className="flex items-center gap-3 px-2">
        <img src="/brand/mark-white.png" alt="" className="h-9 w-auto" />
        <div className="font-semibold leading-tight text-white">{me?.organization.name}</div>
      </div>
      {groups.map((g) => (
        <div key={g.label}>
          <div className="px-2 pb-1 text-xs font-medium text-white/55">{g.label}</div>
          <ul className="flex flex-col gap-0.5">
            {g.items.map((it) => (
              <li key={it.to}>
                <NavLink
                  to={it.to}
                  end={it.to === '/'}
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    clsx(
                      'flex min-h-10 items-center gap-2.5 rounded-control px-2.5 py-2 text-[15px] pointer-coarse:min-h-11',
                      isActive ? 'bg-brand font-medium text-white' : 'text-white/80 hover:bg-char-2 hover:text-white',
                    )
                  }
                >
                  <it.icon className="size-[18px]" aria-hidden />
                  {it.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/** Floor staff get a toast when food is ready to serve (SPEC §3.5 แจ้งเตือนเมื่ออาหารพร้อมเสิร์ฟ). */
function FloorNotifier() {
  const { can } = useAuth();
  const toast = useToast();
  useRealtimeEvent((e) => {
    if (!can('table.operate')) return;
    if (e.type === 'order_item.status_changed' && e.payload.status === 'READY') {
      toast.info(`${e.payload.tableName ? `โต๊ะ ${e.payload.tableName}` : `บิล #${e.payload.orderNo}`}: ${e.payload.name} ×${e.payload.qty} พร้อมเสิร์ฟ`);
    }
    if (e.type === 'call_waiter') {
      toast.info(`โต๊ะ ${e.payload.tableName}: ${e.payload.label ?? 'เรียกพนักงาน'}`);
    }
  });
  return null;
}

/** Back-office shell: left rail on desktop, drawer on mobile/tablet. */
/**
 * Screens load on demand; once staff are signed in, fetch the service screens in the background so the
 * service worker caches them and POS/tables/KDS still open if the connection drops mid-service.
 */
function usePrefetchServiceScreens() {
  useEffect(() => {
    const t = setTimeout(() => {
      void Promise.all([
        import('../features/pos/PosHome'),
        import('../features/pos/OrderScreen'),
        import('../features/pos/PaymentScreen'),
        import('../features/pos/ReceiptPage'),
        import('../features/tables/TablesPage'),
        import('../features/kds/KdsPage'),
      ]).catch(() => undefined);
    }, 2000);
    return () => clearTimeout(t);
  }, []);
}

export function AppLayout() {
  usePrefetchServiceScreens();
  const [open, setOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setOpen(false), [loc.pathname]);
  return (
    <div className="flex min-h-dvh">
      <FloorNotifier />
      <aside className="on-dark no-print sticky top-0 hidden h-dvh w-60 shrink-0 overflow-y-auto bg-char lg:block">
        <SideNav />
      </aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label="เมนู">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setOpen(false)} />
          <aside className="on-dark absolute inset-y-0 left-0 w-72 max-w-[85vw] overflow-y-auto bg-char pb-[env(safe-area-inset-bottom)] shadow-xl">
            <div className="flex justify-end p-2">
              <button type="button" onClick={() => setOpen(false)} aria-label="ปิดเมนู" className="flex size-11 items-center justify-center rounded-control text-white hover:bg-char-2">
                <X className="size-5" />
              </button>
            </div>
            <SideNav onNavigate={() => setOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-line bg-surface/95 px-3 pt-[env(safe-area-inset-top)] backdrop-blur sm:gap-3 sm:px-5">
          <Button variant="ghost" size="sm" className="lg:hidden" onClick={() => setOpen(true)} aria-label="เปิดเมนู" icon={<Menu className="size-5" />} />
          <img src="/brand/mark-red.png" alt="" className="h-7 w-auto lg:hidden" />
          <BranchSelect compact />
          <OfflineIndicator />
          <div className="ml-auto flex items-center gap-2">
            <NotificationBell />
            <UserMenu />
          </div>
        </header>
        <main className="mx-auto w-full max-w-7xl flex-1 px-3 py-5 sm:px-5">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
