import { Link } from 'react-router';
import { PageHeader } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { visibleNav } from '../../nav';

/** Landing page: shortcuts to every module this user may use. */
export function HomePage() {
  const { me, can } = useAuth();
  const items = visibleNav(can)
    .flatMap((g) => g.items)
    .filter((i) => i.to !== '/');
  return (
    <>
      <PageHeader title={`สวัสดี ${me?.user.name ?? ''}`} description={me?.branch ? `สาขา ${me.branch.name}` : 'ยังไม่ได้เลือกสาขา'} />
      {items.length === 0 ? (
        <p className="text-ink-2">บัญชีของคุณยังไม่มีสิทธิ์ใช้งานโมดูลใด ติดต่อผู้จัดการร้าน</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
          {items.map((it) => (
            <li key={it.to}>
              <Link
                to={it.to}
                className="flex h-full flex-col gap-3 rounded-panel border border-line bg-surface p-4 hover:border-basil hover:bg-basil-50/40"
              >
                <it.icon className="size-6 text-basil" aria-hidden />
                <span className="font-medium">{it.label}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
