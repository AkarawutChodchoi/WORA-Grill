import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Checkbox, Dialog, Input, PageHeader, Panel, QueryView, useToast } from '../../components/ui';
import { errorMessage, get, post, put } from '../../lib/api';

interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

function RoleDialog({ role, perms, onClose }: { role: Role | 'new'; perms: { code: string; label: string }[]; onClose: () => void }) {
  const isNew = role === 'new';
  const r = isNew ? null : role;
  const readOnly = !!r?.isSystem;
  const [code, setCode] = useState(r?.code ?? '');
  const [name, setName] = useState(r?.name ?? '');
  const [selected, setSelected] = useState(new Set(r?.permissions ?? []));
  const qc = useQueryClient();
  const toast = useToast();
  const save = useMutation({
    mutationFn: () => (isNew ? post('/roles', { code, name, permissions: [...selected] }) : put(`/roles/${r!.id}`, { name, permissions: [...selected] })),
    onSuccess: () => {
      toast.success('บันทึกบทบาทแล้ว');
      qc.invalidateQueries({ queryKey: ['roles'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const groups = Object.entries(
    perms.reduce<Record<string, { code: string; label: string }[]>>((acc, p) => {
      (acc[p.code.split('.')[0]] ??= []).push(p);
      return acc;
    }, {}),
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? 'สร้างบทบาท' : r!.name}
      size="xl"
      footer={
        readOnly ? (
          <Button onClick={onClose}>ปิด</Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              ยกเลิก
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()} disabled={!name || (isNew && !code)}>
              บันทึก
            </Button>
          </>
        )
      }
    >
      {readOnly && <p className="mb-3 text-sm text-ink-2">บทบาทระบบแก้ไขไม่ได้ ถ้าต้องการปรับสิทธิ์ ให้สร้างบทบาทใหม่</p>}
      <div className="mb-4 grid gap-3 sm:grid-cols-2">
        {isNew && <Input label="รหัส" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} hint="A-Z 0-9 _ เช่น HOST" />}
        <Input label="ชื่อบทบาท" value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {groups.map(([g, list]) => (
          <fieldset key={g} className="rounded-control border border-line p-3">
            <legend className="px-1 text-sm font-medium text-ink-2">{g}</legend>
            <div className="flex flex-col gap-1.5">
              {list.map((p) => (
                <Checkbox
                  key={p.code}
                  label={p.label}
                  disabled={readOnly}
                  checked={selected.has(p.code)}
                  onChange={(e) => {
                    const s = new Set(selected);
                    if (e.target.checked) s.add(p.code);
                    else s.delete(p.code);
                    setSelected(s);
                  }}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>
    </Dialog>
  );
}

export function RolesPage() {
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<{ roles: Role[] }>('/roles') });
  const perms = useQuery({ queryKey: ['permissions'], queryFn: () => get<{ permissions: { code: string; label: string }[] }>('/permissions') });
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="บทบาท"
        crumbs={[{ label: 'ระบบ' }]}
        description="บทบาทคือชุดสิทธิ์ย่อย มอบให้ผู้ใช้ได้รายสาขา"
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            สร้างบทบาท
          </Button>
        }
      />
      <QueryView query={roles}>
        {(d) => (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {d.roles.map((r) => (
              <button key={r.id} type="button" onClick={() => setEditing(r)} className="text-left">
                <Panel className="h-full hover:border-brand">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">{r.name}</span>
                    {r.isSystem && <Badge>ระบบ</Badge>}
                  </div>
                  <p className="mt-1 text-sm text-ink-2">{r.permissions.length} สิทธิ์</p>
                </Panel>
              </button>
            ))}
          </div>
        )}
      </QueryView>
      {editing && perms.data && <RoleDialog role={editing} perms={perms.data.permissions} onClose={() => setEditing(null)} />}
    </>
  );
}
