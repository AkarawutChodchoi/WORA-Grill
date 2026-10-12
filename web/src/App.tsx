import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router';
import { EmptyState, ToastProvider } from './components/ui';
import { LoginPage } from './features/auth/LoginPage';
import { PinPage } from './features/auth/PinPage';
import { SetupPage } from './features/auth/SetupPage';
import { AppLayout, FullPageSpinner, RequireAuth, RequirePermission } from './layouts/AppLayout';
import type { Permission } from '@shared/permissions';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { RealtimeProvider } from './lib/realtime';
import { OfflineProvider } from './lib/offline';

// Each screen loads on demand: a guest scanning a table QR downloads only the QR menu, not the back office.
const AuditPage = lazy(() => import('./features/admin/AuditPage').then((m) => ({ default: m.AuditPage })));
const DevicesPage = lazy(() => import('./features/admin/DevicesPage').then((m) => ({ default: m.DevicesPage })));
const RolesPage = lazy(() => import('./features/admin/RolesPage').then((m) => ({ default: m.RolesPage })));
const UsersPage = lazy(() => import('./features/admin/UsersPage').then((m) => ({ default: m.UsersPage })));
const HomePage = lazy(() => import('./features/home/HomePage').then((m) => ({ default: m.HomePage })));
const MenuPage = lazy(() => import('./features/menu/MenuPage').then((m) => ({ default: m.MenuPage })));
const InventoryPage = lazy(() => import('./features/inventory/InventoryPage').then((m) => ({ default: m.InventoryPage })));
const PurchasingPage = lazy(() => import('./features/purchasing/PurchasingPage').then((m) => ({ default: m.PurchasingPage })));
const CustomersPage = lazy(() => import('./features/crm/CustomersPage').then((m) => ({ default: m.CustomersPage })));
const DashboardPage = lazy(() => import('./features/reports/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const GuestMenuPage = lazy(() => import('./features/guest/GuestMenuPage').then((m) => ({ default: m.GuestMenuPage })));
const BookingPage = lazy(() => import('./features/guest/QueuePage').then((m) => ({ default: m.BookingPage })));
const QueuePage = lazy(() => import('./features/guest/QueuePage').then((m) => ({ default: m.QueuePage })));
const ReservationsPage = lazy(() => import('./features/guest/ReservationsPage').then((m) => ({ default: m.ReservationsPage })));
const StaffPage = lazy(() => import('./features/staff/StaffPage').then((m) => ({ default: m.StaffPage })));
const BranchesPage = lazy(() => import('./features/admin/BranchesPage').then((m) => ({ default: m.BranchesPage })));
const ReportsPage = lazy(() => import('./features/reports/ReportsPage').then((m) => ({ default: m.ReportsPage })));
const PromotionsPage = lazy(() => import('./features/crm/PromotionsPage').then((m) => ({ default: m.PromotionsPage })));
const TablesPage = lazy(() => import('./features/tables/TablesPage').then((m) => ({ default: m.TablesPage })));
const OrderScreen = lazy(() => import('./features/pos/OrderScreen').then((m) => ({ default: m.OrderScreen })));
const PosHome = lazy(() => import('./features/pos/PosHome').then((m) => ({ default: m.PosHome })));
const PaymentScreen = lazy(() => import('./features/pos/PaymentScreen').then((m) => ({ default: m.PaymentScreen })));
const ReceiptPage = lazy(() => import('./features/pos/ReceiptPage').then((m) => ({ default: m.ReceiptPage })));
const ShiftPage = lazy(() => import('./features/shift/ShiftPage').then((m) => ({ default: m.ShiftPage })));
const KdsPage = lazy(() => import('./features/kds/KdsPage').then((m) => ({ default: m.KdsPage })));
const KitchenTicketPage = lazy(() => import('./features/kds/KitchenTicketPage').then((m) => ({ default: m.KitchenTicketPage })));
const SettingsPage = lazy(() => import('./features/admin/SettingsPage').then((m) => ({ default: m.SettingsPage })));

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        refetchOnWindowFocus: true,
        retry: (count, err) => !(err instanceof ApiError && err.status >= 400 && err.status < 500) && count < 2,
      },
    },
  });
}

const guard = (anyOf: Permission[], el: React.ReactNode) => <RequirePermission anyOf={anyOf}>{el}</RequirePermission>;

export function AppRoutes() {
  return (
    <Suspense fallback={<FullPageSpinner />}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/setup" element={<SetupPage />} />
      <Route path="/pin" element={<PinPage />} />
      <Route path="/m/:token" element={<GuestMenuPage />} />
      <Route path="/q/:token" element={<QueuePage />} />
      <Route path="/book/:branchId" element={<BookingPage />} />
      <Route
        path="/pos/orders/:id"
        element={
          <RequireAuth>
            {guard(['order.view', 'order.create'], <OrderScreen />)}
          </RequireAuth>
        }
      />
      <Route
        path="/pos/orders/:id/pay"
        element={
          <RequireAuth>
            {guard(['payment.take'], <PaymentScreen />)}
          </RequireAuth>
        }
      />
      <Route
        path="/kds"
        element={
          <RequireAuth>
            {guard(['kitchen.view'], <KdsPage />)}
          </RequireAuth>
        }
      />
      <Route
        path="/kitchen-ticket/:id"
        element={
          <RequireAuth>
            {guard(['kitchen.view', 'order.send'], <KitchenTicketPage />)}
          </RequireAuth>
        }
      />
      <Route
        path="/pos/orders/:id/receipt"
        element={
          <RequireAuth>
            {guard(['order.view', 'payment.take'], <ReceiptPage />)}
          </RequireAuth>
        }
      />
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
        <Route path="pos" element={guard(['order.view'], <PosHome />)} />
        <Route path="reservations" element={guard(['reservation.manage'], <ReservationsPage />)} />
        <Route path="shift" element={guard(['shift.open', 'shift.view_all'], <ShiftPage />)} />
        <Route path="staff" element={guard(['staff.manage', 'attendance.manage', 'attendance.self'], <StaffPage />)} />
        <Route path="admin/branches" element={guard(['org.manage'], <BranchesPage />)} />
        <Route path="admin/settings" element={guard(['settings.manage'], <SettingsPage />)} />
        <Route path="tables" element={guard(['table.view'], <TablesPage />)} />
        <Route path="inventory" element={guard(['inventory.view', 'stock.receive', 'stock.count', 'stock.waste'], <InventoryPage />)} />
        <Route path="purchasing" element={guard(['purchase.view', 'purchase.create', 'stock.receive'], <PurchasingPage />)} />
        <Route path="dashboard" element={guard(['report.view_sales'], <DashboardPage />)} />
        <Route path="reports" element={guard(['report.view_sales', 'report.view_profit', 'report.view_staff'], <ReportsPage />)} />
        <Route path="customers" element={guard(['customer.view'], <CustomersPage />)} />
        <Route path="promotions" element={guard(['promotion.manage'], <PromotionsPage />)} />
        <Route path="menu" element={guard(['menu.view'], <MenuPage />)} />
        <Route path="admin/users" element={guard(['user.manage'], <UsersPage />)} />
        <Route path="admin/roles" element={guard(['user.manage'], <RolesPage />)} />
        <Route path="admin/devices" element={guard(['device.manage'], <DevicesPage />)} />
        <Route path="admin/audit" element={guard(['audit.view'], <AuditPage />)} />
        <Route path="*" element={<EmptyState title="ไม่พบหน้านี้">ตรวจสอบลิงก์อีกครั้ง หรือกลับไปหน้าหลัก</EmptyState>} />
      </Route>
    </Routes>
    </Suspense>
  );
}

export function App({ client = makeQueryClient() }: { client?: QueryClient }) {
  return (
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AuthProvider>
          <RealtimeProvider>
            <OfflineProvider>
              <BrowserRouter>
                <AppRoutes />
              </BrowserRouter>
            </OfflineProvider>
          </RealtimeProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
