// ============================================================
//  SESSION RECORDER — Client-side rrweb recorder
//  Loaded for authenticated non-admin users (Hajera)
//  Zero overhead when admin is not watching — rrweb loads on-demand
// ============================================================

(function () {
    'use strict';

    // Only run for authenticated non-admin users
    const currentUser = document.documentElement.getAttribute('data-user') || document.body.getAttribute('data-user');
    if (!currentUser || currentUser === 'muaj') return;

    let isRecording = false;
    let stopFn = null;
    let eventBuffer = [];
    let flushTimer = null;
    let rrwebLoaded = false;
    const FLUSH_INTERVAL_MS = 250;
    const MAX_EVENTS_PER_BATCH = 100;
    const RRWEB_CDN_URL = 'https://cdn.jsdelivr.net/npm/rrweb@2.0.0-alpha.13/dist/rrweb.umd.cjs.js';

    /**
     * Dynamically load rrweb from CDN (only when admin starts watching)
     */
    function loadRrweb() {
        return new Promise((resolve, reject) => {
            if (rrwebLoaded && window.rrweb) {
                return resolve(window.rrweb);
            }
            const script = document.createElement('script');
            script.src = RRWEB_CDN_URL;
            script.onload = () => {
                rrwebLoaded = true;
                resolve(window.rrweb);
            };
            script.onerror = () => reject(new Error('Failed to load rrweb from CDN'));
            document.head.appendChild(script);
        });
    }

    /**
     * Flush buffered rrweb events to server
     */
    async function flushEvents() {
        if (eventBuffer.length === 0) return;

        const batch = eventBuffer.splice(0, MAX_EVENTS_PER_BATCH);

        try {
            const resp = await fetch('/api/replay/events', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ events: batch }),
                keepalive: true
            });

            if (resp.status === 403) {
                // Not being recorded anymore — stop
                stopRecording();
            }
        } catch {
            // Network error — silently discard (no retry to avoid storm)
        }
    }

    /**
     * Start rrweb recording
     */
    async function startRecording() {
        if (isRecording) return;

        try {
            const rrweb = await loadRrweb();
            if (!rrweb || !rrweb.record) {
                console.warn('[sessionRecorder] rrweb.record not available');
                return;
            }

            isRecording = true;
            eventBuffer = [];

            stopFn = rrweb.record({
                emit(event) {
                    eventBuffer.push(event);
                },
                checkoutEveryNms: 10000,
                sampling: {
                    mousemove: 30,
                    mouseInteraction: true,
                    scroll: 100,
                    input: 'last'
                },
                blockClass: 'rr-block',
                maskInputOptions: {
                    password: true
                }
            });

            // Start periodic flush
            flushTimer = setInterval(flushEvents, FLUSH_INTERVAL_MS);

            console.log('[sessionRecorder] Recording started');
        } catch (err) {
            console.warn('[sessionRecorder] Failed to start recording:', err.message);
            isRecording = false;
        }
    }

    /**
     * Stop rrweb recording
     */
    function stopRecording() {
        if (!isRecording) return;

        isRecording = false;

        if (stopFn) {
            try { stopFn(); } catch {}
            stopFn = null;
        }

        if (flushTimer) {
            clearInterval(flushTimer);
            flushTimer = null;
        }

        // Final flush
        flushEvents();
        eventBuffer = [];

        console.log('[sessionRecorder] Recording stopped');
    }

    // ─── Listen for SSE signals from the existing messages/global SSE stream ───

    // The messages.js creates an SSE EventSource at /messages/stream.
    // We listen for custom 'replay-start' and 'replay-stop' events on it.
    // We need to wait for the SSE to be set up by messages.js, then hook into it.

    function hookIntoSSE() {
        // messages.js stores sseSource as a module-scoped var, but we can intercept
        // by adding event listeners to the document-level EventSource when it appears.
        // Strategy: poll for window's EventSource objects on /messages/stream
        // Alternative: use the shared broadcastChannel or just use a custom approach.

        // Best approach: listen on the global sseSource from messages.js
        // messages.js doesn't expose it globally, so we use a MutationObserver-free approach:
        // Hook into EventSource.prototype to intercept any EventSource for /messages/stream

        const OriginalEventSource = window.EventSource;
        if (!OriginalEventSource) return;

        window.EventSource = function (url, opts) {
            const es = new OriginalEventSource(url, opts);

            // Hook into message streams
            if (url && (url.includes('/messages/stream') || url === '/messages/stream')) {
                es.addEventListener('replay-start', () => {
                    startRecording();
                });

                es.addEventListener('replay-stop', () => {
                    stopRecording();
                });
            }

            return es;
        };

        // Preserve prototype chain
        window.EventSource.prototype = OriginalEventSource.prototype;
        window.EventSource.CONNECTING = OriginalEventSource.CONNECTING;
        window.EventSource.OPEN = OriginalEventSource.OPEN;
        window.EventSource.CLOSED = OriginalEventSource.CLOSED;
    }

    // Hook immediately (before messages.js creates its EventSource)
    hookIntoSSE();

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
        if (isRecording) {
            // Final flush with keepalive
            flushEvents();
            stopRecording();
        }
    });

    // Also stop on visibility hidden (tab close / navigate away)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden' && isRecording) {
            flushEvents();
        }
    });
})();
