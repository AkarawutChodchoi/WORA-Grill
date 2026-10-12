import { useQuery } from '@tanstack/react-query';
import { ShieldCheck } from 'lucide-react';
import { useState } from 'react';
import type { Permission } from '@shared/permissions';
import { PERMISSIONS } from '@shared/permissions';
import { errorMessage, get } from '../lib/api';
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
export function ApprovalDialog({ open, permission, onApproved, onClose }: { open: boolean; permission: Permission; onApproved: (a: ApprovalValue) => Promise<void>; onClose: () => void }) {
  const approvers = useQuery({
    queryKey: ['approvers', permission],
    queryFn: () => get<{ approvers: { id: string; name: string }[] }>(`/auth/approvers?permission=${permission}`),
    enabled: open,
  });
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const list = approvers.data?.approvers ?? [];
  const chosen = userId || list[0]?.id || '';
  return (
    <Dialog open={open} onClose={onClose} title="ต้องให้ผู้จัดการอนุมัติ" size="sm">
      <p className="mb-3 flex items-center gap-2 text-sm text-ink-2">
        <ShieldCheck className="size-4 text-brand" />
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
            onChange={(v) => {
              setPin(v);
              setError(null);
            }}
            onSubmit={async () => {
              if (busy) return;
              setBusy(true);
              try {
                // Stay open until the server accepts the PIN, so a typo only means typing it again.
                await onApproved({ userId: chosen, pin });
              } catch (e) {
                setError(`${errorMessage(e)} — ลองใส่ PIN อีกครั้ง`);
              } finally {
                setPin('');
                setBusy(false);
              }
            }}
          />
          {busy && <p className="mt-2 text-center text-sm text-ink-3" role="status">กำลังตรวจสอบ…</p>}
          {error && (
            <p className="mt-2 text-center text-sm text-chili" role="alert">
              {error}
            </p>
          )}
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
  const [pending, setPending] = useState<((a: ApprovalValue | null) => unknown) | null>(null);
  /** `run` may return a promise (e.g. `mutation.mutateAsync`): the PIN dialog then stays open if it fails. */
  const request = (run: (approval: ApprovalValue | null) => unknown) => {
    if (can(permission)) void Promise.resolve(run(null)).catch(() => undefined); // errors are already shown by the mutation
    else setPending(() => run);
  };
  const dialog = (
    <ApprovalDialog
      open={!!pending}
      permission={permission}
      onClose={() => setPending(null)}
      onApproved={async (a) => {
        await pending?.(a);
        setPending(null);
      }}
    />
  );
  return { request, dialog };
}
