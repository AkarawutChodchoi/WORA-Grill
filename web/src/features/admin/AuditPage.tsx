import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataTable, EmptyState, Input, PageHeader, QueryView } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';

interface Log {
  id: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  reason: string | null;
  data: Record<string, unknown> | null;
  createdAt: string;
  actorName: string | null;
  approverName: string | null;
}

export function AuditPage() {
  const [action, setAction] = useState('');
  const logs = useQuery({ queryKey: ['audit', action], queryFn: () => get<{ logs: Log[] }>(`/audit-logs${qs({ action, limit: 200 })}`) });
  return (
    <>
      <PageHeader title="Audit Log" crumbs={[{ label: 'ระบบ' }]} description="บันทึกการกระทำสำคัญ: ใคร ทำอะไร เมื่อไร (200 รายการล่าสุด)" />
      <Input placeholder="กรองตาม action เช่น order.void" value={action} onChange={(e) => setAction(e.target.value)} wrapClassName="mb-3 max-w-sm" aria-label="กรอง action" />
      <QueryView query={logs} isEmpty={(d) => d.logs.length === 0} empty={<EmptyState title="ไม่พบรายการ" />}>
        {(d) => (
          <DataTable
            rows={d.logs}
            rowKey={(r) => r.id}
            columns={[
              { key: 'time', header: 'เวลา', cell: (r) => <span className="num whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
              { key: 'actor', header: 'ผู้ทำ', cell: (r) => r.actorName ?? 'ระบบ' },
              { key: 'action', header: 'การกระทำ', cell: (r) => <code className="text-xs">{r.action}</code> },
              { key: 'target', header: 'เป้าหมาย', cell: (r) => (r.targetType ? `${r.targetType} ${r.targetId?.slice(0, 8) ?? ''}` : '—') },
              { key: 'approver', header: 'ผู้อนุมัติ', cell: (r) => r.approverName ?? '—' },
              { key: 'reason', header: 'เหตุผล', cell: (r) => r.reason ?? '—' },
              {
                key: 'data',
                header: 'รายละเอียด',
                cell: (r) => (r.data ? <span className="line-clamp-2 max-w-xs text-xs break-all text-ink-2">{JSON.stringify(r.data)}</span> : '—'),
              },
            ]}
          />
        )}
      </QueryView>
    </>
  );
}
