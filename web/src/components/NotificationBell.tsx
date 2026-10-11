import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Bell } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { get, post } from '../lib/api';
import { fmtDateTime } from '../lib/format';
import { useLivePolling } from '../lib/realtime';
import { Button, Dialog } from './ui';

interface Notification {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  link: string | null;
  createdAt: string;
  read: boolean;
}

/** In-app notifications (low stock, web bookings, printer failures…). */
export function NotificationBell() {
  const qc = useQueryClient();
  const poll = useLivePolling();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => get<{ notifications: Notification[] }>('/notifications'), refetchInterval: poll });
  const unread = (q.data?.notifications ?? []).filter((n) => !n.read);
  const markRead = useMutation({
    mutationFn: (ids: string[]) => post('/notifications/read', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="relative rounded p-2 text-ink-2 hover:bg-sunken" aria-label={`การแจ้งเตือน ${unread.length} รายการที่ยังไม่อ่าน`}>
        <Bell className="size-5" />
        {unread.length > 0 && <span className="num absolute -top-0.5 -right-0.5 min-w-5 rounded-full bg-chili px-1 text-center text-[11px] font-semibold text-white">{unread.length}</span>}
      </button>
      {open && (
        <Dialog
          open
          onClose={() => setOpen(false)}
          title="การแจ้งเตือน"
          footer={
            unread.length > 0 && (
              <Button variant="outline" onClick={() => markRead.mutate(unread.map((n) => n.id))}>
                อ่านทั้งหมดแล้ว
              </Button>
            )
          }
        >
          <ul className="flex flex-col divide-y divide-line">
            {(q.data?.notifications ?? []).map((n) => (
              <li key={n.id} className={clsx('py-2', !n.read && 'font-medium')}>
                <div className="flex justify-between gap-2">
                  <span>{n.title}</span>
                  <span className="shrink-0 text-xs text-ink-3">{fmtDateTime(n.createdAt)}</span>
                </div>
                {n.body && <p className="text-sm font-normal text-ink-2">{n.body}</p>}
                {n.link && (
                  <Link to={n.link} className="text-sm font-normal text-sky hover:underline" onClick={() => (setOpen(false), markRead.mutate([n.id]))}>
                    ดูรายละเอียด
                  </Link>
                )}
              </li>
            ))}
            {q.data?.notifications.length === 0 && <li className="py-4 text-ink-3">ไม่มีการแจ้งเตือน</li>}
          </ul>
        </Dialog>
      )}
    </>
  );
}
