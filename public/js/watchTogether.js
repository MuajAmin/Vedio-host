/**
 * Watch Together — Cinema Real-Time Sync & Live Chat Engine
 * Real-time video sync + chat between Muaj & Hajera
 */
(function () {
    'use strict';

    // Prevent double initialization
    if (window.__WATCH_TOGETHER_INITIALIZED__) return;
    window.__WATCH_TOGETHER_INITIALIZED__ = true;

    // Detect user from body attribute or badge
    const currentUser = (document.body.dataset.user ||
        (document.body.querySelector('.badge-admin') ? 'muaj' :
            (document.body.querySelector('.badge-viewer') ? 'hajera' : ''))).toLowerCase();

    if (!currentUser) return; // Not logged in

    const isHost = currentUser === 'muaj';
    const isGuest = currentUser === 'hajera';

    // Video element on watch pages
    const video = document.getElementById('vpVideo');
    const isWatchPage = !!video;
    const currentVideoId = video ? video.dataset.videoId : null;

    // State
    let roomId = null;
    let eventSource = null;
    let syncActive = false;
    let ignoreNextSeek = false;
    let ignoreNextPlay = false;
    let ignoreNextPause = false;
    let lastSyncTime = 0;
    let dismissedRoomId = null;
    let dismissExpiry = 0;
    const SYNC_THROTTLE_MS = 250;
    const SYNC_TOLERANCE_SEC = 1.2;

    // DOM Elements (Watch page)
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

    // DOM Elements (Global layout)
    const globalWtToast = document.getElementById('globalWtToast');
    const globalWtToastTitle = document.getElementById('globalWtToastTitle');
    const globalWtToastJoin = document.getElementById('globalWtToastJoin');
    const globalWtToastClose = document.getElementById('globalWtToastClose');

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
    //  CHECK ACTIVE ROOM (POLLING EVERY 2.5s)
    // ============================================================
    async function checkActiveRoom() {
        if (syncActive && roomId) return; // Already connected in an active session

        try {
            const data = await fetch('/watch-together/active', { credentials: 'same-origin' }).then(r => r.json());
            if (!data) {
                // No active room
                hideInvites();
                return;
            }

            // Host reconnecting on watch page
            if (isHost && isWatchPage && data.role === 'host' && data.videoId === currentVideoId) {
                if (!roomId) {
                    roomId = data.roomId;
                    startSSE();
                    showSyncActive();
                }
                return;
            }

            // Guest (Hajera) invited
            if (isGuest || (!isHost && data.host !== currentUser)) {
                // Check if user temporarily dismissed this room
                if (dismissedRoomId === data.roomId && Date.now() < dismissExpiry) {
                    return;
                }

                roomId = data.roomId;

                if (isWatchPage && data.videoId === currentVideoId) {
                    // Hajera is on the same video watch page
                    showInPageInvite(data);

                    // Auto-join if URL param ?join=1 was passed
                    const urlParams = new URLSearchParams(window.location.search);
                    if (urlParams.get('join') === '1' || urlParams.get('join') === 'true') {
                        joinRoom();
                    }
                } else {
                    // Hajera is on dashboard or another video page
                    showGlobalToast(data);
                }
            }
        } catch (err) {
            // Ignore polling errors
        }
    }

    function showInPageInvite(data) {
        if (!wtInviteBanner) return;
        const titleEl = wtInviteBanner.querySelector('.wt-invite-video-title');
        if (titleEl) titleEl.textContent = data.videoTitle || 'this video';
        wtInviteBanner.classList.add('visible');
    }

    function showGlobalToast(data) {
        if (!globalWtToast) return;
        if (globalWtToastTitle) {
            globalWtToastTitle.textContent = `Muaj invited you to watch: "${data.videoTitle || 'a video'}" together!`;
        }
        if (globalWtToastJoin) {
            globalWtToastJoin.href = `/watch/${encodeURIComponent(data.videoId)}?join=1`;
        }
        globalWtToast.style.display = 'flex';
        globalWtToast.classList.add('visible');
    }

    function hideInvites() {
        if (wtInviteBanner) wtInviteBanner.classList.remove('visible');
        if (globalWtToast) {
            globalWtToast.classList.remove('visible');
            globalWtToast.style.display = 'none';
        }
    }

    // Dismiss buttons
    if (wtDismissBtn) {
        wtDismissBtn.addEventListener('click', () => {
            if (wtInviteBanner) wtInviteBanner.classList.remove('visible');
            dismissedRoomId = roomId;
            dismissExpiry = Date.now() + (60 * 1000); // 1 minute dismiss
        });
    }

    if (globalWtToastClose) {
        globalWtToastClose.addEventListener('click', () => {
            hideInvites();
            dismissedRoomId = roomId;
            dismissExpiry = Date.now() + (60 * 1000);
        });
    }

    // Join button on in-page banner
    if (wtJoinBtn) {
        wtJoinBtn.addEventListener('click', (e) => {
            e.preventDefault();
            joinRoom();
        });
    }

    // Polling timer every 2.5 seconds
    setInterval(checkActiveRoom, 2500);

    // ============================================================
    //  HOST: CREATE ROOM (MUAJ)
    // ============================================================
    if (wtStartBtn && isWatchPage && isHost) {
        wtStartBtn.addEventListener('click', async () => {
            try {
                wtStartBtn.disabled = true;
                const titleEl = document.getElementById('videoTitleText');
                const videoTitle = titleEl ? titleEl.textContent.trim() : '';

                const data = await postJSON('/watch-together/create', { videoId: currentVideoId, videoTitle });
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
    //  STOP / LEAVE SESSION (HOST OR GUEST)
    // ============================================================
    async function endOrLeaveSession() {
        if (!roomId) {
            cleanup();
            return;
        }

        const confirmMsg = isHost ?
            'Watch Together সেশনটি বন্ধ করতে চাও? (উভয়ের জন্য সেশন শেষ হবে)' :
            'Watch Together সেশন থেকে বের হতে চাও?';

        if (window.confirm(confirmMsg)) {
            try {
                await postJSON(`/watch-together/leave/${roomId}`);
            } catch {}
            cleanup();
        }
    }

    document.querySelectorAll('.wt-stop-session-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            endOrLeaveSession();
        });
    });

    // ============================================================
    //  GUEST: JOIN ROOM (HAJERA)
    // ============================================================
    async function joinRoom() {
        if (!roomId) {
            try {
                const data = await fetch('/watch-together/active', { credentials: 'same-origin' }).then(r => r.json());
                if (data && data.roomId) {
                    roomId = data.roomId;
                }
            } catch {}
        }
        if (!roomId) return;

        try {
            const data = await postJSON(`/watch-together/join/${roomId}`);
            if (data.status === 'joined' || data.status === 'already-host') {
                hideInvites();

                // If not on the right watch page, redirect
                if (data.videoId && data.videoId !== currentVideoId) {
                    window.location.href = `/watch/${encodeURIComponent(data.videoId)}?join=1`;
                    return;
                }

                startSSE();
                showSyncActive();

                // Apply initial video state
                if (data.videoState && video) {
                    applyVideoState(data.videoState);
                }

                // Load chat history
                if (data.chatHistory && wtChatMessages) {
                    wtChatMessages.innerHTML = '';
                    data.chatHistory.forEach(msg => appendChatMessage(msg, false));
                }
            }
        } catch (err) {
            console.error('[WT] Join error:', err);
        }
    }

    // ============================================================
    //  SSE CONNECTION
    // ============================================================
    function startSSE() {
        if (!roomId) return;
        if (eventSource) eventSource.close();

        eventSource = new EventSource(`/watch-together/stream/${roomId}`);

        eventSource.addEventListener('connected', (e) => {
            try {
                const data = JSON.parse(e.data);
                syncActive = true;
                updateStatusBar('connected', data.guest ? 2 : 1);

                if (!isHost && data.chatHistory && wtChatMessages) {
                    wtChatMessages.innerHTML = '';
                    data.chatHistory.forEach(msg => appendChatMessage(msg, false));
                }
            } catch {}
        });

        eventSource.addEventListener('sync', (e) => {
            if (isHost) return; // Host doesn't sync from server
            try {
                const data = JSON.parse(e.data);
                applyVideoState(data);
            } catch {}
        });

        eventSource.addEventListener('chat', (e) => {
            try {
                const msg = JSON.parse(e.data);
                appendChatMessage(msg, true);
            } catch {}
        });

        eventSource.addEventListener('user-joined', (e) => {
            try {
                const data = JSON.parse(e.data);
                updateStatusBar('connected', 2);
                appendSystemMessage(`${data.user === 'hajera' ? 'Hajera' : 'Muaj'} joined the session 🎉`);

                // Re-sync current video state for the new guest
                if (isHost && video) {
                    sendSync('join-sync');
                }
            } catch {}
        });

        eventSource.addEventListener('user-left', (e) => {
            try {
                const data = JSON.parse(e.data);
                updateStatusBar('waiting', 1);
                appendSystemMessage(`${data.user === 'hajera' ? 'Hajera' : 'Muaj'} left the session`);
            } catch {}
        });

        eventSource.addEventListener('user-disconnected', (e) => {
            try {
                const data = JSON.parse(e.data);
                updateStatusBar('waiting', data.memberCount || 1);
            } catch {}
        });

        eventSource.addEventListener('room-closed', (e) => {
            try {
                const data = JSON.parse(e.data);
                appendSystemMessage(`Session ended: ${data.reason || 'Closed'}`);
                cleanup();
            } catch {}
        });

        eventSource.onerror = () => {
            updateStatusBar('reconnecting', 0);
        };
    }

    // ============================================================
    //  VIDEO SYNC LOGIC
    // ============================================================
    function applyVideoState(state) {
        if (!state || isHost || !video) return;

        const timeDiff = Math.abs(video.currentTime - state.currentTime);

        // Seek if time drift exceeds tolerance
        if (timeDiff > SYNC_TOLERANCE_SEC) {
            ignoreNextSeek = true;
            video.currentTime = state.currentTime;

            if (wtSyncOverlay) {
                wtSyncOverlay.classList.add('visible');
                setTimeout(() => wtSyncOverlay.classList.remove('visible'), 1400);
            }
        }

        // Sync play / pause
        if (state.playing && video.paused) {
            ignoreNextPlay = true;
            video.play().catch(() => {});
        } else if (!state.playing && !video.paused) {
            ignoreNextPause = true;
            video.pause();
        }

        // Sync speed
        if (state.playbackRate && video.playbackRate !== state.playbackRate) {
            video.playbackRate = state.playbackRate;
        }
    }

    function sendSync(action = 'update') {
        if (!isHost || !roomId || !syncActive || !video) return;

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

    // Host Video Event Listeners
    if (isHost && video) {
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

        // Periodic sync every 2.5s while playing
        setInterval(() => {
            if (!video.paused && syncActive) {
                sendSync('update');
            }
        }, 2500);
    }

    // ============================================================
    //  LIVE CHAT
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

        // Unread Badge
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
            console.error('[WT] Chat error:', err);
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

    // Chat Drawer Toggle
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

    // Emoji Bar
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
    //  UI STATE MANAGEMENT
    // ============================================================
    function showSyncActive() {
        syncActive = true;
        if (wtPanel) wtPanel.classList.add('wt-active');

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

        const otherName = isHost ? 'Hajera' : 'Muaj';
        const statusMap = {
            'connected': `🟢 Watch Together • 2 connected`,
            'waiting': `🟡 Waiting for ${otherName}...`,
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

        if (wtPanel) wtPanel.classList.remove('wt-active');

        if (isHost) {
            if (wtStartBtn) { wtStartBtn.style.display = ''; wtStartBtn.disabled = false; }
            if (wtStopBtn) wtStopBtn.style.display = 'none';
        }

        if (wtStatusBar) wtStatusBar.classList.remove('visible');
        if (wtChatToggle) wtChatToggle.style.display = 'none';
        if (wtChatPanel) wtChatPanel.classList.remove('open');
        hideInvites();

        chatOpen = false;
        unreadCount = 0;
        updateUnreadBadge();
    }

    // ============================================================
    //  INITIAL TRIGGER
    // ============================================================
    checkActiveRoom();

    // Auto-join check on watch page load
    if (isWatchPage) {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('join') === '1' || urlParams.get('join') === 'true') {
            joinRoom();
        }
    }

    // Best-effort cleanup on window close
    window.addEventListener('beforeunload', () => {
        if (roomId && eventSource && isHost) {
            navigator.sendBeacon(`/watch-together/leave/${roomId}`,
                new Blob([JSON.stringify({})], { type: 'application/json' }));
        }
    });

})();
