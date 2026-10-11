import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router';
import { Button, Input } from '../../components/ui';
import { ApiError, errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { AuthCard } from './LoginPage';

/** First-run: create the organisation, first branch and owner account. */
export function SetupPage() {
  const { refresh } = useAuth();
  const qc = useQueryClient();
  const nav = useNavigate();
  const status = useQuery({ queryKey: ['setup-status'], queryFn: () => get<{ needsSetup: boolean }>('/setup/status') });
  const [f, setF] = useState({ orgName: '', branchName: 'สาขาหลัก', ownerName: '', email: '', password: '', pin: '' });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  if (status.data && !status.data.needsSetup) return <Navigate to="/login" replace />;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await post('/setup', { ...f, pin: f.pin || undefined });
      qc.clear();
      await refresh();
      nav('/', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Array.isArray(err.details)) {
        setFieldErrors(Object.fromEntries((err.details as { path: string; message: string }[]).map((d) => [d.path, d.message])));
      }
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard title="ตั้งค่าร้านครั้งแรก">
      <form onSubmit={submit} className="flex flex-col gap-3">
        <Input label="ชื่อร้าน / บริษัท" value={f.orgName} onChange={set('orgName')} required error={fieldErrors.orgName} />
        <Input label="ชื่อสาขาแรก" value={f.branchName} onChange={set('branchName')} required error={fieldErrors.branchName} />
        <Input label="ชื่อเจ้าของ" value={f.ownerName} onChange={set('ownerName')} required error={fieldErrors.ownerName} />
        <Input label="อีเมลเจ้าของ" type="email" value={f.email} onChange={set('email')} required error={fieldErrors.email} autoComplete="username" />
        <Input label="รหัสผ่าน" type="password" value={f.password} onChange={set('password')} required hint="อย่างน้อย 10 ตัวอักษร" error={fieldErrors.password} autoComplete="new-password" />
        <Input label="PIN สำหรับอนุมัติหน้าร้าน (ไม่บังคับ)" inputMode="numeric" value={f.pin} onChange={set('pin')} hint="ตัวเลข 4–6 หลัก" error={fieldErrors.pin} />
        {error && <p className="rounded-control bg-chili-50 px-3 py-2 text-sm text-chili" role="alert">{error}</p>}
        <Button type="submit" size="lg" loading={busy}>
          สร้างร้าน
        </Button>
      </form>
    </AuthCard>
  );
}
