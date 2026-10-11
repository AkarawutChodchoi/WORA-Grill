import type { LucideIcon } from 'lucide-react';
import { BarChart3, CalendarClock, Boxes, Gauge, Gift, Truck, UserRound, BookOpen, Calculator, ChefHat, Grid3x3, Settings, Wallet, History, LayoutDashboard, MonitorSmartphone, ShieldCheck, Users } from 'lucide-react';
import type { Permission } from '@shared/permissions';

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Shown when the user has ANY of these permissions (empty = any signed-in user). */
  anyOf: Permission[];
  /** Full-screen operational surfaces (POS, KDS) open without the back-office rail. */
  fullscreen?: boolean;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/**
 * Only modules that actually exist are listed here; each prompt adds its own entries.
 * The server enforces the same permissions on every API call.
 */
export const NAV: NavGroup[] = [
  {
    label: 'ภาพรวม',
    items: [{ to: '/', label: 'หน้าหลัก', icon: LayoutDashboard, anyOf: [] }],
  },
  {
    label: 'หน้าร้าน',
    items: [
      { to: '/pos', label: 'POS / บิล', icon: Calculator, anyOf: ['order.view'] },
      { to: '/tables', label: 'ผังโต๊ะ', icon: Grid3x3, anyOf: ['table.view'] },
      { to: '/reservations', label: 'การจอง / คิว', icon: CalendarClock, anyOf: ['reservation.manage'] },
      { to: '/kds', label: 'จอครัว (KDS)', icon: ChefHat, anyOf: ['kitchen.view'], fullscreen: true },
      { to: '/shift', label: 'กะ / ลิ้นชักเงิน', icon: Wallet, anyOf: ['shift.open', 'shift.view_all'] },
    ],
  },
  {
    label: 'หลังร้าน',
    items: [
      { to: '/menu', label: 'เมนู', icon: BookOpen, anyOf: ['menu.view'] },
      { to: '/inventory', label: 'สต็อก', icon: Boxes, anyOf: ['inventory.view', 'stock.receive', 'stock.count', 'stock.waste'] },
      { to: '/purchasing', label: 'จัดซื้อ', icon: Truck, anyOf: ['purchase.view', 'purchase.create', 'stock.receive'] },
    ],
  },
  {
    label: 'บริหาร',
    items: [
      { to: '/dashboard', label: 'แดชบอร์ด', icon: Gauge, anyOf: ['report.view_sales'] },
      { to: '/reports', label: 'รายงาน', icon: BarChart3, anyOf: ['report.view_sales', 'report.view_profit', 'report.view_staff'] },
      { to: '/customers', label: 'ลูกค้า', icon: UserRound, anyOf: ['customer.view'] },
      { to: '/promotions', label: 'โปรโมชัน/สมาชิก', icon: Gift, anyOf: ['promotion.manage'] },
    ],
  },
  {
    label: 'ระบบ',
    items: [
      { to: '/admin/settings', label: 'ตั้งค่าร้าน', icon: Settings, anyOf: ['settings.manage'] },
      { to: '/admin/users', label: 'ผู้ใช้', icon: Users, anyOf: ['user.manage'] },
      { to: '/admin/roles', label: 'บทบาท', icon: ShieldCheck, anyOf: ['user.manage'] },
      { to: '/admin/devices', label: 'อุปกรณ์', icon: MonitorSmartphone, anyOf: ['device.manage'] },
      { to: '/admin/audit', label: 'Audit Log', icon: History, anyOf: ['audit.view'] },
    ],
  },
];

export function visibleNav(can: (p: Permission) => boolean, groups: NavGroup[] = NAV): NavGroup[] {
  return groups.map((g) => ({ ...g, items: g.items.filter((i) => i.anyOf.length === 0 || i.anyOf.some(can)) })).filter((g) => g.items.length > 0);
}
