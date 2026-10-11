import type { LucideIcon } from 'lucide-react';
import { History, LayoutDashboard, MonitorSmartphone, ShieldCheck, Users } from 'lucide-react';
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
    label: 'ระบบ',
    items: [
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
