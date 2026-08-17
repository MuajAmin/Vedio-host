// ============================================================
//  VideoHost Service Worker � PWA Offline Shell Cache
//  Strategy: Cache-first for static assets, Network-only for
//  dynamic routes (videos, API, SSE streams, thumbnails).
//  2 users, 1 vCPU VPS � keep it lean.
// ============================================================

const CACHE_NAME = 'videohost-v6.0';

// Static assets to pre-cache on install
const PRECACHE_ASSETS = [
    '/css/style.css?v=6.7',
    '/css/messages.css?v=2.8',
    '/js/theme-init.js?v=6.7',
    '/js/app.js?v=6.6',
    '/js/messages.js?v=3.0',
    '/js/watchTogether.js?v=3.0',
    '/css/icon-192.png',
    '/css/icon-512.png',
];

// Routes that must ALWAYS go to the network (never cache)
function isNetworkOnly(url) {
    const pathname = new URL(url).pathname;
    return (
        pathname.startsWith('/stream/') ||
        pathname.startsWith('/thumbnails/') ||
        pathname.startsWith('/avatars/') ||
        pathname.startsWith('/voice/') ||
        pathname.startsWith('/import-progress/') ||
        pathname.startsWith('/watch-together/') ||
        pathname.startsWith('/messages/stream') ||
        pathname.startsWith('/api/') ||
        pathname.startsWith('/login') ||
        pathname.startsWith('/logout') ||
        pathname.startsWith('/upload') ||
        pathname.startsWith('/import-url') ||
        pathname.startsWith('/delete/') ||
        pathname.startsWith('/thumbnail/') ||
        pathname.startsWith('/profile/') ||
        pathname === '/health'
    );
}

// -- INSTALL -- pre-cache static shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(PRECACHE_ASSETS).catch((err) => {
                console.warn('[SW] Pre-cache partial failure:', err.message);
            });
        }).then(() => self.skipWaiting())
    );
});

// -- ACTIVATE -- clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== CACHE_NAME)
                    .map((key) => caches.delete(key))
            )
        ).then(() => self.clients.claim())
    );
});

// -- FETCH -- serve static from cache, network for everything else
self.addEventListener('fetch', (event) => {
    const { request } = event;

    if (request.method !== 'GET') return;

    const url = request.url;

    if (isNetworkOnly(url)) return;

    const pathname = new URL(url).pathname;
    if (pathname.startsWith('/css/') || pathname.startsWith('/js/')) {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) return cached;
                return fetch(request).then((response) => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                });
            })
        );
        return;
    }

    event.respondWith(
        fetch(request).catch(() => caches.match(request))
    );
});
