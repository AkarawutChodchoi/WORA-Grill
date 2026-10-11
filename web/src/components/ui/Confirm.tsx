import { useState, type ReactNode } from 'react';
import { Button } from './Button';
import { Dialog } from './Dialog';
import { Textarea } from './Field';

interface ConfirmProps {
  open: boolean;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** When set, a reason must be typed before confirming. */
  requireReason?: boolean;
  loading?: boolean;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

export function ConfirmDialog({ open, title, message, confirmLabel, danger, requireReason, loading, onConfirm, onClose }: ConfirmProps) {
  const [reason, setReason] = useState('');
  const invalid = requireReason && reason.trim().length < 3;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            ยกเลิก
          </Button>
          <Button variant={danger ? 'danger-solid' : 'primary'} disabled={invalid} loading={loading} onClick={() => onConfirm(reason.trim())}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message && <div className="mb-3 text-ink-2">{message}</div>}
      {requireReason && (
        <Textarea label="เหตุผล" required value={reason} onChange={(e) => setReason(e.target.value)} hint="อย่างน้อย 3 ตัวอักษร จะถูกบันทึกในประวัติการใช้งาน" />
      )}
    </Dialog>
  );
}
