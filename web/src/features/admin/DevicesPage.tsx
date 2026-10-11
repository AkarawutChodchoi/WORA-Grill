import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MonitorSmartphone } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, ConfirmDialog, DataTable, EmptyState, Input, PageHeader, Panel, QueryView, Select, useToast } from '../../components/ui';
import { del, errorMessage, get, post } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';

interface Device {
  id: string;
  name: string;
  kind: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  createdAt: string;
  paired: boolean;
}

const KIND_LABEL: Record<string, string> = {
  POS: 'POS แคชเชียร์',
  WAITER: 'แท็บเล็ตพนักงานเสิร์ฟ',
  KDS: 'จอครัว',
  KIOSK: 'Kiosk สั่งเอง',
  PRINTER: 'เครื่องพิมพ์',
  CUSTOMER_DISPLAY: 'จอลูกค้า',
  EDC: 'เครื่อง EDC',
  CASH_DRAWER: 'ลิ้นชักเงิน',
};

export function DevicesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ['devices'], queryFn: () => get<{ devices: Device[] }>('/devices') });
  const terminal = useQuery({ queryKey: ['terminal'], queryFn: () => get<{ paired: boolean; device?: { name: string } }>('/auth/terminal') });
  const [name, setName] = useState('');
  const [kind, setKind] = useState('POS');
  const [revoke, setRevoke] = useState<Device | null>(null);
  const pair = useMutation({
    mutationFn: () => post('/auth/terminal', { name, kind }),
    onSuccess: () => {
      toast.success('ลงทะเบียนเครื่องนี้แล้ว พนักงานเข้าด้วย PIN ได้');
      setName('');
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['terminal'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const doRevoke = useMutation({
    mutationFn: (id: string) => del(`/devices/${id}`),
    onSuccess: () => {
      toast.success('ยกเลิกอุปกรณ์แล้ว');
      setRevoke(null);
      qc.invalidateQueries({ queryKey: ['devices'] });
      qc.invalidateQueries({ queryKey: ['terminal'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader title="อุปกรณ์" crumbs={[{ label: 'ระบบ' }]} description="ลงทะเบียนแท็บเล็ต/คอมพิวเตอร์หน้าร้าน เพื่อให้พนักงานเข้าใช้ด้วย PIN" />
      <Panel title="เครื่องนี้" className="mb-5">
        {terminal.data?.paired ? (
          <p className="text-ink-2">
            เครื่องนี้ลงทะเบียนแล้วในชื่อ <b>{terminal.data.device?.name}</b>
          </p>
        ) : (
          <form
            className="flex flex-wrap items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              pair.mutate();
            }}
          >
            <Input label="ชื่อเครื่อง" value={name} onChange={(e) => setName(e.target.value)} placeholder="เช่น POS เคาน์เตอร์ 1" required wrapClassName="min-w-56 flex-1" />
            <Select label="ใช้เป็น" value={kind} onChange={(e) => setKind(e.target.value)} wrapClassName="w-56">
              {['POS', 'WAITER', 'KDS', 'KIOSK'].map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
            <Button type="submit" loading={pair.isPending} disabled={!name}>
              ลงทะเบียนเครื่องนี้
            </Button>
          </form>
        )}
      </Panel>
      <QueryView query={list} isEmpty={(d) => d.devices.length === 0} empty={<EmptyState icon={<MonitorSmartphone className="size-8" />} title="ยังไม่มีอุปกรณ์ในสาขานี้" />}>
        {(d) => (
          <DataTable
            rows={d.devices}
            rowKey={(r) => r.id}
            columns={[
              { key: 'name', header: 'ชื่อ', cell: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'kind', header: 'ประเภท', cell: (r) => KIND_LABEL[r.kind] ?? r.kind },
              { key: 'status', header: 'สถานะ', cell: (r) => (r.revokedAt ? <Badge>ยกเลิกแล้ว</Badge> : <Badge tone="success">ใช้งาน</Badge>) },
              { key: 'seen', header: 'ใช้ล่าสุด', cell: (r) => fmtDateTime(r.lastSeenAt) },
              {
                key: 'act',
                header: '',
                align: 'right',
                cell: (r) =>
                  !r.revokedAt && (
                    <Button size="sm" variant="ghost" className="text-chili" onClick={() => setRevoke(r)}>
                      ยกเลิก
                    </Button>
                  ),
              },
            ]}
          />
        )}
      </QueryView>
      <ConfirmDialog
        open={!!revoke}
        title={`ยกเลิก "${revoke?.name}"?`}
        message="เครื่องนี้จะเข้าด้วย PIN ไม่ได้อีก จนกว่าจะลงทะเบียนใหม่"
        confirmLabel="ยกเลิกอุปกรณ์"
        danger
        loading={doRevoke.isPending}
        onConfirm={() => revoke && doRevoke.mutate(revoke.id)}
        onClose={() => setRevoke(null)}
      />
    </>
  );
}
