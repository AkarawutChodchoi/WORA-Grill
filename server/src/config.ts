import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().default(3000),
  /** Real PostgreSQL connection string. When empty, an embedded PGlite database in PGLITE_DIR is used. */
  DATABASE_URL: z.string().optional(),
  PGLITE_DIR: z.string().default('./data/pglite'),
  UPLOAD_DIR: z.string().default('./data/uploads'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  /** Set to "true" behind HTTPS so cookies get the Secure flag. */
  COOKIE_SECURE: z.enum(['true', 'false']).default('false'),
  /** Public address for guest QR links (e.g. https://order.example.com). Empty = automatic: the address staff use, with localhost swapped for this machine's Wi-Fi/LAN IP. */
  PUBLIC_BASE_URL: z.string().default(''),
  LOG_LEVEL: z.string().default('info'),
  /**
   * Behind a reverse proxy you control: number of proxy hops to trust in X-Forwarded-For
   * ("true" = 1 hop). Never trust every hop, or clients could spoof their IP and bypass rate limits.
   */
  TRUST_PROXY: z.string().regex(/^(true|false|\d{1,2})$/).default('false'),
  // ---- Optional integrations (each stays disabled until configured) ----
  /** Opn Payments (Omise) secret key for PromptPay charges. */
  OPN_SECRET_KEY: z.string().optional(),
  /** Base64 webhook signing secret from the Opn dashboard. */
  OPN_WEBHOOK_SECRET: z.string().optional(),
  OPN_API_BASE: z.string().default('https://api.omise.co'),
  /** Shared HMAC secret used by a delivery-platform middleware posting normalised orders. */
  DELIVERY_WEBHOOK_SECRET: z.string().optional(),
  /** LINE Messaging API channel access token and the user/group id that receives alerts. */
  LINE_CHANNEL_ACCESS_TOKEN: z.string().optional(),
  LINE_NOTIFY_TO: z.string().optional(),
  /** Send kitchen tickets to configured network printers automatically. */
  AUTO_KITCHEN_PRINT: z.enum(['true', 'false']).default('true'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = envSchema.parse(env);
  if (cfg.DATABASE_URL === '') cfg.DATABASE_URL = undefined;
  return cfg;
}
