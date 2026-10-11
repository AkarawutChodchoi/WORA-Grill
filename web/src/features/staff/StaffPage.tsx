import { ROLE_LABELS, type SystemRole } from '@shared/permissions';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Clock, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toSatang } from '@shared/money';
import { Badge, Button, DataTable, Dialog, EmptyState, Input, MoneyInput, PageHeader, Panel, QueryView, Select, Tabs, Textarea, useToast } from '../../components/ui';
import { del, errorMessage, get, patch, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, fmtTime, formatBaht, todayISO } from '../../lib/format';

interface StaffRow {
  id: string;
  name: string;
  phone: string | null;
  isActive: boolean;
  position: string | null;
  wageType: string | null;
  wageRateSatang: number | null;
  startDate: string | null;
  roles: string[];
}

const WAGE: Record<string, string> = { HOURLY: 'รายชั่วโมง', DAILY: 'รายวัน', MONTHLY: 'รายเดือน' };
const addDays = (d: string, n: number) => {
  const t = new Date(d + 'T00:00:00Z');
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};
/** Bangkok wall-clock input → ISO */
const bkk = (date: string, time: string) => new Date(`${date}T${time}:00+07:00`).toISOString();
const toLocalInput = (iso: string) => new Date(new Date(iso).getTime() + 7 * 3600_000).toISOString().slice(0, 16);

/** Clock in/out card shown on the home page for staff with attendance.self. */
export function ClockWidget() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['attendance-me'], queryFn: () => get<{ open: { clockInAt: string } | null }>('/attendance/me'), enabled: can('attendance.self') });
  const clock = useMutation({
    mutationFn: (action: 'in' | 'out') => post('/attendance/clock', { action }),
    onSuccess: (_r, action) => {
      toast.success(action === 'in' ? 'ลงเวลาเข้างานแล้ว' : 'ลงเวลาออกงานแล้ว');
      qc.invalidateQueries({ queryKey: ['attendance-me'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!can('attendance.self') || !q.data) return null;
  return (
    <div className="mb-5 flex flex-wrap items-center gap-3 rounded-panel border border-line bg-surface px-4 py-3">
      <Clock className="size-5 text-brand" />
      <span className="flex-1">{q.data.open ? `เข้างานเมื่อ ${fmtTime(q.data.open.clockInAt)}` : 'ยังไม่ได้ลงเวลาเข้างาน'}</span>
      {q.data.open ? (
        <Button variant="outline" loading={clock.isPending} onClick={() => clock.mutate('out')}>
          ลงเวลาออก
        </Button>
      ) : (
        <Button loading={clock.isPending} onClick={() => clock.mutate('in')}>
          ลงเวลาเข้า
        </Button>
      )}
    </div>
  );
}

function ProfileDialog({ s, onClose }: { s: StaffRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const canPay = can('report.view_staff') || can('user.manage');
  const [f, setF] = useState({ position: s.position ?? '', wageType: s.wageType ?? '', wage: s.wageRateSatang ? (s.wageRateSatang / 100).toFixed(2) : '', startDate: s.startDate ?? '' });
  const save = useMutation({
    mutationFn: () =>
      put(`/staff/${s.id}/profile`, {
        position: f.position || null,
        startDate: f.startDate || null,
        ...(canPay ? { wageType: f.wageType || null, wageRateSatang: f.wage ? toSatang(f.wage) : null } : {}),
      }),
    onSuccess: () => {
      toast.success('บันทึกแล้ว');
      qc.invalidateQueries({ queryKey: ['staff'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={s.name}
      footer={
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          บันทึก
        </Button>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="ตำแหน่ง" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} />
        <Input label="วันเริ่มงาน" type="date" value={f.startDate} onChange={(e) => setF({ ...f, startDate: e.target.value })} />
        {canPay && (
          <>
            <Select label="รูปแบบค่าจ้าง" value={f.wageType} onChange={(e) => setF({ ...f, wageType: e.target.value })}>
              <option value="">ไม่ระบุ</option>
              {Object.entries(WAGE).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
            <MoneyInput label="อัตรา (บาท)" value={f.wage} onChange={(e) => setF({ ...f, wage: e.target.value })} />
          </>
        )}
      </div>
      <p className="mt-3 text-xs text-ink-3">ระบบใช้ค่าจ้างเพื่อคำนวณต้นทุนแรงงานในรายงานเท่านั้น ไม่คำนวณเงินเดือน OT ประกันสังคม หรือภาษีหัก ณ ที่จ่าย</p>
    </Dialog>
  );
}

function ScheduleTab({ staff }: { staff: StaffRow[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [weekStart, setWeekStart] = useState(todayISO());
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const q = useQuery({ queryKey: ['schedules', weekStart], queryFn: () => get<{ shifts: { id: string; userId: string; name: string; startsAt: string; endsAt: string; position: string | null }[] }>(`/schedules?from=${days[0]}&to=${days[6]}`) });
  const [f, setF] = useState({ userId: staff[0]?.id ?? '', date: todayISO(), start: '10:00', end: '18:00', position: '' });
  const add = useMutation({
    mutationFn: () => {
      let end = bkk(f.date, f.end);
      if (end <= bkk(f.date, f.start)) end = bkk(addDays(f.date, 1), f.end); // overnight shift
      return post('/schedules', { userId: f.userId, startsAt: bkk(f.date, f.start), endsAt: end, position: f.position || null });
    },
    onSuccess: () => {
      toast.success('เพิ่มกะแล้ว');
      qc.invalidateQueries({ queryKey: ['schedules'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/schedules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['schedules'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <Panel title="เพิ่มกะ" className="mb-4">
        <div className="flex flex-wrap items-end gap-2">
          <Select label="พนักงาน" value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })} wrapClassName="w-44">
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
          <Input label="วันที่" type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} wrapClassName="w-40" />
          <Input label="เริ่ม" type="time" value={f.start} onChange={(e) => setF({ ...f, start: e.target.value })} wrapClassName="w-28" />
          <Input label="เลิก" type="time" value={f.end} onChange={(e) => setF({ ...f, end: e.target.value })} wrapClassName="w-28" />
          <Input label="หน้าที่" value={f.position} onChange={(e) => setF({ ...f, position: e.target.value })} wrapClassName="w-32" />
          <Button icon={<Plus className="size-4" />} loading={add.isPending} disabled={!f.userId} onClick={() => add.mutate()}>
            เพิ่ม
          </Button>
        </div>
      </Panel>
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" onClick={() => setWeekStart(addDays(weekStart, -7))}>
          ‹ สัปดาห์ก่อน
        </Button>
        <span className="text-sm">
          {fmtDate(days[0])} – {fmtDate(days[6])}
        </span>
        <Button size="sm" variant="ghost" onClick={() => setWeekStart(addDays(weekStart, 7))}>
          สัปดาห์ถัดไป ›
        </Button>
      </div>
      <QueryView query={q}>
        {(d) => (
          <div className="grid gap-2 md:grid-cols-7">
            {days.map((day) => {
              const list = d.shifts.filter((s) => toLocalInput(s.startsAt).slice(0, 10) === day);
              return (
                <section key={day} className="rounded-panel border border-line bg-surface p-2">
                  <h3 className="mb-1 text-sm font-semibold">{fmtDate(day)}</h3>
                  <ul className="flex flex-col gap-1 text-sm">
                    {list.map((s) => (
                      <li key={s.id} className="flex items-start justify-between gap-1 rounded bg-basil-50 px-1.5 py-1">
                        <span>
                          {s.name}
                          <span className="block text-xs text-ink-2">
                            {fmtTime(s.startsAt)}–{fmtTime(s.endsAt)} {s.position}
                          </span>
                        </span>
                        <button type="button" aria-label="ลบกะ" className="-m-1 rounded p-2 text-ink-3 hover:text-chili" onClick={() => confirm('ลบกะนี้?') && remove.mutate(s.id)}>
                          <Trash2 className="size-4" />
                        </button>
                      </li>
                    ))}
                    {list.length === 0 && <li className="text-xs text-ink-3">—</li>}
                  </ul>
                </section>
              );
            })}
          </div>
        )}
      </QueryView>
    </>
  );
}

function AttendanceTab() {
  const { can, me } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [from, setFrom] = useState(addDays(todayISO(), -6));
  const [to, setTo] = useState(todayISO());
  const [edit, setEdit] = useState<any | null>(null);
  const q = useQuery({ queryKey: ['attendance', from, to], queryFn: () => get<{ records: any[] }>(`/attendance?from=${from}&to=${to}`) });
  const save = useMutation({
    mutationFn: () => patch(`/attendance/${edit.id}`, { clockInAt: new Date(`${edit.in}:00+07:00`).toISOString(), clockOutAt: edit.out ? new Date(`${edit.out}:00+07:00`).toISOString() : null, reason: edit.reason }),
    onSuccess: () => {
      toast.success('แก้ไขเวลาแล้ว');
      setEdit(null);
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <div className="mb-3 flex gap-2">
        <Input label="จาก" type="date" value={from} onChange={(e) => setFrom(e.target.value)} wrapClassName="w-40" />
        <Input label="ถึง" type="date" value={to} onChange={(e) => setTo(e.target.value)} wrapClassName="w-40" />
      </div>
      <QueryView query={q} isEmpty={(d) => d.records.length === 0} empty={<EmptyState title="ไม่มีการลงเวลาในช่วงนี้" />}>
        {(d) => (
          <DataTable
            rows={d.records}
            rowKey={(r) => r.id}
            columns={[
              { key: 'n', header: 'พนักงาน', cell: (r) => r.name },
              { key: 'i', header: 'เข้า', cell: (r) => fmtDateTime(r.clockInAt) },
              { key: 'o', header: 'ออก', cell: (r) => (r.clockOutAt ? fmtDateTime(r.clockOutAt) : <Badge tone="info">กำลังทำงาน</Badge>) },
              { key: 'h', header: 'ชั่วโมง', align: 'right', cell: (r) => r.hours ?? '—' },
              { key: 'l', header: 'สาย', align: 'right', cell: (r) => (r.lateMinutes ? <span className="text-chili">{r.lateMinutes} นาที</span> : r.lateMinutes === 0 ? 'ตรงเวลา' : '—') },
              { key: 'e', header: '', cell: (r) => (r.editReason ? <span title={r.editReason}><Badge>แก้ไขแล้ว</Badge></span> : null) },
              {
                key: 'a',
                header: '',
                align: 'right',
                cell: (r) =>
                  can('attendance.manage') &&
                  r.userId !== me?.user.id && (
                    <Button size="sm" variant="ghost" onClick={() => setEdit({ id: r.id, in: toLocalInput(r.clockInAt), out: r.clockOutAt ? toLocalInput(r.clockOutAt) : '', reason: '' })}>
                      แก้ไข
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </QueryView>
      {edit && (
        <Dialog
          open
          onClose={() => setEdit(null)}
          title="แก้ไขเวลาเข้า-ออก"
          size="sm"
          footer={
            <Button loading={save.isPending} disabled={edit.reason.length < 3} onClick={() => save.mutate()}>
              บันทึก
            </Button>
          }
        >
          <div className="grid gap-3">
            <Input label="เข้า" type="datetime-local" value={edit.in} onChange={(e) => setEdit({ ...edit, in: e.target.value })} />
            <Input label="ออก" type="datetime-local" value={edit.out} onChange={(e) => setEdit({ ...edit, out: e.target.value })} />
            <Textarea label="เหตุผล" required value={edit.reason} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} />
          </div>
        </Dialog>
      )}
    </>
  );
}

export function StaffPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'staff' | 'schedule' | 'attendance'>(can('staff.manage') ? 'staff' : 'attendance');
  const staff = useQuery({ queryKey: ['staff'], queryFn: () => get<{ staff: StaffRow[] }>('/staff'), enabled: can('staff.manage') });
  const [editing, setEditing] = useState<StaffRow | null>(null);
  return (
    <>
      <PageHeader title="พนักงาน" crumbs={[{ label: 'บริหาร' }]} description="ข้อมูลพนักงาน ตารางกะ และเวลาเข้า-ออกงาน (เพิ่มผู้ใช้/สิทธิ์ที่เมนู ระบบ → ผู้ใช้)" />
      <ClockWidget />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          ...(can('staff.manage') ? [{ value: 'staff' as const, label: 'พนักงาน' }, { value: 'schedule' as const, label: 'ตารางกะ' }] : []),
          { value: 'attendance', label: 'เวลาเข้า-ออก' },
        ]}
      />
      {tab === 'staff' && (
        <QueryView query={staff} isEmpty={(d) => d.staff.length === 0} empty={<EmptyState title="ยังไม่มีพนักงานในสาขานี้" />}>
          {(d) => (
            <DataTable
              rows={d.staff}
              rowKey={(r) => r.id}
              onRowClick={setEditing}
              columns={[
                { key: 'n', header: 'ชื่อ', cell: (r) => <span className="font-medium">{r.name}</span> },
                { key: 'p', header: 'ตำแหน่ง', cell: (r) => r.position ?? '—' },
                { key: 'r', header: 'บทบาท', cell: (r) => r.roles.map((x) => ROLE_LABELS[x as SystemRole] ?? x).join(', ') },
                { key: 'w', header: 'ค่าจ้าง', cell: (r) => (r.wageType ? `${WAGE[r.wageType]} ${r.wageRateSatang ? formatBaht(r.wageRateSatang) : ''}` : '—') },
                { key: 's', header: 'สถานะ', cell: (r) => (r.isActive ? <Badge tone="success">ใช้งาน</Badge> : <Badge>ปิด</Badge>) },
              ]}
            />
          )}
        </QueryView>
      )}
      {tab === 'schedule' && staff.data && <ScheduleTab staff={staff.data.staff.filter((s) => s.isActive)} />}
      {tab === 'attendance' && <AttendanceTab />}
      {editing && <ProfileDialog s={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
