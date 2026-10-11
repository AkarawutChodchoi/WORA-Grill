import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useParams } from 'react-router';
import { Button, ErrorState, Input, LoadingBlock, Textarea } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';

/** Guest-facing queue ticket status (SPEC §3.3 ดูคิวผ่านมือถือ). */
export function QueuePage() {
  const { token = '' } = useParams();
  const q = useQuery({ queryKey: ['queue', token], queryFn: () => get<{ branchName: string; queueNo: number; partySize: number; status: string; ahead: number; estimatedWaitMinutes: number | null }>(`/public/queue/${token}`), refetchInterval: 15_000, retry: false });
  if (q.isLoading) return <div className="p-6"><LoadingBlock /></div>;
  if (q.error || !q.data) return <div className="p-6"><ErrorState error={q.error} /></div>;
  const d = q.data;
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm flex-col items-center justify-center gap-3 p-6 text-center">
      <p className="text-ink-2">{d.branchName}</p>
      <p className="text-sm text-ink-3">บัตรคิว / Queue</p>
      <p className="num text-7xl font-bold text-brand" aria-live="polite">
        {d.queueNo}
      </p>
      <p className="text-ink-2">{d.partySize} ท่าน</p>
      {d.status === 'WAITING' && (
        <>
          <p className="text-lg">
            รออีก <b className="num">{d.ahead}</b> คิว · {d.ahead} ahead
          </p>
          {d.estimatedWaitMinutes !== null && <p className="text-sm text-ink-3">ประมาณ {d.estimatedWaitMinutes} นาที (เฉลี่ยจาก 7 วันที่ผ่านมา)</p>}
        </>
      )}
      {d.status === 'CALLED' && <p className="rounded-panel bg-basil px-4 py-3 text-xl font-semibold text-white">ถึงคิวแล้ว เชิญที่หน้าร้าน · It's your turn!</p>}
      {d.status === 'SEATED' && <p className="text-lg">ได้โต๊ะแล้ว ขอให้อร่อย · Enjoy your meal</p>}
      {d.status === 'LEFT' && <p className="text-ink-3">คิวนี้ถูกยกเลิก</p>}
      <p className="mt-6 text-xs text-ink-3">หน้านี้อัปเดตอัตโนมัติ</p>
    </main>
  );
}

/** Public web booking form; bookings arrive as BOOKED and are confirmed by staff. */
export function BookingPage() {
  const { branchId = '' } = useParams();
  const info = useQuery({ queryKey: ['public-branch', branchId], queryFn: () => get<{ name: string; address: string | null; phone: string | null; openTime: string; closeTime: string }>(`/public/branches/${branchId}`), retry: false });
  const [f, setF] = useState({ name: '', phone: '', partySize: 2, date: '', time: '18:00', notes: '', website: '' });
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const book = useMutation({
    mutationFn: () => post<{ message: string }>(`/public/branches/${branchId}/reservations`, { name: f.name, phone: f.phone, partySize: Number(f.partySize), reservedAt: new Date(`${f.date}T${f.time}:00+07:00`).toISOString(), notes: f.notes || undefined, website: f.website || undefined }),
    onSuccess: (r) => setDone(r.message),
    onError: (e) => setErr(errorMessage(e)),
  });
  if (info.isLoading) return <div className="p-6"><LoadingBlock /></div>;
  if (info.error || !info.data) return <div className="p-6"><ErrorState error={info.error} /></div>;
  return (
    <main className="mx-auto max-w-md p-6">
      <h1 className="text-xl font-semibold">จองโต๊ะ — {info.data.name}</h1>
      <p className="mb-4 text-sm text-ink-2">
        เปิด {info.data.openTime}–{info.data.closeTime} {info.data.phone && `· โทร ${info.data.phone}`}
      </p>
      {done ? (
        <p className="rounded-panel bg-basil-50 p-4 text-basil-600">{done}</p>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setErr(null);
            book.mutate();
          }}
        >
          <Input label="ชื่อ" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input label="เบอร์โทร" required inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            <Input label="จำนวนคน" type="number" min={1} max={20} value={f.partySize} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} />
            <Input label="วันที่" type="date" required value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} />
            <Input label="เวลา" type="time" required value={f.time} onChange={(e) => setF({ ...f, time: e.target.value })} />
          </div>
          <Textarea label="หมายเหตุ" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          {/* honeypot: hidden from people, filled by bots */}
          <input tabIndex={-1} autoComplete="off" aria-hidden className="hidden" name="website" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
          {err && <p className="text-sm text-chili" role="alert">{err}</p>}
          <Button type="submit" size="lg" loading={book.isPending}>
            ส่งคำขอจอง
          </Button>
          <p className="text-xs text-ink-3">ข้อมูลของคุณใช้เพื่อการจองนี้เท่านั้น</p>
        </form>
      )}
    </main>
  );
}
