import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { DataTable, EmptyState, PageHeader, QueryView, Select } from '../../components/ui';
import { get, qs } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { AUDIT_ACTION, AUDIT_GROUPS, AUDIT_TARGET, auditSummary } from './auditLabels';

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
      <PageHeader title="ประวัติการใช้งาน" crumbs={[{ label: 'ระบบ' }]} description="ใคร ทำอะไร เมื่อไร กับการกระทำสำคัญในร้าน (แสดง 200 รายการล่าสุด)" />
      <Select label="ประเภท" value={action} onChange={(e) => setAction(e.target.value)} wrapClassName="mb-3 max-w-xs">
        {AUDIT_GROUPS.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </Select>
      <QueryView query={logs} isEmpty={(d) => d.logs.length === 0} empty={<EmptyState title="ไม่พบรายการ" />}>
        {(d) => (
          <DataTable
            rows={d.logs}
            rowKey={(r) => r.id}
            columns={[
              { key: 'time', header: 'เวลา', cell: (r) => <span className="num whitespace-nowrap">{fmtDateTime(r.createdAt)}</span> },
              { key: 'actor', header: 'ผู้ทำ', cell: (r) => r.actorName ?? 'ระบบ' },
              { key: 'action', header: 'การกระทำ', mobile: 'title', cell: (r) => <span title={r.action}>{AUDIT_ACTION[r.action] ?? r.action}</span> },
              { key: 'target', header: 'เกี่ยวกับ', cell: (r) => (r.targetType ? AUDIT_TARGET[r.targetType] ?? r.targetType : '—') },
              { key: 'approver', header: 'ผู้อนุมัติ', mobile: 'hide', cell: (r) => r.approverName ?? '—' },
              { key: 'reason', header: 'เหตุผล', cell: (r) => r.reason ?? '—' },
              {
                key: 'data',
                header: 'รายละเอียด',
                cell: (r) =>
                  r.data ? (
                    <details className="max-w-xs text-sm text-ink-2">
                      <summary className="cursor-pointer">{auditSummary(r.data) || 'ดูข้อมูล'}</summary>
                      <pre className="mt-1 max-h-48 overflow-auto rounded bg-sunken p-2 text-left text-xs whitespace-pre-wrap break-all">{JSON.stringify(r.data, null, 1)}</pre>
                    </details>
                  ) : (
                    '—'
                  ),
              },
            ]}
          />
        )}
      </QueryView>
    </>
  );
}
