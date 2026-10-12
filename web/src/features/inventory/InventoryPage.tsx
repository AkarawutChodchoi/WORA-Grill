import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useApproval } from '../../components/ApprovalDialog';
import { Badge, Button, Checkbox, DataTable, Dialog, EmptyState, Input, MoneyInput, PageHeader, Panel, QueryView, Select, Tabs, Textarea, useToast } from '../../components/ui';
import { errorMessage, get, post, put, qs } from '../../lib/api';
import { useTabParam } from '../../lib/useTabParam';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, formatBaht, todayISO } from '../../lib/format';
import { toSatang } from '@shared/money';
import type { AdminMenu } from '../menu/types';
import { TransfersTab } from './TransfersTab';

export interface Ingredient {
  id: string;
  name: string;
  sku: string | null;
  category: string | null;
  baseUnit: string;
  reorderPoint: string;
  reorderQty: string;
  isSubRecipe: boolean;
  trackExpiry: boolean;
  archivedAt: string | null;
  onHand: string;
  avgCost: string | null;
  stockValue: string | null;
  low: boolean;
  units: { unit: string; factor: string; isPurchase: boolean; isUsage: boolean }[];
}

export const fmtQty = (v: string | number, unit?: string) => `${Number(v).toLocaleString('th-TH', { maximumFractionDigits: 3 })}${unit ? ` ${unit}` : ''}`;

export function useIngredients() {
  return useQuery({ queryKey: ['ingredients'], queryFn: () => get<{ warehouseId: string; ingredients: Ingredient[] }>('/inventory/ingredients') });
}

function useInvMutation<T>(fn: (v: T) => Promise<unknown>, success: string, after?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(success);
      for (const k of ['ingredients', 'movements', 'low-stock', 'counts', 'recipes', 'menu-costs', 'expiring']) qc.invalidateQueries({ queryKey: [k] });
      after?.();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

function IngredientDialog({ ing, onClose }: { ing: Ingredient | 'new'; onClose: () => void }) {
  const i = ing === 'new' ? null : ing;
  const [f, setF] = useState({
    name: i?.name ?? '',
    sku: i?.sku ?? '',
    category: i?.category ?? '',
    baseUnit: i?.baseUnit ?? 'g',
    reorderPoint: i?.reorderPoint ? String(Number(i.reorderPoint)) : '0',
    reorderQty: i?.reorderQty ? String(Number(i.reorderQty)) : '0',
    isSubRecipe: i?.isSubRecipe ?? false,
    trackExpiry: i?.trackExpiry ?? false,
  });
  const [units, setUnits] = useState(i?.units.map((u) => ({ ...u, factor: String(Number(u.factor)) })) ?? [{ unit: 'kg', factor: '1000', isPurchase: true, isUsage: false }]);
  const save = useInvMutation(
    () => {
      const body = { ...f, sku: f.sku || null, category: f.category || null, units: units.filter((u) => u.unit && u.factor) };
      return i ? put(`/inventory/ingredients/${i.id}`, body) : post('/inventory/ingredients', body);
    },
    'บันทึกวัตถุดิบแล้ว',
    onClose,
  );
  const archive = useInvMutation(() => put(`/inventory/ingredients/${i!.id}`, { ...f, units, archived: true }), 'เก็บวัตถุดิบแล้ว', onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title={i ? `แก้ไข ${i.name}` : 'เพิ่มวัตถุดิบ'}
      size="lg"
      footer={
        <>
          {i && (
            <Button variant="danger-ghost" className="mr-auto" onClick={() => confirm(`ซ่อนวัตถุดิบ "${i.name}" (เลิกใช้)?`) && archive.mutate(undefined)}>
              ซ่อนวัตถุดิบ (เลิกใช้)
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} disabled={!f.name || !f.baseUnit} onClick={() => save.mutate(undefined)}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="ชื่อ" required wrapClassName="sm:col-span-2" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="หมวด" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} placeholder="เช่น ของสด, แห้ง" />
        <Input label="หน่วยเก็บ (หน่วยหลัก)" required value={f.baseUnit} onChange={(e) => setF({ ...f, baseUnit: e.target.value })} hint="เช่น g, ml, pcs" disabled={!!i && Number(i.onHand) !== 0} />
        <Input label={`จุดสั่งซื้อ (${f.baseUnit})`} inputMode="decimal" value={f.reorderPoint} onChange={(e) => setF({ ...f, reorderPoint: e.target.value })} />
        <Input label={`จำนวนสั่งซื้อแนะนำ (${f.baseUnit})`} inputMode="decimal" value={f.reorderQty} onChange={(e) => setF({ ...f, reorderQty: e.target.value })} />
        <Input label="SKU" value={f.sku} onChange={(e) => setF({ ...f, sku: e.target.value })} />
        <Checkbox className="self-end pb-2" label="วัตถุดิบกึ่งสำเร็จ (ผลิตเอง)" checked={f.isSubRecipe} onChange={(e) => setF({ ...f, isSubRecipe: e.target.checked })} />
        <Checkbox className="self-end pb-2" label="ติดตามล็อต/วันหมดอายุ" checked={f.trackExpiry} onChange={(e) => setF({ ...f, trackExpiry: e.target.checked })} />
      </div>
      <h3 className="mt-5 mb-2 font-semibold">การแปลงหน่วย</h3>
      <div className="flex flex-col gap-2">
        {units.map((u, idx) => (
          <div key={idx} className="flex flex-wrap items-end gap-2">
            <span className="pb-2.5">1</span>
            <Input label="หน่วย" placeholder="kg / ลัง / แผง" wrapClassName="w-28" value={u.unit} onChange={(e) => setUnits(units.map((x, j) => (j === idx ? { ...x, unit: e.target.value } : x)))} />
            <span className="pb-2.5">=</span>
            <Input label="ตัวคูณ" inputMode="decimal" wrapClassName="w-28" value={u.factor} onChange={(e) => setUnits(units.map((x, j) => (j === idx ? { ...x, factor: e.target.value } : x)))} />
            <span className="pb-2.5">{f.baseUnit}</span>
            <Checkbox className="pb-2" label="หน่วยซื้อ" checked={u.isPurchase} onChange={(e) => setUnits(units.map((x, j) => (j === idx ? { ...x, isPurchase: e.target.checked } : x)))} />
            <Checkbox className="pb-2" label="หน่วยใช้" checked={u.isUsage} onChange={(e) => setUnits(units.map((x, j) => (j === idx ? { ...x, isUsage: e.target.checked } : x)))} />
            <Button variant="ghost" aria-label="ลบหน่วย" icon={<Trash2 className="size-4" />} onClick={() => setUnits(units.filter((_, j) => j !== idx))} />
          </div>
        ))}
        <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => setUnits([...units, { unit: '', factor: '', isPurchase: false, isUsage: false }])}>
          เพิ่มหน่วย
        </Button>
      </div>
    </Dialog>
  );
}

function IngredientsTab() {
  const { can } = useAuth();
  const q = useIngredients();
  const [editing, setEditing] = useState<Ingredient | 'new' | null>(null);
  const [search, setSearch] = useState('');
  return (
    <>
      <div className="mb-3 flex flex-wrap gap-2">
        <Input placeholder="ค้นหาวัตถุดิบ" value={search} onChange={(e) => setSearch(e.target.value)} wrapClassName="w-64" aria-label="ค้นหาวัตถุดิบ" />
        {can('inventory.manage') && (
          <Button className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            เพิ่มวัตถุดิบ
          </Button>
        )}
      </div>
      <QueryView query={q} isEmpty={(d) => d.ingredients.length === 0} empty={<EmptyState title="ยังไม่มีวัตถุดิบ">เพิ่มวัตถุดิบ แล้วสร้างสูตรอาหารเพื่อตัดสต็อกอัตโนมัติ</EmptyState>}>
        {(d) => (
          <DataTable
            rows={d.ingredients.filter((i) => !search || i.name.includes(search))}
            rowKey={(r) => r.id}
            onRowClick={can('inventory.manage') ? setEditing : undefined}
            columns={[
              {
                key: 'name',
                header: 'วัตถุดิบ',
                cell: (r) => (
                  <span>
                    <span className="font-medium">{r.name}</span> {r.isSubRecipe && <Badge tone="info">กึ่งสำเร็จ</Badge>} {r.trackExpiry && <Badge>ล็อต</Badge>}
                    <span className="block text-xs text-ink-3">{r.category}</span>
                  </span>
                ),
              },
              {
                key: 'onhand',
                header: 'คงเหลือ',
                align: 'right',
                cell: (r) => <span className={Number(r.onHand) < 0 ? 'text-chili' : ''}>{fmtQty(r.onHand, r.baseUnit)}</span>,
              },
              { key: 'rp', header: 'จุดสั่งซื้อ', align: 'right', cell: (r) => (Number(r.reorderPoint) > 0 ? fmtQty(r.reorderPoint, r.baseUnit) : '—') },
              { key: 'status', header: '', cell: (r) => (Number(r.onHand) < 0 ? <Badge tone="danger">ติดลบ</Badge> : r.low ? <Badge tone="warning">ใกล้หมด</Badge> : null) },
              ...(d.ingredients[0]?.avgCost !== null
                ? [
                    { key: 'cost', header: 'ต้นทุนเฉลี่ย/หน่วย', align: 'right' as const, cell: (r: Ingredient) => `${(Number(r.avgCost) / 100).toFixed(4)} ฿/${r.baseUnit}` },
                    { key: 'value', header: 'มูลค่า', align: 'right' as const, cell: (r: Ingredient) => formatBaht(Math.round(Number(r.stockValue))) },
                  ]
                : []),
            ]}
          />
        )}
      </QueryView>
      {editing && <IngredientDialog ing={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

interface LineDraft {
  ingredientId: string;
  qty: string;
  unit: string;
  cost?: string;
  lotNo?: string;
  expiryDate?: string;
}

/** Shared editor for multi-line stock documents. */
/** `baseUnitOnly`: quantities are counted in the ingredient's base unit (stock adjust sets the new on-hand amount). */
export function LinesEditor({ lines, setLines, ingredients, withCost, baseUnitOnly }: { lines: LineDraft[]; setLines: (l: LineDraft[]) => void; ingredients: Ingredient[]; withCost?: boolean; baseUnitOnly?: boolean }) {
  const byId = useMemo(() => new Map(ingredients.map((i) => [i.id, i])), [ingredients]);
  const set = (idx: number, patch: Partial<LineDraft>) => setLines(lines.map((x, j) => (j === idx ? { ...x, ...patch } : x)));
  return (
    <div className="flex flex-col gap-2">
      {lines.map((l, idx) => {
        const ing = byId.get(l.ingredientId);
        const unitOpts = ing ? [ing.baseUnit, ...ing.units.map((u) => u.unit)] : [];
        return (
          <div key={idx} className="flex flex-wrap items-end gap-2 rounded-control border border-line p-2">
            <Select
              label="วัตถุดิบ"
              wrapClassName="min-w-48 flex-1"
              value={l.ingredientId}
              onChange={(e) => {
                const n = byId.get(e.target.value);
                set(idx, { ingredientId: e.target.value, unit: n?.units.find((u) => u.isPurchase)?.unit ?? n?.baseUnit ?? '' });
              }}
            >
              <option value="">เลือกวัตถุดิบ</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
            <Input
              label={baseUnitOnly ? 'ยอดคงเหลือจริง' : 'จำนวน'}
              placeholder={baseUnitOnly ? 'ยอดจริง' : 'จำนวน'}
              inputMode="decimal"
              wrapClassName="w-24"
              value={l.qty}
              onChange={(e) => set(idx, { qty: e.target.value })}
            />
            {baseUnitOnly ? (
              <span className="flex h-10 items-center text-sm text-ink-2 pointer-coarse:h-11">{ing?.baseUnit ?? ''}</span>
            ) : (
              <Select label="หน่วย" wrapClassName="w-28" value={l.unit} onChange={(e) => set(idx, { unit: e.target.value })}>
                {unitOpts.map((u) => (
                  <option key={u} value={u}>
                    {u}
                  </option>
                ))}
              </Select>
            )}
            {withCost && (
              <>
                <MoneyInput label="ราคาต่อหน่วย" placeholder="ราคา/หน่วย" wrapClassName="w-28" value={l.cost ?? ''} onChange={(e) => set(idx, { cost: e.target.value })} />
                {ing?.trackExpiry && (
                  <>
                    <Input label="เลขล็อต" placeholder="ล็อต" wrapClassName="w-24" value={l.lotNo ?? ''} onChange={(e) => set(idx, { lotNo: e.target.value })} />
                    <Input label="วันหมดอายุ" type="date" wrapClassName="w-40" value={l.expiryDate ?? ''} onChange={(e) => set(idx, { expiryDate: e.target.value })} />
                  </>
                )}
              </>
            )}
            <Button variant="ghost" aria-label="ลบรายการ" icon={<Trash2 className="size-4" />} onClick={() => setLines(lines.filter((_, j) => j !== idx))} />
          </div>
        );
      })}
      <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => setLines([...lines, { ingredientId: '', qty: '', unit: '' }])}>
        เพิ่มรายการ
      </Button>
    </div>
  );
}

function StockOpsTab() {
  const { can } = useAuth();
  const q = useIngredients();
  const [kind, setKind] = useState<'receive' | 'issue' | 'waste' | 'adjust'>(can('stock.receive') ? 'receive' : 'waste');
  const [lines, setLines] = useState<LineDraft[]>([{ ingredientId: '', qty: '', unit: '' }]);
  const [reason, setReason] = useState('');
  const adjustApproval = useApproval('stock.adjust');
  const submit = useInvMutation(
    (approval: { userId: string; pin: string } | null) => {
      const valid = lines.filter((l) => l.ingredientId && l.qty);
      if (!valid.length) throw new Error('กรอกอย่างน้อย 1 รายการ');
      if (kind === 'receive')
        return post('/inventory/receive', {
          note: reason || undefined,
          lines: valid.map((l) => ({ ingredientId: l.ingredientId, qty: l.qty, unit: l.unit, unitCostSatang: toSatang(l.cost || '0'), lotNo: l.lotNo || undefined, expiryDate: l.expiryDate || undefined })),
        });
      if (kind === 'adjust') return post('/inventory/adjust', { reason, approval, lines: valid.map((l) => ({ ingredientId: l.ingredientId, newQty: l.qty })) });
      return post(`/inventory/${kind}`, { reason, lines: valid.map((l) => ({ ingredientId: l.ingredientId, qty: l.qty, unit: l.unit })) });
    },
    'บันทึกแล้ว',
    () => {
      setLines([{ ingredientId: '', qty: '', unit: '' }]);
      setReason('');
    },
  );
  const kinds = [
    { value: 'receive' as const, label: 'รับเข้า', perm: 'stock.receive' },
    { value: 'issue' as const, label: 'เบิกใช้', perm: 'stock.issue' },
    { value: 'waste' as const, label: 'ของเสีย', perm: 'stock.waste' },
    { value: 'adjust' as const, label: 'ปรับยอด', perm: 'inventory.view' },
  ].filter((k) => can(k.perm as never));
  return (
    <QueryView query={q}>
      {(d) => (
        <Panel>
          <div className="mb-4 flex flex-wrap gap-2" role="radiogroup">
            {kinds.map((k) => (
              <Button key={k.value} variant={kind === k.value ? 'primary' : 'outline'} onClick={() => setKind(k.value)} role="radio" aria-checked={kind === k.value}>
                {k.label}
              </Button>
            ))}
          </div>
          <p className="mb-3 text-sm text-ink-2">
            {kind === 'receive' && 'รับของที่ซื้อเองโดยไม่มีใบสั่งซื้อ (ถ้ามีใบสั่งซื้อ ให้รับที่หน้า "จัดซื้อ") — ราคาเป็นต่อหน่วยที่เลือก'}
            {kind === 'issue' && 'เบิกของออกจากคลัง เช่น อาหารพนักงาน หรือส่งต่อไปใช้งาน'}
            {kind === 'waste' && 'บันทึกของเสีย/หมดอายุ/ทำตก พร้อมเหตุผล — ใช้ในรายงานของเสีย'}
            {kind === 'adjust' && 'ตั้งยอดคงเหลือใหม่ (กรอกจำนวนในหน่วยหลัก) — ต้องมีสิทธิ์ปรับยอดหรือ PIN ผู้จัดการ'}
          </p>
          <LinesEditor lines={lines} setLines={setLines} ingredients={d.ingredients} withCost={kind === 'receive'} baseUnitOnly={kind === 'adjust'} />
          <Textarea label={kind === 'receive' ? 'หมายเหตุ / ผู้ขาย' : 'เหตุผล'} required={kind !== 'receive'} value={reason} onChange={(e) => setReason(e.target.value)} wrapClassName="mt-3" />
          <Button
            className="mt-3"
            loading={submit.isPending}
            disabled={kind !== 'receive' && reason.trim().length < 3}
            onClick={() => (kind === 'adjust' ? adjustApproval.request((a) => submit.mutateAsync(a)) : submit.mutate(null))}
          >
            บันทึก{kinds.find((k) => k.value === kind)?.label}
          </Button>
          {adjustApproval.dialog}
        </Panel>
      )}
    </QueryView>
  );
}

interface Recipe {
  id: string;
  menuItemId: string | null;
  modifierId: string | null;
  outputIngredientId: string | null;
  yieldQty: string;
  lines: { ingredientId: string; qty: string; unit: string; qtyBase: string }[];
}

function RecipesTab() {
  const { can } = useAuth();
  const ings = useIngredients();
  const recipes = useQuery({ queryKey: ['recipes'], queryFn: () => get<{ recipes: Recipe[] }>('/inventory/recipes') });
  const menu = useQuery({ queryKey: ['menu-admin'], queryFn: () => get<AdminMenu>('/menu/admin') });
  const costs = useQuery({ queryKey: ['menu-costs'], queryFn: () => get<{ items: { menuItemId: string; costSatang: number; foodCostPct: number | null; hasRecipe: boolean }[] }>('/inventory/menu-costs'), enabled: can('report.view_profit') });
  const [target, setTarget] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([]);
  const [yieldQty, setYieldQty] = useState('1');
  const targets = useMemo(() => {
    const out: { key: string; label: string; body: Record<string, string> }[] = [];
    for (const i of menu.data?.items.filter((x) => !x.archivedAt) ?? []) out.push({ key: `m:${i.id}`, label: `เมนู: ${i.name}`, body: { menuItemId: i.id } });
    for (const g of menu.data?.modifierGroups ?? []) for (const m of g.modifiers.filter((x) => !x.archivedAt)) out.push({ key: `o:${m.id}`, label: `ตัวเลือก: ${g.name} › ${m.name}`, body: { modifierId: m.id } });
    for (const i of ings.data?.ingredients.filter((x) => x.isSubRecipe) ?? []) out.push({ key: `s:${i.id}`, label: `กึ่งสำเร็จ: ${i.name}`, body: { outputIngredientId: i.id } });
    return out;
  }, [menu.data, ings.data]);
  const load = (key: string) => {
    setTarget(key);
    const t = targets.find((x) => x.key === key);
    const r = recipes.data?.recipes.find(
      (x) =>
        (!!t?.body.menuItemId && x.menuItemId === t.body.menuItemId) ||
        (!!t?.body.modifierId && x.modifierId === t.body.modifierId) ||
        (!!t?.body.outputIngredientId && x.outputIngredientId === t.body.outputIngredientId),
    );
    setLines(r?.lines.map((l) => ({ ingredientId: l.ingredientId, qty: String(Number(l.qty)), unit: l.unit })) ?? []);
    setYieldQty(r ? String(Number(r.yieldQty)) : '1');
  };
  const save = useInvMutation(() => {
    const t = targets.find((x) => x.key === target)!;
    return put('/inventory/recipes', { ...t.body, yieldQty, lines: lines.filter((l) => l.ingredientId && l.qty) });
  }, 'บันทึกสูตรแล้ว');
  const produceQty = useState('1');
  const produce = useInvMutation(() => post('/inventory/produce', { outputIngredientId: target.slice(2), batches: produceQty[0] }), 'บันทึกการผลิตแล้ว');
  const cost = target.startsWith('m:') ? costs.data?.items.find((c) => c.menuItemId === target.slice(2)) : undefined;
  return (
    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Panel title="สูตรอาหาร (วัตถุดิบต่อ 1 จาน)">
        <Select label="เลือกเมนู / ตัวเลือก / วัตถุดิบกึ่งสำเร็จ" value={target} onChange={(e) => load(e.target.value)} wrapClassName="mb-4">
          <option value="">— เลือก —</option>
          {targets.map((t) => (
            <option key={t.key} value={t.key}>
              {t.label}
              {t.body.menuItemId && recipes.data?.recipes.some((r) => r.menuItemId === t.body.menuItemId) ? ' ✓' : ''}
            </option>
          ))}
        </Select>
        {target && ings.data && (
          <>
            {target.startsWith('s:') && <Input label="1 ชุดการผลิตได้ (หน่วยหลัก)" inputMode="decimal" value={yieldQty} onChange={(e) => setYieldQty(e.target.value)} wrapClassName="mb-3 w-60" />}
            <LinesEditor lines={lines} setLines={setLines} ingredients={ings.data.ingredients.filter((i) => `s:${i.id}` !== target)} />
            {can('inventory.manage') && (
              <Button className="mt-3" loading={save.isPending} onClick={() => save.mutate(undefined)}>
                บันทึกสูตร
              </Button>
            )}
            {target.startsWith('s:') && can('stock.issue') && (
              <div className="mt-4 flex items-end gap-2 border-t border-line pt-4">
                <Input label="ผลิตจำนวน (ชุด)" inputMode="decimal" value={produceQty[0]} onChange={(e) => produceQty[1](e.target.value)} wrapClassName="w-40" />
                <Button variant="outline" loading={produce.isPending} onClick={() => produce.mutate(undefined)}>
                  บันทึกการผลิต
                </Button>
              </div>
            )}
          </>
        )}
      </Panel>
      {can('report.view_profit') && (
        <Panel title="ต้นทุนต่อจาน">
          {cost ? (
            cost.hasRecipe ? (
              <dl className="flex flex-col gap-1">
                <div className="flex justify-between">
                  <dt>ต้นทุน</dt>
                  <dd className="num">{formatBaht(cost.costSatang)}</dd>
                </div>
                <div className="flex justify-between font-semibold">
                  <dt>ต้นทุนวัตถุดิบ %</dt>
                  <dd className={cost.foodCostPct! > 40 ? 'text-chili' : 'text-basil-600'}>{cost.foodCostPct}%</dd>
                </div>
              </dl>
            ) : (
              <p className="text-ink-3">ยังไม่มีสูตร</p>
            )
          ) : (
            <p className="text-sm text-ink-3">เลือกเมนูเพื่อดูต้นทุน (คำนวณจากต้นทุนเฉลี่ยถ่วงน้ำหนักปัจจุบัน)</p>
          )}
        </Panel>
      )}
    </div>
  );
}

interface CountSheet {
  count: { id: string; status: string; createdAt: string; postedAt: string | null; note: string | null };
  lines: { ingredientId: string; name: string; baseUnit: string; theoreticalQty: string; countedQty: string | null; varianceQty: string | null; varianceValue: string | null }[];
}

function CountsTab() {
  const { can } = useAuth();
  const list = useQuery({ queryKey: ['counts'], queryFn: () => get<{ counts: { id: string; status: string; createdAt: string; postedAt: string | null; note: string | null }[] }>('/inventory/counts') });
  const [openId, setOpenId] = useState<string | null>(null);
  const sheet = useQuery({ queryKey: ['counts', openId], queryFn: () => get<CountSheet>(`/inventory/counts/${openId}`), enabled: !!openId });
  const [counted, setCounted] = useState<Record<string, string>>({});
  const approval = useApproval('stock.adjust');
  const create = useInvMutation(async () => {
    const c = await post<{ id: string }>('/inventory/counts', {});
    setOpenId(c.id);
    setCounted({});
  }, 'สร้างใบนับสต็อกแล้ว');
  const saveCounts = useInvMutation(
    () => put(`/inventory/counts/${openId}`, { lines: Object.entries(counted).map(([ingredientId, v]) => ({ ingredientId, countedQty: v === '' ? null : v })) }),
    'บันทึกจำนวนที่นับแล้ว',
  );
  const postCount = useInvMutation(
    async (appr: { userId: string; pin: string } | null) => {
      if (Object.keys(counted).length) await put(`/inventory/counts/${openId}`, { lines: Object.entries(counted).map(([ingredientId, v]) => ({ ingredientId, countedQty: v === '' ? null : v })) });
      return post(`/inventory/counts/${openId}/post`, { approval: appr });
    },
    'ปรับยอดตามการนับแล้ว',
  );
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_minmax(0,1fr)]">
      <Panel
        title="ใบนับสต็อก"
        actions={
          can('stock.count') && (
            <Button size="sm" icon={<Plus className="size-4" />} loading={create.isPending} onClick={() => create.mutate(undefined)}>
              นับใหม่
            </Button>
          )
        }
      >
        <QueryView query={list} isEmpty={(d) => d.counts.length === 0} empty={<p className="text-sm text-ink-3">ยังไม่มีใบนับ</p>}>
          {(d) => (
            <ul className="flex flex-col gap-1">
              {d.counts.map((c) => (
                <li key={c.id}>
                  <button type="button" onClick={() => (setOpenId(c.id), setCounted({}))} className={`flex w-full justify-between rounded-control px-2 py-1.5 text-left text-sm ${openId === c.id ? 'bg-basil-50' : 'hover:bg-sunken'}`}>
                    <span>{fmtDateTime(c.createdAt)}</span>
                    <Badge tone={c.status === 'POSTED' ? 'success' : 'warning'}>{c.status === 'POSTED' ? 'บันทึกแล้ว' : 'ร่าง'}</Badge>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Panel>
      {openId && (
        <QueryView query={sheet}>
          {(s) => (
            <Panel title={`นับสต็อก ${fmtDateTime(s.count.createdAt)}`}>
              <DataTable
                rows={s.lines}
                rowKey={(r) => r.ingredientId}
                columns={[
                  { key: 'name', header: 'วัตถุดิบ', cell: (r) => r.name },
                  { key: 'theo', header: 'ตามระบบ', align: 'right', cell: (r) => fmtQty(r.theoreticalQty, r.baseUnit) },
                  {
                    key: 'counted',
                    header: 'นับได้',
                    align: 'right',
                    cell: (r) =>
                      s.count.status === 'DRAFT' ? (
                        <input
                          aria-label={`นับได้ ${r.name}`}
                          inputMode="decimal"
                          className="h-11 w-28 rounded-control border border-line-strong px-2 text-right text-base"
                          value={counted[r.ingredientId] ?? (r.countedQty == null ? '' : String(Number(r.countedQty)))}
                          onChange={(e) => setCounted({ ...counted, [r.ingredientId]: e.target.value })}
                        />
                      ) : r.countedQty == null ? (
                        '—'
                      ) : (
                        fmtQty(r.countedQty, r.baseUnit)
                      ),
                  },
                  {
                    key: 'var',
                    header: 'ส่วนต่าง',
                    align: 'right',
                    cell: (r) => (r.varianceQty == null ? '—' : <span className={Number(r.varianceQty) < 0 ? 'text-chili' : ''}>{fmtQty(r.varianceQty, r.baseUnit)}</span>),
                  },
                  { key: 'val', header: 'มูลค่าส่วนต่าง', align: 'right', cell: (r) => (r.varianceValue == null ? '—' : formatBaht(Math.round(Number(r.varianceValue)))) },
                ]}
              />
              {s.count.status === 'DRAFT' && (
                <div className="mt-3 flex gap-2">
                  <Button variant="outline" loading={saveCounts.isPending} onClick={() => saveCounts.mutate(undefined)}>
                    บันทึกร่าง
                  </Button>
                  <Button loading={postCount.isPending} onClick={() => approval.request((a) => postCount.mutateAsync(a))}>
                    ยืนยันและปรับยอด
                  </Button>
                </div>
              )}
              {approval.dialog}
            </Panel>
          )}
        </QueryView>
      )}
    </div>
  );
}

const REF_LABEL: Record<string, string> = {
  order_item: 'ขายในบิล',
  receive: 'รับเข้า',
  goods_receipt: 'รับของตามใบสั่งซื้อ',
  adjust: 'ปรับยอด',
  stock_count: 'นับสต็อก',
  transfer: 'โอนระหว่างสาขา',
  stock_transfer: 'โอนระหว่างสาขา',
  supplier_return: 'คืนซัพพลายเออร์',
  production: 'ผลิต/เตรียมของ',
};

const MOVE_LABEL: Record<string, string> = {
  PURCHASE: 'รับเข้า',
  SALE: 'ขาย',
  SALE_REVERSAL: 'คืนจากการยกเลิก',
  TRANSFER_IN: 'โอนเข้า',
  TRANSFER_OUT: 'โอนออก',
  WASTE: 'ของเสีย',
  ADJUST: 'ปรับยอด',
  COUNT: 'ปรับตามนับ',
  ISSUE: 'เบิกใช้',
  PRODUCTION_IN: 'ผลิตได้',
  PRODUCTION_OUT: 'ใช้ผลิต',
  RETURN: 'คืนซัพพลายเออร์',
};

function MovementsTab() {
  const ings = useIngredients();
  const [ingredientId, setIngredientId] = useState('');
  const [type, setType] = useState('');
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const q = useQuery({ queryKey: ['movements', ingredientId, type, from, to], queryFn: () => get<{ movements: any[] }>(`/inventory/movements${qs({ ingredientId, type, from, to })}`) });
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Select label="วัตถุดิบ" value={ingredientId} onChange={(e) => setIngredientId(e.target.value)} wrapClassName="w-56">
          <option value="">ทั้งหมด</option>
          {ings.data?.ingredients.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </Select>
        <Select label="ประเภท" value={type} onChange={(e) => setType(e.target.value)} wrapClassName="w-44">
          <option value="">ทั้งหมด</option>
          {Object.entries(MOVE_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
        <Input label="จาก" type="date" value={from} onChange={(e) => setFrom(e.target.value)} wrapClassName="w-40" />
        <Input label="ถึง" type="date" value={to} onChange={(e) => setTo(e.target.value)} wrapClassName="w-40" />
      </div>
      <QueryView query={q} isEmpty={(d) => d.movements.length === 0} empty={<EmptyState title="ไม่มีความเคลื่อนไหวในช่วงนี้" />}>
        {(d) => (
          <DataTable
            rows={d.movements}
            rowKey={(r) => r.id}
            columns={[
              { key: 't', header: 'เวลา', cell: (r) => fmtDateTime(r.createdAt) },
              { key: 'i', header: 'วัตถุดิบ', cell: (r) => r.ingredient },
              { key: 'type', header: 'ประเภท', cell: (r) => <Badge tone={Number(r.qty) < 0 ? 'neutral' : 'success'}>{MOVE_LABEL[r.type] ?? r.type}</Badge> },
              { key: 'q', header: 'จำนวน', align: 'right', cell: (r) => fmtQty(r.qty, r.baseUnit) },
              { key: 'bal', header: 'คงเหลือ', align: 'right', cell: (r) => fmtQty(r.balanceAfter, r.baseUnit) },
              { key: 'v', header: 'มูลค่า', align: 'right', cell: (r) => (r.value == null ? '—' : formatBaht(Math.round(Number(r.value)))) },
              { key: 'r', header: 'อ้างอิง/เหตุผล', cell: (r) => <span className="text-xs text-ink-2">{r.reason ?? REF_LABEL[r.refType] ?? r.refType}</span> },
              { key: 'by', header: 'โดย', cell: (r) => r.by ?? '—' },
            ]}
          />
        )}
      </QueryView>
    </>
  );
}

function AlertsTab() {
  const low = useQuery({ queryKey: ['low-stock'], queryFn: () => get<{ items: { id: string; name: string; baseUnit: string; onHand: string; reorderPoint: string; reorderQty: string }[] }>('/inventory/low-stock') });
  const exp = useQuery({ queryKey: ['expiring'], queryFn: () => get<{ lots: { id: string; name: string; baseUnit: string; lotNo: string | null; expiryDate: string; remainingQty: string }[] }>('/inventory/expiring?days=7') });
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="ใกล้หมด (ต่ำกว่าจุดสั่งซื้อ)">
        <QueryView query={low} isEmpty={(d) => d.items.length === 0} empty={<p className="text-sm text-ink-3">ไม่มีรายการใกล้หมด</p>}>
          {(d) => (
            <ul className="flex flex-col gap-1">
              {d.items.map((i) => (
                <li key={i.id} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1">
                    <AlertTriangle className="size-4 text-turmeric" />
                    {i.name}
                  </span>
                  <span className="num text-sm">
                    {fmtQty(i.onHand, i.baseUnit)} / จุดสั่ง {fmtQty(i.reorderPoint)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Panel>
      <Panel title="ล็อตที่จะหมดอายุภายใน 7 วัน">
        <QueryView query={exp} isEmpty={(d) => d.lots.length === 0} empty={<p className="text-sm text-ink-3">ไม่มี</p>}>
          {(d) => (
            <ul className="flex flex-col gap-1">
              {d.lots.map((l) => (
                <li key={l.id} className="flex justify-between gap-2">
                  <span>
                    {l.name} {l.lotNo && <span className="text-xs text-ink-3">ล็อต {l.lotNo}</span>}
                  </span>
                  <span className="text-sm">
                    {fmtQty(l.remainingQty, l.baseUnit)} · หมดอายุ {fmtDate(l.expiryDate)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </Panel>
    </div>
  );
}

type Tab = 'ingredients' | 'ops' | 'recipes' | 'counts' | 'movements' | 'alerts' | 'transfers';

export function InventoryPage() {
  const { can } = useAuth();
  const [tab, setTab] = useTabParam<Tab>('ingredients');
  const items: { value: Tab; label: string }[] = [
    { value: 'ingredients', label: 'วัตถุดิบ' },
    { value: 'ops', label: 'รับ/เบิก/ของเสีย' },
    ...(can('inventory.view') ? [{ value: 'recipes' as Tab, label: 'สูตรอาหาร' }] : []),
    ...(can('stock.count') ? [{ value: 'counts' as Tab, label: 'นับสต็อก' }] : []),
    { value: 'movements', label: 'ความเคลื่อนไหว' },
    ...(can('stock.issue') || can('stock.receive') ? [{ value: 'transfers' as Tab, label: 'โอนระหว่างสาขา' }] : []),
    { value: 'alerts', label: 'แจ้งเตือน' },
  ];
  return (
    <>
      <PageHeader title="สต็อกวัตถุดิบ" crumbs={[{ label: 'หลังร้าน' }]} description="ยอดคงเหลือคำนวณจากประวัติรับเข้า-เบิกออกทุกรายการ ต้นทุนเป็นค่าเฉลี่ย และตัดสต็อกอัตโนมัติเมื่อส่งรายการเข้าครัว" />
      <Tabs value={tab} onChange={setTab} items={items} />
      {tab === 'ingredients' && <IngredientsTab />}
      {tab === 'ops' && <StockOpsTab />}
      {tab === 'recipes' && <RecipesTab />}
      {tab === 'counts' && <CountsTab />}
      {tab === 'movements' && <MovementsTab />}
      {tab === 'alerts' && <AlertsTab />}
      {tab === 'transfers' && <TransfersTab />}
    </>
  );
}
