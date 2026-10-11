import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { toSatang } from '@shared/money';
import { Badge, Button, Checkbox, DataTable, Dialog, EmptyState, Input, MoneyInput, PageHeader, Panel, QueryView, Select, Tabs, Textarea, useToast } from '../../components/ui';
import { errorMessage, get, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDate, fmtDateTime, formatBaht, todayISO } from '../../lib/format';
import { fmtQty, useIngredients, type Ingredient } from '../inventory/InventoryPage';

interface Supplier {
  id: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  lineId: string | null;
  address: string | null;
  taxId: string | null;
  paymentTermsDays: number;
  note: string | null;
  archivedAt: string | null;
  items: { ingredientId: string; unit: string; priceSatang: number; supplierSku: string | null; leadTimeDays: number; isPreferred: boolean }[];
}
interface PoSummary {
  id: string;
  poNo: string;
  supplier: string;
  supplierId: string;
  status: string;
  totalSatang: number;
  expectedDate: string | null;
  createdAt: string;
  createdByName: string | null;
}
interface PoDetail extends Omit<PoSummary, 'supplier'> {
  supplier: Supplier;
  note: string | null;
  rejectedReason: string | null;
  lines: { id: string; ingredientId: string; name: string; baseUnit: string; qty: string; unit: string; qtyBase: string; receivedQtyBase: string; unitPriceSatang: number; lineTotalSatang: number }[];
  receipts: { id: string; grNo: string; postedAt: string; totalSatang: number; invoiceNo: string | null }[];
}

const STATUS_LABEL: Record<string, string> = {
  DRAFT: 'ร่าง',
  SUBMITTED: 'ขอซื้อ (รออนุมัติ)',
  APPROVED: 'อนุมัติแล้ว',
  ORDERED: 'สั่งแล้ว',
  PARTIAL: 'รับบางส่วน',
  RECEIVED: 'รับครบ',
  CANCELLED: 'ยกเลิก',
  REJECTED: 'ไม่อนุมัติ',
};

function useSuppliers() {
  return useQuery({ queryKey: ['suppliers'], queryFn: () => get<{ suppliers: Supplier[] }>('/purchasing/suppliers') });
}

function useP<T>(fn: (v: T) => Promise<unknown>, msg: string, after?: (r: any) => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (r) => {
      toast.success(msg);
      for (const k of ['suppliers', 'pos', 'po', 'receipts', 'payables', 'suggestions', 'ingredients', 'movements']) qc.invalidateQueries({ queryKey: [k] });
      after?.(r);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

function unitsOf(ing?: Ingredient) {
  return ing ? [ing.baseUnit, ...ing.units.map((u) => u.unit)] : [];
}

function SupplierDialog({ s, ingredients, onClose }: { s: Supplier | 'new'; ingredients: Ingredient[]; onClose: () => void }) {
  const x = s === 'new' ? null : s;
  const [f, setF] = useState({
    name: x?.name ?? '',
    contactName: x?.contactName ?? '',
    phone: x?.phone ?? '',
    email: x?.email ?? '',
    lineId: x?.lineId ?? '',
    address: x?.address ?? '',
    taxId: x?.taxId ?? '',
    paymentTermsDays: x?.paymentTermsDays ?? 0,
    note: x?.note ?? '',
  });
  const [items, setItems] = useState((x?.items ?? []).map((i) => ({ ...i, price: (i.priceSatang / 100).toFixed(2) })));
  const save = useP(
    () => {
      const body = { ...f, items: items.filter((i) => i.ingredientId && i.unit).map((i) => ({ ingredientId: i.ingredientId, unit: i.unit, priceSatang: toSatang(i.price || '0'), supplierSku: i.supplierSku || null, leadTimeDays: i.leadTimeDays, isPreferred: i.isPreferred })) };
      return x ? put(`/purchasing/suppliers/${x.id}`, body) : post('/purchasing/suppliers', body);
    },
    'บันทึกซัพพลายเออร์แล้ว',
    onClose,
  );
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={x ? x.name : 'เพิ่มซัพพลายเออร์'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} disabled={!f.name} onClick={() => save.mutate(undefined)}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="ชื่อ" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="ผู้ติดต่อ" value={f.contactName} onChange={(e) => setF({ ...f, contactName: e.target.value })} />
        <Input label="โทร" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <Input label="อีเมล" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        <Input label="LINE" value={f.lineId} onChange={(e) => setF({ ...f, lineId: e.target.value })} />
        <Input label="เครดิต (วัน)" type="number" min={0} value={f.paymentTermsDays} onChange={(e) => setF({ ...f, paymentTermsDays: Number(e.target.value) })} />
        <Input label="เลขผู้เสียภาษี" value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value })} />
        <Textarea label="ที่อยู่" wrapClassName="sm:col-span-2" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
      </div>
      <h3 className="mt-5 mb-2 font-semibold">สินค้าที่ซื้อจากเจ้านี้</h3>
      <div className="flex flex-col gap-2">
        {items.map((it, idx) => (
          <div key={idx} className="flex flex-wrap items-end gap-2">
            <Select aria-label="วัตถุดิบ" wrapClassName="min-w-44 flex-1" value={it.ingredientId} onChange={(e) => setItems(items.map((y, j) => (j === idx ? { ...y, ingredientId: e.target.value, unit: byId.get(e.target.value)?.units.find((u) => u.isPurchase)?.unit ?? byId.get(e.target.value)?.baseUnit ?? '' } : y)))}>
              <option value="">เลือก</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
            <Select aria-label="หน่วย" wrapClassName="w-24" value={it.unit} onChange={(e) => setItems(items.map((y, j) => (j === idx ? { ...y, unit: e.target.value } : y)))}>
              {unitsOf(byId.get(it.ingredientId)).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </Select>
            <MoneyInput aria-label="ราคา" wrapClassName="w-28" value={it.price} onChange={(e) => setItems(items.map((y, j) => (j === idx ? { ...y, price: e.target.value } : y)))} />
            <Input aria-label="Lead time (วัน)" type="number" min={0} wrapClassName="w-20" value={it.leadTimeDays} onChange={(e) => setItems(items.map((y, j) => (j === idx ? { ...y, leadTimeDays: Number(e.target.value) } : y)))} />
            <Checkbox className="pb-2" label="เจ้าหลัก" checked={it.isPreferred} onChange={(e) => setItems(items.map((y, j) => (j === idx ? { ...y, isPreferred: e.target.checked } : y)))} />
            <Button variant="ghost" aria-label="ลบ" icon={<Trash2 className="size-4" />} onClick={() => setItems(items.filter((_, j) => j !== idx))} />
          </div>
        ))}
        <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => setItems([...items, { ingredientId: '', unit: '', priceSatang: 0, price: '', supplierSku: null, leadTimeDays: 1, isPreferred: false }])}>
          เพิ่มสินค้า
        </Button>
      </div>
    </Dialog>
  );
}

function PoEditor({ initial, suppliers, ingredients, onClose }: { initial?: PoDetail | { supplierId: string; lines: { ingredientId: string; qty: string; unit: string; unitPriceSatang: number }[] }; suppliers: Supplier[]; ingredients: Ingredient[]; onClose: () => void }) {
  const isEdit = !!initial && 'id' in initial;
  const [supplierId, setSupplierId] = useState(initial?.supplierId ?? suppliers[0]?.id ?? '');
  const [expectedDate, setExpectedDate] = useState(isEdit ? ((initial as PoDetail).expectedDate ?? '') : '');
  const [note, setNote] = useState(isEdit ? ((initial as PoDetail).note ?? '') : '');
  const [lines, setLines] = useState(
    (initial?.lines ?? []).map((l) => ({ ingredientId: l.ingredientId, qty: String(Number(l.qty)), unit: l.unit, price: (l.unitPriceSatang / 100).toFixed(2) })),
  );
  const byId = new Map(ingredients.map((i) => [i.id, i]));
  const sup = suppliers.find((s) => s.id === supplierId);
  const total = lines.reduce((n, l) => {
    try {
      return n + Math.round(Number(l.qty || 0) * toSatang(l.price || '0'));
    } catch {
      return n;
    }
  }, 0);
  const save = useP(
    () => {
      const body = { supplierId, expectedDate: expectedDate || null, note: note || null, lines: lines.filter((l) => l.ingredientId && l.qty).map((l) => ({ ingredientId: l.ingredientId, qty: l.qty, unit: l.unit, unitPriceSatang: toSatang(l.price || '0') })) };
      return isEdit ? put(`/purchasing/orders/${(initial as PoDetail).id}`, body) : post('/purchasing/orders', body);
    },
    'บันทึกใบสั่งซื้อแล้ว',
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={isEdit ? `แก้ไข ${(initial as PoDetail).poNo}` : 'สร้างใบขอซื้อ/ใบสั่งซื้อ'}
      footer={
        <>
          <span className="num mr-auto self-center font-semibold">รวม {formatBaht(total)}</span>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} disabled={!supplierId || lines.length === 0} onClick={() => save.mutate(undefined)}>
            บันทึกร่าง
          </Button>
        </>
      }
    >
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <Select label="ซัพพลายเออร์" value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
          {suppliers
            .filter((s) => !s.archivedAt)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </Select>
        <Input label="วันที่ต้องการ" type="date" value={expectedDate} onChange={(e) => setExpectedDate(e.target.value)} />
        <Input label="หมายเหตุ" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="flex flex-col gap-2">
        {lines.map((l, idx) => (
          <div key={idx} className="flex flex-wrap items-end gap-2">
            <Select
              aria-label="วัตถุดิบ"
              wrapClassName="min-w-48 flex-1"
              value={l.ingredientId}
              onChange={(e) => {
                const offer = sup?.items.find((i) => i.ingredientId === e.target.value);
                const ing = byId.get(e.target.value);
                setLines(lines.map((y, j) => (j === idx ? { ...y, ingredientId: e.target.value, unit: offer?.unit ?? ing?.units.find((u) => u.isPurchase)?.unit ?? ing?.baseUnit ?? '', price: offer ? (offer.priceSatang / 100).toFixed(2) : y.price } : y)));
              }}
            >
              <option value="">เลือกวัตถุดิบ</option>
              {ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
            <Input aria-label="จำนวน" inputMode="decimal" wrapClassName="w-24" value={l.qty} onChange={(e) => setLines(lines.map((y, j) => (j === idx ? { ...y, qty: e.target.value } : y)))} />
            <Select aria-label="หน่วย" wrapClassName="w-24" value={l.unit} onChange={(e) => setLines(lines.map((y, j) => (j === idx ? { ...y, unit: e.target.value } : y)))}>
              {unitsOf(byId.get(l.ingredientId)).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </Select>
            <MoneyInput aria-label="ราคาต่อหน่วย" wrapClassName="w-28" value={l.price} onChange={(e) => setLines(lines.map((y, j) => (j === idx ? { ...y, price: e.target.value } : y)))} />
            <Button variant="ghost" aria-label="ลบ" icon={<Trash2 className="size-4" />} onClick={() => setLines(lines.filter((_, j) => j !== idx))} />
          </div>
        ))}
        <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => setLines([...lines, { ingredientId: '', qty: '', unit: '', price: '' }])}>
          เพิ่มรายการ
        </Button>
      </div>
    </Dialog>
  );
}

function ReceiveDialog({ po, onClose }: { po: PoDetail; onClose: () => void }) {
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState(todayISO());
  const [rows, setRows] = useState(
    po.lines.map((l) => {
      const outstandingBase = Number(l.qtyBase) - Number(l.receivedQtyBase);
      const factor = Number(l.qtyBase) / Number(l.qty);
      return { line: l, delivered: String(Math.max(0, +(outstandingBase / factor).toFixed(4))), rejected: '0', reason: '', price: (l.unitPriceSatang / 100).toFixed(2), lotNo: '', expiryDate: '' };
    }),
  );
  const [id] = useState(() => crypto.randomUUID());
  const save = useP(
    () =>
      post('/purchasing/receipts', {
        id,
        poId: po.id,
        supplierId: po.supplierId,
        invoiceNo: invoiceNo || undefined,
        invoiceDate,
        lines: rows
          .filter((r) => Number(r.delivered) > 0)
          .map((r) => ({ poLineId: r.line.id, ingredientId: r.line.ingredientId, unit: r.line.unit, deliveredQty: r.delivered, rejectedQty: r.rejected || '0', rejectReason: r.reason || undefined, unitPriceSatang: toSatang(r.price || '0'), lotNo: r.lotNo || undefined, expiryDate: r.expiryDate || undefined })),
      }),
    'รับของเข้าสต็อกแล้ว',
    onClose,
  );
  return (
    <Dialog
      open
      onClose={onClose}
      size="xl"
      title={`รับของตาม ${po.poNo}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>
            ยืนยันรับของ
          </Button>
        </>
      }
    >
      <div className="mb-3 flex flex-wrap gap-3">
        <Input label="เลขที่ใบแจ้งหนี้/ใบส่งของ" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} />
        <Input label="วันที่ใบแจ้งหนี้" type="date" value={invoiceDate} onChange={(e) => setInvoiceDate(e.target.value)} />
      </div>
      <div className="flex flex-col gap-3">
        {rows.map((r, idx) => (
          <div key={r.line.id} className="rounded-control border border-line p-3">
            <p className="mb-2 font-medium">
              {r.line.name} — สั่ง {fmtQty(r.line.qty, r.line.unit)} · รับแล้ว {fmtQty(r.line.receivedQtyBase, r.line.baseUnit)}
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <Input label={`ส่งมา (${r.line.unit})`} inputMode="decimal" wrapClassName="w-28" value={r.delivered} onChange={(e) => setRows(rows.map((y, j) => (j === idx ? { ...y, delivered: e.target.value } : y)))} />
              <Input label="ปฏิเสธ/เสีย" inputMode="decimal" wrapClassName="w-28" value={r.rejected} onChange={(e) => setRows(rows.map((y, j) => (j === idx ? { ...y, rejected: e.target.value } : y)))} />
              <Input label="เหตุผลที่ปฏิเสธ" wrapClassName="min-w-40 flex-1" value={r.reason} onChange={(e) => setRows(rows.map((y, j) => (j === idx ? { ...y, reason: e.target.value } : y)))} />
              <MoneyInput label="ราคาตามบิล/หน่วย" wrapClassName="w-32" value={r.price} onChange={(e) => setRows(rows.map((y, j) => (j === idx ? { ...y, price: e.target.value } : y)))} />
              <Input label="ล็อต" wrapClassName="w-24" value={r.lotNo} onChange={(e) => setRows(rows.map((y, j) => (j === idx ? { ...y, lotNo: e.target.value } : y)))} />
              <Input label="หมดอายุ" type="date" wrapClassName="w-40" value={r.expiryDate} onChange={(e) => setRows(rows.map((y, j) => (j === idx ? { ...y, expiryDate: e.target.value } : y)))} />
            </div>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function PoDetailDialog({ id, suppliers, ingredients, onClose }: { id: string; suppliers: Supplier[]; ingredients: Ingredient[]; onClose: () => void }) {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['po', id], queryFn: () => get<PoDetail>(`/purchasing/orders/${id}`) });
  const [edit, setEdit] = useState(false);
  const [receive, setReceive] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const act = useP((a: string) => post(`/purchasing/orders/${id}/${a}`, a === 'reject' ? { reason: rejectReason } : {}), 'อัปเดตสถานะแล้ว');
  if (!q.data) return null;
  const po = q.data;
  return (
    <Dialog open onClose={onClose} size="xl" title={`${po.poNo} · ${po.supplier.name}`}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Badge tone={po.status === 'RECEIVED' ? 'success' : po.status === 'CANCELLED' || po.status === 'REJECTED' ? 'danger' : 'info'}>{STATUS_LABEL[po.status]}</Badge>
        {po.expectedDate && <span className="text-sm text-ink-2">ต้องการ {fmtDate(po.expectedDate)}</span>}
        {po.rejectedReason && <span className="text-sm text-chili">ไม่อนุมัติ: {po.rejectedReason}</span>}
      </div>
      <DataTable
        rows={po.lines}
        rowKey={(r) => r.id}
        columns={[
          { key: 'n', header: 'วัตถุดิบ', cell: (r) => r.name },
          { key: 'q', header: 'สั่ง', align: 'right', cell: (r) => fmtQty(r.qty, r.unit) },
          { key: 'p', header: 'ราคา/หน่วย', align: 'right', cell: (r) => formatBaht(r.unitPriceSatang) },
          { key: 't', header: 'รวม', align: 'right', cell: (r) => formatBaht(r.lineTotalSatang) },
          { key: 'r', header: 'รับแล้ว', align: 'right', cell: (r) => fmtQty(r.receivedQtyBase, r.baseUnit) },
        ]}
      />
      <p className="num mt-2 text-right font-semibold">รวม {formatBaht(po.totalSatang)}</p>
      {po.receipts.length > 0 && (
        <p className="mt-2 text-sm text-ink-2">
          ใบรับของ: {po.receipts.map((r) => `${r.grNo} (${formatBaht(r.totalSatang)})`).join(', ')}
        </p>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        {['DRAFT', 'SUBMITTED', 'REJECTED'].includes(po.status) && can('purchase.create') && (
          <Button variant="outline" onClick={() => setEdit(true)}>
            แก้ไข
          </Button>
        )}
        {['DRAFT', 'REJECTED'].includes(po.status) && can('purchase.create') && <Button onClick={() => act.mutate('submit')}>ส่งขออนุมัติ</Button>}
        {['SUBMITTED', 'DRAFT'].includes(po.status) && can('purchase.approve') && <Button onClick={() => act.mutate('approve')}>อนุมัติ</Button>}
        {po.status === 'SUBMITTED' && can('purchase.approve') && (
          <span className="flex items-end gap-2">
            <Input aria-label="เหตุผลไม่อนุมัติ" placeholder="เหตุผลไม่อนุมัติ" value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} />
            <Button variant="danger" disabled={!rejectReason} onClick={() => act.mutate('reject')}>
              ไม่อนุมัติ
            </Button>
          </span>
        )}
        {po.status === 'APPROVED' && can('purchase.create') && (
          <Button variant="outline" onClick={() => act.mutate('order')}>
            ส่งให้ซัพพลายเออร์แล้ว
          </Button>
        )}
        {['APPROVED', 'ORDERED', 'PARTIAL'].includes(po.status) && can('stock.receive') && <Button onClick={() => setReceive(true)}>รับของ</Button>}
        {['DRAFT', 'SUBMITTED', 'APPROVED', 'ORDERED', 'REJECTED'].includes(po.status) && can('purchase.create') && (
          <Button variant="ghost" className="text-chili" onClick={() => act.mutate('cancel')}>
            ยกเลิกใบสั่งซื้อ
          </Button>
        )}
      </div>
      {edit && <PoEditor initial={po} suppliers={suppliers} ingredients={ingredients} onClose={() => setEdit(false)} />}
      {receive && <ReceiveDialog po={po} onClose={() => setReceive(false)} />}
    </Dialog>
  );
}

function OrdersTab() {
  const { can } = useAuth();
  const sups = useSuppliers();
  const ings = useIngredients();
  const [status, setStatus] = useState('');
  const pos = useQuery({ queryKey: ['pos', status], queryFn: () => get<{ orders: PoSummary[] }>(`/purchasing/orders${status ? `?status=${status}` : ''}`) });
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="mb-3 flex flex-wrap items-end gap-2">
        <Select label="สถานะ" value={status} onChange={(e) => setStatus(e.target.value)} wrapClassName="w-52">
          <option value="">ทั้งหมด</option>
          <option value="SUBMITTED">รออนุมัติ</option>
          <option value="APPROVED,ORDERED,PARTIAL">รอรับของ</option>
          <option value="RECEIVED">รับครบ</option>
        </Select>
        {can('purchase.create') && (
          <Button className="ml-auto" icon={<Plus className="size-4" />} disabled={!sups.data?.suppliers.length} onClick={() => setCreating(true)}>
            สร้างใบขอซื้อ
          </Button>
        )}
      </div>
      <QueryView query={pos} isEmpty={(d) => d.orders.length === 0} empty={<EmptyState title="ยังไม่มีใบสั่งซื้อ">{sups.data?.suppliers.length ? '' : 'เพิ่มซัพพลายเออร์ก่อน'}</EmptyState>}>
        {(d) => (
          <DataTable
            rows={d.orders}
            rowKey={(r) => r.id}
            onRowClick={(r) => setOpen(r.id)}
            columns={[
              { key: 'no', header: 'เลขที่', cell: (r) => <span className="num font-medium">{r.poNo}</span> },
              { key: 's', header: 'ซัพพลายเออร์', cell: (r) => r.supplier },
              { key: 'st', header: 'สถานะ', cell: (r) => <Badge tone={r.status === 'RECEIVED' ? 'success' : r.status === 'SUBMITTED' ? 'warning' : 'info'}>{STATUS_LABEL[r.status]}</Badge> },
              { key: 'd', header: 'สร้าง', cell: (r) => fmtDateTime(r.createdAt) },
              { key: 'by', header: 'โดย', cell: (r) => r.createdByName },
              { key: 't', header: 'ยอด', align: 'right', cell: (r) => formatBaht(r.totalSatang) },
            ]}
          />
        )}
      </QueryView>
      {creating && sups.data && ings.data && <PoEditor suppliers={sups.data.suppliers} ingredients={ings.data.ingredients} onClose={() => setCreating(false)} />}
      {open && sups.data && ings.data && <PoDetailDialog id={open} suppliers={sups.data.suppliers} ingredients={ings.data.ingredients} onClose={() => setOpen(null)} />}
    </>
  );
}

function SuppliersTab() {
  const { can } = useAuth();
  const sups = useSuppliers();
  const ings = useIngredients();
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  return (
    <>
      {can('supplier.manage') && (
        <div className="mb-3 flex justify-end">
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            เพิ่มซัพพลายเออร์
          </Button>
        </div>
      )}
      <QueryView query={sups} isEmpty={(d) => d.suppliers.length === 0} empty={<EmptyState title="ยังไม่มีซัพพลายเออร์" />}>
        {(d) => (
          <DataTable
            rows={d.suppliers}
            rowKey={(r) => r.id}
            onRowClick={can('supplier.manage') ? setEditing : undefined}
            columns={[
              { key: 'n', header: 'ชื่อ', cell: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'c', header: 'ติดต่อ', cell: (r) => [r.contactName, r.phone].filter(Boolean).join(' · ') || '—' },
              { key: 't', header: 'เครดิต', cell: (r) => (r.paymentTermsDays ? `${r.paymentTermsDays} วัน` : 'เงินสด') },
              { key: 'i', header: 'สินค้า', align: 'right', cell: (r) => r.items.length },
            ]}
          />
        )}
      </QueryView>
      {editing && ings.data && <SupplierDialog s={editing} ingredients={ings.data.ingredients} onClose={() => setEditing(null)} />}
    </>
  );
}

function SuggestionsTab() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['suggestions'], queryFn: () => get<{ items: any[] }>('/purchasing/suggestions') });
  const sups = useSuppliers();
  const ings = useIngredients();
  const [draft, setDraft] = useState<{ supplierId: string; lines: { ingredientId: string; qty: string; unit: string; unitPriceSatang: number }[] } | null>(null);
  return (
    <>
      <p className="mb-3 text-sm text-ink-2">คำนวณจากยอดใช้เฉลี่ย 14 วันล่าสุด (ขาย เบิก ของเสีย) + lead time ของเจ้าหลัก หรือจากจุดสั่งซื้อเมื่อยังไม่มีข้อมูลการใช้</p>
      <QueryView query={q} isEmpty={(d) => d.items.length === 0} empty={<EmptyState title="ยังไม่มีรายการที่ต้องสั่งซื้อ" />}>
        {(d) => {
          const bySupplier = new Map<string, any[]>();
          for (const i of d.items.filter((x) => x.suggestion)) bySupplier.set(i.suggestion.supplierId, [...(bySupplier.get(i.suggestion.supplierId) ?? []), i]);
          return (
            <>
              <DataTable
                rows={d.items}
                rowKey={(r) => r.ingredientId}
                columns={[
                  { key: 'n', header: 'วัตถุดิบ', cell: (r) => r.name },
                  { key: 'o', header: 'คงเหลือ', align: 'right', cell: (r) => fmtQty(r.onHand, r.baseUnit) },
                  { key: 'u', header: 'ใช้/วัน', align: 'right', cell: (r) => fmtQty(r.avgDailyUsage, r.baseUnit) },
                  { key: 'c', header: 'พอใช้ (วัน)', align: 'right', cell: (r) => r.daysOfCover ?? '—' },
                  { key: 's', header: 'แนะนำ', cell: (r) => (r.suggestion ? `${r.suggestion.qty} ${r.suggestion.unit} จาก ${r.suggestion.supplier} (${formatBaht(r.suggestion.totalSatang)})` : <span className="text-ink-3">ยังไม่ผูกซัพพลายเออร์</span>) },
                ]}
              />
              {can('purchase.create') && bySupplier.size > 0 && (
                <div className="mt-3 flex flex-wrap gap-2">
                  {[...bySupplier].map(([sid, list]) => (
                    <Button key={sid} variant="outline" onClick={() => setDraft({ supplierId: sid, lines: list.map((i) => ({ ingredientId: i.ingredientId, qty: String(i.suggestion.qty), unit: i.suggestion.unit, unitPriceSatang: i.suggestion.unitPriceSatang })) })}>
                      สร้างใบขอซื้อ: {list[0].suggestion.supplier} ({list.length} รายการ)
                    </Button>
                  ))}
                </div>
              )}
            </>
          );
        }}
      </QueryView>
      {draft && sups.data && ings.data && <PoEditor initial={draft} suppliers={sups.data.suppliers} ingredients={ings.data.ingredients} onClose={() => setDraft(null)} />}
    </>
  );
}

function PayablesTab() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['payables'], queryFn: () => get<{ suppliers: any[]; receipts: any[] }>('/purchasing/payables') });
  const [pay, setPay] = useState<any | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('TRANSFER');
  const [reference, setReference] = useState('');
  const save = useP(
    () => post('/purchasing/payments', { id: crypto.randomUUID(), supplierId: pay.supplierId, grId: pay.id, amountSatang: toSatang(amount || '0'), method, reference: reference || undefined, paidAt: todayISO() }),
    'บันทึกการจ่ายเงินแล้ว',
    () => setPay(null),
  );
  return (
    <QueryView query={q} isEmpty={(d) => d.suppliers.length === 0} empty={<EmptyState title="ยังไม่มียอดเจ้าหนี้" />}>
      {(d) => (
        <div className="flex flex-col gap-4">
          <DataTable
            rows={d.suppliers}
            rowKey={(r) => r.supplierId}
            columns={[
              { key: 'n', header: 'ซัพพลายเออร์', cell: (r) => r.name },
              { key: 'b', header: 'ยอดรับของ', align: 'right', cell: (r) => formatBaht(r.billedSatang) },
              { key: 'c', header: 'คืนของ (เครดิต)', align: 'right', cell: (r) => formatBaht(r.creditSatang) },
              { key: 'p', header: 'จ่ายแล้ว', align: 'right', cell: (r) => formatBaht(r.paidSatang) },
              { key: 'o', header: 'ค้างจ่าย', align: 'right', cell: (r) => <span className={r.outstandingSatang > 0 ? 'font-semibold' : ''}>{formatBaht(r.outstandingSatang)}</span> },
            ]}
          />
          <Panel title="ใบรับของรอจ่าย">
            <DataTable
              rows={d.receipts.filter((r) => r.paidSatang < r.totalSatang)}
              rowKey={(r) => r.id}
              columns={[
                { key: 'g', header: 'ใบรับของ', cell: (r) => r.grNo },
                { key: 'i', header: 'ใบแจ้งหนี้', cell: (r) => r.invoiceNo ?? '—' },
                { key: 'd', header: 'ครบกำหนด', cell: (r) => <span className={r.dueDate && r.dueDate < todayISO() ? 'text-chili' : ''}>{fmtDate(r.dueDate)}</span> },
                { key: 't', header: 'ยอด', align: 'right', cell: (r) => formatBaht(r.totalSatang) },
                { key: 'p', header: 'จ่ายแล้ว', align: 'right', cell: (r) => formatBaht(r.paidSatang) },
                {
                  key: 'a',
                  header: '',
                  align: 'right',
                  cell: (r) =>
                    can('purchase.approve') && (
                      <Button size="sm" variant="outline" onClick={() => (setPay(r), setAmount(((r.totalSatang - r.paidSatang) / 100).toFixed(2)))}>
                        บันทึกจ่าย
                      </Button>
                    ),
                },
              ]}
            />
          </Panel>
          {pay && (
            <Dialog
              open
              onClose={() => setPay(null)}
              title={`จ่ายเงิน ${pay.grNo}`}
              size="sm"
              footer={
                <Button loading={save.isPending} onClick={() => save.mutate(undefined)}>
                  บันทึก
                </Button>
              }
            >
              <div className="grid gap-3">
                <MoneyInput label="จำนวน" value={amount} onChange={(e) => setAmount(e.target.value)} />
                <Select label="วิธีจ่าย" value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="TRANSFER">โอน</option>
                  <option value="CASH">เงินสด</option>
                  <option value="CHEQUE">เช็ค</option>
                </Select>
                <Input label="อ้างอิง" value={reference} onChange={(e) => setReference(e.target.value)} />
              </div>
            </Dialog>
          )}
        </div>
      )}
    </QueryView>
  );
}

function ReturnsTab() {
  const sups = useSuppliers();
  const ings = useIngredients();
  const grs = useQuery({ queryKey: ['receipts'], queryFn: () => get<{ receipts: { id: string; grNo: string; supplierId: string; supplier: string; totalSatang: number; postedAt: string }[] }>('/purchasing/receipts') });
  const [supplierId, setSupplierId] = useState('');
  const [grId, setGrId] = useState('');
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<{ ingredientId: string; qty: string; unit: string }[]>([{ ingredientId: '', qty: '', unit: '' }]);
  const save = useP(
    () => post('/purchasing/returns', { id: crypto.randomUUID(), supplierId, grId: grId || undefined, reason, lines: lines.filter((l) => l.ingredientId && l.qty) }),
    'บันทึกการคืนของแล้ว',
    () => (setLines([{ ingredientId: '', qty: '', unit: '' }]), setReason('')),
  );
  const byId = new Map((ings.data?.ingredients ?? []).map((i) => [i.id, i]));
  return (
    <Panel title="คืนของให้ซัพพลายเออร์">
      <div className="mb-3 grid gap-3 sm:grid-cols-2">
        <Select label="ซัพพลายเออร์" value={supplierId} onChange={(e) => (setSupplierId(e.target.value), setGrId(''))}>
          <option value="">เลือก</option>
          {sups.data?.suppliers.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </Select>
        <Select label="อ้างอิงใบรับของ (ไม่บังคับ)" value={grId} onChange={(e) => setGrId(e.target.value)}>
          <option value="">ไม่อ้างอิง</option>
          {grs.data?.receipts
            .filter((g) => g.supplierId === supplierId)
            .map((g) => (
              <option key={g.id} value={g.id}>
                {g.grNo} · {fmtDate(g.postedAt)} · {formatBaht(g.totalSatang)}
              </option>
            ))}
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        {lines.map((l, idx) => (
          <div key={idx} className="flex flex-wrap items-end gap-2">
            <Select aria-label="วัตถุดิบ" wrapClassName="min-w-48 flex-1" value={l.ingredientId} onChange={(e) => setLines(lines.map((y, j) => (j === idx ? { ...y, ingredientId: e.target.value, unit: byId.get(e.target.value)?.baseUnit ?? '' } : y)))}>
              <option value="">เลือก</option>
              {ings.data?.ingredients.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                </option>
              ))}
            </Select>
            <Input aria-label="จำนวน" inputMode="decimal" wrapClassName="w-24" value={l.qty} onChange={(e) => setLines(lines.map((y, j) => (j === idx ? { ...y, qty: e.target.value } : y)))} />
            <Select aria-label="หน่วย" wrapClassName="w-24" value={l.unit} onChange={(e) => setLines(lines.map((y, j) => (j === idx ? { ...y, unit: e.target.value } : y)))}>
              {unitsOf(byId.get(l.ingredientId)).map((u) => (
                <option key={u}>{u}</option>
              ))}
            </Select>
          </div>
        ))}
        <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => setLines([...lines, { ingredientId: '', qty: '', unit: '' }])}>
          เพิ่มรายการ
        </Button>
      </div>
      <Textarea label="เหตุผล" required value={reason} onChange={(e) => setReason(e.target.value)} wrapClassName="mt-3" />
      <Button className="mt-3" loading={save.isPending} disabled={!supplierId || reason.trim().length < 3} onClick={() => save.mutate(undefined)}>
        บันทึกการคืนของ
      </Button>
    </Panel>
  );
}

type Tab = 'orders' | 'suggestions' | 'suppliers' | 'returns' | 'payables';

export function PurchasingPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('orders');
  return (
    <>
      <PageHeader title="จัดซื้อ" crumbs={[{ label: 'หลังร้าน' }]} description="ใบขอซื้อ → อนุมัติเป็นใบสั่งซื้อ → รับของ (ตัวเดียวที่เพิ่มสต็อกและอัปเดตต้นทุน) → ตั้งหนี้/จ่ายเงิน" />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'orders', label: 'ใบขอซื้อ/สั่งซื้อ' },
          { value: 'suggestions', label: 'แนะนำการสั่งซื้อ' },
          { value: 'suppliers', label: 'ซัพพลายเออร์' },
          ...(can('stock.receive') ? [{ value: 'returns' as Tab, label: 'คืนของ' }] : []),
          ...(can('purchase.view') ? [{ value: 'payables' as Tab, label: 'เจ้าหนี้' }] : []),
        ]}
      />
      {tab === 'orders' && <OrdersTab />}
      {tab === 'suggestions' && <SuggestionsTab />}
      {tab === 'suppliers' && <SuppliersTab />}
      {tab === 'returns' && <ReturnsTab />}
      {tab === 'payables' && <PayablesTab />}
    </>
  );
}
