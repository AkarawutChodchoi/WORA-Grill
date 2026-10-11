import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { SystemRole } from '@shared/permissions';
import { buildApp } from '../src/app';
import type { Integrations } from '../src/modules/integrations/routes';
import { loadConfig } from '../src/config';
import { openDatabase, type DB } from '../src/db/client';
import { userRoles, users } from '../src/db/schema';
import { hashSecret } from '../src/lib/crypto';
import { EventBus } from '../src/lib/events';
import { bootstrapOrganization } from '../src/modules/auth/bootstrap';
import { seedDemoData } from '../src/db/seed-demo';
import { eq } from 'drizzle-orm';
import { diningTables, menuItems } from '../src/db/schema';

export const TEST_PASSWORD = 'test-password-123';
export const TEST_PIN = '2468';

export interface Res<T = any> {
  status: number;
  body: T;
  headers: Record<string, unknown>;
}

export class Client {
  constructor(
    private app: FastifyInstance,
    public cookie = '',
  ) {}
  async req<T = any>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, extraHeaders: Record<string, string> = {}): Promise<Res<T>> {
    const r = await this.app.inject({
      method,
      url: `/api${url}`,
      payload: payload as any,
      headers: { cookie: this.cookie, 'x-requested-with': 'rms', ...extraHeaders },
    });
    const setCookie = r.headers['set-cookie'];
    if (setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : [setCookie];
      const jar = new Map(this.cookie.split('; ').filter(Boolean).map((c) => c.split('=') as [string, string]));
      for (const c of list) {
        const [kv] = c.split(';');
        const [k, v] = kv.split('=');
        if (v === '' || /Max-Age=0|Expires=Thu, 01 Jan 1970/.test(c)) jar.delete(k);
        else jar.set(k, v);
      }
      this.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    return { status: r.statusCode, body: r.body ? safeJson(r.body) : undefined, headers: r.headers };
  }
  get<T = any>(url: string) {
    return this.req<T>('GET', url);
  }
  post<T = any>(url: string, body: unknown = {}) {
    return this.req<T>('POST', url, body);
  }
  put<T = any>(url: string, body: unknown = {}) {
    return this.req<T>('PUT', url, body);
  }
  patch<T = any>(url: string, body: unknown = {}) {
    return this.req<T>('PATCH', url, body);
  }
  del<T = any>(url: string) {
    return this.req<T>('DELETE', url);
  }
}

function safeJson(s: string) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export interface TestEnv {
  app: FastifyInstance;
  db: DB;
  bus: EventBus;
  orgId: string;
  branchId: string;
  roleIds: Record<SystemRole, string>;
  userIds: Record<SystemRole, string>;
  as: (role: SystemRole) => Promise<Client>;
  anon: () => Client;
  close: () => Promise<void>;
}

/** Fresh in-memory Postgres + app + one org/branch with one user per system role. */
export async function createTestEnv(opts: { demo?: boolean; env?: Record<string, string>; integrations?: Partial<Integrations> } = {}): Promise<TestEnv> {
  const database = await openDatabase({ memory: true });
  await database.migrate();
  const db = database.db;
  const config = loadConfig({ NODE_ENV: 'test', UPLOAD_DIR: mkdtempSync(path.join(tmpdir(), 'rms-up-')), ...opts.env } as NodeJS.ProcessEnv);
  const bus = new EventBus();
  const app = await buildApp({ db, bus, config, integrations: opts.integrations });
  const boot = await bootstrapOrganization(db, {
    orgName: 'Test Org',
    branchName: 'สาขาทดสอบ',
    branchCode: 'T1',
    owner: { name: 'Owner', email: 'owner@test.local', password: TEST_PASSWORD, pin: TEST_PIN },
  });
  const pw = await hashSecret(TEST_PASSWORD);
  const pin = await hashSecret(TEST_PIN);
  const userIds = { OWNER: boot.owner.id } as Record<SystemRole, string>;
  for (const role of ['MANAGER', 'CASHIER', 'WAITER', 'KITCHEN', 'STOREKEEPER'] as const) {
    const [u] = await db
      .insert(users)
      .values({ organizationId: boot.org.id, name: role.toLowerCase(), email: `${role.toLowerCase()}@test.local`, passwordHash: pw, pinHash: pin })
      .returning();
    await db.insert(userRoles).values({ userId: u.id, roleId: boot.roleIds[role], branchId: boot.branch.id });
    userIds[role] = u.id;
  }
  if (opts.demo) await db.transaction((tx) => seedDemoData(tx, boot.org.id, boot.branch.id, boot.owner.id));
  const cache = new Map<SystemRole, string>();
  return {
    app,
    db,
    bus,
    orgId: boot.org.id,
    branchId: boot.branch.id,
    roleIds: boot.roleIds,
    userIds,
    async as(role) {
      if (!cache.has(role)) {
        const c = new Client(app);
        const r = await c.post('/auth/login', { email: `${role.toLowerCase()}@test.local`, password: TEST_PASSWORD });
        if (r.status !== 200) throw new Error(`login ${role} failed: ${JSON.stringify(r.body)}`);
        cache.set(role, c.cookie);
      }
      return new Client(app, cache.get(role));
    },
    anon: () => new Client(app),
    async close() {
      await app.close();
      await database.close();
    },
  };
}

/** Demo menu item id by SKU (requires createTestEnv({ demo: true })). */
export async function itemBySku(env: TestEnv, sku: string) {
  const [i] = await env.db.select().from(menuItems).where(eq(menuItems.sku, sku));
  return i;
}
export async function tableByName(env: TestEnv, name: string) {
  const [t] = await env.db.select().from(diningTables).where(eq(diningTables.name, name));
  return t;
}
