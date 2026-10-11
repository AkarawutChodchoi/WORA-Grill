import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Printer, XCircle } from 'lucide-react';
import { useState } from 'react';
import { Button, Checkbox, Input, Panel, Select, useToast } from '../../components/ui';
import { errorMessage, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';

interface Station {
  id: string;
  code: string;
  name: string;
}

/** Add a LAN thermal printer (ESC/POS over TCP 9100) for receipts or a kitchen station. */
export function PrinterSetup() {
  const qc = useQueryClient();
  const toast = useToast();
  const stations = useQuery({ queryKey: ['stations'], queryFn: () => get<{ stations: Station[] }>('/stations') });
  const [f, setF] = useState({ name: '', host: '', port: 9100, width: 48, codePage: 21, role: 'RECEIPT', stationId: '', openDrawer: true });
  const add = useMutation({
    mutationFn: () =>
      post('/devices/printers', {
        name: f.name,
        stationId: f.role === 'KITCHEN' && f.stationId ? f.stationId : null,
        config: { host: f.host, port: Number(f.port), width: Number(f.width), codePage: Number(f.codePage), role: f.role, openDrawer: f.role === 'RECEIPT' && f.openDrawer },
      }),
    onSuccess: () => {
      toast.success('เพิ่มเครื่องพิมพ์แล้ว — กด "ทดสอบพิมพ์" ในรายการด้านล่าง');
      qc.invalidateQueries({ queryKey: ['devices'] });
      setF({ ...f, name: '', host: '' });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Panel title="เพิ่มเครื่องพิมพ์ (LAN)" className="mb-5">
      <div className="grid gap-3 sm:grid-cols-4">
        <Input label="ชื่อ" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="เช่น ครัวร้อน" />
        <Input label="IP" value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="192.168.1.50" />
        <Input label="Port" type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) })} />
        <Select label="ใช้สำหรับ" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="RECEIPT">ใบเสร็จ</option>
          <option value="KITCHEN">ใบสั่งครัว</option>
        </Select>
        <Select label="ขนาดกระดาษ" value={f.width} onChange={(e) => setF({ ...f, width: Number(e.target.value) })}>
          <option value={48}>80 มม. (48 ตัวอักษร)</option>
          <option value={42}>80 มม. (42 ตัวอักษร)</option>
          <option value={32}>58 มม. (32 ตัวอักษร)</option>
        </Select>
        <Input label="Code page ภาษาไทย (ESC t)" type="number" min={0} max={255} value={f.codePage} onChange={(e) => setF({ ...f, codePage: Number(e.target.value) })} hint="ดูคู่มือเครื่องพิมพ์ (TIS-620)" />
        {f.role === 'KITCHEN' ? (
          <Select label="สเตชัน" value={f.stationId} onChange={(e) => setF({ ...f, stationId: e.target.value })}>
            <option value="">ทุกสเตชัน</option>
            {stations.data?.stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        ) : (
          <Checkbox className="self-end pb-2" label="ต่อลิ้นชักเงิน" checked={f.openDrawer} onChange={(e) => setF({ ...f, openDrawer: e.target.checked })} />
        )}
        <Button className="self-end" icon={<Printer className="size-4" />} loading={add.isPending} disabled={!f.name || !f.host} onClick={() => add.mutate()}>
          เพิ่ม
        </Button>
      </div>
    </Panel>
  );
}

export function DeviceActions({ d }: { d: { id: string; kind: string; stationId: string | null; revokedAt: string | null } }) {
  const toast = useToast();
  const qc = useQueryClient();
  const stations = useQuery({ queryKey: ['stations'], queryFn: () => get<{ stations: Station[] }>('/stations'), enabled: d.kind === 'KDS' });
  const test = useMutation({
    mutationFn: () => post(`/devices/${d.id}/test-print`),
    onSuccess: () => toast.success('ส่งหน้าทดสอบแล้ว'),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const bind = useMutation({
    mutationFn: (stationId: string | null) => patch(`/devices/${d.id}`, { stationId }),
    onSuccess: () => {
      toast.success('ผูกสเตชันแล้ว');
      qc.invalidateQueries({ queryKey: ['devices'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  if (d.revokedAt) return null;
  if (d.kind === 'PRINTER')
    return (
      <Button size="sm" variant="outline" loading={test.isPending} onClick={() => test.mutate()}>
        ทดสอบพิมพ์
      </Button>
    );
  if (d.kind === 'KDS')
    return (
      <select aria-label="สเตชันของจอนี้" className="h-8 rounded-control border border-line-strong px-2 text-sm" value={d.stationId ?? ''} onChange={(e) => bind.mutate(e.target.value || null)}>
        <option value="">ทุกสเตชัน</option>
        {stations.data?.stations.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </select>
    );
  return null;
}

export function IntegrationStatus() {
  const { can } = useAuth();
  const q = useQuery({ queryKey: ['integrations'], queryFn: () => get<any>('/integrations/status'), enabled: can('settings.manage') });
  if (!q.data) return null;
  const Row = ({ ok, label, note }: { ok: boolean; label: string; note?: string }) => (
    <li className="flex items-start gap-2">
      {ok ? <CheckCircle2 className="mt-0.5 size-4 text-basil" /> : <XCircle className="mt-0.5 size-4 text-ink-3" />}
      <span>
        {label} — {ok ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า (ปิดอยู่)'}
        {note && <span className="block text-xs text-ink-3">{note}</span>}
      </span>
    </li>
  );
  const d = q.data;
  return (
    <Panel title="การเชื่อมต่อภายนอก" className="mt-5">
      <ul className="flex flex-col gap-2 text-sm">
        <Row ok={d.paymentGateway.enabled} label="Payment Gateway (PromptPay ยืนยันอัตโนมัติ)" note={d.paymentGateway.enabled && !d.paymentGateway.webhookVerified ? 'ยังไม่มี webhook secret — จะยืนยันอัตโนมัติไม่ได้' : 'ตั้งค่าด้วย OPN_SECRET_KEY / OPN_WEBHOOK_SECRET'} />
        <Row ok={d.line.enabled} label="LINE แจ้งเตือนพนักงาน" note="LINE_CHANNEL_ACCESS_TOKEN + LINE_NOTIFY_TO" />
        <Row ok={d.delivery.enabled} label="Delivery platforms" note={d.delivery.note} />
        <Row ok={d.printers.length > 0} label={`เครื่องพิมพ์ ${d.printers.length} เครื่อง`} />
        <Row ok={d.email.enabled} label="อีเมล" note={d.email.note} />
      </ul>
    </Panel>
  );
}
