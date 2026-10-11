import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Config } from '../config';

/**
 * Opn Payments (formerly Omise) adapter for PromptPay charges. Disabled unless OPN_SECRET_KEY is set.
 * Webhooks are verified with HMAC-SHA256 over `${timestamp}.${rawBody}` using the base64 signing secret,
 * and the charge is re-fetched from the API before money is marked as received.
 * NOTE: verify header names/formats against the provider's current documentation before go-live.
 */
export interface GatewayCharge {
  id: string;
  status: 'pending' | 'successful' | 'failed' | 'expired' | string;
  amountSatang: number;
  qrImageUrl: string | null;
  metadata: Record<string, string>;
}

export interface PaymentGateway {
  name: string;
  enabled: boolean;
  createPromptPayCharge(amountSatang: number, metadata: Record<string, string>): Promise<GatewayCharge>;
  getCharge(id: string): Promise<GatewayCharge>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): boolean;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ ok: boolean; status: number; json: () => Promise<any> }>;

function toCharge(c: any): GatewayCharge {
  return { id: c.id, status: c.status, amountSatang: c.amount, qrImageUrl: c.source?.scannable_code?.image?.download_uri ?? null, metadata: c.metadata ?? {} };
}

export function createOpnGateway(config: Pick<Config, 'OPN_SECRET_KEY' | 'OPN_WEBHOOK_SECRET' | 'OPN_API_BASE'>, fetchImpl: FetchLike = fetch as unknown as FetchLike): PaymentGateway {
  const key = config.OPN_SECRET_KEY;
  const auth = key ? `Basic ${Buffer.from(`${key}:`).toString('base64')}` : '';
  const call = async (method: string, path: string, form?: Record<string, string>) => {
    if (!key) throw new Error('Opn gateway is not configured');
    const res = await fetchImpl(`${config.OPN_API_BASE}${path}`, {
      method,
      headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const body = await res.json();
    if (!res.ok) throw new Error(`Opn API error ${res.status}: ${body?.message ?? 'unknown'}`);
    return body;
  };
  return {
    name: 'opn',
    enabled: !!key,
    async createPromptPayCharge(amountSatang, metadata) {
      const form: Record<string, string> = { amount: String(amountSatang), currency: 'thb', 'source[type]': 'promptpay' };
      for (const [k, v] of Object.entries(metadata)) form[`metadata[${k}]`] = v;
      return toCharge(await call('POST', '/charges', form));
    },
    async getCharge(id) {
      if (!/^chrg_[\w]+$/.test(id)) throw new Error('invalid charge id');
      return toCharge(await call('GET', `/charges/${id}`));
    },
    verifyWebhook(rawBody, headers) {
      const secret = config.OPN_WEBHOOK_SECRET;
      if (!secret) return false;
      const sigHeader = String(headers['omise-signature'] ?? '');
      const ts = String(headers['omise-signature-timestamp'] ?? '');
      if (!sigHeader || !/^\d+$/.test(ts)) return false;
      // Reject stale deliveries (replay protection).
      if (Math.abs(Date.now() / 1000 - Number(ts)) > 10 * 60) return false;
      const expected = createHmac('sha256', Buffer.from(secret, 'base64')).update(`${ts}.${rawBody.toString('utf8')}`).digest();
      return sigHeader.split(',').some((s) => {
        const got = Buffer.from(s.trim(), 'hex');
        return got.length === expected.length && timingSafeEqual(got, expected);
      });
    },
  };
}
