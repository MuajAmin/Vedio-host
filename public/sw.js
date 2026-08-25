// ============================================================
//  VideoHost Service Worker — Android Mobile PWA Cache Engine
//  Strategy: Cache-first for versioned static assets (CSS, JS, fonts),
//  Network-only for SSE streams, WebRTC signaling, API, & range videos.
//  + Web Push Notification Handler for Messenger-style notifications
// ============================================================

const CACHE_NAME = 'videohost-v13.2';

// Static assets to pre-cache on install
const PRECACHE_ASSETS = [
    '/css/style.css?v=13.2',
    '/css/minimal.css?v=13.2',
    '/css/messages.css?v=13.2',
    '/css/calling.css?v=13.2',
    '/js/theme-init.js?v=13.2',
    '/js/twemoji.min.js?v=13.2',
    '/js/app.js?v=13.2',
    '/js/messages.js?v=13.2',
    '/js/watchTogether.js?v=13.2',
    '/js/calling.js?v=13.2',
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

// ============================================================
//  WEB PUSH NOTIFICATION HANDLER
//  Receives push events and shows native browser/Android notifications
// ============================================================

self.addEventListener('push', (event) => {
    if (!event.data) return;

    let data;
    try {
        data = event.data.json();
    } catch {
        return;
    }

    const title = data.title || 'VideoHost';
    const body = data.body || 'You have a new message';
    const messageId = data.messageId;
    const sender = data.sender || '';
    const tag = data.tag || `msg-${sender}`;
    const url = data.url || '/messages';

    // Check if user is currently viewing the messages page
    // If so, skip the system notification (SSE handles in-page updates)
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            // Check if any visible client is on the messages page
            const isViewingMessages = clients.some((client) => {
                if (client.visibilityState !== 'visible') return false;
                try {
                    const clientUrl = new URL(client.url);
                    return clientUrl.pathname === '/messages';
                } catch {
                    return false;
                }
            });

            if (isViewingMessages) {
                // User is actively viewing messages — SSE handles UI updates
                // Skip the system notification to avoid being intrusive
                return;
            }

            // Show the native notification
            const options = {
                body,
                icon: data.icon || '/css/icon-192.png',
                badge: data.badge || '/css/icon-192.png',
                tag,
                renotify: true, // Vibrate/sound even when replacing same tag
                data: {
                    url,
                    messageId,
                    sender,
                    timestamp: data.timestamp
                },
                vibrate: [200, 100, 200],
                requireInteraction: false,
                silent: false
            };

            // Add timestamp if available
            if (data.timestamp) {
                try {
                    options.timestamp = new Date(data.timestamp).getTime();
                } catch {}
            }

            return self.registration.showNotification(title, options);
        })
    );
});

// ============================================================
//  NOTIFICATION CLICK HANDLER
//  Opens/focuses the website and navigates to the correct conversation
// ============================================================

self.addEventListener('notificationclick', (event) => {
    const notification = event.notification;
    notification.close();

    const targetUrl = (notification.data && notification.data.url) || '/messages';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
            // Try to find an existing tab with our site open
            for (const client of clients) {
                try {
                    const clientUrl = new URL(client.url);
                    // Check if this client is from our origin
                    if (clientUrl.origin === self.location.origin) {
                        // Navigate to messages if not already there
                        client.navigate(targetUrl);
                        client.focus();
                        return;
                    }
                } catch {}
            }

            // No existing tab found — open a new one
            return self.clients.openWindow(targetUrl);
        })
    );
});

// ============================================================
//  MESSAGE HANDLER
//  Communication between the main page and service worker
// ============================================================

self.addEventListener('message', (event) => {
    if (!event.data) return;

    // Handle skip-notification message from the active page
    // (used when the page knows the user is viewing the conversation)
    if (event.data.type === 'SKIP_NOTIFICATION') {
        // The page is signaling that it's handling this message in-page
        // No action needed — the push handler already checks visibility
    }
});
