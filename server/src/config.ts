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
  /** Public URL used when generating QR-menu links, e.g. https://pos.example.com */
  PUBLIC_BASE_URL: z.string().default('http://localhost:5173'),
  LOG_LEVEL: z.string().default('info'),
  /** Trust X-Forwarded-For (only when running behind a reverse proxy you control). */
  TRUST_PROXY: z.enum(['true', 'false']).default('false'),
});

export type Config = z.infer<typeof envSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const cfg = envSchema.parse(env);
  if (cfg.DATABASE_URL === '') cfg.DATABASE_URL = undefined;
  return cfg;
}
