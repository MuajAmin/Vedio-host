// ============================================================
//  VideoHost Service Worker — Android Mobile PWA Cache Engine
//  Strategy: Cache-first for versioned static assets (CSS, JS, fonts),
//  Network-only for SSE streams, WebRTC signaling, API, & range videos.
// ============================================================

const CACHE_NAME = 'videohost-v8.0';

// Static assets to pre-cache on install
const PRECACHE_ASSETS = [
    '/css/style.css?v=8.0',
    '/css/messages.css?v=8.0',
    '/css/calling.css?v=8.0',
    '/js/theme-init.js?v=8.0',
    '/js/app.js?v=8.0',
    '/js/messages.js?v=8.0',
    '/js/watchTogether.js?v=8.0',
    '/js/calling.js?v=8.0',
    '/css/icon-192.png',
    '/css/icon-512.png',
    '/manifest.json'
];

// Routes that must ALWAYS bypass cache and go straight to network
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
        pathname.startsWith('/rename/') ||
        pathname.startsWith('/comment/') ||
        pathname === '/health'
    );
}

// -- INSTALL -- Pre-cache critical static shell
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then((cache) => {
            return cache.addAll(PRECACHE_ASSETS).catch((err) => {
                console.warn('[SW] Pre-cache partial notice:', err.message);
            });
        }).then(() => self.skipWaiting())
    );
});

// -- ACTIVATE -- Clean up legacy caches
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

// -- FETCH -- Smart routing for Android mobile
self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = request.url;
    if (isNetworkOnly(url)) return;

    const pathname = new URL(url).pathname;

    // Cache-first with network revalidation for static assets
    if (pathname.startsWith('/css/') || pathname.startsWith('/js/') || pathname.endsWith('.png') || pathname.endsWith('.json')) {
        event.respondWith(
            caches.match(request).then((cached) => {
                if (cached) return cached;
                return fetch(request).then((response) => {
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
                    }
                    return response;
                }).catch(() => caches.match(request));
            })
        );
        return;
    }

    // Network-first with cache fallback for page navigation
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request).catch(() => {
                return caches.match(request).then((cached) => {
                    if (cached) return cached;
                    return caches.match('/dashboard');
                });
            })
        );
    }
});
