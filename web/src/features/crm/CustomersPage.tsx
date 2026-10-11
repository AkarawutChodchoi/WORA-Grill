import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Checkbox, ConfirmDialog, DataTable, Dialog, EmptyState, Input, PageHeader, Panel, QueryView, Textarea, useToast } from '../../components/ui';
import { errorMessage, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, formatBaht } from '../../lib/format';

interface CustomerRow {
  id: string;
  name: string;
  phone: string | null;
  tier: string | null;
  pointsBalance: number;
  visitCount: number;
  lastVisitAt: string | null;
  consentMarketing: boolean;
}
interface CustomerDetail {
  customer: CustomerRow & { email: string | null; lineId: string | null; birthDate: string | null; allergies: string | null; notes: string | null; lifetimeSpendSatang: number; consentAt: string | null; anonymizedAt: string | null };
  orders: { id: string; orderNo: string; businessDate: string; status: string; grandTotalSatang: number }[];
  loyalty: { id: string; type: string; points: number; reason: string | null; createdAt: string }[];
  favourites: { name: string; qty: number }[];
}

export function CustomerForm({ initial, onSaved, onCancel }: { initial?: Partial<CustomerDetail['customer']>; onSaved: (c: { id: string; name: string }) => void; onCancel?: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({
    name: initial?.name ?? '',
    phone: initial?.phone ?? '',
    email: initial?.email ?? '',
    lineId: initial?.lineId ?? '',
    birthDate: initial?.birthDate ?? '',
    allergies: initial?.allergies ?? '',
    notes: initial?.notes ?? '',
    consentMarketing: initial?.consentMarketing ?? false,
  });
  const save = useMutation({
    mutationFn: () => {
      const body = { ...f, phone: f.phone ? f.phone : initial?.id ? undefined : null, email: f.email || null, lineId: f.lineId || null, birthDate: f.birthDate || null, allergies: f.allergies || null, notes: f.notes || null };
      return initial?.id ? patch(`/customers/${initial.id}`, body).then(() => ({ id: initial.id!, name: f.name })) : post<{ id: string; name: string }>('/customers', body);
    },
    onSuccess: (c) => {
      toast.success('บันทึกข้อมูลลูกค้าแล้ว');
      onSaved(c);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <Input label="ชื่อ" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      <Input label="เบอร์โทร" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder={initial?.id ? 'เว้นว่างถ้าไม่เปลี่ยน' : ''} />
      <Input label="วันเกิด" type="date" value={f.birthDate} onChange={(e) => setF({ ...f, birthDate: e.target.value })} />
      <Input label="LINE ID" value={f.lineId} onChange={(e) => setF({ ...f, lineId: e.target.value })} />
      <Input label="อีเมล" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <Input label="แพ้อาหาร" value={f.allergies} onChange={(e) => setF({ ...f, allergies: e.target.value })} />
      <Textarea label="หมายเหตุ" wrapClassName="sm:col-span-2" value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      <Checkbox className="sm:col-span-2" label="ลูกค้ายินยอมรับข่าวสาร/โปรโมชัน (บันทึกเวลาที่ให้ความยินยอม)" checked={f.consentMarketing} onChange={(e) => setF({ ...f, consentMarketing: e.target.checked })} />
      <div className="flex justify-end gap-2 sm:col-span-2">
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            ยกเลิก
          </Button>
        )}
        <Button loading={save.isPending} disabled={!f.name} onClick={() => save.mutate()}>
          บันทึก
        </Button>
      </div>
    </div>
  );
}

const LOYALTY_LABEL: Record<string, string> = { EARN: 'ได้รับ', REDEEM: 'ใช้แต้ม', ADJUST: 'ปรับ', EXPIRE: 'หมดอายุ', REVERSE: 'คืน/ยกเลิก' };

function CustomerDrawer({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['customer', id], queryFn: () => get<CustomerDetail>(`/customers/${id}`) });
  const [edit, setEdit] = useState(false);
  const [adjust, setAdjust] = useState({ points: '', reason: '' });
  const [anon, setAnon] = useState(false);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['customer', id] });
    qc.invalidateQueries({ queryKey: ['customers'] });
  };
  const adj = useMutation({
    mutationFn: () => post(`/customers/${id}/points`, { points: Number(adjust.points), reason: adjust.reason }),
    onSuccess: () => {
      toast.success('ปรับแต้มแล้ว');
      setAdjust({ points: '', reason: '' });
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const anonymize = useMutation({
    mutationFn: (reason: string) => post(`/customers/${id}/anonymize`, { reason }),
    onSuccess: () => {
      toast.success('ลบข้อมูลส่วนบุคคลแล้ว');
      setAnon(false);
      refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const exportPii = async () => {
    try {
      const data = await get(`/customers/${id}/export`);
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `customer-${id}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      toast.error(errorMessage(e));
    }
  };
  return (
    <Dialog open onClose={onClose} size="xl" title={q.data?.customer.name ?? 'ลูกค้า'}>
      <QueryView query={q}>
        {(d) =>
          edit ? (
            <CustomerForm initial={{ ...d.customer, phone: '' }} onSaved={() => (setEdit(false), refresh())} onCancel={() => setEdit(false)} />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2">
              <Panel
                title="ข้อมูล"
                actions={
                  can('customer.manage') &&
                  !d.customer.anonymizedAt && (
                    <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
                      แก้ไข
                    </Button>
                  )
                }
              >
                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-ink-2">โทร</dt>
                  <dd>{d.customer.phone ?? '—'}</dd>
                  <dt className="text-ink-2">วันเกิด</dt>
                  <dd>{fmtDate(d.customer.birthDate)}</dd>
                  <dt className="text-ink-2">LINE / อีเมล</dt>
                  <dd>{[d.customer.lineId, d.customer.email].filter(Boolean).join(' · ') || '—'}</dd>
                  <dt className="text-ink-2">แพ้อาหาร</dt>
                  <dd className={d.customer.allergies ? 'font-medium text-chili' : ''}>{d.customer.allergies ?? '—'}</dd>
                  <dt className="text-ink-2">ระดับ</dt>
                  <dd>{d.customer.tier ?? '—'}</dd>
                  <dt className="text-ink-2">แต้มคงเหลือ</dt>
                  <dd className="num font-semibold">{d.customer.pointsBalance.toLocaleString()}</dd>
                  <dt className="text-ink-2">ยอดซื้อสะสม</dt>
                  <dd className="num">{formatBaht(d.customer.lifetimeSpendSatang)}</dd>
                  <dt className="text-ink-2">ยินยอมรับข่าวสาร</dt>
                  <dd>{d.customer.consentMarketing ? `ใช่ (${fmtDateTime(d.customer.consentAt)})` : 'ไม่'}</dd>
                </dl>
                {d.favourites.length > 0 && (
                  <p className="mt-3 text-sm">
                    <span className="text-ink-2">เมนูโปรด: </span>
                    {d.favourites.map((f) => `${f.name} (${f.qty})`).join(', ')}
                  </p>
                )}
                {can('customer.export_pii') && (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-3">
                    <Button size="sm" variant="outline" icon={<Download className="size-4" />} onClick={exportPii}>
                      ส่งออกข้อมูล (PDPA)
                    </Button>
                    {!d.customer.anonymizedAt && (
                      <Button size="sm" variant="ghost" className="text-chili" onClick={() => setAnon(true)}>
                        ลบข้อมูลส่วนบุคคล
                      </Button>
                    )}
                  </div>
                )}
              </Panel>
              <Panel title="แต้มสะสม">
                {can('loyalty.adjust') && (
                  <div className="mb-3 flex flex-wrap items-end gap-2">
                    <Input label="ปรับแต้ม (+/-)" inputMode="numeric" wrapClassName="w-28" value={adjust.points} onChange={(e) => setAdjust({ ...adjust, points: e.target.value })} />
                    <Input label="เหตุผล" wrapClassName="flex-1" value={adjust.reason} onChange={(e) => setAdjust({ ...adjust, reason: e.target.value })} />
                    <Button size="sm" disabled={!Number(adjust.points) || adjust.reason.length < 3} loading={adj.isPending} onClick={() => adj.mutate()}>
                      บันทึก
                    </Button>
                  </div>
                )}
                <ul className="max-h-60 divide-y divide-line overflow-y-auto text-sm">
                  {d.loyalty.map((l) => (
                    <li key={l.id} className="flex justify-between gap-2 py-1.5">
                      <span>
                        {LOYALTY_LABEL[l.type] ?? l.type} <span className="text-ink-3">{l.reason}</span>
                      </span>
                      <span className={`num ${l.points < 0 ? 'text-chili' : 'text-basil-600'}`}>
                        {l.points > 0 ? '+' : ''}
                        {l.points}
                      </span>
                    </li>
                  ))}
                  {d.loyalty.length === 0 && <li className="text-ink-3">ยังไม่มีรายการ</li>}
                </ul>
              </Panel>
              <Panel title="ประวัติการสั่ง" className="lg:col-span-2">
                {d.orders.length === 0 ? (
                  <p className="text-sm text-ink-3">ยังไม่มีบิล</p>
                ) : (
                  <DataTable
                    rows={d.orders}
                    rowKey={(r) => r.id}
                    columns={[
                      { key: 'n', header: 'บิล', cell: (r) => `#${r.orderNo}` },
                      { key: 'd', header: 'วันที่', cell: (r) => fmtDate(r.businessDate) },
                      { key: 's', header: 'สถานะ', cell: (r) => <Badge>{r.status}</Badge> },
                      { key: 't', header: 'ยอด', align: 'right', cell: (r) => formatBaht(r.grandTotalSatang) },
                    ]}
                  />
                )}
              </Panel>
            </div>
          )
        }
      </QueryView>
      <ConfirmDialog
        open={anon}
        title="ลบข้อมูลส่วนบุคคลของลูกค้า?"
        message="ชื่อ เบอร์ อีเมล วันเกิด จะถูกลบถาวร ประวัติบิลและแต้มยังคงอยู่แบบไม่ระบุตัวตน"
        confirmLabel="ลบข้อมูล"
        danger
        requireReason
        loading={anonymize.isPending}
        onClose={() => setAnon(false)}
        onConfirm={(r) => anonymize.mutate(r)}
      />
    </Dialog>
  );
}

export function CustomersPage() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['customers', q], queryFn: () => get<{ customers: CustomerRow[] }>(`/customers${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  const audience = useQuery({ queryKey: ['audience'], queryFn: () => get<{ consented: number; total: number }>('/crm/audience') });
  return (
    <>
      <PageHeader
        title="ลูกค้าและสมาชิก"
        crumbs={[{ label: 'บริหาร' }]}
        description={audience.data ? `สมาชิก ${audience.data.total} คน · ยินยอมรับข่าวสาร ${audience.data.consented} คน · การส่งข้อความผ่าน LINE/SMS ยังไม่ได้ตั้งค่า` : undefined}
        actions={
          can('customer.manage') && (
            <Button icon={<Plus className="size-4" />} onClick={() => setCreating(true)}>
              เพิ่มลูกค้า
            </Button>
          )
        }
      />
      <Input placeholder="ค้นหาชื่อหรือเบอร์ (อย่างน้อย 4 หลัก)" value={q} onChange={(e) => setQ(e.target.value)} wrapClassName="mb-3 max-w-sm" aria-label="ค้นหาลูกค้า" />
      <QueryView query={list} isEmpty={(d) => d.customers.length === 0} empty={<EmptyState title="ไม่พบลูกค้า" />}>
        {(d) => (
          <DataTable
            rows={d.customers}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpen(r.id)}
            columns={[
              { key: 'n', header: 'ชื่อ', cell: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'p', header: 'โทร', cell: (r) => r.phone ?? '—' },
              { key: 't', header: 'ระดับ', cell: (r) => (r.tier ? <Badge tone="info">{r.tier}</Badge> : '—') },
              { key: 'pt', header: 'แต้ม', align: 'right', cell: (r) => r.pointsBalance.toLocaleString() },
              { key: 'v', header: 'มาแล้ว', align: 'right', cell: (r) => `${r.visitCount} ครั้ง` },
              { key: 'l', header: 'มาล่าสุด', cell: (r) => fmtDate(r.lastVisitAt) },
              { key: 'c', header: 'ข่าวสาร', cell: (r) => (r.consentMarketing ? <Badge tone="success">ยินยอม</Badge> : '—') },
            ]}
          />
        )}
      </QueryView>
      {creating && (
        <Dialog open onClose={() => setCreating(false)} title="เพิ่มลูกค้า" size="lg">
          <CustomerForm onSaved={() => (setCreating(false), qc.invalidateQueries({ queryKey: ['customers'] }))} onCancel={() => setCreating(false)} />
        </Dialog>
      )}
      {open && <CustomerDrawer id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
