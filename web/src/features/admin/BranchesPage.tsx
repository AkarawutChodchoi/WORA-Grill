import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Checkbox, DataTable, Dialog, Input, PageHeader, QueryView, Select, useToast } from '../../components/ui';
import { errorMessage, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';

interface Branch {
  id: string;
  code: string;
  name: string;
  address: string | null;
  phone: string | null;
  taxId: string | null;
  timezone: string;
  isCentralKitchen: boolean;
  archivedAt: string | null;
}

/** Organisation-level branch management (owner / org admin only). */
export function BranchesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const { refresh } = useAuth();
  const q = useQuery({ queryKey: ['org-branches'], queryFn: () => get<{ branches: Branch[] }>('/org/branches') });
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  const [f, setF] = useState<any>({});
  const open = (b: Branch | 'new') => {
    setEditing(b);
    setF(b === 'new' ? { name: '', code: '', address: '', phone: '', taxId: '', isCentralKitchen: false, copySettingsFromBranchId: '' } : { ...b, address: b.address ?? '', phone: b.phone ?? '', taxId: b.taxId ?? '' });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = { name: f.name, code: f.code, address: f.address || null, phone: f.phone || null, taxId: f.taxId || null, isCentralKitchen: f.isCentralKitchen };
      return editing === 'new' ? post('/org/branches', { ...body, copySettingsFromBranchId: f.copySettingsFromBranchId || undefined }) : patch(`/org/branches/${(editing as Branch).id}`, body);
    },
    onSuccess: async () => {
      toast.success('บันทึกสาขาแล้ว');
      setEditing(null);
      qc.invalidateQueries({ queryKey: ['org-branches'] });
      await refresh();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const archive = useMutation({
    mutationFn: (b: Branch) => patch(`/org/branches/${b.id}`, { archived: !b.archivedAt }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['org-branches'] }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <>
      <PageHeader
        title="สาขา"
        crumbs={[{ label: 'ระบบ' }]}
        description="เมนูเป็นเมนูกลางขององค์กร ราคาและการเปิด/ปิดขายปรับได้รายสาขา · มอบสิทธิ์พนักงานรายสาขาที่หน้า ผู้ใช้"
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => open('new')}>
            เพิ่มสาขา
          </Button>
        }
      />
      <QueryView query={q}>
        {(d) => (
          <DataTable
            rows={d.branches}
            rowKey={(r) => r.id}
            onRowClick={open}
            columns={[
              { key: 'c', header: 'รหัส', cell: (r) => <code>{r.code}</code> },
              { key: 'n', header: 'ชื่อ', cell: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'k', header: '', cell: (r) => (r.isCentralKitchen ? <Badge tone="info">ครัวกลาง</Badge> : null) },
              { key: 's', header: 'สถานะ', cell: (r) => (r.archivedAt ? <Badge>ปิดแล้ว</Badge> : <Badge tone="success">เปิด</Badge>) },
              {
                key: 'a',
                header: '',
                align: 'right',
                cell: (r) => (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      archive.mutate(r);
                    }}
                  >
                    {r.archivedAt ? 'เปิดใช้' : 'ปิดสาขา'}
                  </Button>
                ),
              },
            ]}
          />
        )}
      </QueryView>
      {editing && (
        <Dialog
          open
          onClose={() => setEditing(null)}
          title={editing === 'new' ? 'เพิ่มสาขา' : f.name}
          footer={
            <Button loading={save.isPending} disabled={!f.name || !f.code} onClick={() => save.mutate()}>
              บันทึก
            </Button>
          }
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <Input label="ชื่อสาขา" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
            <Input label="รหัสสาขา" required value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} hint="ใช้ในเลขที่เอกสาร" />
            <Input label="ที่อยู่" wrapClassName="sm:col-span-2" value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
            <Input label="โทร" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            <Input label="เลขผู้เสียภาษี" value={f.taxId} onChange={(e) => setF({ ...f, taxId: e.target.value.replace(/\D/g, '').slice(0, 13) })} />
            <Checkbox label="เป็นครัวกลาง (ผลิตและส่งวัตถุดิบให้สาขาอื่น)" checked={f.isCentralKitchen} onChange={(e) => setF({ ...f, isCentralKitchen: e.target.checked })} />
            {editing === 'new' && (
              <Select label="คัดลอกการตั้งค่าจาก" value={f.copySettingsFromBranchId} onChange={(e) => setF({ ...f, copySettingsFromBranchId: e.target.value })}>
                <option value="">ใช้ค่าเริ่มต้น</option>
                {q.data?.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Dialog>
      )}
    </>
  );
}
