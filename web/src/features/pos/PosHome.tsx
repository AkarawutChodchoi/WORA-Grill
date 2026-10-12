import { useMutation, useQuery } from '@tanstack/react-query';
import { Bike, Grid3x3, ShoppingBag } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Button, DataTable, Dialog, EmptyState, Input, PageHeader, QueryView, StatusBadge, useToast } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtElapsed, formatBaht } from '../../lib/format';
import { LiveIndicator, useLivePolling } from '../../lib/realtime';
import { CHANNEL_LABEL } from '../menu/ItemDialog';

export interface OrderSummary {
  id: string;
  orderNo: string;
  channel: string;
  source: string;
  status: string;
  tableName: string | null;
  guestCount: number;
  customerName: string | null;
  grandTotalSatang: number;
  paidSatang: number;
  openedAt: string;
  itemCount: number;
  pendingCount: number;
}

function NewOrderDialog({ channel, onClose }: { channel: 'TAKEAWAY' | 'DELIVERY'; onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [note, setNote] = useState('');
  const create = useMutation({
    mutationFn: () => post<{ id: string }>('/orders', { id: crypto.randomUUID(), channel, customerName: name || undefined, customerPhone: phone || undefined, note: note || undefined }),
    onSuccess: (o) => nav(`/pos/orders/${o.id}`),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={channel === 'TAKEAWAY' ? 'บิลกลับบ้าน' : 'บิลเดลิเวอรี่ของร้าน'}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={create.isPending} onClick={() => create.mutate()}>
            เปิดบิล
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Input label="ชื่อลูกค้า (ไม่บังคับ)" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="เบอร์โทร (ไม่บังคับ)" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        {channel === 'DELIVERY' && <Input label="ที่อยู่/หมายเหตุการส่ง" value={note} onChange={(e) => setNote(e.target.value)} />}
      </div>
    </Dialog>
  );
}

export function PosHome() {
  const { can } = useAuth();
  const nav = useNavigate();
  const poll = useLivePolling();
  const [newOrder, setNewOrder] = useState<'TAKEAWAY' | 'DELIVERY' | null>(null);
  const orders = useQuery({ queryKey: ['orders', 'active'], queryFn: () => get<{ orders: OrderSummary[] }>('/orders?scope=active'), refetchInterval: poll });
  return (
    <>
      <PageHeader
        title="POS — บิลที่เปิดอยู่"
        crumbs={[{ label: 'หน้าร้าน' }]}
        description={<LiveIndicator />}
        actions={
          <>
            {can('table.view') && (
              <Link to="/tables">
                <Button variant="outline" icon={<Grid3x3 className="size-4" />}>
                  ทานที่ร้าน (ผังโต๊ะ)
                </Button>
              </Link>
            )}
            {can('order.create') && (
              <>
                <Button variant="outline" icon={<ShoppingBag className="size-4" />} onClick={() => setNewOrder('TAKEAWAY')}>
                  กลับบ้าน
                </Button>
                <Button variant="outline" icon={<Bike className="size-4" />} onClick={() => setNewOrder('DELIVERY')}>
                  เดลิเวอรี่
                </Button>
              </>
            )}
          </>
        }
      />
      <QueryView query={orders} isEmpty={(d) => d.orders.length === 0} empty={<EmptyState title="ไม่มีบิลที่เปิดอยู่">เปิดโต๊ะจากผังโต๊ะ หรือเปิดบิลกลับบ้าน</EmptyState>}>
        {(d) => (
          <DataTable
            rows={d.orders}
            rowKey={(r) => r.id}
            onRowClick={(r) => nav(`/pos/orders/${r.id}`)}
            columns={[
              { key: 'no', header: 'บิล', cell: (r) => <span className="num font-medium">#{r.orderNo}</span> },
              { key: 'where', header: 'โต๊ะ/ช่องทาง', mobile: 'title', cell: (r) => (r.tableName ? `โต๊ะ ${r.tableName}` : `${CHANNEL_LABEL[r.channel] ?? r.channel}${r.customerName ? ` · ${r.customerName}` : ''}`) },
              { key: 'status', header: 'สถานะ', cell: (r) => <StatusBadge status={r.status} /> },
              { key: 'items', header: 'รายการ', align: 'right', cell: (r) => `${r.itemCount}${r.pendingCount ? ` (ยังไม่ส่ง ${r.pendingCount})` : ''}` },
              { key: 'time', header: 'เปิดมาแล้ว', cell: (r) => fmtElapsed(r.openedAt) },
              { key: 'total', header: 'ยอด', align: 'right', cell: (r) => formatBaht(r.grandTotalSatang) },
            ]}
          />
        )}
      </QueryView>
      {newOrder && <NewOrderDialog channel={newOrder} onClose={() => setNewOrder(null)} />}
    </>
  );
}
