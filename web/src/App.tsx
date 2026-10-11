import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';
import { EmptyState, ToastProvider } from './components/ui';
import { AuditPage } from './features/admin/AuditPage';
import { DevicesPage } from './features/admin/DevicesPage';
import { RolesPage } from './features/admin/RolesPage';
import { UsersPage } from './features/admin/UsersPage';
import { LoginPage } from './features/auth/LoginPage';
import { PinPage } from './features/auth/PinPage';
import { SetupPage } from './features/auth/SetupPage';
import { HomePage } from './features/home/HomePage';
import { MenuPage } from './features/menu/MenuPage';
import { InventoryPage } from './features/inventory/InventoryPage';
import { PurchasingPage } from './features/purchasing/PurchasingPage';
import { CustomersPage } from './features/crm/CustomersPage';
import { DashboardPage } from './features/reports/DashboardPage';
import { GuestMenuPage } from './features/guest/GuestMenuPage';
import { BookingPage, QueuePage } from './features/guest/QueuePage';
import { ReservationsPage } from './features/guest/ReservationsPage';
import { StaffPage } from './features/staff/StaffPage';
import { BranchesPage } from './features/admin/BranchesPage';
import { ReportsPage } from './features/reports/ReportsPage';
import { PromotionsPage } from './features/crm/PromotionsPage';
import { TablesPage } from './features/tables/TablesPage';
import { OrderScreen } from './features/pos/OrderScreen';
import { PosHome } from './features/pos/PosHome';
import { PaymentScreen } from './features/pos/PaymentScreen';
import { ReceiptPage } from './features/pos/ReceiptPage';
import { ShiftPage } from './features/shift/ShiftPage';
import { KdsPage } from './features/kds/KdsPage';
import { KitchenTicketPage } from './features/kds/KitchenTicketPage';
import { SettingsPage } from './features/admin/SettingsPage';
import { AppLayout, RequireAuth, RequirePermission } from './layouts/AppLayout';
import type { Permission } from '@shared/permissions';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';
import { RealtimeProvider } from './lib/realtime';
import { OfflineProvider } from './lib/offline';

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
