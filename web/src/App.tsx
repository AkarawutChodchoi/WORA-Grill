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
import { AppLayout, RequireAuth, RequirePermission } from './layouts/AppLayout';
import type { Permission } from '@shared/permissions';
import { ApiError } from './lib/api';
import { AuthProvider } from './lib/auth';

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
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
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
          <BrowserRouter>
            <AppRoutes />
          </BrowserRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
