import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { BranchSettings } from '@shared/settings';
import { Button, Checkbox, Input, PageHeader, Panel, QueryView, Select, Textarea, useToast } from '../../components/ui';
import { errorMessage, put } from '../../lib/api';
import { METHOD_LABEL, useBranchSettings, type BranchInfo } from '../../lib/settings';
import { CHANNEL_LABEL } from '../menu/ItemDialog';

const pct = (bps: number) => String(bps / 100);
const bps = (v: string) => Math.round(Number(v || '0') * 100);

function SettingsForm({ data }: { data: BranchInfo }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [b, setB] = useState(data.branch);
  const [s, setS] = useState<BranchSettings>(data.settings);
  const [vat, setVat] = useState(pct(data.settings.vatBps));
  const [sc, setSc] = useState(pct(data.settings.serviceChargeBps));
  const [maxDisc, setMaxDisc] = useState(pct(data.settings.maxDiscountBps));
  useEffect(() => setB(data.branch), [data.branch]);
  const save = useMutation({
    mutationFn: () =>
      put('/settings/branch', {
        name: b.name,
        address: b.address || null,
        phone: b.phone || null,
        taxId: b.taxId || null,
        timezone: b.timezone,
        settings: { ...s, vatBps: bps(vat), serviceChargeBps: bps(sc), maxDiscountBps: bps(maxDisc) },
      }),
    onSuccess: () => {
      toast.success('บันทึกการตั้งค่าแล้ว (ใช้กับบิลที่เปิดใหม่)');
      qc.invalidateQueries({ queryKey: ['branch-settings'] });
      qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const toggleIn = (key: 'enabledPaymentMethods' | 'serviceChargeChannels', v: string) => {
    const list = s[key] as string[];
    setS({ ...s, [key]: list.includes(v) ? list.filter((x) => x !== v) : [...list, v] } as BranchSettings);
  };
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <Panel title="ข้อมูลร้าน/สาขา">
        <div className="grid gap-3 sm:grid-cols-2">
          <Input label="ชื่อสาขา (แสดงบนใบเสร็จ)" required value={b.name} onChange={(e) => setB({ ...b, name: e.target.value })} />
          <Input label="โทรศัพท์" value={b.phone ?? ''} onChange={(e) => setB({ ...b, phone: e.target.value })} />
          <Textarea label="ที่อยู่" wrapClassName="sm:col-span-2" value={b.address ?? ''} onChange={(e) => setB({ ...b, address: e.target.value })} />
          <Input
            label="เลขประจำตัวผู้เสียภาษี"
            inputMode="numeric"
            value={b.taxId ?? ''}
            onChange={(e) => setB({ ...b, taxId: e.target.value.replace(/\D/g, '').slice(0, 13) })}
            hint="ใส่เมื่อจดทะเบียน VAT แล้ว — ใบเสร็จจะเป็นใบกำกับภาษีอย่างย่อ"
          />
          <Input label="Timezone" value={b.timezone} onChange={(e) => setB({ ...b, timezone: e.target.value })} />
          <Input label="เวลาเปิด" type="time" value={s.openTime} onChange={(e) => setS({ ...s, openTime: e.target.value })} />
          <Input label="เวลาปิด" type="time" value={s.closeTime} onChange={(e) => setS({ ...s, closeTime: e.target.value })} />
        </div>
      </Panel>
      <Panel title="ภาษีและค่าบริการ">
        <div className="grid gap-3 sm:grid-cols-3">
          <Select label="VAT" value={s.vatMode} onChange={(e) => setS({ ...s, vatMode: e.target.value as BranchSettings['vatMode'] })}>
            <option value="EXCLUSIVE">แยกนอกราคา (บวกเพิ่ม)</option>
            <option value="INCLUSIVE">รวมในราคาแล้ว</option>
            <option value="NONE">ไม่คิด VAT</option>
          </Select>
          <Input label="อัตรา VAT (%)" inputMode="decimal" value={vat} onChange={(e) => setVat(e.target.value)} disabled={s.vatMode === 'NONE'} />
          <Input label="ค่าบริการ (%)" inputMode="decimal" value={sc} onChange={(e) => setSc(e.target.value)} />
          <Checkbox className="sm:col-span-3" label="คิด VAT จากค่าบริการด้วย" checked={s.serviceChargeTaxable} onChange={(e) => setS({ ...s, serviceChargeTaxable: e.target.checked })} />
          <fieldset className="sm:col-span-3">
            <legend className="mb-1 text-sm font-medium text-ink-2">คิดค่าบริการกับช่องทาง</legend>
            <div className="flex flex-wrap gap-3">
              {['DINE_IN', 'TAKEAWAY', 'DELIVERY'].map((c) => (
                <Checkbox key={c} label={CHANNEL_LABEL[c]} checked={s.serviceChargeChannels.includes(c)} onChange={() => toggleIn('serviceChargeChannels', c)} />
              ))}
            </div>
          </fieldset>
          <Input label="ส่วนลดสูงสุดที่แคชเชียร์ให้ได้ (%)" inputMode="decimal" value={maxDisc} onChange={(e) => setMaxDisc(e.target.value)} hint="เกินกว่านี้ต้องให้ผู้จัดการอนุมัติ" />
        </div>
      </Panel>
      <Panel title="การชำระเงิน">
        <fieldset>
          <legend className="mb-1 text-sm font-medium text-ink-2">ช่องทางที่เปิดรับ</legend>
          <div className="flex flex-wrap gap-3">
            {(['CASH', 'PROMPTPAY', 'CARD', 'EWALLET', 'TRANSFER', 'VOUCHER'] as const).map((m) => (
              <Checkbox key={m} label={METHOD_LABEL[m]} checked={s.enabledPaymentMethods.includes(m)} onChange={() => toggleIn('enabledPaymentMethods', m)} />
            ))}
          </div>
        </fieldset>
        <Input
          label="PromptPay ID (เบอร์มือถือหรือเลขผู้เสียภาษี)"
          wrapClassName="mt-3 max-w-sm"
          value={s.promptPayId}
          onChange={(e) => setS({ ...s, promptPayId: e.target.value.replace(/[^\d]/g, '').slice(0, 15) })}
          hint="ใช้สร้าง QR สำหรับลูกค้าสแกน — ต้องยืนยันยอดเข้าด้วยตนเองจนกว่าจะเชื่อม Payment Gateway"
        />
      </Panel>
      <Panel title="ใบเสร็จ">
        <div className="grid gap-3 sm:grid-cols-2">
          <Textarea label="ข้อความหัวใบเสร็จ" value={s.receiptHeader} onChange={(e) => setS({ ...s, receiptHeader: e.target.value })} />
          <Textarea label="ข้อความท้ายใบเสร็จ" value={s.receiptFooter} onChange={(e) => setS({ ...s, receiptFooter: e.target.value })} />
        </div>
      </Panel>
      <Panel title="ครัวและ QR">
        <div className="grid gap-3 sm:grid-cols-3">
          <Input label="จอครัว: เตือนสีเหลือง (นาที)" type="number" min={1} value={s.kdsWarnMinutes} onChange={(e) => setS({ ...s, kdsWarnMinutes: Number(e.target.value) })} />
          <Input label="จอครัว: เตือนสีแดง (นาที)" type="number" min={2} value={s.kdsLateMinutes} onChange={(e) => setS({ ...s, kdsLateMinutes: Number(e.target.value) })} />
          <Input label="ระยะเวลาที่นั่งเริ่มต้น (นาที) สำหรับการจอง" type="number" min={15} value={s.reservationSeatingMinutes} onChange={(e) => setS({ ...s, reservationSeatingMinutes: Number(e.target.value) })} />
          <Checkbox label="เปิดให้ลูกค้าสั่งผ่าน QR" checked={s.qrOrderingEnabled} onChange={(e) => setS({ ...s, qrOrderingEnabled: e.target.checked })} />
          <Checkbox label="ออเดอร์จาก QR ต้องให้พนักงานอนุมัติก่อนส่งครัว" checked={s.qrRequireApproval} onChange={(e) => setS({ ...s, qrRequireApproval: e.target.checked })} />
          <Input label="อายุ QR โต๊ะ (นาที)" type="number" min={15} value={s.qrTokenTtlMinutes} onChange={(e) => setS({ ...s, qrTokenTtlMinutes: Number(e.target.value) })} />
        </div>
      </Panel>
      <div className="sticky bottom-0 -mx-3 flex justify-end border-t border-line bg-bg/95 px-3 py-3 backdrop-blur sm:-mx-5 sm:px-5">
        <Button type="submit" size="lg" loading={save.isPending}>
          บันทึกการตั้งค่า
        </Button>
      </div>
    </form>
  );
}

export function SettingsPage() {
  const q = useBranchSettings();
  return (
    <>
      <PageHeader title="ตั้งค่าร้าน" crumbs={[{ label: 'ระบบ' }]} description="การเปลี่ยนภาษี/ค่าบริการจะมีผลกับบิลที่เปิดหลังบันทึก บิลเดิมใช้ค่าที่บันทึกไว้ตอนเปิดบิล" />
      <QueryView query={q}>{(d) => <SettingsForm data={d} />}</QueryView>
    </>
  );
}
