import { Socket } from 'node:net';
import { z } from 'zod';
import { formatBaht } from '@shared/money';
import { EscPos, twoCol } from './escpos';

/** Per-device printer settings stored in devices.config. */
export const printerConfigSchema = z.object({
  host: z.string().min(1).max(100),
  port: z.number().int().min(1).max(65535).default(9100),
  width: z.union([z.literal(32), z.literal(42), z.literal(48)]).default(48),
  codePage: z.number().int().min(0).max(255).default(21),
  role: z.enum(['RECEIPT', 'KITCHEN']).default('RECEIPT'),
  openDrawer: z.boolean().default(false),
});
export type PrinterConfig = z.infer<typeof printerConfigSchema>;

export interface PrinterTransport {
  send(cfg: PrinterConfig, data: Buffer): Promise<void>;
}

/** Raw TCP (port 9100 "JetDirect") — the common interface of LAN thermal printers. */
export const tcpTransport: PrinterTransport = {
  send(cfg, data) {
    return new Promise((resolve, reject) => {
      const sock = new Socket();
      const done = (err?: Error) => {
        sock.destroy();
        if (err) reject(err);
        else resolve();
      };
      sock.setTimeout(5000, () => done(new Error(`เครื่องพิมพ์ ${cfg.host}:${cfg.port} ไม่ตอบสนอง`)));
      sock.once('error', (e) => done(e));
      sock.connect(cfg.port, cfg.host, () => sock.end(data, () => done()));
    });
  },
};

const money = (v: number) => formatBaht(v, { symbol: false });

export interface ReceiptPrintData {
  seller: { name: string; address: string | null; phone: string | null; taxId: string | null; header: string; footer: string };
  isTaxInvoice: boolean;
  order: {
    orderNo: string;
    receiptNo: string | null;
    tableName: string | null;
    paidAt: Date | null;
    items: { nameSnapshot: string; qty: number; unitPriceSatang: number; status: string; modifiers: { name: string }[]; discountSatang: number }[];
    subtotalSatang: number;
    discountSatang: number;
    serviceChargeSatang: number;
    vatSatang: number;
    grandTotalSatang: number;
    pricing: { vatMode: string; vatBps: number; serviceChargeBps: number };
    payments: { method: string; status: string; amountSatang: number; tenderedSatang: number | null; changeSatang: number }[];
  };
  cashier: string | null;
}

export function receiptDocument(d: ReceiptPrintData, cfg: Pick<PrinterConfig, 'width' | 'codePage' | 'openDrawer'>, opts: { openDrawer?: boolean } = {}): Buffer {
  const p = new EscPos(cfg.width, cfg.codePage);
  const o = d.order;
  p.align('center').bold(true).text(d.seller.name).bold(false);
  for (const l of [d.seller.header, d.seller.address, d.seller.phone && `โทร ${d.seller.phone}`, d.seller.taxId && `เลขผู้เสียภาษี ${d.seller.taxId}`]) if (l) p.text(l);
  p.text(d.isTaxInvoice ? 'ใบเสร็จรับเงิน/ใบกำกับภาษีอย่างย่อ' : 'ใบเสร็จรับเงิน');
  p.align('left').rule();
  p.lines(twoCol('เลขที่', o.receiptNo ?? `#${o.orderNo}`, p.width));
  p.lines(twoCol('วันที่', o.paidAt ? o.paidAt.toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' }) : '-', p.width));
  if (o.tableName) p.lines(twoCol('โต๊ะ', o.tableName, p.width));
  if (d.cashier) p.lines(twoCol('พนักงาน', d.cashier, p.width));
  p.rule();
  for (const i of o.items.filter((x) => x.status !== 'CANCELLED')) {
    p.lines(twoCol(`${i.qty} ${i.nameSnapshot}`, money(i.unitPriceSatang * i.qty), p.width));
    for (const m of i.modifiers) p.text(`   + ${m.name}`);
    if (i.discountSatang) p.lines(twoCol('   ส่วนลด', `-${money(i.discountSatang)}`, p.width));
  }
  p.rule();
  p.lines(twoCol('รวม', money(o.subtotalSatang), p.width));
  if (o.discountSatang) p.lines(twoCol('ส่วนลด', `-${money(o.discountSatang)}`, p.width));
  if (o.serviceChargeSatang) p.lines(twoCol(`ค่าบริการ ${o.pricing.serviceChargeBps / 100}%`, money(o.serviceChargeSatang), p.width));
  if (o.pricing.vatMode === 'EXCLUSIVE') p.lines(twoCol(`VAT ${o.pricing.vatBps / 100}%`, money(o.vatSatang), p.width));
  p.bold(true).lines(twoCol('ยอดสุทธิ', money(o.grandTotalSatang), p.width)).bold(false);
  if (o.pricing.vatMode === 'INCLUSIVE') p.text(`(รวม VAT ${money(o.vatSatang)})`);
  for (const pay of o.payments.filter((x) => x.status === 'CONFIRMED')) {
    p.lines(twoCol(pay.method, money(pay.tenderedSatang ?? pay.amountSatang), p.width));
    if (pay.changeSatang) p.lines(twoCol('เงินทอน', money(pay.changeSatang), p.width));
  }
  p.rule().align('center');
  if (d.seller.footer) p.text(d.seller.footer);
  p.feed(3).cut();
  if (opts.openDrawer && cfg.openDrawer) p.openDrawer();
  return p.build();
}

export interface KitchenPrintData {
  stationName: string;
  orderNo: string;
  tableName: string | null;
  channel: string;
  guestCount: number;
  printedAt: Date;
  items: { qty: number; nameSnapshot: string; modifiers: { name: string; qty: number }[]; note: string | null; allergens: string[]; course: number }[];
}

export function kitchenDocument(d: KitchenPrintData, cfg: Pick<PrinterConfig, 'width' | 'codePage'>): Buffer {
  const p = new EscPos(cfg.width, cfg.codePage);
  p.align('center').text(d.stationName).big(true).bold(true).text(d.tableName ? `โต๊ะ ${d.tableName}` : d.channel).big(false).bold(false);
  p.text(`#${d.orderNo}  ${d.guestCount} คน  ${d.printedAt.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit' })}`);
  p.align('left').rule('=');
  for (const i of d.items) {
    p.bold(true).text(`${i.qty} x ${i.nameSnapshot}${i.course > 1 ? ` [รอบ ${i.course}]` : ''}`).bold(false);
    for (const m of i.modifiers) p.text(`   + ${m.name}${m.qty > 1 ? ` x${m.qty}` : ''}`);
    if (i.note) p.bold(true).text(`   ** ${i.note} **`).bold(false);
    if (i.allergens.length) p.bold(true).text(`   !! แพ้: ${i.allergens.join(', ')}`).bold(false);
  }
  p.rule('=').feed(3).cut();
  return p.build();
}
