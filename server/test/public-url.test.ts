import { describe, expect, it } from 'vitest';
import { pickLanAddress, resolvePublicBaseUrl } from '../src/lib/public-url';

describe('QR link base URL', () => {
  it('uses PUBLIC_BASE_URL when it is a real address', () => {
    expect(resolvePublicBaseUrl({ configured: 'https://order.wora.example/', origin: 'http://localhost:5173', lanAddress: '192.168.1.20' })).toBe('https://order.wora.example');
  });

  it('follows the address the staff device used, so a phone on the same Wi-Fi can open it', () => {
    expect(resolvePublicBaseUrl({ configured: '', origin: 'http://192.168.1.20:5173', lanAddress: '192.168.1.20' })).toBe('http://192.168.1.20:5173');
  });

  it('never prints localhost into a QR: swaps in the LAN address and keeps the port', () => {
    expect(resolvePublicBaseUrl({ configured: '', origin: 'http://localhost:5173', lanAddress: '192.168.1.20' })).toBe('http://192.168.1.20:5173');
    expect(resolvePublicBaseUrl({ configured: 'http://localhost:3000', host: '127.0.0.1:3000', protocol: 'http', lanAddress: '10.0.0.5' })).toBe('http://10.0.0.5:3000');
  });

  it('falls back to the Host header when there is no Origin', () => {
    expect(resolvePublicBaseUrl({ configured: '', host: '192.168.0.9:3000', protocol: 'http', lanAddress: null })).toBe('http://192.168.0.9:3000');
  });

  it('keeps localhost only when no network address exists at all', () => {
    expect(resolvePublicBaseUrl({ configured: '', origin: 'http://localhost:5173', lanAddress: null })).toBe('http://localhost:5173');
  });

  it('picks a private Wi-Fi/LAN IPv4 and skips loopback, IPv6 and virtual adapters', () => {
    expect(
      pickLanAddress({
        'vEthernet (WSL)': [{ address: '172.20.48.1', family: 'IPv4', internal: false }],
        Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
        'Wi-Fi': [
          { address: 'fe80::1', family: 'IPv6', internal: false },
          { address: '192.168.1.42', family: 'IPv4', internal: false },
        ],
      }),
    ).toBe('192.168.1.42');
    expect(pickLanAddress({ Loopback: [{ address: '127.0.0.1', family: 'IPv4', internal: true }] })).toBeNull();
  });
});
