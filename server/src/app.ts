import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { Config } from './config';
import type { DB } from './db/client';
import { loadAuth, SESSION_COOKIE } from './lib/auth';
import { AppError } from './lib/errors';
import { EventBus } from './lib/events';
import { registerModules } from './modules';

export interface Deps {
  db: DB;
  bus: EventBus;
  config: Config;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: Deps;
  }
}

/** Paths that receive server-to-server calls and therefore skip the CSRF header check. */
const CSRF_EXEMPT = ['/api/webhooks/'];

export async function buildApp(deps: Deps, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger
      ? {
          level: deps.config.LOG_LEVEL,
          redact: { paths: ['req.headers.cookie', 'req.headers.authorization', 'res.headers["set-cookie"]'], remove: true },
        }
      : false,
    trustProxy: deps.config.TRUST_PROXY === 'true',
    bodyLimit: 1024 * 1024,
  });
  app.decorate('deps', deps);
  app.decorateRequest('auth', null);

  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'ws:', 'wss:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
  });
  await app.register(multipart, { limits: { fileSize: 2 * 1024 * 1024, files: 1 } });
  await app.register(websocket);

  app.addHook('onRequest', async (req) => {
    const url = req.url;
    if (!url.startsWith('/api/')) return;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && !CSRF_EXEMPT.some((p) => url.startsWith(p))) {
      if (req.headers['x-requested-with'] !== 'rms') throw new AppError(403, 'CSRF', 'คำขอไม่ถูกต้อง (missing X-Requested-With)');
    }
    req.auth = await loadAuth(deps.db, req.cookies[SESSION_COOKIE]);
  });

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.status).send({ error: { code: err.code, message: err.message, details: err.details } });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: { code: 'VALIDATION', message: 'ข้อมูลไม่ถูกต้อง', details: err.issues } });
    }
    if (err.validation || err.statusCode === 400 || err.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
      return reply.status(400).send({ error: { code: 'BAD_REQUEST', message: 'รูปแบบคำขอไม่ถูกต้อง' } });
    }
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
      return reply.status(413).send({ error: { code: 'FILE_TOO_LARGE', message: 'ไฟล์ใหญ่เกิน 2 MB' } });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: { code: err.code ?? 'ERROR', message: err.message } });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: { code: 'INTERNAL', message: 'เกิดข้อผิดพลาดในระบบ กรุณาลองใหม่' } });
  });

  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));

  await app.register(registerModules, { prefix: '/api' });

  // Uploaded files (menu images). Filenames are random and validated at upload time.
  const uploadDir = path.resolve(deps.config.UPLOAD_DIR);
  mkdirSync(uploadDir, { recursive: true });
  await app.register(fastifyStatic, { root: uploadDir, prefix: '/uploads/', decorateReply: false, index: false });

  // Production: serve the built SPA with history-API fallback.
  const webDir = path.resolve('dist/web');
  if (existsSync(path.join(webDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDir, prefix: '/', wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html', webDir);
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'ไม่พบ endpoint' } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'ไม่พบ endpoint' } }));
  }

  return app;
}
