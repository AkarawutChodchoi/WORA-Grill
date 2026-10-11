/* Service worker: keeps the POS shell and last-known menu/orders available offline.
 * - Static assets: cache-first (they are content-hashed by Vite).
 * - Navigations: network-first, falling back to the cached app shell.
 * - A few read APIs (menu, tables, orders, settings, me): network-first, fallback to the last response
 *   with header "x-offline-cache: 1" so the UI can label the data as possibly stale.
 * - Writes are never cached here; the app's outbox (IndexedDB) handles them.
 */
const VERSION = 'rms-v1';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const READ_APIS = [/^\/api\/menu(\?|$)/, /^\/api\/tables$/, /^\/api\/orders\/[\w-]+$/, /^\/api\/orders\?scope=active/, /^\/api\/settings\/branch$/, /^\/api\/auth\/me$/, /^\/api\/stations$/];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/manifest.webmanifest', '/icon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put('/', copy));
          return res;
        })
        .catch(() => caches.match('/')),
    );
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }
  const path = url.pathname + url.search;
  if (READ_APIS.some((r) => r.test(path))) {
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(DATA).then((c) => c.put(req, copy));
          }
          return res;
        })
        .catch(async () => {
          const hit = await caches.match(req);
          if (!hit) return new Response(JSON.stringify({ error: { code: 'OFFLINE', message: 'ออฟไลน์และยังไม่มีข้อมูลในเครื่อง' } }), { status: 503, headers: { 'content-type': 'application/json' } });
          const headers = new Headers(hit.headers);
          headers.set('x-offline-cache', '1');
          return new Response(await hit.blob(), { status: 200, headers });
        }),
    );
  }
});
