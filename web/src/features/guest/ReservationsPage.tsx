import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Plus } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toSatang } from '@shared/money';
import { Badge, Button, ConfirmDialog, DataTable, Dialog, EmptyState, Input, MoneyInput, PageHeader, Panel, QueryView, Select, StatusBadge, Textarea, useToast } from '../../components/ui';
import { errorMessage, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtTime, formatBaht, todayISO } from '../../lib/format';
import { LiveIndicator, useLivePolling } from '../../lib/realtime';
import { useFloor } from '../tables/TablesPage';

interface Reservation {
  id: string;
  name: string;
  phone: string;
  partySize: number;
  reservedAt: string;
  durationMinutes: number;
  zoneId: string | null;
  tableId: string | null;
  tableName: string | null;
  status: string;
  channel: string;
  depositSatang: number;
  depositStatus: string;
  notes: string | null;
  orderId: string | null;
}
interface QueueEntry {
  id: string;
  queueNo: number;
  name: string;
  phone: string | null;
  partySize: number;
  status: string;
  createdAt: string;
  publicUrl: string;
}

const toLocal = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 16);

function ReservationDialog({ r, date, defaultDuration, onClose }: { r: Reservation | 'new'; date: string; defaultDuration: number; onClose: () => void }) {
  const x = r === 'new' ? null : r;
  const qc = useQueryClient();
  const toast = useToast();
  const floor = useFloor();
  const [f, setF] = useState({
    name: x?.name ?? '',
    phone: x?.phone ?? '',
    partySize: x?.partySize ?? 2,
    when: x ? toLocal(x.reservedAt) : `${date}T18:00`,
    durationMinutes: x?.durationMinutes ?? defaultDuration,
    zoneId: x?.zoneId ?? '',
    tableId: x?.tableId ?? '',
    channel: x?.channel ?? 'PHONE',
    deposit: x ? (x.depositSatang / 100).toFixed(2) : '0.00',
    depositStatus: x?.depositStatus ?? 'NONE',
    notes: x?.notes ?? '',
  });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        phone: f.phone,
        partySize: Number(f.partySize),
        reservedAt: new Date(`${f.when}:00+07:00`).toISOString(),
        durationMinutes: Number(f.durationMinutes),
        zoneId: f.zoneId || null,
        tableId: f.tableId || null,
        channel: f.channel,
        depositSatang: toSatang(f.deposit || '0'),
        depositStatus: f.depositStatus,
        notes: f.notes || null,
      };
      return x ? patch(`/reservations/${x.id}`, body) : post('/reservations', body);
    },
    onSuccess: () => {
      toast.success('บันทึกการจองแล้ว');
      qc.invalidateQueries({ queryKey: ['reservations'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const tables = (floor.data?.tables ?? []).filter((t) => !f.zoneId || t.zoneId === f.zoneId);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={x ? `การจอง ${x.name}` : 'จองโต๊ะ'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="ชื่อ" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="เบอร์โทร" required value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Input label="จำนวนคน" type="number" min={1} value={f.partySize} onChange={(e) => setF({ ...f, partySize: Number(e.target.value) })} />
        <Input label="วันเวลา" type="datetime-local" value={f.when} onChange={(e) => setF({ ...f, when: e.target.value })} />
        <Input label="ระยะเวลา (นาที)" type="number" min={15} value={f.durationMinutes} onChange={(e) => setF({ ...f, durationMinutes: Number(e.target.value) })} />
        <Select label="ช่องทาง" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
          <option value="PHONE">โทรศัพท์</option>
          <option value="LINE">LINE</option>
          <option value="WALK_IN">หน้าร้าน</option>
          <option value="WEB">เว็บไซต์</option>
        </Select>
        <Select label="โซนที่ต้องการ" value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value, tableId: '' })}>
          <option value="">ไม่ระบุ</option>
          {floor.data?.zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
        <Select label="โต๊ะ" value={f.tableId} onChange={(e) => setF({ ...f, tableId: e.target.value })}>
          <option value="">ยังไม่กำหนด</option>
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.capacity} ที่นั่ง)
            </option>
          ))}
        </Select>
        <div className="flex gap-2">
          <MoneyInput label="มัดจำ" value={f.deposit} onChange={(e) => setF({ ...f, deposit: e.target.value })} />
          <Select label="สถานะมัดจำ" value={f.depositStatus} onChange={(e) => setF({ ...f, depositStatus: e.target.value })}>
            <option value="NONE">ไม่มี</option>
            <option value="PENDING">รอชำระ</option>
            <option value="PAID">ชำระแล้ว</option>
            <option value="REFUNDED">คืนแล้ว</option>
            <option value="FORFEITED">ยึดมัดจำ</option>
          </Select>
        </div>
        <Textarea label="หมายเหตุ" wrapClassName="sm:col-span-3" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </div>
    </Dialog>
  );
}

function SeatDialog({ title, partySize, onSeat, onClose }: { title: string; partySize: number; onSeat: (tableId: string) => void; onClose: () => void }) {
  const floor = useFloor();
  const free = (floor.data?.tables ?? []).filter((t) => t.status === 'AVAILABLE' && !t.mergedIntoTableId);
  return (
    <Dialog open onClose={onClose} title={title} size="md">
      {free.length === 0 ? (
        <p className="text-ink-2">ไม่มีโต๊ะว่างตอนนี้</p>
      ) : (
        <ul className="grid grid-cols-3 gap-2">
          {free.map((t) => (
            <li key={t.id}>
              <button type="button" onClick={() => onSeat(t.id)} className={`w-full rounded-control border px-3 py-3 text-left ${t.capacity >= partySize ? 'border-basil/50 bg-basil-50' : 'border-line'}`}>
                <span className="font-semibold">{t.name}</span>
                <span className="block text-xs text-ink-2">{t.capacity} ที่นั่ง</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

export function ReservationsPage() {
  const { me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const poll = useLivePolling();
  const [date, setDate] = useState(todayISO());
  const [editing, setEditing] = useState<Reservation | 'new' | null>(null);
  const [seating, setSeating] = useState<{ kind: 'res' | 'queue'; id: string; name: string; party: number } | null>(null);
  const [walkIn, setWalkIn] = useState({ name: '', partySize: 2, phone: '' });
  const [ticket, setTicket] = useState<{ queueNo: number; qrDataUrl: string; publicUrl: string } | null>(null);
  const res = useQuery({ queryKey: ['reservations', date], queryFn: () => get<{ reservations: Reservation[]; defaultDuration: number }>(`/reservations?date=${date}`), refetchInterval: poll });
  const queue = useQuery({ queryKey: ['waitlist'], queryFn: () => get<{ entries: QueueEntry[]; avgWaitMinutes: number | null }>('/waitlist'), refetchInterval: poll });
  const act = useMutation({
    mutationFn: (fn: () => Promise<any>) => fn(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['reservations'] });
      qc.invalidateQueries({ queryKey: ['waitlist'] });
      qc.invalidateQueries({ queryKey: ['tables'] });
      return r;
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const [confirmAct, setConfirmAct] = useState<{ id: string; status: 'CANCELLED' | 'NO_SHOW' } | null>(null);
  const status = (id: string, s: string) => {
    // Cancelling / marking no-show is confirmed in a dialog (cancel also asks for a reason).
    if (s === 'CANCELLED' || s === 'NO_SHOW') return setConfirmAct({ id, status: s });
    act.mutate(() => post(`/reservations/${id}/status`, { status: s }));
  };
  const waiting = (queue.data?.entries ?? []).filter((e) => ['WAITING', 'CALLED'].includes(e.status));
  return (
    <>
      <PageHeader
        title="การจองและคิว"
        crumbs={[{ label: 'หน้าร้าน' }]}
        description={<LiveIndicator />}
        actions={
          <>
            {me?.branch && (
              <Button
                variant="ghost"
                icon={<Link2 className="size-4" />}
                onClick={() => {
                  navigator.clipboard?.writeText(`${location.origin}/book/${me.branch!.id}`);
                  toast.success('คัดลอกลิงก์จองออนไลน์แล้ว');
                }}
              >
                ลิงก์จองออนไลน์
              </Button>
            )}
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              จองโต๊ะ
            </Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_380px]">
        <Panel title="การจอง" actions={<Input aria-label="วันที่" type="date" value={date} onChange={(e) => setDate(e.target.value)} />}>
          <QueryView query={res} isEmpty={(d) => d.reservations.length === 0} empty={<EmptyState title="ไม่มีการจองวันนี้" />}>
            {(d) => (
              <DataTable
                rows={d.reservations}
                rowKey={(r) => r.id}
                columns={[
                  { key: 't', header: 'เวลา', cell: (r) => <span className="num font-medium">{fmtTime(r.reservedAt)}</span> },
                  {
                    key: 'n',
                    header: 'ลูกค้า',
                    cell: (r) => (
                      <button type="button" className="text-left hover:underline" onClick={() => setEditing(r)}>
                        {r.name} <span className="text-ink-3">· {r.partySize} คน · {r.phone}</span>
                        {r.notes && <span className="block text-xs text-ink-2">{r.notes}</span>}
                      </button>
                    ),
                  },
                  { key: 'tb', header: 'โต๊ะ', cell: (r) => r.tableName ?? '—' },
                  { key: 'd', header: 'มัดจำ', cell: (r) => (r.depositSatang ? `${formatBaht(r.depositSatang)} ${r.depositStatus === 'PAID' ? '✓' : r.depositStatus === 'FORFEITED' ? '(ยึด)' : ''}` : '—') },
                  { key: 's', header: 'สถานะ', cell: (r) => <StatusBadge status={r.status} /> },
                  {
                    key: 'a',
                    header: '',
                    align: 'right',
                    cell: (r) => (
                      <div className="flex justify-end gap-1">
                        {r.status === 'BOOKED' && (
                          <Button size="sm" variant="outline" onClick={() => status(r.id, 'CONFIRMED')}>
                            ยืนยัน
                          </Button>
                        )}
                        {['BOOKED', 'CONFIRMED'].includes(r.status) && (
                          <>
                            <Button size="sm" onClick={() => setSeating({ kind: 'res', id: r.id, name: r.name, party: r.partySize })}>
                              มาถึงแล้ว
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => status(r.id, 'NO_SHOW')}>
                              ไม่มา
                            </Button>
                            <Button size="sm" variant="danger-ghost" onClick={() => status(r.id, 'CANCELLED')}>
                              ยกเลิก
                            </Button>
                          </>
                        )}
                        {r.status === 'SEATED' && r.orderId && (
                          <Button size="sm" variant="ghost" onClick={() => nav(`/pos/orders/${r.orderId}`)}>
                            ไปที่บิล
                          </Button>
                        )}
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </QueryView>
        </Panel>
        <Panel title={`คิวหน้าร้าน (${waiting.length})`}>
          <form
            className="mb-3 flex flex-wrap items-end gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              act.mutate(async () => {
                const t = await post<{ queueNo: number; qrDataUrl: string; publicUrl: string }>('/waitlist', { name: walkIn.name, partySize: Number(walkIn.partySize), phone: walkIn.phone || undefined });
                setTicket(t);
                setWalkIn({ name: '', partySize: 2, phone: '' });
              });
            }}
          >
            <Input label="ชื่อ" required value={walkIn.name} onChange={(e) => setWalkIn({ ...walkIn, name: e.target.value })} wrapClassName="w-32" />
            <Input label="คน" type="number" min={1} value={walkIn.partySize} onChange={(e) => setWalkIn({ ...walkIn, partySize: Number(e.target.value) })} wrapClassName="w-16" />
            <Input label="โทร" value={walkIn.phone} onChange={(e) => setWalkIn({ ...walkIn, phone: e.target.value })} wrapClassName="w-32" />
            <Button type="submit">ออกบัตรคิว</Button>
          </form>
          {queue.data?.avgWaitMinutes !== null && queue.data?.avgWaitMinutes !== undefined && <p className="mb-2 text-sm text-ink-2">รอเฉลี่ย {queue.data.avgWaitMinutes} นาที (7 วันล่าสุด)</p>}
          <ul className="flex flex-col gap-2">
            {waiting.map((e) => (
              <li key={e.id} className="flex flex-wrap items-center gap-2 rounded-control border border-line p-2">
                <span className="num w-10 text-center text-xl font-bold">{e.queueNo}</span>
                <span className="flex-1">
                  {e.name} <span className="text-ink-3">· {e.partySize} คน</span>
                  <span className="block text-xs text-ink-3">รับคิว {fmtTime(e.createdAt)}</span>
                </span>
                {e.status === 'CALLED' && <Badge tone="info">เรียกแล้ว</Badge>}
                {e.status === 'WAITING' && (
                  <Button size="sm" variant="outline" onClick={() => act.mutate(() => post(`/waitlist/${e.id}/call`))}>
                    เรียก
                  </Button>
                )}
                <Button size="sm" onClick={() => setSeating({ kind: 'queue', id: e.id, name: `คิว ${e.queueNo} ${e.name}`, party: e.partySize })}>
                  ให้นั่ง
                </Button>
                <Button size="sm" variant="danger-ghost" onClick={() => confirm(`ลบคิว ${e.queueNo} ${e.name} ออกจากคิว?`) && act.mutate(() => post(`/waitlist/${e.id}/left`))}>
                  ลบออกจากคิว
                </Button>
              </li>
            ))}
            {waiting.length === 0 && <li className="text-sm text-ink-3">ไม่มีคิวรอ</li>}
          </ul>
        </Panel>
      </div>
      <ConfirmDialog
        open={!!confirmAct}
        title={confirmAct?.status === 'CANCELLED' ? 'ยกเลิกการจองนี้?' : 'บันทึกว่าลูกค้าไม่มา?'}
        message={confirmAct?.status === 'NO_SHOW' ? 'โต๊ะที่กันไว้จะว่างทันที' : undefined}
        confirmLabel={confirmAct?.status === 'CANCELLED' ? 'ยกเลิกการจอง' : 'ลูกค้าไม่มา'}
        danger
        requireReason={confirmAct?.status === 'CANCELLED'}
        loading={act.isPending}
        onClose={() => setConfirmAct(null)}
        onConfirm={(reason) => {
          const c = confirmAct!;
          act.mutate(() => post(`/reservations/${c.id}/status`, { status: c.status, reason: reason || undefined }));
          setConfirmAct(null);
        }}
      />
      {editing && <ReservationDialog r={editing} date={date} defaultDuration={res.data?.defaultDuration ?? 90} onClose={() => setEditing(null)} />}
      {seating && (
        <SeatDialog
          title={`เลือกโต๊ะให้ ${seating.name}`}
          partySize={seating.party}
          onClose={() => setSeating(null)}
          onSeat={(tableId) =>
            act.mutate(async () => {
              const r: any = seating.kind === 'res' ? await post(`/reservations/${seating.id}/seat`, { tableId }) : await post(`/waitlist/${seating.id}/seat`, { tableId });
              setSeating(null);
              toast.success('เปิดโต๊ะแล้ว');
              const orderId = r.id ?? r.orderId;
              if (orderId) nav(`/pos/orders/${orderId}`);
            })
          }
        />
      )}
      {ticket && (
        <Dialog open onClose={() => setTicket(null)} title="บัตรคิว" size="sm" footer={<Button onClick={() => window.print()}>พิมพ์</Button>}>
          <div className="flex flex-col items-center gap-2 text-center">
            <p className="num text-6xl font-bold">{ticket.queueNo}</p>
            <img src={ticket.qrDataUrl} alt="QR ติดตามคิว" className="size-48" />
            <p className="text-sm text-ink-2">สแกนเพื่อดูสถานะคิวบนมือถือ</p>
          </div>
        </Dialog>
      )}
    </>
  );
}
