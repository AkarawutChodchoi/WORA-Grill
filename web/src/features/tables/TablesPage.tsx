import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { BellRing, LayoutGrid, List, Minus, Move, Pencil, Plus, Users } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import type { TableStatus } from '@shared/states';
import { Badge, Button, Checkbox, Dialog, EmptyState, Input, PageHeader, QueryView, Select, StatusBadge, statusLabel, useToast } from '../../components/ui';
import { errorMessage, get, patch, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtElapsed, fmtElapsedShort, formatBaht } from '../../lib/format';
import { LiveIndicator, useLivePolling } from '../../lib/realtime';
import { ServiceRequestsPanel } from './ServiceRequests';

export interface TableRow {
  id: string;
  zoneId: string;
  name: string;
  capacity: number;
  shape: 'square' | 'round' | 'rect';
  posX: number;
  posY: number;
  width: number;
  height: number;
  status: TableStatus;
  currentOrderId: string | null;
  mergedIntoTableId: string | null;
  statusChangedAt: string;
  version: number;
  order: { id: string; orderNo: string; guestCount: number; openedAt: string; grandTotalSatang: number; status: string; openedBy: string | null; readyCount: number } | null;
}
export interface Zone {
  id: string;
  name: string;
  floor: string | null;
  waiters: { id: string; name: string }[];
}
export interface FloorData {
  zones: Zone[];
  tables: TableRow[];
}

export const STATUS_STYLE: Record<TableStatus, string> = {
  AVAILABLE: 'border-basil/50 bg-basil-50 text-basil-600',
  OCCUPIED: 'border-sky/50 bg-sky-50 text-sky',
  WAITING_FOOD: 'border-turmeric bg-turmeric-50 text-turmeric-700',
  DINING: 'border-sky bg-sky text-white',
  BILL_REQUESTED: 'border-chili bg-chili text-white',
  CLEANING: 'border-line-strong bg-sunken text-ink-3 [background-image:repeating-linear-gradient(135deg,transparent_0_6px,rgb(0_0_0/0.04)_6px_12px)]',
};

const CELL = 44;

/** Short status words that fit on a floor-plan tile (full wording is in the list view and aria-label). */
const TILE_STATUS: Record<TableStatus, string> = { AVAILABLE: 'ว่าง', OCCUPIED: 'มีลูกค้า', WAITING_FOOD: 'รออาหาร', DINING: 'กำลังทาน', BILL_REQUESTED: 'เช็กบิล', CLEANING: 'รอเก็บโต๊ะ' };

export function useFloor() {
  const poll = useLivePolling();
  return useQuery({ queryKey: ['tables'], queryFn: () => get<FloorData>('/tables'), refetchInterval: poll });
}

/** Re-render every 30 s so elapsed times stay current. */
export function useNow(intervalMs = 30_000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

function TableTile({ t, joinedTo, now, selected, onClick, style }: { t: TableRow; joinedTo?: string; now: number; selected?: boolean; onClick: () => void; style?: React.CSSProperties }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={style}
      aria-label={`โต๊ะ ${t.name} ${statusLabel(t.status)}`}
      className={clsx(
        'flex flex-col items-center justify-center gap-0.5 overflow-hidden border-2 p-1 text-center leading-tight transition-shadow',
        t.shape === 'round' ? 'rounded-full' : 'rounded-panel',
        STATUS_STYLE[t.status],
        selected && 'ring-4 ring-sky/40',
      )}
    >
      <span className="text-base font-semibold">{t.name}</span>
      {/* Status in words too, never colour alone. */}
      {t.status !== 'AVAILABLE' && <span className="text-xs font-medium whitespace-nowrap">{TILE_STATUS[t.status]}</span>}
      {t.order ? (
        <>
          <span className="flex items-center gap-0.5 text-xs whitespace-nowrap" title={fmtElapsed(t.order.openedAt, now)}>
            <Users className="size-3" aria-hidden />
            {t.order.guestCount} · {fmtElapsedShort(t.order.openedAt, now)}
          </span>
          {t.order.readyCount > 0 && (
            <span className="flex items-center gap-0.5 rounded bg-white/90 px-1 text-xs font-medium text-basil-600">
              <BellRing className="size-3" />
              พร้อมเสิร์ฟ {t.order.readyCount}
            </span>
          )}
        </>
      ) : joinedTo ? (
        <span className="text-xs">รวมกับ {joinedTo}</span>
      ) : (
        <span className="text-xs opacity-80">{t.capacity} ที่นั่ง</span>
      )}
    </button>
  );
}

function TableSheet({ table, data, onClose }: { table: TableRow; data: FloorData; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const nav = useNavigate();
  const [guests, setGuests] = useState(Math.min(2, table.capacity));
  const [moveTo, setMoveTo] = useState('');
  const [joinIds, setJoinIds] = useState<string[]>([]);
  const free = data.tables.filter((x) => x.id !== table.id && !x.currentOrderId && !x.mergedIntoTableId && x.status === 'AVAILABLE');
  const joined = data.tables.filter((x) => x.mergedIntoTableId === table.id);
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tables'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const openTable = () =>
    run.mutate(async () => {
      const o = await post<{ id: string; orderNo: string }>(`/tables/${table.id}/open`, { guestCount: guests, orderId: crypto.randomUUID() });
      toast.success(`เปิดโต๊ะ ${table.name} บิล #${o.orderNo}`);
      onClose();
      nav(`/pos/orders/${o.id}`);
    });
  const operate = can('table.operate');
  return (
    <Dialog open onClose={onClose} title={`โต๊ะ ${table.name}`} size="md">
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <StatusBadge status={table.status} />
        <span className="text-sm text-ink-2">{table.capacity} ที่นั่ง</span>
        {table.mergedIntoTableId && <Badge tone="info">รวมกับโต๊ะ {data.tables.find((x) => x.id === table.mergedIntoTableId)?.name}</Badge>}
      </div>
      {table.order ? (
        <div className="flex flex-col gap-4">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <dt className="text-ink-2">บิล</dt>
            <dd className="num">#{table.order.orderNo}</dd>
            <dt className="text-ink-2">ลูกค้า</dt>
            <dd>{table.order.guestCount} คน</dd>
            <dt className="text-ink-2">นั่งมาแล้ว</dt>
            <dd>{fmtElapsed(table.order.openedAt)}</dd>
            <dt className="text-ink-2">ยอดปัจจุบัน</dt>
            <dd className="num">{formatBaht(table.order.grandTotalSatang)}</dd>
            <dt className="text-ink-2">เปิดโดย</dt>
            <dd>{table.order.openedBy ?? '—'}</dd>
            {joined.length > 0 && (
              <>
                <dt className="text-ink-2">โต๊ะที่รวม</dt>
                <dd>{joined.map((j) => j.name).join(', ')}</dd>
              </>
            )}
          </dl>
          {can('order.view') && (
            <Button size="lg" onClick={() => nav(`/pos/orders/${table.order!.id}`)}>
              เปิดบิล / สั่งอาหาร
            </Button>
          )}
          {operate && (
            <>
              <div className="flex items-end gap-2">
                <Select label="ย้ายไปโต๊ะ" value={moveTo} onChange={(e) => setMoveTo(e.target.value)} wrapClassName="flex-1">
                  <option value="">เลือกโต๊ะว่าง</option>
                  {free.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name} ({f.capacity} ที่นั่ง)
                    </option>
                  ))}
                </Select>
                <Button
                  variant="outline"
                  disabled={!moveTo}
                  loading={run.isPending}
                  onClick={() =>
                    run.mutate(async () => {
                      await post(`/tables/${table.id}/move`, { toTableId: moveTo });
                      toast.success('ย้ายโต๊ะแล้ว');
                      onClose();
                    })
                  }
                >
                  ย้าย
                </Button>
              </div>
              {free.length > 0 && (
                <fieldset>
                  <legend className="mb-1 text-sm font-medium text-ink-2">รวมโต๊ะว่างเข้ากลุ่มนี้</legend>
                  <div className="flex flex-wrap gap-3">
                    {free.map((f) => (
                      <Checkbox key={f.id} label={f.name} checked={joinIds.includes(f.id)} onChange={() => setJoinIds(joinIds.includes(f.id) ? joinIds.filter((x) => x !== f.id) : [...joinIds, f.id])} />
                    ))}
                  </div>
                  <Button
                    className="mt-2"
                    size="sm"
                    variant="outline"
                    disabled={joinIds.length === 0}
                    onClick={() =>
                      run.mutate(async () => {
                        await post(`/tables/${table.id}/join`, { tableIds: joinIds });
                        toast.success('รวมโต๊ะแล้ว');
                        setJoinIds([]);
                      })
                    }
                  >
                    รวมโต๊ะ
                  </Button>
                </fieldset>
              )}
              {joined.length > 0 && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    confirm('แยกโต๊ะที่รวมไว้ออกจากกัน?') &&
                    run.mutate(async () => {
                      await post(`/tables/${table.id}/unjoin`, { tableIds: joined.map((j) => j.id) });
                      toast.success('แยกโต๊ะแล้ว');
                    })
                  }
                >
                  แยกโต๊ะที่รวมออก
                </Button>
              )}
            </>
          )}
        </div>
      ) : table.status === 'CLEANING' ? (
        operate && (
          <Button
            size="lg"
            className="w-full"
            loading={run.isPending}
            onClick={() =>
              run.mutate(async () => {
                await post(`/tables/${table.id}/status`, { status: 'AVAILABLE', version: table.version });
                toast.success(`โต๊ะ ${table.name} พร้อมใช้งาน`);
                onClose();
              })
            }
          >
            ทำความสะอาดเสร็จแล้ว
          </Button>
        )
      ) : table.mergedIntoTableId ? (
        <p className="text-ink-2">โต๊ะนี้ถูกรวมกับโต๊ะอื่น จัดการได้ที่โต๊ะหลัก</p>
      ) : (
        can('order.create') &&
        operate && (
          <div className="flex flex-col gap-4">
            <div>
              <div className="mb-2 text-sm font-medium text-ink-2">จำนวนลูกค้า</div>
              <div className="flex items-center gap-3">
                <Button variant="outline" size="lg" aria-label="ลด" icon={<Minus className="size-5" />} onClick={() => setGuests(Math.max(1, guests - 1))} />
                <span className="num w-12 text-center text-3xl font-semibold" aria-live="polite">
                  {guests}
                </span>
                <Button variant="outline" size="lg" aria-label="เพิ่ม" icon={<Plus className="size-5" />} onClick={() => setGuests(Math.min(100, guests + 1))} />
              </div>
              {guests > table.capacity && <p className="mt-1 text-sm text-turmeric">เกินจำนวนที่นั่ง ({table.capacity}) — พิจารณารวมโต๊ะ</p>}
            </div>
            <Button size="lg" loading={run.isPending} onClick={openTable}>
              เปิดโต๊ะ
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                run.mutate(async () => {
                  await post(`/tables/${table.id}/status`, { status: 'CLEANING', version: table.version });
                  onClose();
                })
              }
            >
              ทำเครื่องหมายรอทำความสะอาด
            </Button>
          </div>
        )
      )}
    </Dialog>
  );
}

function TableEditDialog({ table, zones, onClose }: { table: TableRow | 'new'; zones: Zone[]; onClose: () => void }) {
  const t = table === 'new' ? null : table;
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({ name: t?.name ?? '', zoneId: t?.zoneId ?? zones[0]?.id ?? '', capacity: t?.capacity ?? 4, shape: t?.shape ?? 'square', width: t?.width ?? 2, height: t?.height ?? 2 });
  const save = useMutation({
    mutationFn: () => (t ? patch(`/tables/${t.id}`, f) : post('/tables', { ...f, posX: 0, posY: 0 })),
    onSuccess: () => {
      toast.success('บันทึกโต๊ะแล้ว');
      qc.invalidateQueries({ queryKey: ['tables'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const archive = useMutation({
    mutationFn: () => patch(`/tables/${t!.id}`, { archived: true }),
    onSuccess: () => {
      toast.success('เก็บโต๊ะแล้ว');
      qc.invalidateQueries({ queryKey: ['tables'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={t ? `แก้ไขโต๊ะ ${t.name}` : 'เพิ่มโต๊ะ'}
      footer={
        <>
          {t && (
            <Button variant="danger-ghost" className="mr-auto" onClick={() => confirm(`ซ่อนโต๊ะ ${t.name} ออกจากผัง?`) && archive.mutate()} loading={archive.isPending}>
              ซ่อนโต๊ะ (เลิกใช้)
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!f.name || !f.zoneId}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <Input label="ชื่อ/หมายเลขโต๊ะ" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Input label="จำนวนที่นั่ง" type="number" min={1} max={50} value={f.capacity} onChange={(e) => setF({ ...f, capacity: Number(e.target.value) })} />
        <Select label="โซน" value={f.zoneId} onChange={(e) => setF({ ...f, zoneId: e.target.value })}>
          {zones.map((z) => (
            <option key={z.id} value={z.id}>
              {z.name}
            </option>
          ))}
        </Select>
        <Select label="รูปทรง" value={f.shape} onChange={(e) => setF({ ...f, shape: e.target.value as TableRow['shape'] })}>
          <option value="square">สี่เหลี่ยม</option>
          <option value="rect">สี่เหลี่ยมผืนผ้า</option>
          <option value="round">กลม</option>
        </Select>
        <Input label="กว้าง (ช่อง)" type="number" min={1} max={10} value={f.width} onChange={(e) => setF({ ...f, width: Number(e.target.value) })} />
        <Input label="ยาว (ช่อง)" type="number" min={1} max={10} value={f.height} onChange={(e) => setF({ ...f, height: Number(e.target.value) })} />
      </div>
    </Dialog>
  );
}

function ZoneDialog({ zone, onClose }: { zone: Zone | 'new'; onClose: () => void }) {
  const z = zone === 'new' ? null : zone;
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState(z?.name ?? '');
  const [floor, setFloor] = useState(z?.floor ?? '');
  const users = useQuery({ queryKey: ['users', ''], queryFn: () => get<{ users: { id: string; name: string; isActive: boolean }[] }>('/users'), enabled: !!z });
  const [waiterIds, setWaiterIds] = useState<string[]>(z?.waiters.map((w) => w.id) ?? []);
  const save = useMutation({
    mutationFn: async () => {
      if (z) {
        await patch(`/zones/${z.id}`, { name, floor: floor || null });
        if (users.data) await put(`/zones/${z.id}/waiters`, { userIds: waiterIds });
      } else await post('/zones', { name, floor: floor || null });
    },
    onSuccess: () => {
      toast.success('บันทึกโซนแล้ว');
      qc.invalidateQueries({ queryKey: ['tables'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={z ? `โซน ${z.name}` : 'เพิ่มโซน'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button onClick={() => save.mutate()} loading={save.isPending} disabled={!name}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Input label="ชื่อโซน" value={name} onChange={(e) => setName(e.target.value)} required placeholder="เช่น ในร้าน, ระเบียง, ชั้น 2" />
        <Input label="ชั้น" value={floor} onChange={(e) => setFloor(e.target.value)} />
        {z && users.data && (
          <fieldset>
            <legend className="mb-1 text-sm font-medium text-ink-2">พนักงานเสิร์ฟประจำโซน</legend>
            <div className="flex flex-wrap gap-3">
              {users.data.users
                .filter((u) => u.isActive)
                .map((u) => (
                  <Checkbox key={u.id} label={u.name} checked={waiterIds.includes(u.id)} onChange={() => setWaiterIds(waiterIds.includes(u.id) ? waiterIds.filter((x) => x !== u.id) : [...waiterIds, u.id])} />
                ))}
            </div>
          </fieldset>
        )}
      </div>
    </Dialog>
  );
}

export function FloorPlan({ data, zoneId, onPick, editing, selectedId, onMove }: { data: FloorData; zoneId: string; onPick: (t: TableRow) => void; editing?: boolean; selectedId?: string | null; onMove?: (id: string, x: number, y: number) => void }) {
  const now = useNow();
  const tables = data.tables.filter((t) => t.zoneId === zoneId);
  const cols = Math.max(16, ...tables.map((t) => t.posX + t.width + 1));
  const rows = Math.max(10, ...tables.map((t) => t.posY + t.height + 1));
  const nameOf = (id: string | null) => data.tables.find((x) => x.id === id)?.name;
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  return (
    <div className="overflow-auto rounded-panel border border-line bg-surface">
      <div
        className="relative"
        style={{
          width: cols * CELL,
          height: rows * CELL,
          backgroundImage: editing ? 'radial-gradient(circle, var(--color-line) 1px, transparent 1px)' : undefined,
          backgroundSize: `${CELL}px ${CELL}px`,
        }}
        onPointerMove={(e) => {
          if (!drag || !onMove) return;
          const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
          const x = Math.max(0, Math.round((e.clientX - rect.left - drag.dx) / CELL));
          const y = Math.max(0, Math.round((e.clientY - rect.top - drag.dy) / CELL));
          onMove(drag.id, x, y);
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        {tables.map((t) => (
          <div
            key={t.id}
            className="absolute p-1"
            style={{ left: t.posX * CELL, top: t.posY * CELL, width: t.width * CELL, height: t.height * CELL, touchAction: editing ? 'none' : undefined }}
            onPointerDown={(e) => {
              if (!editing) return;
              const r = (e.currentTarget as HTMLDivElement).getBoundingClientRect();
              setDrag({ id: t.id, dx: e.clientX - r.left, dy: e.clientY - r.top });
            }}
          >
            <TableTile t={t} now={now} joinedTo={nameOf(t.mergedIntoTableId)} selected={selectedId === t.id} onClick={() => onPick(t)} style={{ width: '100%', height: '100%' }} />
          </div>
        ))}
      </div>
    </div>
  );
}

export function TablesPage() {
  const { can } = useAuth();
  const floor = useFloor();
  const qc = useQueryClient();
  const toast = useToast();
  const [zoneId, setZoneId] = useState<string | null>(null);
  const [view, setView] = useState<'plan' | 'list'>(() => (typeof window !== 'undefined' && window.innerWidth < 640 ? 'list' : 'plan'));
  const [picked, setPicked] = useState<string | null>(null);
  const [editMode, setEditMode] = useState(false);
  const [editTable, setEditTable] = useState<TableRow | 'new' | null>(null);
  const [editZone, setEditZone] = useState<Zone | 'new' | null>(null);
  const [layout, setLayout] = useState<Record<string, { posX: number; posY: number }>>({});
  const data = useMemo(() => {
    if (!floor.data) return undefined;
    return { ...floor.data, tables: floor.data.tables.map((t) => ({ ...t, ...(layout[t.id] ?? {}) })) };
  }, [floor.data, layout]);
  const activeZone = zoneId ?? data?.zones[0]?.id ?? null;
  const pickedTable = data?.tables.find((t) => t.id === picked) ?? null;
  const saveLayout = useMutation({
    mutationFn: () => put('/tables/layout', { positions: Object.entries(layout).map(([id, p]) => ({ id, ...p })) }),
    onSuccess: async () => {
      toast.success('บันทึกผังโต๊ะแล้ว');
      await qc.invalidateQueries({ queryKey: ['tables'] });
      setLayout({});
      setEditMode(false);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  // Keyboard layout editing: arrow keys move the selected table one grid cell.
  useEffect(() => {
    if (!editMode || !picked || !data) return;
    const h = (e: KeyboardEvent) => {
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!d) return;
      e.preventDefault();
      const t = data.tables.find((x) => x.id === picked)!;
      setLayout((l) => ({ ...l, [picked]: { posX: Math.max(0, t.posX + d[0]), posY: Math.max(0, t.posY + d[1]) } }));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [editMode, picked, data]);

  const counts = useMemo(() => {
    const c: Partial<Record<TableStatus, number>> = {};
    for (const t of data?.tables ?? []) c[t.status] = (c[t.status] ?? 0) + 1;
    return c;
  }, [data]);

  return (
    <>
      <PageHeader
        title="ผังโต๊ะ"
        crumbs={[{ label: 'หน้าร้าน' }]}
        description={
          <span className="flex flex-wrap items-center gap-3">
            <LiveIndicator />
            <span>ว่าง {counts.AVAILABLE ?? 0}</span>
            <span>มีลูกค้า {(counts.OCCUPIED ?? 0) + (counts.WAITING_FOOD ?? 0) + (counts.DINING ?? 0)}</span>
            <span>เรียกเช็กบิล {counts.BILL_REQUESTED ?? 0}</span>
            <span>รอทำความสะอาด {counts.CLEANING ?? 0}</span>
          </span>
        }
        actions={
          <>
            <div className="flex rounded-control border border-line-strong" role="group" aria-label="มุมมอง">
              <Button size="sm" variant={view === 'plan' ? 'secondary' : 'ghost'} icon={<LayoutGrid className="size-4" />} onClick={() => setView('plan')} aria-pressed={view === 'plan'}>
                ผัง
              </Button>
              <Button size="sm" variant={view === 'list' ? 'secondary' : 'ghost'} icon={<List className="size-4" />} onClick={() => setView('list')} aria-pressed={view === 'list'}>
                รายการ
              </Button>
            </div>
            {can('table.manage') &&
              (editMode ? (
                <>
                  <Button size="sm" variant="ghost" onClick={() => (setLayout({}), setEditMode(false))}>
                    ยกเลิก
                  </Button>
                  <Button size="sm" loading={saveLayout.isPending} onClick={() => saveLayout.mutate()} disabled={Object.keys(layout).length === 0}>
                    บันทึกผัง
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" icon={<Pencil className="size-4" />} onClick={() => (setEditMode(true), setView('plan'))}>
                  จัดผัง
                </Button>
              ))}
          </>
        }
      />
      <ServiceRequestsPanel />
      <QueryView
        query={{ ...floor, data }}
        isEmpty={(d) => d.zones.length === 0}
        empty={
          <EmptyState
            title="ยังไม่มีโซนและโต๊ะ"
            action={
              can('table.manage') && (
                <Button icon={<Plus className="size-4" />} onClick={() => setEditZone('new')}>
                  เพิ่มโซน
                </Button>
              )
            }
          >
            เริ่มจากสร้างโซน เช่น "ในร้าน" แล้วเพิ่มโต๊ะ
          </EmptyState>
        }
      >
        {(d) => (
          <>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {d.zones.map((z) => (
                <Button key={z.id} size="sm" variant={activeZone === z.id ? 'primary' : 'outline'} onClick={() => setZoneId(z.id)}>
                  {z.name}
                  <span className="opacity-70">({d.tables.filter((t) => t.zoneId === z.id).length})</span>
                </Button>
              ))}
              {editMode && (
                <>
                  <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setEditZone('new')}>
                    โซน
                  </Button>
                  {activeZone && (
                    <Button size="sm" variant="ghost" onClick={() => setEditZone(d.zones.find((z) => z.id === activeZone)!)}>
                      แก้ไขโซน
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setEditTable('new')}>
                    โต๊ะ
                  </Button>
                  {picked && (
                    <Button size="sm" variant="ghost" onClick={() => setEditTable(d.tables.find((t) => t.id === picked)!)}>
                      แก้ไขโต๊ะที่เลือก
                    </Button>
                  )}
                  <span className="flex items-center gap-1 text-sm text-ink-3">
                    <Move className="size-4" /> ลากโต๊ะ หรือเลือกแล้วกดปุ่มลูกศร
                  </span>
                </>
              )}
            </div>
            {activeZone &&
              (view === 'plan' ? (
                <FloorPlan
                  data={d}
                  zoneId={activeZone}
                  editing={editMode}
                  selectedId={picked}
                  onPick={(t) => setPicked(t.id)}
                  onMove={(id, posX, posY) => setLayout((l) => ({ ...l, [id]: { posX, posY } }))}
                />
              ) : (
                <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
                  {d.tables
                    .filter((t) => t.zoneId === activeZone)
                    .map((t) => (
                      <li key={t.id} className="h-24">
                        <TableTile t={t} now={Date.now()} joinedTo={d.tables.find((x) => x.id === t.mergedIntoTableId)?.name} onClick={() => setPicked(t.id)} style={{ width: '100%', height: '100%' }} />
                      </li>
                    ))}
                </ul>
              ))}
            {!editMode && pickedTable && <TableSheet table={pickedTable} data={d} onClose={() => setPicked(null)} />}
            {editTable && <TableEditDialog table={editTable} zones={d.zones} onClose={() => setEditTable(null)} />}
          </>
        )}
      </QueryView>
      {editZone && <ZoneDialog zone={editZone} onClose={() => setEditZone(null)} />}
    </>
  );
}
