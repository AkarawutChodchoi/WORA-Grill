/**
 * Granular permissions (SPEC §2). Roles are bundles of these; role assignments are scoped to a branch
 * (or org-wide when branch is null). The server is the authority — the UI only uses these to hide controls.
 */
export const PERMISSIONS = {
  // Organisation / settings
  'org.manage': 'จัดการข้อมูลองค์กรและสาขา',
  'settings.manage': 'แก้ไขการตั้งค่าร้าน',
  'user.manage': 'จัดการผู้ใช้และสิทธิ์',
  'audit.view': 'ดู Audit Log',
  'device.manage': 'จัดการอุปกรณ์',
  // Menu
  'menu.view': 'ดูเมนู',
  'menu.manage': 'จัดการเมนู หมวด ตัวเลือก ราคา',
  'menu.sold_out': 'แจ้งเมนูหมด (86)',
  // Tables
  'table.view': 'ดูผังโต๊ะ',
  'table.manage': 'จัดการโซนและโต๊ะ',
  'table.operate': 'เปิด/ย้าย/รวมโต๊ะ',
  // Orders
  'order.view': 'ดูออเดอร์',
  'order.create': 'เปิดบิล/รับออเดอร์',
  'order.send': 'ส่งออเดอร์เข้าครัว',
  'order.cancel_item': 'ยกเลิกรายการที่ส่งครัวแล้ว',
  'order.void': 'Void บิล',
  'order.request_bill': 'เรียกเช็กบิล',
  'order.approve_qr': 'อนุมัติออเดอร์จาก QR',
  // Billing & payments
  'bill.discount': 'ให้ส่วนลด',
  'bill.discount_override': 'ให้ส่วนลดเกินเพดาน',
  'bill.split': 'แยก/รวมบิล',
  'payment.take': 'รับชำระเงิน',
  'payment.confirm_transfer': 'ยืนยันการโอน/PromptPay',
  'payment.refund': 'คืนเงิน',
  // Shifts & cash drawer
  'shift.open': 'เปิดกะ',
  'shift.close': 'ปิดกะ',
  'shift.view_all': 'ดูกะของทุกคน',
  'cash.pay_in_out': 'นำเงินเข้า/ออกลิ้นชัก',
  'cash.open_drawer': 'เปิดลิ้นชักโดยไม่มีการขาย',
  // Kitchen
  'kitchen.view': 'ดูจอครัว',
  'kitchen.update': 'เปลี่ยนสถานะรายการในครัว',
  // Inventory
  'inventory.view': 'ดูสต็อก',
  'inventory.manage': 'จัดการวัตถุดิบและสูตร',
  'stock.receive': 'รับของเข้า',
  'stock.issue': 'เบิกของ/โอนของ',
  'stock.count': 'นับสต็อก',
  'stock.adjust': 'ปรับยอดสต็อก',
  'stock.waste': 'บันทึกของเสีย',
  // Purchasing
  'purchase.view': 'ดูการจัดซื้อ',
  'purchase.create': 'สร้างใบขอซื้อ/ใบสั่งซื้อ',
  'purchase.approve': 'อนุมัติใบสั่งซื้อ',
  'supplier.manage': 'จัดการซัพพลายเออร์',
  // CRM & promotions
  'customer.view': 'ดูข้อมูลลูกค้า',
  'customer.manage': 'จัดการข้อมูลลูกค้า',
  'customer.export_pii': 'ส่งออก/ลบข้อมูลส่วนบุคคลลูกค้า (PDPA)',
  'loyalty.adjust': 'ปรับแต้มสะสมด้วยมือ',
  'promotion.manage': 'จัดการโปรโมชันและคูปอง',
  // Reports
  'report.view_sales': 'ดูรายงานยอดขาย',
  'report.view_profit': 'ดูรายงานกำไร/ต้นทุน',
  'report.view_staff': 'ดูรายงานพนักงาน/การควบคุม',
  'report.export': 'ส่งออกรายงาน',
  // Reservations & QR
  'reservation.manage': 'จัดการการจองและคิว',
  // Staff
  'staff.manage': 'จัดการพนักงานและตารางกะ',
  'attendance.self': 'ลงเวลาเข้า-ออกงานของตัวเอง',
  'attendance.manage': 'แก้ไขเวลาเข้า-ออกงาน',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const SYSTEM_ROLES = ['OWNER', 'MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'STOREKEEPER'] as const;
export type SystemRole = (typeof SYSTEM_ROLES)[number];

const WAITER: Permission[] = [
  'menu.view', 'table.view', 'table.operate', 'order.view', 'order.create', 'order.send',
  'order.request_bill', 'order.approve_qr', 'reservation.manage', 'attendance.self',
];
const CASHIER: Permission[] = [
  ...WAITER, 'bill.discount', 'bill.split', 'payment.take', 'payment.confirm_transfer',
  'shift.open', 'shift.close', 'cash.pay_in_out', 'customer.view', 'customer.manage',
];
const KITCHEN: Permission[] = ['menu.view', 'menu.sold_out', 'kitchen.view', 'kitchen.update', 'order.view', 'attendance.self'];
const STOREKEEPER: Permission[] = [
  'menu.view', 'inventory.view', 'stock.receive', 'stock.issue', 'stock.count', 'stock.waste',
  'purchase.view', 'attendance.self',
];
const MANAGER: Permission[] = ALL_PERMISSIONS.filter((p) => !['org.manage', 'customer.export_pii'].includes(p));

export const DEFAULT_ROLE_PERMISSIONS: Record<SystemRole, Permission[]> = {
  OWNER: ALL_PERMISSIONS,
  MANAGER,
  CASHIER: [...new Set(CASHIER)],
  WAITER,
  KITCHEN,
  STOREKEEPER,
};

export const ROLE_LABELS: Record<SystemRole, string> = {
  OWNER: 'เจ้าของ',
  MANAGER: 'ผู้จัดการสาขา',
  CASHIER: 'แคชเชียร์',
  WAITER: 'พนักงานเสิร์ฟ',
  KITCHEN: 'ครัว/บาร์',
  STOREKEEPER: 'สโตร์',
};

/** Permissions that, when the actor lacks them, may be granted for one action by a manager PIN approval. */
export const APPROVABLE_PERMISSIONS: Permission[] = [
  'order.void', 'order.cancel_item', 'bill.discount', 'bill.discount_override', 'payment.refund',
  'cash.open_drawer', 'cash.pay_in_out', 'stock.adjust',
];
