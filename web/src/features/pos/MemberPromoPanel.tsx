import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Gift, UserPlus, UserRound, X } from 'lucide-react';
import { useState } from 'react';
import type { OrgSettings } from '@shared/settings';
import { Badge, Button, Dialog, Input, Panel, useToast } from '../../components/ui';
import { errorMessage, get, post } from '../../lib/api';
import { useTierName } from '../../lib/tiers';
import { useAuth } from '../../lib/auth';
import { formatBaht } from '../../lib/format';
import { CustomerForm } from '../crm/CustomersPage';
import type { Order } from './types';

/** Attach a member, apply promotions/coupons and redeem points — all validated by the server. */
export function MemberPromoPanel({ order }: { order: Order }) {
  const tierName = useTierName();
  const { can } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [points, setPoints] = useState('');
  const [creating, setCreating] = useState(false);
  const promos = useQuery({ queryKey: ['promos-available'], queryFn: () => get<{ promotions: { id: string; name: string; description: string | null }[] }>('/promotions/available') });
  const org = useQuery({ queryKey: ['org-loyalty'], queryFn: () => get<{ settings: OrgSettings }>('/settings/org').catch(() => null), staleTime: 300_000 });
  const setOrder = (o: Order) => qc.setQueryData(['order', order.id], o);
  const attach = useMutation({
    mutationFn: (customerId: string | null) => post<Order>(`/orders/${order.id}/customer`, { customerId }),
    onSuccess: setOrder,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const lookup = useMutation({
    mutationFn: () => get<{ customer: { id: string; name: string } | null }>(`/customers/lookup?phone=${encodeURIComponent(phone)}`),
    onSuccess: (r) => {
      if (r.customer) {
        attach.mutate(r.customer.id);
        setPhone('');
      } else toast.info('ไม่พบสมาชิกเบอร์นี้ — สมัครสมาชิกใหม่ได้');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const apply = useMutation({
    mutationFn: (body: { promotionId?: string; code?: string }) => post<{ amountSatang: number; order: Order }>(`/orders/${order.id}/promotions`, body),
    onSuccess: (r) => {
      setOrder(r.order);
      setCode('');
      toast.success(`ใช้โปรโมชันแล้ว ลด ${formatBaht(r.amountSatang)}`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const redeem = useMutation({
    mutationFn: () => post<Order>(`/orders/${order.id}/redeem-points`, { paymentId: crypto.randomUUID(), points: Number(points) }),
    onSuccess: (o) => {
      setOrder(o);
      setPoints('');
      toast.success('ใช้แต้มชำระแล้ว');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const c = order.customer;
  const loyalty = org.data?.settings.loyalty;
  const usedPromoIds = new Set(order.discounts.map((d) => d.promotionId).filter(Boolean));
  const canPromo = order.paidSatang === 0;
  return (
    <Panel title="สมาชิกและโปรโมชัน">
      {c ? (
        <div className="mb-3 flex items-start justify-between gap-2 rounded-control bg-basil-50 p-3">
          <div>
            <p className="flex items-center gap-2 font-medium">
              <UserRound className="size-4" /> {c.name} {c.tier && <Badge tone="info">{tierName(c.tier)}</Badge>}
            </p>
            <p className="text-sm text-ink-2">
              {c.phone} · แต้ม {c.pointsBalance.toLocaleString()}
            </p>
            {'allergies' in c && (c as any).allergies && <p className="text-sm font-medium text-chili">แพ้: {(c as any).allergies}</p>}
          </div>
          {order.paidSatang === 0 && (
            <Button size="sm" variant="ghost" aria-label="นำสมาชิกออก" icon={<X className="size-4" />} onClick={() => attach.mutate(null)} />
          )}
        </div>
      ) : (
        can('customer.view') && (
          <div className="mb-3 flex items-end gap-2">
            <Input label="เบอร์สมาชิก" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} wrapClassName="flex-1" onKeyDown={(e) => e.key === 'Enter' && phone && lookup.mutate()} />
            <Button variant="outline" loading={lookup.isPending} disabled={phone.replace(/\D/g, '').length < 9} onClick={() => lookup.mutate()}>
              ค้นหา
            </Button>
            {can('customer.manage') && <Button variant="outline" icon={<UserPlus className="size-4" />} onClick={() => setCreating(true)}>
                สมัคร
              </Button>}
          </div>
        )
      )}
      {canPromo && (
        <>
          <div className="mb-2 flex flex-wrap gap-2">
            {promos.data?.promotions
              .filter((p) => !usedPromoIds.has(p.id))
              .map((p) => (
                <Button key={p.id} size="sm" variant="outline" icon={<Gift className="size-4" />} loading={apply.isPending && apply.variables?.promotionId === p.id} onClick={() => apply.mutate({ promotionId: p.id })} title={p.description ?? undefined}>
                  {p.name}
                </Button>
              ))}
          </div>
          <div className="flex items-end gap-2">
            <Input label="รหัสคูปอง" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} wrapClassName="flex-1" />
            <Button variant="outline" disabled={code.length < 3} loading={apply.isPending && !!apply.variables?.code} onClick={() => apply.mutate({ code })}>
              ใช้คูปอง
            </Button>
          </div>
        </>
      )}
      {c && loyalty?.enabled && c.pointsBalance > 0 && can('payment.take') && (
        <div className="mt-3 flex items-end gap-2 border-t border-line pt-3">
          <Input label={`ใช้แต้ม (1 แต้ม = ${formatBaht(loyalty.pointValueSatang)})`} inputMode="numeric" value={points} onChange={(e) => setPoints(e.target.value.replace(/\D/g, ''))} wrapClassName="flex-1" />
          <Button variant="outline" disabled={!Number(points) || Number(points) > c.pointsBalance} loading={redeem.isPending} onClick={() => redeem.mutate()}>
            ใช้แต้ม
          </Button>
        </div>
      )}
      {creating && (
        <Dialog open onClose={() => setCreating(false)} title="สมัครสมาชิก" size="lg">
          <CustomerForm
            initial={{ phone }}
            onSaved={(cust) => {
              setCreating(false);
              attach.mutate(cust.id);
            }}
            onCancel={() => setCreating(false)}
          />
        </Dialog>
      )}
    </Panel>
  );
}
