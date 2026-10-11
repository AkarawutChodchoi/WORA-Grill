import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { Button, Input } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';

export function AuthCard({ title, children, footer }: { title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center gap-2">
          <img src="/icon.svg" alt="" className="size-9" />
          <span className="text-lg font-semibold">ระบบจัดการร้านอาหาร</span>
        </div>
        <div className="rounded-panel border border-line bg-surface p-6">
          <h1 className="mb-4 text-xl font-semibold">{title}</h1>
          {children}
        </div>
        {footer && <div className="mt-4 text-center text-sm text-ink-2">{footer}</div>}
      </div>
    </div>
  );
}

/** Only allow same-origin relative redirects after login. */
function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export function LoginPage() {
  const { me, refresh } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setup = useQuery({ queryKey: ['setup-status'], queryFn: () => get<{ needsSetup: boolean }>('/setup/status') });

  if (me) return <Navigate to={safeNext(params.get('next'))} replace />;
  if (setup.data?.needsSetup) return <Navigate to="/setup" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/login', { email, password });
      qc.clear();
      await refresh();
      nav(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="เข้าสู่ระบบหลังร้าน" footer={<Link to="/pin" className="text-sky hover:underline">เครื่องหน้าร้าน: เข้าด้วย PIN</Link>}>
      <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
        <Input label="อีเมล" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
        <Input label="รหัสผ่าน" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && (
          <p className="rounded-control bg-chili-50 px-3 py-2 text-sm text-chili" role="alert">
            {error}
          </p>
        )}
        <Button type="submit" size="lg" loading={busy} disabled={!email || !password}>
          เข้าสู่ระบบ
        </Button>
      </form>
    </AuthCard>
  );
}
