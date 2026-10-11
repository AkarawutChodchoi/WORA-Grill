import { useMutation } from '@tanstack/react-query';
import { Copy, ExternalLink, Printer, QrCode, TriangleAlert, Wifi } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog, useToast } from '../../components/ui';
import { errorMessage, post } from '../../lib/api';

interface QrResult {
  url: string;
  qrDataUrl: string;
  expiresAt: string;
}

/** A phone can only open the link if it is not "localhost"; private IPs only work on the shop Wi-Fi. */
function reachability(url: string): 'local' | 'lan' | 'public' {
  const host = new URL(url).hostname;
  if (host === 'localhost' || host === '127.0.0.1') return 'local';
  if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return 'lan';
  return 'public';
}

/** Create the table's self-order QR, then print it or let the guest scan it from the screen. */
export function QrDialog({ orderId, label, onClose }: { orderId: string; label: string; onClose: () => void }) {
  const toast = useToast();
  const [qr, setQr] = useState<QrResult | null>(null);
  const issue = useMutation({
    mutationFn: () => post<QrResult>(`/orders/${orderId}/qr`),
    onSuccess: setQr,
    onError: (e) => toast.error(errorMessage(e)),
  });
  const reach = qr ? reachability(qr.url) : null;
  return (
    <Dialog open onClose={onClose} title={`QR สั่งอาหาร · ${label}`} size="sm">
      {!qr ? (
        <div className="flex flex-col items-center gap-4 py-2 text-center">
          <QrCode className="size-14 text-brand" aria-hidden />
          <p className="text-ink-2">ลูกค้าสแกนแล้วดูเมนู สั่งอาหาร และเรียกพนักงานได้เองจากมือถือ</p>
          <Button size="lg" className="w-full" loading={issue.isPending} onClick={() => issue.mutate()}>
            สร้าง QR
          </Button>
          <p className="text-xs text-ink-3">ถ้าเคยสร้าง QR ให้บิลนี้แล้ว QR ใบเก่าจะใช้ไม่ได้</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3 text-center">
          <img src={qr.qrDataUrl} alt={`QR สั่งอาหาร ${label}`} className="size-64 max-w-full" />
          <p className="font-medium">
            {label} · ใช้ได้ถึง {new Date(qr.expiresAt).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })} น.
          </p>
          <p className="w-full rounded-control bg-sunken px-3 py-2 text-sm break-all text-ink-2">{qr.url}</p>
          {reach === 'local' && (
            <p className="flex items-start gap-2 rounded-control bg-chili-50 px-3 py-2 text-left text-sm text-chili">
              <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              ลิงก์นี้เป็น localhost มือถือจะเปิดไม่ได้ ให้เปิดระบบด้วยที่อยู่ IP ของเครื่องนี้ (ดูที่ ตั้งค่าร้าน › ใช้งานบนมือถือ)
            </p>
          )}
          {reach === 'lan' && (
            <p className="flex items-start gap-2 rounded-control bg-sky-50 px-3 py-2 text-left text-sm text-sky">
              <Wifi className="mt-0.5 size-4 shrink-0" aria-hidden />
              มือถือของลูกค้าต้องต่อ Wi-Fi เดียวกับร้าน
            </p>
          )}
          <div className="no-print grid w-full grid-cols-3 gap-2">
            <Button variant="outline" icon={<Printer className="size-4" />} onClick={() => window.print()}>
              พิมพ์
            </Button>
            <Button
              variant="outline"
              icon={<Copy className="size-4" />}
              onClick={() =>
                navigator.clipboard
                  .writeText(qr.url)
                  .then(() => toast.success('คัดลอกลิงก์แล้ว'))
                  .catch(() => toast.error('คัดลอกไม่ได้ ให้กดค้างที่ลิงก์แทน'))
              }
            >
              คัดลอก
            </Button>
            <Button variant="outline" icon={<ExternalLink className="size-4" />} onClick={() => window.open(qr.url, '_blank', 'noopener')}>
              เปิด
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
