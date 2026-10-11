import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Printer } from 'lucide-react';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Button, ErrorState, LoadingBlock } from '../../components/ui';
import { get } from '../../lib/api';
import { fmtDateTime, formatBaht } from '../../lib/format';
import { METHOD_LABEL } from '../../lib/settings';
import type { Order } from './types';

interface ReceiptData {
  seller: { name: string; address: string | null; phone: string | null; taxId: string | null; header: string; footer: string };
  isTaxInvoice: boolean;
  cashier: string | null;
  taxInvoice: { invoiceNo: string; buyerName: string; buyerTaxId: string; buyerAddress: string; buyerBranch: string | null; issuedAt: string } | null;
  order: Order;
}

const Row = ({ l, r, bold }: { l: string; r: string; bold?: boolean }) => (
  <div className={`flex justify-between gap-2 ${bold ? 'font-bold' : ''}`}>
    <span>{l}</span>
    <span className="num">{r}</span>
  </div>
);

/**
 * Printable 80 mm receipt / abbreviated tax invoice, or an A4-ish full tax invoice (?doc=tax).
 * Uses the browser print dialog; ESC/POS direct printing is handled by the print adapter (Prompt 16).
 */
export function ReceiptPage() {
  const { id } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const q = useQuery({ queryKey: ['receipt', id], queryFn: () => get<ReceiptData>(`/orders/${id}/receipt`) });
  if (q.isLoading) return <div className="p-6"><LoadingBlock /></div>;
  if (q.error || !q.data) return <div className="p-6"><ErrorState error={q.error} onRetry={() => q.refetch()} /></div>;
  const { seller, order: o, isTaxInvoice, taxInvoice, cashier } = q.data;
  const full = params.get('doc') === 'tax' && taxInvoice;
  const items = o.items.filter((i) => i.status !== 'CANCELLED');
  const title = full ? 'ใบกำกับภาษีเต็มรูป / ใบเสร็จรับเงิน' : isTaxInvoice ? 'ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ' : 'ใบเสร็จรับเงิน';
  return (
    <div className="min-h-dvh bg-sunken py-6 print:bg-white print:py-0">
      <div className="no-print mx-auto mb-4 flex max-w-md justify-between gap-2 px-3">
        <Button variant="ghost" icon={<ArrowLeft className="size-4" />} onClick={() => nav(-1)}>
          กลับ
        </Button>
        <Button icon={<Printer className="size-4" />} onClick={() => window.print()}>
          พิมพ์
        </Button>
      </div>
      <article className={`mx-auto bg-white p-4 text-[13px] leading-snug text-black ${full ? 'max-w-2xl' : 'w-[80mm]'} print:w-auto print:p-0`}>
        <header className="mb-2 text-center">
          <h1 className="text-base font-bold">{seller.name}</h1>
          {seller.header && <p>{seller.header}</p>}
          {seller.address && <p>{seller.address}</p>}
          {seller.phone && <p>โทร {seller.phone}</p>}
          {seller.taxId && <p>เลขประจำตัวผู้เสียภาษี {seller.taxId}</p>}
          <p className="mt-1 font-semibold">{title}</p>
        </header>
        <div className="mb-2 border-y border-dashed border-black py-1">
          {full && <Row l="เลขที่ใบกำกับ" r={taxInvoice.invoiceNo} />}
          <Row l="เลขที่" r={o.receiptNo ?? `บิล #${o.orderNo}`} />
          <Row l="วันที่" r={fmtDateTime(o.paidAt ?? o.openedAt)} />
          <Row l="บิล" r={`#${o.orderNo}${o.tableName ? ` โต๊ะ ${o.tableName}` : ''}`} />
          {cashier && <Row l="พนักงาน" r={cashier} />}
        </div>
        {full && (
          <div className="mb-2 border-b border-dashed border-black pb-1">
            <p>ผู้ซื้อ: {taxInvoice.buyerName} ({taxInvoice.buyerBranch})</p>
            <p>เลขประจำตัวผู้เสียภาษี: {taxInvoice.buyerTaxId}</p>
            <p>{taxInvoice.buyerAddress}</p>
          </div>
        )}
        <ul className="mb-2">
          {items.map((i) => (
            <li key={i.id}>
              <Row l={`${i.qty} ${i.nameSnapshot}`} r={formatBaht(i.unitPriceSatang * i.qty, { symbol: false })} />
              {i.modifiers.map((m, k) => (
                <p key={k} className="pl-4 text-[12px]">
                  + {m.name}
                </p>
              ))}
              {i.discountSatang > 0 && <Row l="   ส่วนลดรายการ" r={`-${formatBaht(i.discountSatang, { symbol: false })}`} />}
            </li>
          ))}
        </ul>
        <div className="border-t border-dashed border-black pt-1">
          <Row l="รวม" r={formatBaht(o.subtotalSatang, { symbol: false })} />
          {o.discountSatang > 0 && <Row l="ส่วนลด" r={`-${formatBaht(o.discountSatang, { symbol: false })}`} />}
          {o.serviceChargeSatang > 0 && <Row l={`ค่าบริการ ${o.pricing.serviceChargeBps / 100}%`} r={formatBaht(o.serviceChargeSatang, { symbol: false })} />}
          {o.pricing.vatMode === 'EXCLUSIVE' && <Row l={`ภาษีมูลค่าเพิ่ม ${o.pricing.vatBps / 100}%`} r={formatBaht(o.vatSatang, { symbol: false })} />}
          <Row l="ยอดสุทธิ" r={formatBaht(o.grandTotalSatang, { symbol: false })} bold />
          {o.pricing.vatMode === 'INCLUSIVE' && <Row l={`(ราคารวม VAT ${o.pricing.vatBps / 100}% = ${formatBaht(o.vatSatang, { symbol: false })})`} r="" />}
          {(o.pricing.vatMode !== 'NONE' && isTaxInvoice) && <Row l="มูลค่าก่อนภาษี" r={formatBaht(o.grandTotalSatang - o.vatSatang, { symbol: false })} />}
        </div>
        <div className="mt-2 border-t border-dashed border-black pt-1">
          {(o.payments ?? [])
            .filter((p) => p.status === 'CONFIRMED')
            .map((p) => (
              <div key={p.id}>
                <Row l={METHOD_LABEL[p.method] ?? p.method} r={formatBaht(p.tenderedSatang ?? p.amountSatang, { symbol: false })} />
                {p.changeSatang > 0 && <Row l="เงินทอน" r={formatBaht(p.changeSatang, { symbol: false })} />}
                {p.refundedSatang > 0 && <Row l="คืนเงิน" r={`-${formatBaht(p.refundedSatang, { symbol: false })}`} />}
              </div>
            ))}
        </div>
        {seller.footer && <p className="mt-3 text-center">{seller.footer}</p>}
        {o.status === 'VOIDED' && <p className="mt-2 text-center font-bold">*** VOID ***</p>}
        {!['PAID', 'CLOSED'].includes(o.status) && o.status !== 'VOIDED' && <p className="mt-2 text-center font-bold">*** ใบแจ้งยอด (ยังไม่ชำระ) ***</p>}
      </article>
    </div>
  );
}
