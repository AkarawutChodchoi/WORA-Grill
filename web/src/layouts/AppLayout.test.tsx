// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { Calculator, ChefHat } from 'lucide-react';
import { MemoryRouter, Route, Routes } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '../components/ui';
import { AuthProvider, type Me } from '../lib/auth';
import { visibleNav, type NavGroup } from '../nav';
import { AppLayout, RequireAuth, RequirePermission } from './AppLayout';

const baseMe: Me = {
  user: { id: 'u1', name: 'สมชาย', email: null },
  organization: { id: 'o1', name: 'ร้านทดสอบ' },
  branch: { id: 'b1', code: 'HQ', name: 'สาขาหลัก' },
  branches: [{ id: 'b1', code: 'HQ', name: 'สาขาหลัก' }],
  roles: ['WAITER'],
  permissions: ['order.create', 'table.view'],
  sessionKind: 'PIN',
};

function renderWith(me: Me | null, ui: React.ReactNode, path = '/') {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(me), { status: me ? 200 : 401 })));
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ToastProvider>
        <AuthProvider initial={me}>
          <MemoryRouter initialEntries={[path]}>{ui}</MemoryRouter>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('navigation shell', () => {
  const groups: NavGroup[] = [
    {
      label: 'หน้าร้าน',
      items: [
        { to: '/pos', label: 'POS', icon: Calculator, anyOf: ['order.create'] },
        { to: '/kds', label: 'จอครัว', icon: ChefHat, anyOf: ['kitchen.view'] },
      ],
    },
    { label: 'ระบบ', items: [{ to: '/admin/users', label: 'ผู้ใช้', icon: Calculator, anyOf: ['user.manage'] }] },
  ];

  it('filters navigation by permission and drops empty groups', () => {
    const v = visibleNav((p) => p === 'order.create', groups);
    expect(v).toHaveLength(1);
    expect(v[0].items.map((i) => i.to)).toEqual(['/pos']);
  });

  it('renders the shell with user and branch for a signed-in user', () => {
    renderWith(
      baseMe,
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<p>content</p>} />
        </Route>
      </Routes>,
    );
    expect(screen.getByText('content')).toBeInTheDocument();
    expect(screen.getAllByText('สมชาย').length).toBeGreaterThan(0);
    expect(screen.getByText('สาขาหลัก')).toBeInTheDocument();
    expect(screen.getAllByText('ร้านทดสอบ').length).toBeGreaterThan(0);
  });

  it('redirects anonymous users to the login page', () => {
    renderWith(
      null,
      <Routes>
        <Route path="/login" element={<p>login page</p>} />
        <Route
          path="/"
          element={
            <RequireAuth>
              <p>secret</p>
            </RequireAuth>
          }
        />
      </Routes>,
    );
    expect(screen.getByText('login page')).toBeInTheDocument();
    expect(screen.queryByText('secret')).not.toBeInTheDocument();
  });

  it('shows a forbidden state when the permission is missing', () => {
    renderWith(baseMe, <RequirePermission anyOf={['report.view_profit']}>profit</RequirePermission>);
    expect(screen.getByText('คุณไม่มีสิทธิ์เข้าหน้านี้')).toBeInTheDocument();
    expect(screen.queryByText('profit')).not.toBeInTheDocument();
  });
});
