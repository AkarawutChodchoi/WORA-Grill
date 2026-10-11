import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Permission } from '@shared/permissions';
import { PERMISSIONS } from '@shared/permissions';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PinPad } from '../features/auth/PinPage';
import { Dialog, LoadingBlock, Select } from './ui';

export interface ApprovalValue {
  userId: string;
  pin: string;
}

/**
 * Manager PIN approval (SPEC §2). Opens only when the current user lacks `permission`;
 * the server re-checks the approver's PIN and permission.
 */
export function ApprovalDialog({ open, permission, onApproved, onClose }: { open: boolean; permission: Permission; onApproved: (a: ApprovalValue) => void; onClose: () => void }) {
  const approvers = useQuery({
    queryKey: ['approvers', permission],
    queryFn: () => get<{ approvers: { id: string; name: string }[] }>(`/auth/approvers?permission=${permission}`),
    enabled: open,
  });
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const list = approvers.data?.approvers ?? [];
  const chosen = userId || list[0]?.id || '';
  return (
    <Dialog open={open} onClose={onClose} title="ต้องให้ผู้จัดการอนุมัติ" size="sm">
      <p className="mb-3 flex items-center gap-2 text-sm text-ink-2">
        <ShieldCheck className="size-4 text-basil" />
        {PERMISSIONS[permission]}
      </p>
      {approvers.isLoading ? (
        <LoadingBlock rows={2} />
      ) : list.length === 0 ? (
        <p className="text-sm text-chili">ไม่มีผู้อนุมัติที่ตั้ง PIN ไว้ในสาขานี้</p>
      ) : (
        <>
          <Select label="ผู้อนุมัติ" value={chosen} onChange={(e) => setUserId(e.target.value)} wrapClassName="mb-4">
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
          <PinPad
            value={pin}
            onChange={setPin}
            onSubmit={() => {
              onApproved({ userId: chosen, pin });
              setPin('');
            }}
          />
        </>
      )}
    </Dialog>
  );
}

/**
 * Hook for running an action that may need approval: tries directly when the user has the permission,
 * otherwise asks for a manager PIN first.
 */
export function useApproval(permission: Permission) {
  const { can } = useAuth();
  const [pending, setPending] = useState<((a: ApprovalValue | null) => void) | null>(null);
  const request = (run: (approval: ApprovalValue | null) => void) => {
    if (can(permission)) run(null);
    else setPending(() => run);
  };
  const dialog = (
    <ApprovalDialog
      open={!!pending}
      permission={permission}
      onClose={() => setPending(null)}
      onApproved={(a) => {
        pending?.(a);
        setPending(null);
      }}
    />
  );
  return { request, dialog };
}
