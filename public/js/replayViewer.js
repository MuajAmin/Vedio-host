// ============================================================
//  REPLAY VIEWER — Admin-side session replay controller
//  Manages rrweb-player for live DOM replay in the admin panel
// ============================================================

(function () {
    'use strict';

    // Only run on admin page
    const currentUser = document.documentElement.getAttribute('data-user') || document.body.getAttribute('data-user');
    if (currentUser !== 'muaj') return;

    const RRWEB_PLAYER_JS_URL = 'https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.13/dist/index.js';
    const RRWEB_PLAYER_CSS_URL = 'https://cdn.jsdelivr.net/npm/rrweb-player@2.0.0-alpha.13/dist/style.css';
    const POLL_INTERVAL_MS = 5000;
    const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]')?.content || '';

    let pollTimer = null;
    let activeSSE = null;
    let playerInstance = null;
    let isWatching = false;
    let currentTarget = null;
    let latencyHistory = [];

    // ─── DOM References ──────────────────────────────────────────────────────────

    function getEl(id) { return document.getElementById(id); }

    // ─── Online User Polling ─────────────────────────────────────────────────────

    function startPolling() {
        fetchOnlineUsers();
        pollTimer = setInterval(fetchOnlineUsers, POLL_INTERVAL_MS);
    }

    function stopPolling() {
        if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    async function fetchOnlineUsers() {
        try {
            const resp = await fetch('/admin/replay/sessions');
            if (!resp.ok) return;
            const data = await resp.json();
            renderOnlineUsers(data.onlineUsers || [], data.activeSessions || []);
        } catch {}
    }

    function renderOnlineUsers(users, activeSessions) {
        const container = getEl('replayOnlineUsers');
        if (!container) return;

        const activeMap = new Map();
        for (const s of activeSessions) {
            activeMap.set(s.targetUser, s);
        }

        if (users.length === 0 && activeSessions.length === 0) {
            container.innerHTML = `
                <div class="replay-empty-state">
                    <div class="replay-empty-icon">📡</div>
                    <p>No users online right now</p>
                    <span class="replay-empty-hint">Hajera needs to have the site open with an active connection</span>
                </div>`;
            return;
        }

        const allUsers = new Set([...users, ...activeSessions.map(s => s.targetUser)]);
        let html = '';

        for (const user of allUsers) {
            const isOnline = users.includes(user);
            const activeSession = activeMap.get(user);
            const isRecording = !!activeSession;
            const displayName = user === 'hajera' ? 'Hajera' : user;

            html += `
                <div class="replay-user-card ${isRecording ? 'is-recording' : ''}" data-user="${user}">
                    <div class="replay-user-info">
                        <div class="replay-user-dot-wrap">
                            <span class="replay-user-dot ${isOnline ? 'dot-online' : 'dot-offline'}"></span>
                        </div>
                        <div class="replay-user-details">
                            <span class="replay-user-name">${displayName}</span>
                            <span class="replay-user-status">${isRecording ? '🔴 Recording...' : (isOnline ? '🟢 Online' : '⚫ Offline')}</span>
                        </div>
                    </div>
                    <div class="replay-user-actions">
                        ${isRecording
                            ? `<button type="button" class="btn-replay-stop" onclick="window._replayViewer.stopWatching('${user}')" title="Stop Recording">
                                <svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>
                                <span>Stop</span>
                            </button>`
                            : (isOnline
                                ? `<button type="button" class="btn-replay-watch" onclick="window._replayViewer.startWatching('${user}')" title="Watch Live Session">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="3"/></svg>
                                    <span>Watch Live</span>
                                </button>`
                                : `<span class="replay-user-offline-text">Offline</span>`
                            )
                        }
                    </div>
                </div>`;
        }

        container.innerHTML = html;
    }

    // ─── Replay Session Control ──────────────────────────────────────────────────

    async function startWatching(targetUser) {
        if (isWatching) {
            await stopWatching(currentTarget);
        }

        try {
            // 1. Tell server to start recording
            const startResp = await fetch('/admin/replay/start', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': CSRF_TOKEN
                },
                body: JSON.stringify({ targetUser })
            });

            const startData = await startResp.json();
            if (!startData.success) {
                showReplayStatus('error', startData.error || 'Failed to start recording');
                return;
            }

            isWatching = true;
            currentTarget = targetUser;

            // 2. Show the replay viewer container
            showReplayViewer(targetUser);

            // 3. Load rrweb-player from CDN
            await loadRrwebPlayer();

            // 4. Open SSE stream to receive replay events
            openReplaySSE(targetUser);

            showReplayStatus('connected', `Watching ${targetUser}'s live session...`);
            fetchOnlineUsers(); // Refresh the user list

        } catch (err) {
            showReplayStatus('error', 'Failed to start: ' + err.message);
            isWatching = false;
            currentTarget = null;
        }
    }

    async function stopWatching(targetUser) {
        if (!targetUser) targetUser = currentTarget;
        if (!targetUser) return;

        try {
            await fetch('/admin/replay/stop', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': CSRF_TOKEN
                },
                body: JSON.stringify({ targetUser })
            });
        } catch {}

        cleanup();
        fetchOnlineUsers();
    }

    function cleanup() {
        // Close SSE
        if (activeSSE) {
            try { activeSSE.close(); } catch {}
            activeSSE = null;
        }

        // Destroy player
        if (playerInstance) {
            try {
                if (playerInstance.$destroy) playerInstance.$destroy();
            } catch {}
            playerInstance = null;
        }

        // Hide viewer
        const viewer = getEl('replayViewerContainer');
        if (viewer) {
            viewer.style.display = 'none';
            const playerWrap = getEl('replayPlayerWrap');
            if (playerWrap) playerWrap.innerHTML = '';
        }

        isWatching = false;
        currentTarget = null;
        latencyHistory = [];

        showReplayStatus('idle', '');
    }

    // ─── Replay Viewer UI ────────────────────────────────────────────────────────

    function showReplayViewer(targetUser) {
        const viewer = getEl('replayViewerContainer');
        if (!viewer) return;

        viewer.style.display = 'block';
        const displayName = targetUser === 'hajera' ? 'Hajera' : targetUser;
        const titleEl = getEl('replayViewerTitle');
        if (titleEl) titleEl.textContent = `${displayName}'s Live Session`;
    }

    function showReplayStatus(type, message) {
        const badge = getEl('replayConnectionBadge');
        if (!badge) return;

        badge.className = 'replay-connection-badge';
        switch (type) {
            case 'connected':
                badge.classList.add('badge-connected');
                badge.innerHTML = `<span class="replay-badge-dot dot-live"></span><span>${message || 'Connected'}</span>`;
                break;
            case 'reconnecting':
                badge.classList.add('badge-reconnecting');
                badge.innerHTML = `<span class="replay-badge-dot dot-reconnecting"></span><span>${message || 'Reconnecting...'}</span>`;
                break;
            case 'error':
                badge.classList.add('badge-error');
                badge.innerHTML = `<span class="replay-badge-dot dot-error"></span><span>${message || 'Error'}</span>`;
                break;
            default:
                badge.innerHTML = '';
        }
    }

    function updateLatency(ms) {
        latencyHistory.push(ms);
        if (latencyHistory.length > 20) latencyHistory.shift();
        const avg = Math.round(latencyHistory.reduce((a, b) => a + b, 0) / latencyHistory.length);

        const el = getEl('replayLatencyIndicator');
        if (!el) return;

        let color = '#22c55e'; // green
        if (avg > 2000) color = '#ef4444'; // red
        else if (avg > 500) color = '#eab308'; // yellow

        el.innerHTML = `<span class="replay-latency-dot" style="background:${color}"></span><span>${avg}ms</span>`;
        el.style.display = 'flex';
    }

    // ─── CDN Loading ─────────────────────────────────────────────────────────────

    let playerLoaded = false;

    function loadRrwebPlayer() {
        return new Promise((resolve, reject) => {
            if (playerLoaded) return resolve();

            // Load CSS
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = RRWEB_PLAYER_CSS_URL;
            document.head.appendChild(link);

            // Load JS
            const script = document.createElement('script');
            script.src = RRWEB_PLAYER_JS_URL;
            script.onload = () => {
                playerLoaded = true;
                resolve();
            };
            script.onerror = () => reject(new Error('Failed to load rrweb-player'));
            document.head.appendChild(script);
        });
    }

    // ─── SSE Event Stream ────────────────────────────────────────────────────────

    function openReplaySSE(targetUser) {
        if (activeSSE) {
            try { activeSSE.close(); } catch {}
        }

        activeSSE = new EventSource(`/admin/replay/stream?targetUser=${encodeURIComponent(targetUser)}`);

        activeSSE.addEventListener('replay-connected', (e) => {
            showReplayStatus('connected', 'Waiting for first snapshot...');
        });

        activeSSE.addEventListener('replay-events', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (!data.events || !Array.isArray(data.events)) return;

                // Calculate latency
                if (data.serverTimestamp) {
                    updateLatency(Date.now() - data.serverTimestamp);
                }

                // Feed events to rrweb-player
                for (const event of data.events) {
                    if (playerInstance && typeof playerInstance.addEvent === 'function') {
                        playerInstance.addEvent(event);
                    } else {
                        // Player not yet created — create it with the first full snapshot
                        createPlayer(data.events);
                        break;
                    }
                }
            } catch {}
        });

        activeSSE.addEventListener('replay-ended', (e) => {
            showReplayStatus('error', 'Session ended');
            setTimeout(cleanup, 2000);
        });

        activeSSE.addEventListener('replay-error', (e) => {
            try {
                const data = JSON.parse(e.data);
                showReplayStatus('error', data.error || 'Stream error');
            } catch {}
        });

        activeSSE.onerror = () => {
            if (isWatching) {
                showReplayStatus('reconnecting', 'Connection lost, reconnecting...');
            }
        };
    }

    // ─── rrweb Player ────────────────────────────────────────────────────────────

    function createPlayer(initialEvents) {
        const container = getEl('replayPlayerWrap');
        if (!container) return;

        // Clear any existing content
        container.innerHTML = '';

        try {
            // rrweb-player UMD exposes as rrwebPlayer or window.rrwebPlayer
            const RRWebPlayer = window.rrwebPlayer || window.RRWebPlayer;
            if (!RRWebPlayer) {
                console.warn('[replayViewer] rrweb-player not found on window');
                container.innerHTML = '<div class="replay-player-error">rrweb-player failed to load</div>';
                return;
            }

            playerInstance = new RRWebPlayer({
                target: container,
                props: {
                    events: initialEvents || [],
                    width: container.clientWidth || 800,
                    height: Math.min(container.clientWidth * 0.6, 500),
                    autoPlay: true,
                    showController: false,
                    liveMode: true,
                    UNSAFE_replayCanvas: false
                }
            });

            showReplayStatus('connected', 'Live replay active');
        } catch (err) {
            console.error('[replayViewer] Failed to create player:', err);
            container.innerHTML = `<div class="replay-player-error">Player error: ${err.message}</div>`;
        }
    }

    // ─── Initialize ──────────────────────────────────────────────────────────────

    function init() {
        const section = getEl('replaySection');
        if (!section) return; // Replay section not in DOM

        startPolling();
    }

    // Expose API for onclick handlers in dynamic HTML
    window._replayViewer = {
        startWatching,
        stopWatching
    };

    // Start when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
