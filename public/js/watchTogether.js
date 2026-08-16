/**
 * Watch Together — Client-Side Sync Engine
 * Real-time video sync + chat between Muaj & Hajera
 */
(function () {
    'use strict';

    // Only run on watch pages
    const video = document.getElementById('vpVideo');
    if (!video) return;

    const videoId = video.dataset.videoId;
    const csrfToken = video.dataset.csrfToken;
    const currentUser = document.body.querySelector('.user-badge') ?
        (document.body.querySelector('.badge-admin') ? 'muaj' : 'hajera') : null;
    if (!currentUser) return;

    const isHost = currentUser === 'muaj';

    // State
    let roomId = null;
    let eventSource = null;
    let syncActive = false;
    let ignoreNextSeek = false;
    let ignoreNextPlay = false;
    let ignoreNextPause = false;
    let lastSyncTime = 0;
    const SYNC_THROTTLE_MS = 300;
    const SYNC_TOLERANCE_SEC = 1.5;

    // ============================================================
    //  DOM ELEMENTS
    // ============================================================
    const wtPanel = document.getElementById('wtPanel');
    const wtChatPanel = document.getElementById('wtChatPanel');
    const wtStartBtn = document.getElementById('wtStartBtn');
    const wtStopBtn = document.getElementById('wtStopBtn');
    const wtInviteBanner = document.getElementById('wtInviteBanner');
    const wtJoinBtn = document.getElementById('wtJoinBtn');
    const wtDismissBtn = document.getElementById('wtDismissBtn');
    const wtStatusBar = document.getElementById('wtStatusBar');
    const wtStatusText = document.getElementById('wtStatusText');
    const wtChatToggle = document.getElementById('wtChatToggle');
    const wtChatClose = document.getElementById('wtChatClose');
    const wtChatMessages = document.getElementById('wtChatMessages');
    const wtChatInput = document.getElementById('wtChatInput');
    const wtChatSendBtn = document.getElementById('wtChatSendBtn');
    const wtUnreadBadge = document.getElementById('wtUnreadBadge');
    const wtSyncOverlay = document.getElementById('wtSyncOverlay');

    if (!wtPanel) return;

    let chatOpen = false;
    let unreadCount = 0;

    // ============================================================
    //  UTILITY
    // ============================================================
    function postJSON(url, body = {}) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin'
        }).then(r => r.json());
    }

    function formatTime(seconds) {
        const s = Math.floor(seconds || 0);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        if (h > 0) return `${h}:${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
        return `${m}:${sec < 10 ? '0' : ''}${sec}`;
    }

    function timeAgo(ts) {
        const diff = Math.floor((Date.now() - ts) / 1000);
        if (diff < 60) return 'just now';
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        return Math.floor(diff / 3600) + 'h ago';
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    // ============================================================
    //  CHECK FOR ACTIVE ROOM ON PAGE LOAD
    // ============================================================
    async function checkActiveRoom() {
        try {
            const data = await fetch('/watch-together/active', { credentials: 'same-origin' }).then(r => r.json());
            if (!data) return;

            if (data.role === 'host' && data.videoId === videoId) {
                // Reconnect to own room
                roomId = data.roomId;
                startSSE();
                showSyncActive();
            } else if ((data.role === 'invited' || data.role === 'guest') && !isHost) {
                // Show invite banner
                if (wtInviteBanner) {
                    const titleEl = wtInviteBanner.querySelector('.wt-invite-video-title');
                    if (titleEl) titleEl.textContent = data.videoTitle || 'a video';
                    wtInviteBanner.classList.add('visible');
                    roomId = data.roomId;

                    // If we're on the same video, auto-connect
                    if (data.videoId === videoId && data.role === 'guest') {
                        joinRoom();
                    }
                }
            }
        } catch {}
    }

    // ============================================================
    //  HOST: CREATE ROOM
    // ============================================================
    if (wtStartBtn) {
        wtStartBtn.addEventListener('click', async () => {
            try {
                wtStartBtn.disabled = true;
                const titleEl = document.getElementById('videoTitleText');
                const videoTitle = titleEl ? titleEl.textContent.trim() : '';

                const data = await postJSON('/watch-together/create', { videoId, videoTitle });
                if (data.roomId) {
                    roomId = data.roomId;
                    startSSE();
                    showSyncActive();
                }
            } catch (err) {
                console.error('[WT] Create error:', err);
                wtStartBtn.disabled = false;
            }
        });
    }

    // ============================================================
    //  HOST: STOP SESSION
    // ============================================================
    if (wtStopBtn) {
        wtStopBtn.addEventListener('click', async () => {
            if (!roomId) return;
            try {
                await postJSON(`/watch-together/leave/${roomId}`);
                cleanup();
            } catch {}
        });
    }

    // ============================================================
    //  GUEST: JOIN ROOM
    // ============================================================
    async function joinRoom() {
        if (!roomId) return;
        try {
            const data = await postJSON(`/watch-together/join/${roomId}`);
            if (data.status === 'joined' || data.status === 'already-host') {
                startSSE();
                showSyncActive();

                // Apply initial video state
                if (data.videoState) {
                    applyVideoState(data.videoState);
                }

                // Load chat history
                if (data.chatHistory) {
                    data.chatHistory.forEach(msg => appendChatMessage(msg, false));
                }

                // If different video, redirect
                if (data.videoId && data.videoId !== videoId) {
                    window.location.href = `/watch/${encodeURIComponent(data.videoId)}`;
                }

                if (wtInviteBanner) wtInviteBanner.classList.remove('visible');
            }
        } catch (err) {
            console.error('[WT] Join error:', err);
        }
    }

    if (wtJoinBtn) {
        wtJoinBtn.addEventListener('click', () => {
            // If we need to redirect to the room's video
            fetch('/watch-together/active', { credentials: 'same-origin' })
                .then(r => r.json())
                .then(data => {
                    if (data && data.videoId !== videoId) {
                        // Redirect to the correct video first
                        window.location.href = `/watch/${encodeURIComponent(data.videoId)}`;
                    } else {
                        joinRoom();
                    }
                })
                .catch(() => joinRoom());
        });
    }

    if (wtDismissBtn) {
        wtDismissBtn.addEventListener('click', () => {
            if (wtInviteBanner) wtInviteBanner.classList.remove('visible');
        });
    }

    // ============================================================
    //  SSE CONNECTION
    // ============================================================
    function startSSE() {
        if (eventSource) eventSource.close();

        eventSource = new EventSource(`/watch-together/stream/${roomId}`);

        eventSource.addEventListener('connected', (e) => {
            const data = JSON.parse(e.data);
            syncActive = true;
            updateStatusBar('connected', data.guest ? 2 : 1);

            if (!isHost && data.chatHistory) {
                if (wtChatMessages) wtChatMessages.innerHTML = '';
                data.chatHistory.forEach(msg => appendChatMessage(msg, false));
            }
        });

        eventSource.addEventListener('sync', (e) => {
            if (isHost) return; // Host doesn't sync from server
            const data = JSON.parse(e.data);
            applyVideoState(data);
        });

        eventSource.addEventListener('chat', (e) => {
            const msg = JSON.parse(e.data);
            appendChatMessage(msg, true);
        });

        eventSource.addEventListener('user-joined', (e) => {
            const data = JSON.parse(e.data);
            updateStatusBar('connected', 2);
            appendSystemMessage(`${data.user === 'hajera' ? 'Hajera' : 'Muaj'} joined the session 🎉`);

            // Re-sync current state for the new guest
            if (isHost) {
                sendSync('join-sync');
            }
        });

        eventSource.addEventListener('user-left', (e) => {
            const data = JSON.parse(e.data);
            updateStatusBar('waiting', 1);
            appendSystemMessage(`${data.user === 'hajera' ? 'Hajera' : 'Muaj'} left the session`);
        });

        eventSource.addEventListener('user-disconnected', (e) => {
            const data = JSON.parse(e.data);
            updateStatusBar('waiting', data.memberCount || 1);
        });

        eventSource.addEventListener('room-closed', (e) => {
            const data = JSON.parse(e.data);
            appendSystemMessage(`Session ended: ${data.reason}`);
            cleanup();
        });

        eventSource.onerror = () => {
            updateStatusBar('reconnecting', 0);
            // EventSource auto-reconnects
        };
    }

    // ============================================================
    //  VIDEO SYNC
    // ============================================================
    function applyVideoState(state) {
        if (!state || isHost) return;

        const timeDiff = Math.abs(video.currentTime - state.currentTime);

        // Seek if time is significantly different
        if (timeDiff > SYNC_TOLERANCE_SEC) {
            ignoreNextSeek = true;
            video.currentTime = state.currentTime;

            // Show sync overlay briefly
            if (wtSyncOverlay) {
                wtSyncOverlay.classList.add('visible');
                setTimeout(() => wtSyncOverlay.classList.remove('visible'), 1200);
            }
        }

        // Sync play/pause
        if (state.playing && video.paused) {
            ignoreNextPlay = true;
            video.play().catch(() => {});
        } else if (!state.playing && !video.paused) {
            ignoreNextPause = true;
            video.pause();
        }

        // Sync playback rate
        if (state.playbackRate && video.playbackRate !== state.playbackRate) {
            video.playbackRate = state.playbackRate;
        }
    }

    function sendSync(action = 'update') {
        if (!isHost || !roomId || !syncActive) return;

        const now = Date.now();
        if (action === 'update' && now - lastSyncTime < SYNC_THROTTLE_MS) return;
        lastSyncTime = now;

        postJSON(`/watch-together/sync/${roomId}`, {
            currentTime: video.currentTime,
            playing: !video.paused,
            playbackRate: video.playbackRate,
            action
        }).catch(() => {});
    }

    // Host video event listeners
    if (isHost) {
        video.addEventListener('play', () => {
            if (ignoreNextPlay) { ignoreNextPlay = false; return; }
            sendSync('play');
        });

        video.addEventListener('pause', () => {
            if (ignoreNextPause) { ignoreNextPause = false; return; }
            sendSync('pause');
        });

        video.addEventListener('seeked', () => {
            if (ignoreNextSeek) { ignoreNextSeek = false; return; }
            sendSync('seek');
        });

        video.addEventListener('ratechange', () => {
            sendSync('ratechange');
        });

        // Periodic time sync every 3 seconds while playing
        setInterval(() => {
            if (!video.paused && syncActive) {
                sendSync('update');
            }
        }, 3000);
    }

    // ============================================================
    //  CHAT
    // ============================================================
    function appendChatMessage(msg, animate = true) {
        if (!wtChatMessages) return;

        const isMine = msg.user === currentUser;
        const displayName = msg.user === 'muaj' ? 'Muaj' : 'Hajera';
        const letter = msg.user === 'muaj' ? 'M' : 'H';
        const roleClass = msg.user === 'muaj' ? 'wt-avatar-host' : 'wt-avatar-guest';

        const msgEl = document.createElement('div');
        msgEl.className = `wt-chat-msg ${isMine ? 'wt-msg-mine' : 'wt-msg-other'} ${animate ? 'wt-msg-enter' : ''}`;
        msgEl.innerHTML = `
            <div class="wt-msg-avatar ${roleClass}">${letter}</div>
            <div class="wt-msg-bubble">
                <div class="wt-msg-header">
                    <span class="wt-msg-author">${escapeHtml(displayName)}</span>
                    <span class="wt-msg-time">${timeAgo(msg.timestamp)}</span>
                </div>
                <div class="wt-msg-text">${escapeHtml(msg.text)}</div>
            </div>
        `;

        wtChatMessages.appendChild(msgEl);
        wtChatMessages.scrollTop = wtChatMessages.scrollHeight;

        // Unread badge
        if (!chatOpen && !isMine) {
            unreadCount++;
            updateUnreadBadge();
        }
    }

    function appendSystemMessage(text) {
        if (!wtChatMessages) return;

        const msgEl = document.createElement('div');
        msgEl.className = 'wt-chat-system';
        msgEl.innerHTML = `<span>${escapeHtml(text)}</span>`;
        wtChatMessages.appendChild(msgEl);
        wtChatMessages.scrollTop = wtChatMessages.scrollHeight;
    }

    function sendChatMessage() {
        if (!roomId || !wtChatInput) return;
        const text = wtChatInput.value.trim();
        if (!text) return;

        wtChatInput.value = '';

        postJSON(`/watch-together/chat/${roomId}`, { text }).catch(err => {
            console.error('[WT] Chat send error:', err);
        });
    }

    if (wtChatSendBtn) {
        wtChatSendBtn.addEventListener('click', sendChatMessage);
    }

    if (wtChatInput) {
        wtChatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    // Chat panel toggle
    function toggleChat(forceState) {
        chatOpen = typeof forceState === 'boolean' ? forceState : !chatOpen;
        if (wtChatPanel) wtChatPanel.classList.toggle('open', chatOpen);
        if (chatOpen) {
            unreadCount = 0;
            updateUnreadBadge();
            if (wtChatInput) setTimeout(() => wtChatInput.focus(), 150);
            if (wtChatMessages) wtChatMessages.scrollTop = wtChatMessages.scrollHeight;
        }
    }

    document.querySelectorAll('.wt-chat-toggle-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            toggleChat();
        });
    });

    if (wtChatClose) {
        wtChatClose.addEventListener('click', () => toggleChat(false));
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && chatOpen) {
            toggleChat(false);
        }
    });

    function updateUnreadBadge() {
        if (!wtUnreadBadge) return;
        if (unreadCount > 0) {
            wtUnreadBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
            wtUnreadBadge.style.display = '';
        } else {
            wtUnreadBadge.style.display = 'none';
        }
    }

    // ============================================================
    //  UI STATE MANAGEMENT
    // ============================================================
    function showSyncActive() {
        syncActive = true;
        wtPanel.classList.add('wt-active');

        if (isHost) {
            if (wtStartBtn) wtStartBtn.style.display = 'none';
            if (wtStopBtn) wtStopBtn.style.display = '';
        }

        if (wtStatusBar) wtStatusBar.classList.add('visible');
        if (wtChatToggle) wtChatToggle.style.display = '';

        updateStatusBar('waiting', 1);
    }

    function updateStatusBar(status, count) {
        if (!wtStatusText) return;

        const statusMap = {
            'connected': `🟢 Watch Together • ${count} connected`,
            'waiting': `🟡 Waiting for ${isHost ? 'Hajera' : 'Muaj'}...`,
            'reconnecting': '🔴 Reconnecting...'
        };

        wtStatusText.textContent = statusMap[status] || status;

        if (wtStatusBar) {
            wtStatusBar.className = 'wt-status-bar visible wt-status-' + status;
        }
    }

    function cleanup() {
        syncActive = false;
        roomId = null;

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        wtPanel.classList.remove('wt-active');

        if (isHost) {
            if (wtStartBtn) { wtStartBtn.style.display = ''; wtStartBtn.disabled = false; }
            if (wtStopBtn) wtStopBtn.style.display = 'none';
        }

        if (wtStatusBar) wtStatusBar.classList.remove('visible');
        if (wtChatToggle) wtChatToggle.style.display = 'none';
        if (wtChatPanel) wtChatPanel.classList.remove('open');
        if (wtInviteBanner) wtInviteBanner.classList.remove('visible');

        chatOpen = false;
        unreadCount = 0;
        updateUnreadBadge();
    }

    // ============================================================
    //  EMOJI QUICK ACCESS
    // ============================================================
    const emojiBar = document.getElementById('wtEmojiBar');
    if (emojiBar) {
        emojiBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.wt-emoji-btn');
            if (!btn || !wtChatInput) return;
            wtChatInput.value += btn.textContent;
            wtChatInput.focus();
        });
    }

    // ============================================================
    //  INIT
    // ============================================================
    checkActiveRoom();

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (roomId && eventSource) {
            // Best-effort leave
            navigator.sendBeacon(`/watch-together/leave/${roomId}`,
                new Blob([JSON.stringify({})], { type: 'application/json' }));
        }
    });

})();
