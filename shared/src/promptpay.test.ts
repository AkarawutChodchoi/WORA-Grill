import { describe, expect, it } from 'vitest';
import { crc16ccitt, promptPayPayload } from './promptpay';

describe('PromptPay EMVCo payload', () => {
  it('uses CRC-16/CCITT-FALSE', () => {
    expect(crc16ccitt('123456789')).toBe('29B1');
  });

  it('builds a dynamic payload for a mobile number with amount', () => {
    const p = promptPayPayload('081-234-5678', 12345);
    expect(p.startsWith('000201010212')).toBe(true);
    expect(p).toContain('29370016A000000677010111011300668123456780'.slice(0, 41));
    expect(p).toContain('0066812345678');
    expect(p).toContain('5303764');
    expect(p).toContain('5406123.45');
    expect(p).toContain('5802TH');
    expect(p.slice(-8, -4)).toBe('6304');
    expect(p.slice(-4)).toBe(crc16ccitt(p.slice(0, -4)));
  });

  it('builds a static payload for a 13-digit tax id without amount', () => {
    const p = promptPayPayload('0105536000000', null);
    expect(p.startsWith('000201010211')).toBe(true);
    expect(p).toContain('02130105536000000');
    expect(p).not.toContain('54');
  });

  it('rejects invalid ids', () => {
    expect(() => promptPayPayload('12345', 100)).toThrow();
  });
});
