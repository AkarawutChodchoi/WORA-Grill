import type { FastifyInstance } from 'fastify';
import { loadAuth, SESSION_COOKIE } from '../../lib/auth';
import type { DomainEvent } from '../../lib/events';

/**
 * WebSocket gateway (SPEC §6). Staff connect with their session cookie and receive events for their
 * organisation + active branch. Messages are small hints; clients refetch the affected data.
 * Public QR clients use /api/public/ws (Prompt 14).
 */
export default async function realtimeRoutes(app: FastifyInstance) {
  const { bus, db } = app.deps;

  app.get('/ws', { websocket: true }, (socket, req) => {
    const origin = req.headers.origin;
    const host = req.headers.host;
    // Reject cross-site WebSocket hijacking attempts.
    if (origin && host && new URL(origin).host !== host && !process.env.WS_ALLOWED_ORIGINS?.split(',').includes(origin)) {
      socket.close(4403, 'origin');
      return;
    }
    const auth = req.auth;
    if (!auth) {
      socket.close(4401, 'unauthorized');
      return;
    }
    const forward = (e: DomainEvent) => {
      if (e.organizationId !== auth.orgId) return;
      if (e.branchId !== null && e.branchId !== auth.branchId) return;
      if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: e.type, payload: e.payload, at: e.at }));
    };
    const off = bus.subscribe(forward);
    let ticks = 0;
    const ping = setInterval(async () => {
      if (socket.readyState !== socket.OPEN) return;
      socket.ping();
      // Re-validate the session every ~2 minutes so logout/deactivation also ends the stream.
      if (++ticks % 5 === 0 && !(await loadAuth(db, req.cookies[SESSION_COOKIE]).catch(() => null))) socket.close(4401, 'session ended');
    }, 25_000);
    socket.send(JSON.stringify({ type: 'hello', payload: { branchId: auth.branchId } }));
    socket.on('close', () => {
      off();
      clearInterval(ping);
    });
    socket.on('message', () => undefined); // clients do not send commands over WS
  });
}
