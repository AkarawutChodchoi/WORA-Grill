import { clsx } from 'clsx';
import type { ReactNode } from 'react';

export type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'info';
const tones: Record<Tone, string> = {
  neutral: 'bg-sunken text-ink-2',
  success: 'bg-basil-50 text-basil-600',
  warning: 'bg-turmeric-50 text-[#7A5806]',
  danger: 'bg-chili-50 text-chili',
  info: 'bg-sky-50 text-sky',
};

export function Badge({ tone = 'neutral', children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <span className={clsx('inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs font-medium whitespace-nowrap', tones[tone], className)}>{children}</span>;
}

const STATUS: Record<string, [string, Tone]> = {
  OPEN: ['เปิดอยู่', 'info'],
  BILL_REQUESTED: ['เรียกเช็กบิล', 'warning'],
  PAID: ['ชำระแล้ว', 'success'],
  CLOSED: ['ปิดแล้ว', 'neutral'],
  VOIDED: ['Void', 'danger'],
  PENDING: ['ยังไม่ส่ง', 'neutral'],
  SENT: ['ส่งครัวแล้ว', 'info'],
  PREPARING: ['กำลังทำ', 'warning'],
  READY: ['พร้อมเสิร์ฟ', 'success'],
  SERVED: ['เสิร์ฟแล้ว', 'neutral'],
  CANCELLED: ['ยกเลิก', 'danger'],
  AVAILABLE: ['ว่าง', 'success'],
  OCCUPIED: ['มีลูกค้า', 'info'],
  WAITING_FOOD: ['รออาหาร', 'warning'],
  DINING: ['ทานอยู่', 'info'],
  CLEANING: ['รอทำความสะอาด', 'neutral'],
  DRAFT: ['ร่าง', 'neutral'],
  SUBMITTED: ['รออนุมัติ', 'warning'],
  APPROVED: ['อนุมัติแล้ว', 'info'],
  ORDERED: ['สั่งซื้อแล้ว', 'info'],
  PARTIAL: ['รับบางส่วน', 'warning'],
  RECEIVED: ['รับครบ', 'success'],
  REJECTED: ['ไม่อนุมัติ', 'danger'],
  ACTIVE: ['ใช้งาน', 'success'],
  INACTIVE: ['ปิดใช้งาน', 'neutral'],
  BOOKED: ['จองแล้ว', 'info'],
  CONFIRMED: ['ยืนยันแล้ว', 'success'],
  SEATED: ['นั่งแล้ว', 'info'],
  NO_SHOW: ['ไม่มา', 'danger'],
  WAITING: ['รอคิว', 'warning'],
  CALLED: ['เรียกแล้ว', 'info'],
  LEFT: ['ออกจากคิว', 'neutral'],
  COMPLETED: ['เสร็จสิ้น', 'success'],
  REFUNDED: ['คืนเงินแล้ว', 'danger'],
  POSTED: ['บันทึกแล้ว', 'success'],
  PENDING_CONFIRMATION: ['รอยืนยัน', 'warning'],
  SHIPPED: ['ส่งแล้ว', 'info'],
};

export function StatusBadge({ status }: { status: string }) {
  const [label, tone] = STATUS[status] ?? [status, 'neutral' as Tone];
  return <Badge tone={tone}>{label}</Badge>;
}
