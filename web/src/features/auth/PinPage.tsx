import { useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Delete, UserRound } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, ErrorState, LoadingBlock } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthCard } from './LoginPage';

interface Terminal {
  paired: boolean;
  device?: { id: string; name: string; kind: string };
  branch?: { id: string; name: string };
}

export function PinPad({ value, onChange, onSubmit, disabled }: { value: string; onChange: (v: string) => void; onSubmit: () => void; disabled?: boolean }) {
  const press = (d: string) => value.length < 6 && onChange(value + d);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (disabled) return;
      if (/^\d$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') onChange(value.slice(0, -1));
      else if (e.key === 'Enter' && value.length >= 4) onSubmit();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });
  return (
    <div>
      <div className="mb-4 flex justify-center gap-3" aria-label={`ใส่ PIN แล้ว ${value.length} หลัก`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={clsx('size-3.5 rounded-full border-2', i < value.length ? 'border-basil bg-basil' : 'border-line-strong', i >= 4 && i >= value.length && 'opacity-40')} />
        ))}
      </div>
      <div className="grid grid-cols-3 gap-2">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" disabled={disabled} onClick={() => press(d)} className="num h-14 rounded-control bg-sunken text-xl font-medium hover:bg-line active:bg-line-strong">
            {d}
          </button>
        ))}
        <button type="button" disabled={disabled} onClick={() => onChange('')} className="h-14 rounded-control text-sm text-ink-2 hover:bg-sunken">
          ล้าง
        </button>
        <button type="button" disabled={disabled} onClick={() => press('0')} className="num h-14 rounded-control bg-sunken text-xl font-medium hover:bg-line">
          0
        </button>
        <button type="button" disabled={disabled} onClick={() => onChange(value.slice(0, -1))} className="flex h-14 items-center justify-center rounded-control hover:bg-sunken" aria-label="ลบ">
          <Delete className="size-5" />
        </button>
      </div>
      <Button className="mt-3 w-full" size="lg" disabled={disabled || value.length < 4} onClick={onSubmit}>
        ยืนยัน
      </Button>
    </div>
  );
}

/** Lock screen for paired front-of-house terminals: tap your name, enter PIN. */
export function PinPage() {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const terminal = useQuery({ queryKey: ['terminal'], queryFn: () => get<Terminal>('/auth/terminal') });
  const staff = useQuery({
    queryKey: ['pin-users'],
    queryFn: () => get<{ users: { id: string; name: string }[] }>('/auth/pin-users'),
    enabled: !!terminal.data?.paired,
  });
  const [userId, setUserId] = useState<string | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!userId) return;
    setBusy(true);
    setError(null);
    try {
      await post('/auth/pin-login', { userId, pin });
      qc.clear();
      await refresh();
      nav('/', { replace: true });
    } catch (e) {
      setError(errorMessage(e));
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  if (terminal.isLoading) return <AuthCard title="เข้าด้วย PIN"><LoadingBlock rows={3} /></AuthCard>;
  if (terminal.error) return <AuthCard title="เข้าด้วย PIN"><ErrorState error={terminal.error} onRetry={() => terminal.refetch()} /></AuthCard>;
  if (!terminal.data?.paired) {
    return (
      <AuthCard title="เครื่องนี้ยังไม่ได้ลงทะเบียน" footer={<Link to="/login" className="text-sky hover:underline">เข้าสู่ระบบด้วยอีเมล</Link>}>
        <p className="text-ink-2">
          ให้ผู้จัดการเข้าสู่ระบบบนเครื่องนี้ แล้วไปที่ <b>ระบบ → อุปกรณ์</b> เพื่อลงทะเบียนเป็นเครื่องหน้าร้าน จากนั้นพนักงานจะเข้าด้วย PIN ได้
        </p>
      </AuthCard>
    );
  }
  const selected = staff.data?.users.find((u) => u.id === userId);
  return (
    <AuthCard
      title={selected ? `PIN ของ ${selected.name}` : 'เลือกชื่อของคุณ'}
      footer={
        <span>
          {terminal.data.device?.name} · {terminal.data.branch?.name} ·{' '}
          <Link to="/login" className="text-sky hover:underline">
            เข้าด้วยอีเมล
          </Link>
        </span>
      }
    >
      {!selected ? (
        staff.isLoading ? (
          <LoadingBlock rows={3} />
        ) : staff.error ? (
          <ErrorState error={staff.error} onRetry={() => staff.refetch()} />
        ) : staff.data?.users.length === 0 ? (
          <p className="text-ink-2">ยังไม่มีพนักงานที่ตั้ง PIN ในสาขานี้</p>
        ) : (
          <ul className="grid grid-cols-2 gap-2">
            {staff.data?.users.map((u) => (
              <li key={u.id}>
                <button type="button" onClick={() => setUserId(u.id)} className="flex w-full items-center gap-2 rounded-control border border-line px-3 py-3 text-left hover:border-basil hover:bg-basil-50">
                  <UserRound className="size-5 text-ink-3" />
                  <span className="truncate font-medium">{u.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <>
          <PinPad value={pin} onChange={setPin} onSubmit={submit} disabled={busy} />
          {error && <p className="mt-3 text-center text-sm text-chili" role="alert">{error}</p>}
          <Button variant="ghost" className="mt-2 w-full" onClick={() => { setUserId(null); setPin(''); setError(null); }}>
            เปลี่ยนผู้ใช้
          </Button>
        </>
      )}
    </AuthCard>
  );
}
