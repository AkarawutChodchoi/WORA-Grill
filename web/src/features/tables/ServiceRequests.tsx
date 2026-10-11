import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { Link } from 'react-router';
import { Button, Panel, useToast } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtElapsed } from '../../lib/format';
import { useLivePolling } from '../../lib/realtime';

const LABEL: Record<string, string> = { CALL_WAITER: 'เรียกพนักงาน', WATER: 'ขอน้ำ', ICE: 'ขอน้ำแข็ง', BILL: 'เรียกเช็กบิล', OTHER: 'คำขอ' };

/** Open guest requests (from QR) and guest orders waiting for approval. */
export function ServiceRequestsPanel() {
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const poll = useLivePolling();
  const reqs = useQuery({ queryKey: ['service-requests'], queryFn: () => get<{ requests: { id: string; type: string; note: string | null; status: string; tableName: string | null; createdAt: string; orderId: string | null }[] }>('/service-requests'), refetchInterval: poll });
  const pending = useQuery({ queryKey: ['qr-pending'], queryFn: () => get<{ orders: { orderId: string; orderNo: string; tableName: string | null; n: number }[] }>('/qr/pending'), enabled: can('order.approve_qr'), refetchInterval: poll });
  const act = useMutation({
    mutationFn: (v: { id: string; action: 'ack' | 'done' }) => post(`/service-requests/${v.id}/${v.action}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['service-requests'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const list = reqs.data?.requests ?? [];
  const approvals = pending.data?.orders ?? [];
  if (list.length === 0 && approvals.length === 0) return null;
  return (
    <Panel
      className="mb-4 border-turmeric"
      title={
        <span className="flex items-center gap-2">
          <Bell className="size-4 text-turmeric" /> คำขอจากลูกค้า ({list.length + approvals.length})
        </span>
      }
    >
      <ul className="flex flex-col gap-2">
        {approvals.map((a) => (
          <li key={a.orderId} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{a.tableName ? `โต๊ะ ${a.tableName}` : `#${a.orderNo}`}</span>
            <span className="text-sm">สั่งผ่าน QR {a.n} รายการ รออนุมัติ</span>
            <Link to={`/pos/orders/${a.orderId}`} className="ml-auto">
              <Button size="sm">ตรวจและอนุมัติ</Button>
            </Link>
          </li>
        ))}
        {list.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{r.tableName ? `โต๊ะ ${r.tableName}` : 'ลูกค้า'}</span>
            <span className="text-sm">
              {LABEL[r.type]} {r.note && `— ${r.note}`}
            </span>
            <span className="text-xs text-ink-3">{fmtElapsed(r.createdAt)}</span>
            <span className="ml-auto flex gap-1">
              {r.status === 'OPEN' && (
                <Button size="sm" variant="outline" onClick={() => act.mutate({ id: r.id, action: 'ack' })}>
                  รับทราบ
                </Button>
              )}
              <Button size="sm" onClick={() => act.mutate({ id: r.id, action: 'done' })}>
                เสร็จ
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Panel>
  );
}
