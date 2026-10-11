import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, Archive, ArchiveRestore, Ban, Download, ImageOff, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ALLERGENS, MENU_TAGS } from '@shared/menu';
import { toSatang } from '@shared/money';
import { Badge, Button, Checkbox, DataTable, Dialog, EmptyState, Input, MoneyInput, PageHeader, Panel, QueryView, Tabs, useToast } from '../../components/ui';
import { errorMessage, get, patch, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatBaht } from '../../lib/format';
import { ItemDialog } from './ItemDialog';
import type { AdminItem, AdminMenu, Category, ModifierGroup, Station } from './types';

type Tab = 'items' | 'categories' | 'modifiers' | 'stations';

/** One-tap import of the WORA Grill sample menu (50 dishes with photos) for trying the system. */
function SampleMenuImport({ compact }: { compact: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const run = useMutation({
    mutationFn: () => post<{ created: number; skipped: number }>('/menu/import-sample'),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['menu-admin'] });
      qc.invalidateQueries({ queryKey: ['menu'] });
      toast.success(r.created ? `เพิ่มเมนูตัวอย่าง ${r.created} รายการแล้ว` : 'มีเมนูตัวอย่างครบแล้ว');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const button = (
    <Button variant="outline" icon={<Download className="size-4" />} loading={run.isPending} onClick={() => run.mutate()}>
      นำเข้าเมนูตัวอย่าง WORA Grill (50 รายการ)
    </Button>
  );
  if (compact) return <div className="mb-3 flex justify-end">{button}</div>;
  return (
    <div className="mb-4 flex flex-col items-start gap-2 rounded-panel border border-dashed border-line-strong bg-surface p-4">
      <p className="text-ink-2">ยังไม่มีเมนู ลองนำเข้าเมนูตัวอย่างพร้อมรูปและตัวเลือกเสริม เพื่อทดลองใช้งานได้ทันที</p>
      {button}
    </div>
  );
}

export function useAdminMenu() {
  return useQuery({ queryKey: ['menu-admin'], queryFn: () => get<AdminMenu>('/menu/admin') });
}
export function useStations() {
  return useQuery({ queryKey: ['stations'], queryFn: () => get<{ stations: Station[] }>('/stations') });
}

function useMenuMutation<T>(fn: (v: T) => Promise<unknown>, success?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      if (success) toast.success(success);
      qc.invalidateQueries({ queryKey: ['menu-admin'] });
      qc.invalidateQueries({ queryKey: ['stations'] });
      qc.invalidateQueries({ queryKey: ['menu'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

function ItemsTab({ menu, stations }: { menu: AdminMenu; stations: Station[] }) {
  const { can } = useAuth();
  const [cat, setCat] = useState<string>('all');
  const [q, setQ] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<AdminItem | 'new' | null>(null);
  const soldOut = useMenuMutation((v: { id: string; soldOut: boolean }) => post(`/menu/items/${v.id}/sold-out`, { soldOut: v.soldOut }));
  const archive = useMenuMutation((v: { id: string; archived: boolean }) => post(`/menu/items/${v.id}/archive`, { archived: v.archived }), 'บันทึกแล้ว');
  const branchToggle = useMenuMutation((v: { id: string; isEnabled: boolean }) => put(`/menu/items/${v.id}/branch`, { isEnabled: v.isEnabled }));
  const reorder = useMenuMutation((ids: string[]) => put('/menu/items/order', { ids }));
  const catName = useMemo(() => new Map(menu.categories.map((c) => [c.id, c.name])), [menu]);
  const rows = menu.items.filter(
    (i) =>
      (showArchived || !i.archivedAt) &&
      (cat === 'all' || i.categoryId === cat) &&
      (!q || i.name.includes(q) || i.nameEn?.toLowerCase().includes(q.toLowerCase()) || i.sku?.toLowerCase() === q.toLowerCase()),
  );
  const move = (i: number, dir: -1 | 1) => {
    const list = rows.filter((r) => r.categoryId === cat);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    const ids = list.map((r) => r.id);
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };
  return (
    <div className="flex flex-col gap-4 md:flex-row">
      <nav aria-label="หมวดหมู่" className="flex shrink-0 gap-1 overflow-x-auto md:w-48 md:flex-col">
        {[{ id: 'all', name: 'ทั้งหมด' }, ...menu.categories.filter((c) => !c.archivedAt)].map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => setCat(c.id)}
            className={clsx('min-h-10 rounded-control px-3 py-1.5 text-left text-sm whitespace-nowrap pointer-coarse:min-h-11', cat === c.id ? 'bg-brand-50 font-medium text-brand' : 'text-ink-2 hover:bg-sunken')}
          >
            {c.name}
          </button>
        ))}
      </nav>
      <div className="min-w-0 flex-1">
        {can('menu.manage') && !menu.items.some((i) => i.sku === 'S01') && <SampleMenuImport compact={menu.items.length > 0} />}
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <Input placeholder="ค้นหาชื่อหรือ SKU" value={q} onChange={(e) => setQ(e.target.value)} wrapClassName="w-64" aria-label="ค้นหาเมนู" />
          <Checkbox label="แสดงที่ซ่อนแล้ว" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
          {can('menu.manage') && (
            <Button className="ml-auto" icon={<Plus className="size-4" />} onClick={() => setEditing('new')} disabled={menu.categories.filter((c) => !c.archivedAt).length === 0}>
              เพิ่มเมนู
            </Button>
          )}
        </div>
        {menu.categories.length === 0 ? (
          <EmptyState title="ยังไม่มีหมวดหมู่">สร้างหมวดหมู่ก่อน แล้วจึงเพิ่มเมนู</EmptyState>
        ) : rows.length === 0 ? (
          <EmptyState title="ไม่พบเมนู" />
        ) : (
          <DataTable
            rows={rows}
            rowKey={(r) => r.id}
            columns={[
              {
                key: 'img',
                mobile: 'media',
                header: '',
                className: 'w-14',
                cell: (r) => (r.imageUrl ? <img src={r.imageUrl} alt="" className="size-10 rounded object-cover" /> : <div className="flex size-10 items-center justify-center rounded bg-sunken text-ink-3"><ImageOff className="size-4" /></div>),
              },
              {
                key: 'name',
                mobile: 'title',
                header: 'เมนู',
                cell: (r) => (
                  <button type="button" className="text-left" onClick={() => setEditing(r)}>
                    <div className="font-medium hover:underline">{r.name}</div>
                    <div className="text-xs text-ink-3">
                      {catName.get(r.categoryId)}
                      {r.nameEn && ` · ${r.nameEn}`}
                    </div>
                  </button>
                ),
              },
              {
                key: 'tags',
                header: 'แท็ก',
                cell: (r) => (
                  <div className="flex flex-wrap gap-1">
                    {r.isCombo && <Badge tone="info">ชุด</Badge>}
                    {r.tags.map((t) => (
                      <Badge key={t}>{MENU_TAGS[t] ?? t}</Badge>
                    ))}
                    {r.allergens.length > 0 && <Badge tone="warning">แพ้: {r.allergens.map((a) => ALLERGENS[a] ?? a).join(', ')}</Badge>}
                  </div>
                ),
              },
              { key: 'price', header: 'ราคา', align: 'right', cell: (r) => formatBaht(r.priceSatang) },
              {
                key: 'status',
                header: 'สถานะ',
                cell: (r) =>
                  r.archivedAt ? <Badge>เก็บแล้ว</Badge> : !r.branchEnabled ? <Badge>ปิดในสาขานี้</Badge> : r.soldOut ? <Badge tone="danger">หมด</Badge> : <Badge tone="success">ขายอยู่</Badge>,
              },
              {
                key: 'actions',
                header: '',
                align: 'right',
                cell: (r) => {
                  const idx = rows.filter((x) => x.categoryId === cat).findIndex((x) => x.id === r.id);
                  return (
                    <div className="flex justify-end gap-1">
                      {can('menu.manage') && cat !== 'all' && !r.archivedAt && (
                        <>
                          <Button size="sm" variant="ghost" aria-label="เลื่อนขึ้น" icon={<ArrowUp className="size-4" />} disabled={idx === 0} onClick={() => move(idx, -1)} />
                          <Button size="sm" variant="ghost" aria-label="เลื่อนลง" icon={<ArrowDown className="size-4" />} onClick={() => move(idx, 1)} />
                        </>
                      )}
                      {can('menu.sold_out') && !r.archivedAt && (
                        <Button size="sm" variant={r.soldOut ? 'primary' : 'outline'} onClick={() => soldOut.mutate({ id: r.id, soldOut: !r.soldOut })}>
                          {r.soldOut ? 'มีของแล้ว' : 'แจ้งหมด'}
                        </Button>
                      )}
                      {can('menu.manage') && !r.archivedAt && (
                        <Button size="sm" variant="ghost" icon={<Ban className="size-4" />} onClick={() => branchToggle.mutate({ id: r.id, isEnabled: !r.branchEnabled })}>
                          {r.branchEnabled ? 'ปิดขายสาขานี้' : 'เปิดขายสาขานี้'}
                        </Button>
                      )}
                      {can('menu.manage') && (
                        <Button
                          size="sm"
                          variant="ghost"
                          icon={r.archivedAt ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
                          onClick={() => (r.archivedAt || confirm(`ซ่อนเมนู "${r.name}" (เลิกขาย)? นำกลับมาใช้ได้ภายหลัง`)) && archive.mutate({ id: r.id, archived: !r.archivedAt })}
                        >
                          {r.archivedAt ? 'นำกลับมาใช้' : 'ซ่อน'}
                        </Button>
                      )}
                    </div>
                  );
                },
              },
            ]}
          />
        )}
      </div>
      {editing && <ItemDialog item={editing} menu={menu} stations={stations} defaultCategoryId={cat !== 'all' ? cat : undefined} onClose={() => setEditing(null)} />}
    </div>
  );
}

function CategoryDialog({ cat, stations, onClose }: { cat: Category | 'new'; stations: Station[]; onClose: () => void }) {
  const c = cat === 'new' ? null : cat;
  const [f, setF] = useState({ name: c?.name ?? '', nameEn: c?.nameEn ?? '', nameZh: c?.nameZh ?? '', stationCode: c?.stationCode ?? '' });
  const save = useMenuMutation(async () => {
    const body = { ...f, stationCode: f.stationCode || null };
    if (c) await patch(`/menu/categories/${c.id}`, body);
    else await post('/menu/categories', body);
    onClose();
  }, 'บันทึกหมวดหมู่แล้ว');
  return (
    <Dialog
      open
      onClose={onClose}
      title={c ? `แก้ไข ${c.name}` : 'เพิ่มหมวดหมู่'}
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
      <div className="grid gap-3">
        <Input label="ชื่อ (ไทย)" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="ชื่อ (English)" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} />
        <Input label="ชื่อ (中文)" value={f.nameZh} onChange={(e) => setF({ ...f, nameZh: e.target.value })} />
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink-2">ส่งเข้าสเตชันครัว</span>
          <select className="h-10 rounded-control border border-line-strong bg-surface px-3" value={f.stationCode} onChange={(e) => setF({ ...f, stationCode: e.target.value })}>
            <option value="">ไม่ระบุ (ครัวรวม)</option>
            {stations.map((s) => (
              <option key={s.id} value={s.code}>
                {s.name} ({s.code})
              </option>
            ))}
          </select>
        </label>
      </div>
    </Dialog>
  );
}

function CategoriesTab({ menu, stations }: { menu: AdminMenu; stations: Station[] }) {
  const [editing, setEditing] = useState<Category | 'new' | null>(null);
  const reorder = useMenuMutation((ids: string[]) => put('/menu/categories/order', { ids }));
  const archive = useMenuMutation((v: { id: string; archived: boolean }) => patch(`/menu/categories/${v.id}`, { archived: v.archived }), 'บันทึกแล้ว');
  const active = menu.categories.filter((c) => !c.archivedAt);
  const archived = menu.categories.filter((c) => c.archivedAt);
  const move = (i: number, dir: -1 | 1) => {
    const ids = active.map((c) => c.id);
    const j = i + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    reorder.mutate(ids);
  };
  const count = (id: string) => menu.items.filter((i) => i.categoryId === id && !i.archivedAt).length;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          เพิ่มหมวดหมู่
        </Button>
      </div>
      {active.length === 0 ? (
        <EmptyState title="ยังไม่มีหมวดหมู่" />
      ) : (
        <DataTable
          rows={[...active, ...archived]}
          rowKey={(r) => r.id}
          columns={[
            {
              key: 'order',
              header: 'ลำดับ',
              className: 'w-24',
              cell: (r) =>
                r.archivedAt ? null : (
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" aria-label="เลื่อนขึ้น" icon={<ArrowUp className="size-4" />} onClick={() => move(active.indexOf(r), -1)} />
                    <Button size="sm" variant="ghost" aria-label="เลื่อนลง" icon={<ArrowDown className="size-4" />} onClick={() => move(active.indexOf(r), 1)} />
                  </div>
                ),
            },
            {
              key: 'name',
              header: 'หมวดหมู่',
              cell: (r) => (
                <button type="button" className="text-left font-medium hover:underline" onClick={() => setEditing(r)}>
                  {r.name} {r.nameEn && <span className="font-normal text-ink-3">· {r.nameEn}</span>}
                </button>
              ),
            },
            { key: 'station', header: 'สเตชัน', cell: (r) => r.stationCode ?? '—' },
            { key: 'count', header: 'จำนวนเมนู', align: 'right', cell: (r) => count(r.id) },
            { key: 'status', header: '', cell: (r) => (r.archivedAt ? <Badge>เก็บแล้ว</Badge> : null) },
            {
              key: 'act',
              header: '',
              align: 'right',
              cell: (r) => (
                <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: r.id, archived: !r.archivedAt })}>
                  {r.archivedAt ? 'นำกลับมาใช้' : 'ซ่อน (เลิกใช้)'}
                </Button>
              ),
            },
          ]}
        />
      )}
      {editing && <CategoryDialog cat={editing} stations={stations} onClose={() => setEditing(null)} />}
    </>
  );
}

function GroupDialog({ group, onClose }: { group: ModifierGroup | 'new'; onClose: () => void }) {
  const g = group === 'new' ? null : group;
  const toast = useToast();
  const [f, setF] = useState({
    name: g?.name ?? '',
    nameEn: g?.nameEn ?? '',
    nameZh: g?.nameZh ?? '',
    minSelect: g?.minSelect ?? 0,
    maxSelect: g?.maxSelect ?? 1,
    allowRepeat: g?.allowRepeat ?? false,
  });
  const [mods, setMods] = useState(
    (g?.modifiers.filter((m) => !m.archivedAt) ?? []).map((m) => ({ id: m.id as string | undefined, name: m.name, nameEn: m.nameEn ?? '', price: (m.priceDeltaSatang / 100).toFixed(2), isDefault: m.isDefault })),
  );
  const save = useMenuMutation(async () => {
    let list;
    try {
      list = mods.map((m) => ({ id: m.id, name: m.name, nameEn: m.nameEn || null, priceDeltaSatang: m.price.startsWith('-') ? -toSatang(m.price.slice(1)) : toSatang(m.price || '0'), isDefault: m.isDefault }));
    } catch {
      toast.error('ราคาตัวเลือกไม่ถูกต้อง');
      throw new Error('ราคาตัวเลือกไม่ถูกต้อง');
    }
    const body = { ...f, nameEn: f.nameEn || null, nameZh: f.nameZh || null, modifiers: list };
    if (g) await put(`/menu/modifier-groups/${g.id}`, body);
    else await post('/menu/modifier-groups', body);
    onClose();
  }, 'บันทึกกลุ่มตัวเลือกแล้ว');
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={g ? `แก้ไข ${g.name}` : 'เพิ่มกลุ่มตัวเลือก'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} disabled={!f.name || mods.length === 0} onClick={() => save.mutate(undefined)}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="ชื่อกลุ่ม" wrapClassName="sm:col-span-3" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="เช่น ระดับความเผ็ด, ท็อปปิ้ง" />
        <Input label="English" value={f.nameEn} onChange={(e) => setF({ ...f, nameEn: e.target.value })} />
        <Input label="เลือกขั้นต่ำ" type="number" min={0} max={20} value={f.minSelect} onChange={(e) => setF({ ...f, minSelect: Number(e.target.value) })} hint="0 = ไม่บังคับ" />
        <Input label="เลือกสูงสุด" type="number" min={0} max={20} value={f.maxSelect} onChange={(e) => setF({ ...f, maxSelect: Number(e.target.value) })} hint="0 = ไม่จำกัด" />
        <Checkbox className="sm:col-span-3" label="เลือกตัวเลือกเดิมซ้ำได้ (เช่น ไข่ดาว ×2)" checked={f.allowRepeat} onChange={(e) => setF({ ...f, allowRepeat: e.target.checked })} />
      </div>
      <h3 className="mt-4 mb-2 font-semibold">ตัวเลือก</h3>
      <div className="flex flex-col gap-2">
        {mods.map((m, i) => (
          <div key={i} className="flex flex-wrap items-end gap-2">
            <Input aria-label="ชื่อตัวเลือก" placeholder="ชื่อ" wrapClassName="min-w-40 flex-1" value={m.name} onChange={(e) => setMods(mods.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <Input aria-label="English" placeholder="English" wrapClassName="w-36" value={m.nameEn} onChange={(e) => setMods(mods.map((x, j) => (j === i ? { ...x, nameEn: e.target.value } : x)))} />
            <MoneyInput aria-label="ราคาเพิ่ม" wrapClassName="w-28" pattern="^-?\d+(\.\d{0,2})?$" value={m.price} onChange={(e) => setMods(mods.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
            <Checkbox label="ค่าเริ่มต้น" checked={m.isDefault} onChange={(e) => setMods(mods.map((x, j) => (j === i ? { ...x, isDefault: e.target.checked } : x)))} />
            <Button variant="ghost" aria-label="ลบตัวเลือก" icon={<Trash2 className="size-4" />} onClick={() => setMods(mods.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button size="sm" variant="outline" className="self-start" icon={<Plus className="size-4" />} onClick={() => setMods([...mods, { id: undefined, name: '', nameEn: '', price: '0.00', isDefault: false }])}>
          เพิ่มตัวเลือก
        </Button>
        <p className="text-xs text-ink-3">ตัวเลือกที่ลบจะถูกเก็บไว้ในประวัติ บิลเก่าไม่เปลี่ยน</p>
      </div>
    </Dialog>
  );
}

function ModifiersTab({ menu }: { menu: AdminMenu }) {
  const [editing, setEditing] = useState<ModifierGroup | 'new' | null>(null);
  const archive = useMenuMutation((v: { id: string; archived: boolean }) => post(`/menu/modifier-groups/${v.id}/archive`, { archived: v.archived }), 'บันทึกแล้ว');
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
          เพิ่มกลุ่มตัวเลือก
        </Button>
      </div>
      {menu.modifierGroups.length === 0 ? (
        <EmptyState title="ยังไม่มีกลุ่มตัวเลือก">เช่น ระดับความเผ็ด ไซซ์ ท็อปปิ้งเพิ่มเงิน</EmptyState>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {menu.modifierGroups.map((g) => (
            <Panel
              key={g.id}
              title={
                <span>
                  {g.name} {g.archivedAt && <Badge>เก็บแล้ว</Badge>}
                </span>
              }
              actions={
                <div className="flex gap-1">
                  <Button size="sm" variant="ghost" onClick={() => setEditing(g)}>
                    แก้ไข
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => archive.mutate({ id: g.id, archived: !g.archivedAt })}>
                    {g.archivedAt ? 'นำกลับมาใช้' : 'ซ่อน (เลิกใช้)'}
                  </Button>
                </div>
              }
            >
              <p className="mb-2 text-sm text-ink-2">
                {g.minSelect > 0 ? `บังคับเลือก ${g.minSelect}` : 'ไม่บังคับ'} · สูงสุด {g.maxSelect || 'ไม่จำกัด'} {g.allowRepeat && '· เลือกซ้ำได้'}
              </p>
              <ul className="flex flex-wrap gap-1.5">
                {g.modifiers
                  .filter((m) => !m.archivedAt)
                  .map((m) => (
                    <li key={m.id}>
                      <Badge>
                        {m.name}
                        {m.priceDeltaSatang !== 0 && ` ${m.priceDeltaSatang > 0 ? '+' : ''}${formatBaht(m.priceDeltaSatang)}`}
                      </Badge>
                    </li>
                  ))}
              </ul>
            </Panel>
          ))}
        </div>
      )}
      {editing && <GroupDialog group={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

function StationsTab({ stations }: { stations: Station[] }) {
  const [f, setF] = useState({ code: '', name: '', isExpo: false });
  const create = useMenuMutation(async () => {
    await post('/stations', { ...f, sort: stations.length * 10 });
    setF({ code: '', name: '', isExpo: false });
  }, 'เพิ่มสเตชันแล้ว');
  const remove = useMenuMutation((id: string) => patch(`/stations/${id}`, { archived: true }), 'ลบสเตชันแล้ว');
  return (
    <>
      <Panel title="เพิ่มสเตชัน" className="mb-4">
        <form
          className="flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate(undefined);
          }}
        >
          <Input label="รหัส" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} placeholder="HOT" wrapClassName="w-28" required />
          <Input label="ชื่อ" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ครัวร้อน" wrapClassName="min-w-48 flex-1" required />
          <Checkbox label="จอ Expo (รวมทุกสเตชัน)" checked={f.isExpo} onChange={(e) => setF({ ...f, isExpo: e.target.checked })} />
          <Button type="submit" loading={create.isPending}>
            เพิ่ม
          </Button>
        </form>
      </Panel>
      {stations.length === 0 ? (
        <EmptyState title="ยังไม่มีสเตชัน">เช่น ครัวร้อน (HOT) ครัวเย็น (COLD) ของทอด (FRY) บาร์น้ำ (BAR) ของหวาน (DESSERT)</EmptyState>
      ) : (
        <DataTable
          rows={stations}
          rowKey={(r) => r.id}
          columns={[
            { key: 'code', header: 'รหัส', cell: (r) => <code>{r.code}</code> },
            { key: 'name', header: 'ชื่อ', cell: (r) => r.name },
            { key: 'expo', header: '', cell: (r) => (r.isExpo ? <Badge tone="info">จุดส่งอาหาร (Expo)</Badge> : null) },
            {
              key: 'act',
              header: '',
              align: 'right',
              cell: (r) => (
                <Button size="sm" variant="danger-ghost" onClick={() => confirm(`ลบสเตชัน "${r.name}"?`) && remove.mutate(r.id)}>
                  ลบ
                </Button>
              ),
            },
          ]}
        />
      )}
    </>
  );
}

export function MenuPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<Tab>('items');
  const menu = useAdminMenu();
  const stations = useStations();
  const manage = can('menu.manage');
  return (
    <>
      <PageHeader title="เมนู" crumbs={[{ label: 'หลังร้าน' }]} description="เมนูกลางใช้ร่วมทุกสาขา ปรับราคาและเปิด/ปิดขายรายสาขาได้" />
      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { value: 'items', label: 'รายการเมนู' },
          ...(manage
            ? [
                { value: 'categories' as Tab, label: 'หมวดหมู่' },
                { value: 'modifiers' as Tab, label: 'ตัวเลือกเสริม' },
                { value: 'stations' as Tab, label: 'สเตชันครัว' },
              ]
            : []),
        ]}
      />
      <QueryView query={menu}>
        {(m) => (
          <>
            {tab === 'items' && <ItemsTab menu={m} stations={stations.data?.stations ?? []} />}
            {tab === 'categories' && <CategoriesTab menu={m} stations={stations.data?.stations ?? []} />}
            {tab === 'modifiers' && <ModifiersTab menu={m} />}
            {tab === 'stations' && <StationsTab stations={stations.data?.stations ?? []} />}
          </>
        )}
      </QueryView>
    </>
  );
}
