/**
 * Thai PromptPay QR (EMVCo merchant-presented) payload generator.
 * Only *generates* the QR. Payment confirmation must come from a bank/gateway or a cashier check —
 * never from the customer's screen.
 */

const f = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** CRC-16/CCITT-FALSE (poly 0x1021, init 0xFFFF), uppercase 4-hex. */
export function crc16ccitt(s: string): string {
  let crc = 0xffff;
  for (let i = 0; i < s.length; i++) {
    crc ^= s.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/** @param target mobile number (10 digits) or national/tax id (13 digits) or e-wallet id (15 digits) */
export function promptPayPayload(target: string, amountSatang: number | null): string {
  const id = target.replace(/\D/g, '');
  let account: string;
  if (id.length === 10 && id.startsWith('0')) account = f('01', `0066${id.slice(1)}`);
  else if (id.length === 13) account = f('02', id);
  else if (id.length === 15) account = f('03', id);
  else throw new Error('PromptPay ID must be a 10-digit mobile, 13-digit tax ID or 15-digit e-wallet ID');
  const merchant = f('29', f('00', 'A000000677010111') + account);
  const amount = amountSatang && amountSatang > 0 ? f('54', `${Math.floor(amountSatang / 100)}.${String(amountSatang % 100).padStart(2, '0')}`) : '';
  const body = f('00', '01') + f('01', amount ? '12' : '11') + merchant + f('53', '764') + amount + f('58', 'TH') + '6304';
  return body + crc16ccitt(body);
}
