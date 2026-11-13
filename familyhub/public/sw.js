/*
 * A service worker that caches nothing.
 *
 * It exists so the app is installable -- iOS wants one registered before it
 * will treat a page as a real home-screen app. Caching is deliberately absent:
 * the whole value here is knowing what is actually planned for tonight, and a
 * stale answer served confidently from a cache is worse than an honest failure
 * to reach the server. The plan is a few kilobytes of JSON on the same house
 * network, so there is nothing to save by caching it.
 */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
