/*
 * A service worker that caches nothing, on purpose.
 *
 * Chrome will not offer "Install" without one, so this exists to make the panel
 * installable -- and that is the whole job. It passes every request straight to
 * the network and keeps no copy.
 *
 * Caching here would be actively harmful. This panel is a live view of what the
 * containers on this machine are doing: a cached shell would show yesterday's
 * services, a cached app.js would keep running against an API that has moved on,
 * and the update button would appear to do nothing because the old panel was
 * being served back from disk. An offline control panel for a server you cannot
 * reach has nothing useful to say anyway.
 *
 * iOS does not need any of this for Add to Home Screen -- the manifest and the
 * apple-touch-icon are enough there.
 */

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('activate', (event) => {
    event.waitUntil(
        (async () => {
            // Clears anything a previous version of this file may have stored,
            // so upgrading to the no-cache worker actually frees what it left.
            const names = await caches.keys();
            await Promise.all(names.map((n) => caches.delete(n)));
            await self.clients.claim();
        })(),
    );
});

// No fetch handler that answers from a cache. Declared and left as a pass
// through so the worker is "controlling" the page, which is what the install
// criteria look for.
self.addEventListener('fetch', () => {});
