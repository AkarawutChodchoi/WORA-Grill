import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Checkbox, DataTable, Dialog, EmptyState, Input, PageHeader, QueryView, Select, useToast } from '../../components/ui';
import { errorMessage, get, patch, post, put } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { fmtDateTime } from '../../lib/format';

interface RoleAssignment {
  roleId: string;
  branchId: string | null;
  roleCode?: string;
  roleName?: string;
}
interface UserRow {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  isActive: boolean;
  hasPin: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  roles: RoleAssignment[];
}
interface Role {
  id: string;
  code: string;
  name: string;
  isSystem: boolean;
  permissions: string[];
}

export function useRolesAndBranches() {
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => get<{ roles: Role[] }>('/roles') });
  const branches = useQuery({ queryKey: ['branches'], queryFn: () => get<{ branches: { id: string; name: string }[] }>('/branches') });
  return { roles: roles.data?.roles ?? [], branches: branches.data?.branches ?? [] };
}

function UserDialog({ user, onClose }: { user: UserRow | null | 'new'; onClose: () => void }) {
  const isNew = user === 'new';
  const u = isNew ? null : user;
  const qc = useQueryClient();
  const toast = useToast();
  const { roles, branches } = useRolesAndBranches();
  const [form, setForm] = useState({
    name: u?.name ?? '',
    email: u?.email ?? '',
    phone: u?.phone ?? '',
    password: '',
    pin: '',
    isActive: u?.isActive ?? true,
  });
  const [assignments, setAssignments] = useState<RoleAssignment[]>(u?.roles.map((r) => ({ roleId: r.roleId, branchId: r.branchId })) ?? []);
  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name,
        email: form.email || null,
        phone: form.phone || null,
        password: form.password || undefined,
        pin: form.pin || undefined,
      };
      if (isNew) return post('/users', { ...body, roles: assignments });
      await patch(`/users/${u!.id}`, { ...body, isActive: form.isActive });
      const before = JSON.stringify(u!.roles.map((r) => [r.roleId, r.branchId]).sort());
      const after = JSON.stringify(assignments.map((r) => [r.roleId, r.branchId]).sort());
      if (before !== after) await put(`/users/${u!.id}/roles`, { roles: assignments });
    },
    onSuccess: () => {
      toast.success(isNew ? 'เพิ่มผู้ใช้แล้ว' : 'บันทึกผู้ใช้แล้ว');
      qc.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (!user) return null;
  return (
    <Dialog
      open
      onClose={onClose}
      title={isNew ? 'เพิ่มผู้ใช้' : `แก้ไข ${u!.name}`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()} disabled={!form.name || assignments.length === 0}>
            บันทึก
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="ชื่อ" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <Input label="เบอร์โทร" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        <Input label="อีเมล (สำหรับเข้าหลังร้าน)" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <Input
          label={isNew ? 'รหัสผ่าน' : 'ตั้งรหัสผ่านใหม่'}
          type="password"
          autoComplete="new-password"
          value={form.password}
          hint="อย่างน้อย 10 ตัวอักษร เว้นว่างถ้าไม่เปลี่ยน"
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        <Input
          label={isNew ? 'PIN หน้าร้าน' : u?.hasPin ? 'ตั้ง PIN ใหม่' : 'ตั้ง PIN'}
          inputMode="numeric"
          value={form.pin}
          hint="ตัวเลข 4–6 หลัก"
          onChange={(e) => setForm({ ...form, pin: e.target.value.replace(/\D/g, '').slice(0, 6) })}
        />
        {!isNew && <Checkbox className="self-end pb-2" label="เปิดใช้งาน" checked={form.isActive} onChange={(e) => setForm({ ...form, isActive: e.target.checked })} />}
      </div>
      <h3 className="mt-5 mb-2 font-semibold">บทบาทและสาขา</h3>
      <div className="flex flex-col gap-2">
        {assignments.map((a, i) => (
          <div key={i} className="flex items-end gap-2">
            <Select
              label={i === 0 ? 'บทบาท' : undefined}
              wrapClassName="flex-1"
              value={a.roleId}
              onChange={(e) => setAssignments(assignments.map((x, j) => (j === i ? { ...x, roleId: e.target.value } : x)))}
            >
              {roles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </Select>
            <Select
              label={i === 0 ? 'สาขา' : undefined}
              wrapClassName="flex-1"
              value={a.branchId ?? ''}
              onChange={(e) => setAssignments(assignments.map((x, j) => (j === i ? { ...x, branchId: e.target.value || null } : x)))}
            >
              <option value="">ทุกสาขา</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
            <Button variant="ghost" aria-label="ลบบทบาท" icon={<Trash2 className="size-4" />} onClick={() => setAssignments(assignments.filter((_, j) => j !== i))} />
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="self-start"
          icon={<Plus className="size-4" />}
          disabled={roles.length === 0}
          onClick={() => setAssignments([...assignments, { roleId: roles.find((r) => r.code === 'WAITER')?.id ?? roles[0].id, branchId: branches[0]?.id ?? null }])}
        >
          เพิ่มบทบาท
        </Button>
      </div>
    </Dialog>
  );
}

export function UsersPage() {
  const { me } = useAuth();
  const [editing, setEditing] = useState<UserRow | null | 'new'>(null);
  const [q, setQ] = useState('');
  const users = useQuery({ queryKey: ['users', q], queryFn: () => get<{ users: UserRow[] }>(`/users${q ? `?q=${encodeURIComponent(q)}` : ''}`) });
  const branchName = (id: string | null) => (id ? (me?.branches.find((b) => b.id === id)?.name ?? 'สาขาอื่น') : 'ทุกสาขา');
  return (
    <>
      <PageHeader
        title="ผู้ใช้และสิทธิ์"
        crumbs={[{ label: 'ระบบ' }]}
        actions={
          <Button icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>
            เพิ่มผู้ใช้
          </Button>
        }
      />
      <Input placeholder="ค้นหาชื่อหรืออีเมล" value={q} onChange={(e) => setQ(e.target.value)} wrapClassName="mb-3 max-w-sm" aria-label="ค้นหา" />
      <QueryView query={users} isEmpty={(d) => d.users.length === 0} empty={<EmptyState title="ยังไม่มีผู้ใช้" />}>
        {(d) => (
          <DataTable
            rows={d.users}
            rowKey={(r) => r.id}
            onRowClick={setEditing}
            columns={[
              { key: 'name', header: 'ชื่อ', cell: (r) => <span className="font-medium">{r.name}</span> },
              { key: 'email', header: 'อีเมล', cell: (r) => r.email ?? <span className="text-ink-3">—</span> },
              {
                key: 'roles',
                header: 'บทบาท',
                cell: (r) => (
                  <div className="flex flex-wrap gap-1">
                    {r.roles.map((x) => (
                      <Badge key={x.roleId + x.branchId}>
                        {x.roleName} · {branchName(x.branchId)}
                      </Badge>
                    ))}
                  </div>
                ),
              },
              { key: 'pin', header: 'PIN', cell: (r) => (r.hasPin ? 'ตั้งแล้ว' : '—') },
              {
                key: 'status',
                header: 'สถานะ',
                cell: (r) =>
                  !r.isActive ? <Badge>ปิดใช้งาน</Badge> : r.lockedUntil && new Date(r.lockedUntil) > new Date() ? <Badge tone="danger">ถูกล็อก</Badge> : <Badge tone="success">ใช้งาน</Badge>,
              },
              { key: 'last', header: 'เข้าใช้ล่าสุด', cell: (r) => fmtDateTime(r.lastLoginAt) },
            ]}
          />
        )}
      </QueryView>
      {editing && <UserDialog user={editing} onClose={() => setEditing(null)} />}
    </>
  );
}
