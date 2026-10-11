import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toSatang } from '@shared/money';
import type { OrgSettings } from '@shared/settings';
import { Badge, Button, Checkbox, DataTable, Dialog, EmptyState, Input, MoneyInput, PageHeader, Panel, QueryView, Select, Tabs, Textarea, useToast } from '../../components/ui';
import { errorMessage, get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, formatBaht } from '../../lib/format';
import { CHANNEL_LABEL } from '../menu/ItemDialog';
import type { AdminMenu } from '../menu/types';

interface Promotion {
  id: string;
  name: string;
  description: string | null;
  type: 'PERCENT_BILL' | 'AMOUNT_BILL' | 'PERCENT_ITEM' | 'BUY_X_GET_Y';
  value: number;
  conditions: Record<string, any>;
  requiresCoupon: boolean;
  startsAt: string | null;
  endsAt: string | null;
  usageLimitTotal: number | null;
  usageLimitPerCustomer: number | null;
  stackable: boolean;
  active: boolean;
  archivedAt: string | null;
  used: number;
  discountGivenSatang: number;
}

const TYPE_LABEL = { PERCENT_BILL: 'ลด % ทั้งบิล', AMOUNT_BILL: 'ลดเป็นบาท', PERCENT_ITEM: 'ลด % เฉพาะรายการ/หมวด', BUY_X_GET_Y: 'ซื้อ X แถม Y' };
const DAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส'];
const toLocalInput = (iso: string | null) => (iso ? new Date(iso).toISOString().slice(0, 16) : '');

function PromotionDialog({ p, menu, onClose }: { p: Promotion | 'new'; menu?: AdminMenu; onClose: () => void }) {
  const x = p === 'new' ? null : p;
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    name: x?.name ?? '',
    description: x?.description ?? '',
    type: x?.type ?? ('PERCENT_BILL' as Promotion['type']),
    value: x ? (x.type.startsWith('PERCENT') ? String(x.value / 100) : (x.value / 100).toFixed(2)) : '10',
    requiresCoupon: x?.requiresCoupon ?? false,
    startsAt: toLocalInput(x?.startsAt ?? null),
    endsAt: toLocalInput(x?.endsAt ?? null),
    usageLimitTotal: x?.usageLimitTotal ? String(x.usageLimitTotal) : '',
    usageLimitPerCustomer: x?.usageLimitPerCustomer ? String(x.usageLimitPerCustomer) : '',
    stackable: x?.stackable ?? false,
    active: x?.active ?? true,
  });
  const [c, setC] = useState<Record<string, any>>({ ...(x?.conditions ?? {}), minSpend: x?.conditions.minSpendSatang ? (x.conditions.minSpendSatang / 100).toFixed(2) : '' });
  const save = useMutation({
    mutationFn: () => {
      const value = f.type.startsWith('PERCENT') ? Math.round(Number(f.value) * 100) : f.type === 'AMOUNT_BILL' ? toSatang(f.value || '0') : 0;
      const { minSpend, ...rest } = c;
      const conditions = Object.fromEntries(Object.entries({ ...rest, minSpendSatang: minSpend ? toSatang(minSpend) : undefined } as Record<string, unknown>).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && v.length === 0)));
      const body = {
        ...f,
        value,
        conditions,
        description: f.description || null,
        startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null,
        endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null,
        usageLimitTotal: f.usageLimitTotal ? Number(f.usageLimitTotal) : null,
        usageLimitPerCustomer: f.usageLimitPerCustomer ? Number(f.usageLimitPerCustomer) : null,
      };
      return x ? put(`/promotions/${x.id}`, body) : post('/promotions', body);
    },
    onSuccess: () => {
      toast.success('บันทึกโปรโมชันแล้ว');
      qc.invalidateQueries({ queryKey: ['promotions'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggleArr = (k: string, v: string) => setC({ ...c, [k]: (c[k] ?? []).includes(v) ? c[k].filter((y: string) => y !== v) : [...(c[k] ?? []), v] });
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={x ? x.name : 'สร้างโปรโมชัน'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} disabled={!f.name} onClick={() => save.mutate()}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="ชื่อโปรโมชัน" required wrapClassName="sm:col-span-2" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Select label="ประเภท" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as Promotion['type'] })}>
          {Object.entries(TYPE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        {f.type !== 'BUY_X_GET_Y' && (
          <Input label={f.type.startsWith('PERCENT') ? 'ส่วนลด (%)' : 'ส่วนลด (บาท)'} inputMode="decimal" value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} />
        )}
        {f.type === 'BUY_X_GET_Y' && (
          <>
            <Input label="ซื้อ (ชิ้น)" type="number" min={1} value={c.buyQty ?? ''} onChange={(e) => setC({ ...c, buyQty: Number(e.target.value) })} />
            <Input label="แถม (ชิ้น)" type="number" min={1} value={c.getQty ?? ''} onChange={(e) => setC({ ...c, getQty: Number(e.target.value) })} />
          </>
        )}
        <MoneyInput label="ยอดซื้อขั้นต่ำ (บาท)" value={c.minSpend ?? ''} onChange={(e) => setC({ ...c, minSpend: e.target.value })} />
        <Input label="เริ่ม" type="datetime-local" value={f.startsAt} onChange={(e) => setF({ ...f, startsAt: e.target.value })} />
        <Input label="สิ้นสุด" type="datetime-local" value={f.endsAt} onChange={(e) => setF({ ...f, endsAt: e.target.value })} />
        <Input label="ใช้ได้ทั้งหมด (ครั้ง)" type="number" min={1} value={f.usageLimitTotal} onChange={(e) => setF({ ...f, usageLimitTotal: e.target.value })} hint="ว่าง = ไม่จำกัด" />
        <Input label="ต่อสมาชิก (ครั้ง)" type="number" min={1} value={f.usageLimitPerCustomer} onChange={(e) => setF({ ...f, usageLimitPerCustomer: e.target.value })} />
        <Input label="ช่วงเวลา เริ่ม" type="time" value={c.timeFrom ?? ''} onChange={(e) => setC({ ...c, timeFrom: e.target.value || undefined })} />
        <Input label="ช่วงเวลา สิ้นสุด" type="time" value={c.timeTo ?? ''} onChange={(e) => setC({ ...c, timeTo: e.target.value || undefined })} hint="เช่น Happy hour" />
        <fieldset className="sm:col-span-3">
          <legend className="mb-1 text-sm font-medium text-ink-2">วัน (ว่าง = ทุกวัน)</legend>
          <div className="flex flex-wrap gap-3">
            {DAYS.map((d, i) => (
              <Checkbox key={d} label={d} checked={((c.days ?? 0) & (1 << i)) !== 0} onChange={() => setC({ ...c, days: ((c.days ?? 0) ^ (1 << i)) || undefined })} />
            ))}
          </div>
        </fieldset>
        <fieldset className="sm:col-span-3">
          <legend className="mb-1 text-sm font-medium text-ink-2">ช่องทาง (ว่าง = ทุกช่องทาง)</legend>
          <div className="flex flex-wrap gap-3">
            {['DINE_IN', 'TAKEAWAY', 'DELIVERY', 'QR'].map((ch) => (
              <Checkbox key={ch} label={CHANNEL_LABEL[ch]} checked={(c.channels ?? []).includes(ch)} onChange={() => toggleArr('channels', ch)} />
            ))}
          </div>
        </fieldset>
        {(f.type === 'PERCENT_ITEM' || f.type === 'BUY_X_GET_Y') && menu && (
          <fieldset className="sm:col-span-3">
            <legend className="mb-1 text-sm font-medium text-ink-2">เมนูที่ร่วมรายการ</legend>
            <div className="flex max-h-40 flex-wrap gap-3 overflow-y-auto">
              {f.type === 'PERCENT_ITEM' &&
                menu.categories
                  .filter((y) => !y.archivedAt)
                  .map((cat) => <Checkbox key={cat.id} label={`หมวด: ${cat.name}`} checked={(c.categoryIds ?? []).includes(cat.id)} onChange={() => toggleArr('categoryIds', cat.id)} />)}
              {menu.items
                .filter((y) => !y.archivedAt)
                .map((it) => (
                  <Checkbox key={it.id} label={it.name} checked={(c.menuItemIds ?? []).includes(it.id)} onChange={() => toggleArr('menuItemIds', it.id)} />
                ))}
            </div>
          </fieldset>
        )}
        <div className="flex flex-col gap-2 sm:col-span-3">
          <Checkbox label="เฉพาะสมาชิก" checked={!!c.memberOnly} onChange={(e) => setC({ ...c, memberOnly: e.target.checked || undefined })} />
          <Checkbox label="ใช้ร่วมกับโปรโมชันอื่นได้" checked={f.stackable} onChange={(e) => setF({ ...f, stackable: e.target.checked })} />
          <Checkbox label="ต้องใช้รหัสคูปอง" checked={f.requiresCoupon} onChange={(e) => setF({ ...f, requiresCoupon: e.target.checked })} />
          <Checkbox label="เปิดใช้งาน" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />
        </div>
        <Textarea label="คำอธิบาย" wrapClassName="sm:col-span-3" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </div>
    </Dialog>
  );
}

function CouponsDialog({ p, onClose }: { p: Promotion; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['coupons', p.id], queryFn: () => get<{ coupons: { id: string; code: string; maxUses: number; usedCount: number; expiresAt: string | null }[] }>(`/promotions/${p.id}/coupons`) });
  const [count, setCount] = useState('10');
  const [maxUses, setMaxUses] = useState('1');
  const [code, setCode] = useState('');
  const gen = useMutation({
    mutationFn: () => post(`/promotions/${p.id}/coupons`, code ? { code: code.toUpperCase(), maxUses: Number(maxUses) } : { count: Number(count), maxUses: Number(maxUses) }),
    onSuccess: () => {
      toast.success('สร้างคูปองแล้ว');
      qc.invalidateQueries({ queryKey: ['coupons', p.id] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog open onClose={onClose} title={`คูปอง: ${p.name}`} size="lg">
      <div className="mb-4 flex flex-wrap items-end gap-2">
        <Input label="รหัสกำหนดเอง (ไม่บังคับ)" value={code} onChange={(e) => setCode(e.target.value)} wrapClassName="w-48" />
        {!code && <Input label="จำนวนคูปอง" type="number" min={1} max={500} value={count} onChange={(e) => setCount(e.target.value)} wrapClassName="w-28" />}
        <Input label="ใช้ได้ (ครั้ง/คูปอง)" type="number" min={1} value={maxUses} onChange={(e) => setMaxUses(e.target.value)} wrapClassName="w-32" />
        <Button loading={gen.isPending} onClick={() => gen.mutate()}>
          สร้างคูปอง
        </Button>
      </div>
      <QueryView query={list} isEmpty={(d) => d.coupons.length === 0} empty={<p className="text-ink-3">ยังไม่มีคูปอง</p>}>
        {(d) => (
          <DataTable
            rows={d.coupons}
            rowKey={(r) => r.id}
            columns={[
              { key: 'c', header: 'รหัส', cell: (r) => <code>{r.code}</code> },
              { key: 'u', header: 'ใช้แล้ว', cell: (r) => `${r.usedCount}/${r.maxUses}` },
              { key: 'e', header: 'หมดอายุ', cell: (r) => fmtDate(r.expiresAt) },
            ]}
          />
        )}
      </QueryView>
    </Dialog>
  );
}

function LoyaltySettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['org-settings'], queryFn: () => get<{ name: string; settings: OrgSettings }>('/settings/org') });
  const promos = useQuery({ queryKey: ['promotions'], queryFn: () => get<{ promotions: Promotion[] }>('/promotions') });
  const [draft, setDraft] = useState<OrgSettings['loyalty'] | null>(null);
  const l = draft ?? q.data?.settings.loyalty;
  const save = useMutation({
    mutationFn: () => put('/settings/org', { name: q.data!.name, settings: { ...q.data!.settings, loyalty: l } }),
    onSuccess: () => {
      toast.success('บันทึกการตั้งค่าสมาชิกแล้ว');
      qc.invalidateQueries({ queryKey: ['org-settings'] });
      setDraft(null);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const run = useMutation({
    mutationFn: (path: string) => post<{ issued?: number; expired?: number; note?: string }>(path),
    onSuccess: (r) => toast.success(r.issued !== undefined ? `ออกคูปองวันเกิด ${r.issued} ใบ` : `ตัดแต้มหมดอายุ ${r.expired} แต้ม`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!l) return null;
  const set = (patch: Partial<OrgSettings['loyalty']>) => setDraft({ ...l, ...patch });
  return (
    <Panel title="ระบบสมาชิกและแต้มสะสม">
      <div className="grid gap-3 sm:grid-cols-3">
        <Checkbox className="sm:col-span-3" label="เปิดใช้ระบบแต้มสะสม" checked={l.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
        <Input label="แต้มต่อทุก 100 บาท" type="number" min={0} value={l.pointsPer100Baht} onChange={(e) => set({ pointsPer100Baht: Number(e.target.value) })} />
        <MoneyInput label="มูลค่า 1 แต้ม (บาท)" value={(l.pointValueSatang / 100).toFixed(2)} onChange={(e) => set({ pointValueSatang: (() => { try { return toSatang(e.target.value || '0'); } catch { return l.pointValueSatang; } })() })} />
        <Input label="แต้มหมดอายุหลัง (เดือน)" type="number" min={0} value={l.expiryMonths} onChange={(e) => set({ expiryMonths: Number(e.target.value) })} hint="0 = ไม่หมดอายุ" />
        <Select label="โปรโมชันคูปองวันเกิด" value={l.birthdayCouponPromotionId ?? ''} onChange={(e) => set({ birthdayCouponPromotionId: e.target.value || null })}>
          <option value="">ไม่ใช้</option>
          {promos.data?.promotions
            .filter((p) => p.requiresCoupon)
            .map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
        </Select>
      </div>
      <h3 className="mt-4 mb-2 font-semibold">ระดับสมาชิก</h3>
      <div className="flex flex-col gap-2">
        {l.tiers.map((t, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Input aria-label="รหัส" placeholder="GOLD" wrapClassName="w-28" value={t.code} onChange={(e) => set({ tiers: l.tiers.map((x, j) => (j === i ? { ...x, code: e.target.value.toUpperCase() } : x)) })} />
            <Input aria-label="ชื่อ" placeholder="Gold" wrapClassName="w-36" value={t.name} onChange={(e) => set({ tiers: l.tiers.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
            <MoneyInput aria-label="ยอดสะสมขั้นต่ำ" wrapClassName="w-36" value={(t.minSpendSatang / 100).toFixed(2)} onChange={(e) => set({ tiers: l.tiers.map((x, j) => (j === i ? { ...x, minSpendSatang: (() => { try { return toSatang(e.target.value || '0'); } catch { return x.minSpendSatang; } })() } : x)) })} />
            <Input aria-label="ตัวคูณแต้ม" inputMode="decimal" wrapClassName="w-24" value={String(t.earnMultiplierBps / 10000)} onChange={(e) => set({ tiers: l.tiers.map((x, j) => (j === i ? { ...x, earnMultiplierBps: Math.round(Number(e.target.value || 1) * 10000) } : x)) })} />
            <Button variant="ghost" aria-label="ลบระดับ" icon={<Trash2 className="size-4" />} onClick={() => set({ tiers: l.tiers.filter((_, j) => j !== i) })} />
          </div>
        ))}
        <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => set({ tiers: [...l.tiers, { code: '', name: '', minSpendSatang: 0, earnMultiplierBps: 10000 }] })}>
          เพิ่มระดับ
        </Button>
        <p className="text-xs text-ink-3">ระดับคำนวณจากยอดซื้อสะสมตลอดชีพ · ตัวคูณแต้ม 1.5 = ได้แต้มเพิ่ม 50%</p>
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button loading={save.isPending} disabled={!draft} onClick={() => save.mutate()}>
          บันทึก
        </Button>
        <Button variant="outline" onClick={() => run.mutate('/crm/birthday-coupons')}>
          ออกคูปองวันเกิดเดือนนี้
        </Button>
        {l.expiryMonths > 0 && (
          <Button variant="outline" onClick={() => run.mutate('/crm/expire-points')}>
            ตัดแต้มหมดอายุ
          </Button>
        )}
      </div>
    </Panel>
  );
}

export function PromotionsPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<'promos' | 'loyalty'>('promos');
  const list = useQuery({ queryKey: ['promotions'], queryFn: () => get<{ promotions: Promotion[] }>('/promotions') });
  const menu = useQuery({ queryKey: ['menu-admin'], queryFn: () => get<AdminMenu>('/menu/admin'), enabled: can('menu.view') });
  const [editing, setEditing] = useState<Promotion | 'new' | null>(null);
  const [coupons, setCoupons] = useState<Promotion | null>(null);
  return (
    <>
      <PageHeader
        title="โปรโมชันและสมาชิก"
        crumbs={[{ label: 'บริหาร' }]}
        actions={
          tab === 'promos' && (
            <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
              สร้างโปรโมชัน
            </Button>
          )
        }
      />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'promos', label: 'โปรโมชัน' },
          { value: 'loyalty', label: 'แต้มและระดับสมาชิก' },
        ]}
      />
      {tab === 'promos' ? (
        <QueryView query={list} isEmpty={(d) => d.promotions.length === 0} empty={<EmptyState title="ยังไม่มีโปรโมชัน" />}>
          {(d) => (
            <DataTable
              rows={d.promotions}
              rowKey={(r) => r.id}
              onRowClick={setEditing}
              columns={[
                { key: 'n', header: 'ชื่อ', cell: (r) => <span className="font-medium">{r.name}</span> },
                { key: 't', header: 'ประเภท', cell: (r) => TYPE_LABEL[r.type] },
                { key: 'v', header: 'ส่วนลด', cell: (r) => (r.type.startsWith('PERCENT') ? `${r.value / 100}%` : r.type === 'AMOUNT_BILL' ? formatBaht(r.value) : `ซื้อ ${r.conditions.buyQty} แถม ${r.conditions.getQty}`) },
                { key: 'p', header: 'ช่วงเวลา', cell: (r) => (r.startsAt || r.endsAt ? `${fmtDateTime(r.startsAt)} – ${fmtDateTime(r.endsAt)}` : 'ตลอด') },
                { key: 'u', header: 'ใช้แล้ว', align: 'right', cell: (r) => `${r.used}${r.usageLimitTotal ? `/${r.usageLimitTotal}` : ''}` },
                { key: 'g', header: 'ส่วนลดที่ให้', align: 'right', cell: (r) => formatBaht(r.discountGivenSatang) },
                {
                  key: 's',
                  header: 'สถานะ',
                  cell: (r) => (
                    <span className="flex gap-1">
                      {r.active ? <Badge tone="success">เปิด</Badge> : <Badge>ปิด</Badge>}
                      {r.requiresCoupon && <Badge tone="info">คูปอง</Badge>}
                      {r.stackable && <Badge>ใช้ร่วมได้</Badge>}
                    </span>
                  ),
                },
                {
                  key: 'c',
                  header: '',
                  align: 'right',
                  cell: (r) =>
                    r.requiresCoupon && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={(e) => {
                          e.stopPropagation();
                          setCoupons(r);
                        }}
                      >
                        คูปอง
                      </Button>
                    ),
                },
              ]}
            />
          )}
        </QueryView>
      ) : (
        <LoyaltySettings />
      )}
      {editing && <PromotionDialog p={editing} menu={menu.data} onClose={() => setEditing(null)} />}
      {coupons && <CouponsDialog p={coupons} onClose={() => setCoupons(null)} />}
    </>
  );
}
