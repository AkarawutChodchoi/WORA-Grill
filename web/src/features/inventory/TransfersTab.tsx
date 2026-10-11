import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Badge, Button, DataTable, Dialog, EmptyState, Panel, QueryView, Select, useToast } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';
import { fmtQty, LinesEditor, useIngredients } from './InventoryPage';

interface Transfer {
  id: string;
  transferNo: string;
  status: 'REQUESTED' | 'SHIPPED' | 'RECEIVED' | 'CANCELLED';
  direction: 'IN' | 'OUT';
  fromBranch: string;
  toBranch: string;
  createdAt: string;
  lines: { id: string; name: string; baseUnit: string; requestedQtyBase: string; shippedQtyBase: string | null; receivedQtyBase: string | null; discrepancyReason: string | null }[];
}

const LABEL = { REQUESTED: 'ขอเบิก', SHIPPED: 'ส่งแล้ว', RECEIVED: 'รับแล้ว', CANCELLED: 'ยกเลิก' };

/** Inter-branch / central-kitchen stock transfers. */
export function TransfersTab() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const ings = useIngredients();
  const q = useQuery({ queryKey: ['transfers'], queryFn: () => get<{ transfers: Transfer[]; branches: { id: string; name: string; isCentralKitchen: boolean }[] }>('/transfers') });
  const [mode, setMode] = useState<'SHIP' | 'REQUEST'>('SHIP');
  const [other, setOther] = useState('');
  const [lines, setLines] = useState<{ ingredientId: string; qty: string; unit: string }[]>([{ ingredientId: '', qty: '', unit: '' }]);
  const [receiving, setReceiving] = useState<Transfer | null>(null);
  const [recv, setRecv] = useState<Record<string, { qty: string; reason: string }>>({});
  const done = () => {
    qc.invalidateQueries({ queryKey: ['transfers'] });
    qc.invalidateQueries({ queryKey: ['ingredients'] });
  };
  const create = useMutation({
    mutationFn: () => post('/transfers', { mode, otherBranchId: other, lines: lines.filter((l) => l.ingredientId && l.qty) }),
    onSuccess: () => {
      toast.success(mode === 'SHIP' ? 'ส่งของแล้ว (ตัดสต็อกสาขานี้)' : 'ส่งคำขอเบิกแล้ว');
      setLines([{ ingredientId: '', qty: '', unit: '' }]);
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const act = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      toast.success('บันทึกแล้ว');
      setReceiving(null);
      done();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <QueryView query={q}>
      {(d) =>
        d.branches.length === 0 ? (
          <EmptyState title="มีสาขาเดียว">เพิ่มสาขาที่ ระบบ → สาขา เพื่อโอนสต็อกระหว่างสาขาหรือใช้ครัวกลาง</EmptyState>
        ) : (
          <div className="flex flex-col gap-4">
            <Panel title="สร้างใบโอน">
              <div className="mb-3 flex flex-wrap gap-2">
                {can('stock.issue') && (
                  <Button variant={mode === 'SHIP' ? 'primary' : 'outline'} onClick={() => setMode('SHIP')}>
                    ส่งของไปสาขาอื่น
                  </Button>
                )}
                {can('stock.receive') && (
                  <Button variant={mode === 'REQUEST' ? 'primary' : 'outline'} onClick={() => setMode('REQUEST')}>
                    ขอเบิกจากสาขาอื่น/ครัวกลาง
                  </Button>
                )}
                <Select aria-label="สาขา" value={other} onChange={(e) => setOther(e.target.value)} wrapClassName="w-56">
                  <option value="">{mode === 'SHIP' ? 'ส่งไปที่สาขา' : 'ขอจากสาขา'}</option>
                  {d.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.name}
                      {b.isCentralKitchen ? ' (ครัวกลาง)' : ''}
                    </option>
                  ))}
                </Select>
              </div>
              {ings.data && <LinesEditor lines={lines} setLines={setLines as any} ingredients={ings.data.ingredients} />}
              <Button className="mt-3" loading={create.isPending} disabled={!other} onClick={() => create.mutate()}>
                {mode === 'SHIP' ? 'ยืนยันส่งของ' : 'ส่งคำขอเบิก'}
              </Button>
            </Panel>
            <DataTable
              rows={d.transfers}
              rowKey={(r) => r.id}
              columns={[
                { key: 'n', header: 'เลขที่', cell: (r) => <span className="num">{r.transferNo}</span> },
                { key: 'd', header: '', cell: (r) => <Badge tone={r.direction === 'IN' ? 'info' : 'neutral'}>{r.direction === 'IN' ? 'เข้า' : 'ออก'}</Badge> },
                { key: 'b', header: 'จาก → ถึง', cell: (r) => `${r.fromBranch} → ${r.toBranch}` },
                { key: 'l', header: 'รายการ', cell: (r) => r.lines.map((l) => `${l.name} ${fmtQty(l.shippedQtyBase ?? l.requestedQtyBase, l.baseUnit)}`).join(', ') },
                { key: 's', header: 'สถานะ', cell: (r) => <Badge tone={r.status === 'RECEIVED' ? 'success' : r.status === 'SHIPPED' ? 'warning' : 'neutral'}>{LABEL[r.status]}</Badge> },
                { key: 't', header: 'สร้าง', cell: (r) => fmtDateTime(r.createdAt) },
                {
                  key: 'a',
                  header: '',
                  align: 'right',
                  cell: (r) => (
                    <div className="flex justify-end gap-1">
                      {r.status === 'REQUESTED' && r.direction === 'OUT' && can('stock.issue') && (
                        <Button size="sm" onClick={() => act.mutate(() => post(`/transfers/${r.id}/ship`))}>
                          ส่งของ
                        </Button>
                      )}
                      {r.status === 'SHIPPED' && r.direction === 'IN' && can('stock.receive') && (
                        <Button size="sm" onClick={() => (setReceiving(r), setRecv(Object.fromEntries(r.lines.map((l) => [l.id, { qty: String(Number(l.shippedQtyBase)), reason: '' }])))) }>
                          รับของ
                        </Button>
                      )}
                      {r.status === 'REQUESTED' && (
                        <Button size="sm" variant="ghost" onClick={() => act.mutate(() => post(`/transfers/${r.id}/cancel`))}>
                          ยกเลิก
                        </Button>
                      )}
                    </div>
                  ),
                },
              ]}
            />
            {receiving && (
              <Dialog
                open
                onClose={() => setReceiving(null)}
                title={`รับของ ${receiving.transferNo}`}
                footer={
                  <Button loading={act.isPending} onClick={() => act.mutate(() => post(`/transfers/${receiving.id}/receive`, { lines: Object.entries(recv).map(([lineId, v]) => ({ lineId, receivedQtyBase: v.qty || '0', reason: v.reason || undefined })) }))}>
                    ยืนยันรับของ
                  </Button>
                }
              >
                <ul className="flex flex-col gap-3">
                  {receiving.lines.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-end gap-2">
                      <span className="w-40">
                        {l.name}
                        <span className="block text-xs text-ink-3">ส่งมา {fmtQty(l.shippedQtyBase ?? 0, l.baseUnit)}</span>
                      </span>
                      <input aria-label="รับจริง" inputMode="decimal" className="h-10 w-28 rounded-control border border-line-strong px-2 text-right" value={recv[l.id]?.qty ?? ''} onChange={(e) => setRecv({ ...recv, [l.id]: { ...recv[l.id], qty: e.target.value } })} />
                      <span className="pb-2 text-sm">{l.baseUnit}</span>
                      <input aria-label="เหตุผลถ้าขาด" placeholder="เหตุผลถ้าได้ไม่ครบ" className="h-10 min-w-40 flex-1 rounded-control border border-line-strong px-2" value={recv[l.id]?.reason ?? ''} onChange={(e) => setRecv({ ...recv, [l.id]: { ...recv[l.id], reason: e.target.value } })} />
                    </li>
                  ))}
                </ul>
              </Dialog>
            )}
          </div>
        )
      }
    </QueryView>
  );
}
