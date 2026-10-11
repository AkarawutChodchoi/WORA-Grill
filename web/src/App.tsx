import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';
import { EmptyState, ToastProvider } from './components/ui';
import { HomePage } from './features/home/HomePage';
import { AppLayout, RequireAuth } from './layouts/AppLayout';
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

export function AppRoutes() {
  return (
    <Routes>
      <Route
        element={
          <RequireAuth>
            <AppLayout />
          </RequireAuth>
        }
      >
        <Route index element={<HomePage />} />
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
