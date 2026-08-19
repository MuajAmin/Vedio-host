/**
 * Watch Together — Cinema Real-Time Sync & Global Notification Engine
 * Unified controller for global floating invitations, video playback synchronization,
 * live chat drawer, and interactive floating reactions between Muaj & Hajera.
 */
(function () {
    'use strict';

    // Prevent double execution on the same page
    if (window.__WATCH_TOGETHER_INITIALIZED__) return;
    window.__WATCH_TOGETHER_INITIALIZED__ = true;

    // Detect logged in user
    function getCurrentUser() {
        return (document.body.dataset.user ||
            (document.body.querySelector('.badge-admin') ? 'muaj' :
                (document.body.querySelector('.badge-viewer') ? 'hajera' : ''))).toLowerCase();
    }

    const currentUser = getCurrentUser();
    if (!currentUser) return; // Not logged in

    // Internal State
    let roomId = null;
    let isHost = false; // Dynamic: true if current user created the active room
    let eventSource = null;
    let syncActive = false;
    let ignoreNextSeek = false;
    let ignoreNextPlay = false;
    let ignoreNextPause = false;
    let lastSyncTime = 0;
    let userAvatars = {};
    let chatOpen = false;
    let unreadCount = 0;
    let toastTimer = null;
    let hostSyncInterval = null; // Periodic sync interval (host only)
    let wtDataReceivedViaSSE = false; // Flag to skip redundant checkActiveRoom API call

    const SYNC_THROTTLE_MS = 250;
    const SYNC_TOLERANCE_SEC = 1.0;

    // Global DOM Elements (present in layout.ejs on ALL pages)
    let globalWtToast = null;
    let globalWtToastTitle = null;
    let globalWtToastJoin = null;
    let globalWtToastClose = null;

    // Watch Page DOM Elements (present only on /watch/:id)
    let video = null;
    let playerContainer = null;
    let isWatchPage = false;
    let currentVideoId = null;

    let wtPanel = null;
    let wtChatPanel = null;
    let wtStartBtn = null;
    let wtStopBtn = null;
    let wtStopBtnGuest = null;
    let wtChatToggleGuest = null;
    let wtInviteBanner = null;
    let wtJoinBtn = null;
    let wtDismissBtn = null;
    let wtStatusBar = null;
    let wtStatusText = null;
    let wtResyncBtn = null;
    let wtChatToggle = null;
    let wtChatClose = null;
    let wtChatMessages = null;
    let wtChatInput = null;
    let wtChatSendBtn = null;
    let wtUnreadBadge = null;
    let wtSyncOverlay = null;
    let wtFloatingReactions = null;
    let wtPlayerChatToast = null;
    let wtToastAvatar = null;
    let wtToastSender = null;
    let wtToastMsg = null;
    let emojiBar = null;

    // ============================================================
    //  DOM QUERY & BINDING (Safe for initial load & SPA navigations)
    // ============================================================
    function queryDOM() {
        globalWtToast = document.getElementById('globalWtToast');
        globalWtToastTitle = document.getElementById('globalWtToastTitle');
        globalWtToastJoin = document.getElementById('globalWtToastJoin');
        globalWtToastClose = document.getElementById('globalWtToastClose');

        video = document.getElementById('vpVideo');
        playerContainer = document.getElementById('playerContainer');
        isWatchPage = !!video || window.location.pathname.startsWith('/watch/');
        currentVideoId = video ? (video.dataset.videoId || window.location.pathname.split('/watch/')[1]?.split('?')[0]) : null;

        wtPanel = document.getElementById('wtPanel');
        wtChatPanel = document.getElementById('wtChatPanel');
        wtStartBtn = document.getElementById('wtStartBtn');
        wtStopBtn = document.getElementById('wtStopBtn');
        wtStopBtnGuest = document.getElementById('wtStopBtnGuest');
        wtChatToggleGuest = document.getElementById('wtChatToggleGuest');
        wtInviteBanner = document.getElementById('wtInviteBanner');
        wtJoinBtn = document.getElementById('wtJoinBtn');
        wtDismissBtn = document.getElementById('wtDismissBtn');
        wtStatusBar = document.getElementById('wtStatusBar');
        wtStatusText = document.getElementById('wtStatusText');
        wtResyncBtn = document.getElementById('wtResyncBtn');
        wtChatToggle = document.getElementById('wtChatToggle');
        wtChatClose = document.getElementById('wtChatClose');
        wtChatMessages = document.getElementById('wtChatMessages');
        wtChatInput = document.getElementById('wtChatInput');
        wtChatSendBtn = document.getElementById('wtChatSendBtn');
        wtUnreadBadge = document.getElementById('wtUnreadBadge');
        wtSyncOverlay = document.getElementById('wtSyncOverlay');
        wtFloatingReactions = document.getElementById('wtFloatingReactions');
        wtPlayerChatToast = document.getElementById('wtPlayerChatToast');
        wtToastAvatar = document.getElementById('wtToastAvatar');
        wtToastSender = document.getElementById('wtToastSender');
        wtToastMsg = document.getElementById('wtToastMsg');
        emojiBar = document.getElementById('wtEmojiBar');

        if (video) {
            bindVideoListeners(video);
        }
    }

    // ============================================================
    //  1. SYNTHETIC AUDIO FEEDBACK (Zero External Assets)
    // ============================================================
    let audioCtx = null;
    function playChime(type = 'pop') {
        try {
            if (!audioCtx) {
                const AudioContext = window.AudioContext || window.webkitAudioContext;
                if (AudioContext) audioCtx = new AudioContext();
            }
            if (!audioCtx || audioCtx.state === 'suspended') {
                audioCtx && audioCtx.resume().catch(() => {});
                return;
            }

            const now = audioCtx.currentTime;
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            osc.connect(gain);
            gain.connect(audioCtx.destination);

            if (type === 'invite') {
                // Majestic dual-tone chime for Watch Together invites
                osc.type = 'sine';
                osc.frequency.setValueAtTime(587.33, now); // D5
                osc.frequency.setValueAtTime(880.00, now + 0.15); // A5
                gain.gain.setValueAtTime(0.12, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
                osc.start(now);
                osc.stop(now + 0.45);
            } else if (type === 'reaction') {
                osc.type = 'triangle';
                osc.frequency.setValueAtTime(520, now);
                osc.frequency.exponentialRampToValueAtTime(880, now + 0.12);
                gain.gain.setValueAtTime(0.08, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
                osc.start(now);
                osc.stop(now + 0.2);
            } else if (type === 'message') {
                osc.type = 'sine';
                osc.frequency.setValueAtTime(650, now);
                osc.frequency.exponentialRampToValueAtTime(980, now + 0.1);
                gain.gain.setValueAtTime(0.1, now);
                gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
                osc.start(now);
                osc.stop(now + 0.25);
            }
        } catch {}
    }

    // ============================================================
    //  2. UTILITIES
    // ============================================================
    function postJSON(url, body = {}) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            credentials: 'same-origin'
        }).then(r => r.json());
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str;
        return div.innerHTML;
    }

    function timeAgo(ts) {
        const diff = Math.floor((Date.now() - ts) / 1000);
        if (diff < 30) return 'just now';
        if (diff < 60) return `${diff}s ago`;
        if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
        return Math.floor(diff / 3600) + 'h ago';
    }

    function renderAvatarElement(username, avatarFile, extraClass = '') {
        const isMuaj = username === 'muaj';
        const letter = isMuaj ? 'M' : 'H';
        const roleClass = isMuaj ? 'wt-avatar-host' : 'wt-avatar-guest';

        if (avatarFile) {
            return `<img src="/avatars/${escapeHtml(avatarFile)}" alt="${escapeHtml(username)}" class="wt-msg-avatar-img ${extraClass}" loading="lazy" />`;
        }
        return `<div class="wt-msg-avatar ${roleClass} ${extraClass}">${letter}</div>`;
    }

    // ============================================================
    //  3. GLOBAL FLOATING NOTIFICATION SYSTEM (ALL ROUTES)
    // ============================================================
    function isInviteDismissed(rId) {
        if (!rId) return false;
        try {
            return sessionStorage.getItem('wt_dismissed_' + rId) === '1';
        } catch {
            return false;
        }
    }

    function markInviteDismissed(rId) {
        if (!rId) return;
        try {
            sessionStorage.setItem('wt_dismissed_' + rId, '1');
        } catch {}
    }

    function showGlobalToast(data, playAudio = false) {
        queryDOM();
        if (!globalWtToast || !data || !data.roomId) return;
        if (isInviteDismissed(data.roomId)) return;

        // If currently on the watch page for this video and already in session, skip toast
        if (isWatchPage && data.videoId === currentVideoId && syncActive) {
            hideInvites();
            return;
        }

        roomId = data.roomId;

        const videoTitle = data.videoTitle || 'a video';
        const hostName = data.host === 'muaj' ? 'Muaj' : (data.host === 'hajera' ? 'Hajera' : (data.host || 'Partner'));

        if (globalWtToastTitle) {
            globalWtToastTitle.textContent = `${hostName} invited you to watch "${videoTitle}" together!`;
        }

        if (globalWtToastJoin) {
            globalWtToastJoin.href = `/watch/${encodeURIComponent(data.videoId)}?join=1`;
        }

        globalWtToast.style.display = 'flex';
        void globalWtToast.offsetWidth; // Force reflow
        globalWtToast.classList.add('visible');

        if (playAudio) {
            playChime('invite');
        }
    }

    function showInPageInvite(data) {
        queryDOM();
        if (!wtInviteBanner || !data) return;
        if (isInviteDismissed(data.roomId)) return;

        const hostDisplayName = data.host === 'muaj' ? 'Muaj' : (data.host === 'hajera' ? 'Hajera' : (data.host || 'Host'));
        const hostEl = wtInviteBanner.querySelector('.wt-invite-host-name');
        if (hostEl) hostEl.textContent = hostDisplayName;

        const titleEl = wtInviteBanner.querySelector('.wt-invite-video-title');
        if (titleEl) titleEl.textContent = data.videoTitle || 'this video';
        wtInviteBanner.classList.add('visible');
    }

    function hideInvites() {
        queryDOM();
        if (wtInviteBanner) wtInviteBanner.classList.remove('visible');
        if (globalWtToast) {
            globalWtToast.classList.remove('visible');
            setTimeout(() => {
                if (globalWtToast && !globalWtToast.classList.contains('visible')) {
                    globalWtToast.style.display = 'none';
                }
            }, 300);
        }
    }

    // ============================================================
    //  4. REAL-TIME EVENT BUS HANDLERS (Dispatched via SSE)
    // ============================================================
    window.addEventListener('wt:invite', (e) => {
        const data = e.detail;
        if (!data) return;

        wtDataReceivedViaSSE = true;

        if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);

        if (data.host !== currentUser) {
            roomId = data.roomId;
            isHost = false;
            queryDOM();
            if (isWatchPage && data.videoId === currentVideoId) {
                showInPageInvite(data);
                showGlobalToast(data, true);
            } else {
                showGlobalToast(data, true);
            }
        }
    });

    window.addEventListener('wt:active-room', (e) => {
        const data = e.detail;
        if (!data) {
            hideInvites();
            return;
        }

        wtDataReceivedViaSSE = true;

        if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);

        queryDOM();

        // Host reconnecting on watch page
        if (data.host === currentUser && isWatchPage && data.videoId === currentVideoId) {
            isHost = true;
            if (!roomId || !syncActive) {
                roomId = data.roomId;
                startSSE();
                showSyncActive();
            }
            return;
        }

        // Guest invited / active room present
        if (data.host !== currentUser) {
            roomId = data.roomId;
            isHost = false;
            if (isWatchPage && data.videoId === currentVideoId) {
                if (syncActive) {
                    hideInvites();
                } else {
                    showInPageInvite(data);
                    showGlobalToast(data, false);
                }
            } else {
                showGlobalToast(data, false);
            }
        }
    });

    window.addEventListener('wt:ended', (e) => {
        const data = e.detail;
        if (roomId && data && data.roomId && data.roomId !== roomId) return;

        hideInvites();

        if (syncActive) {
            appendSystemMessage(`Watch Together session ended${data && data.reason ? ': ' + data.reason : ''}`);
            cleanup();
        }
    });

    window.addEventListener('wt:status', (e) => {
        const data = e.detail;
        if (!data || !roomId || data.roomId !== roomId) return;

        if (syncActive) {
            updateStatusBar('connected', data.guest ? 2 : 1);
        }
    });

    // Fallback Initial Check via API
    async function checkActiveRoom() {
        if (syncActive && roomId) return;

        try {
            const data = await fetch('/watch-together/active', { credentials: 'same-origin' }).then(r => r.json());
            if (!data) {
                hideInvites();
                return;
            }

            if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);

            queryDOM();

            if (data.host === currentUser && isWatchPage && data.videoId === currentVideoId) {
                isHost = true;
                if (!roomId || !syncActive) {
                    roomId = data.roomId;
                    startSSE();
                    showSyncActive();
                }
                return;
            }

            if (data.host !== currentUser) {
                roomId = data.roomId;
                isHost = false;
                if (isWatchPage && data.videoId === currentVideoId) {
                    const urlParams = new URLSearchParams(window.location.search);
                    if (urlParams.get('join') === '1' || urlParams.get('join') === 'true') {
                        joinRoom();
                    } else if (!syncActive) {
                        showInPageInvite(data);
                        showGlobalToast(data, false);
                    }
                } else {
                    showGlobalToast(data, false);
                }
            }
        } catch {}
    }

    // ============================================================
    //  5. WATCH PAGE: CREATE ROOM (Any authenticated user can Host)
    // ============================================================
    async function handleStartSession() {
        queryDOM();
        if (!isWatchPage || !currentVideoId) return;

        try {
            if (wtStartBtn) wtStartBtn.disabled = true;
            const titleEl = document.getElementById('videoTitleText');
            const videoTitle = titleEl ? titleEl.textContent.trim() : '';

            const initialCurrentTime = video ? video.currentTime : 0;
            const initialPlaying = video ? !video.paused : false;
            const initialPlaybackRate = video ? video.playbackRate : 1;

            const otherName = currentUser === 'muaj' ? 'Hajera' : 'Muaj';

            const data = await postJSON('/watch-together/create', {
                videoId: currentVideoId,
                videoTitle,
                currentTime: initialCurrentTime,
                playing: initialPlaying,
                playbackRate: initialPlaybackRate
            });

            if (data && data.roomId) {
                roomId = data.roomId;
                isHost = true;
                startSSE();
                showSyncActive();
                triggerSyncBadge(`Session Live • Waiting for ${otherName}`);
            } else if (data && data.error) {
                alert(data.error);
            }
        } catch (err) {
            console.error('[WT] Create error:', err);
        } finally {
            if (wtStartBtn) wtStartBtn.disabled = false;
        }
    }

    // ============================================================
    //  6. WATCH PAGE: JOIN ROOM
    // ============================================================
    async function joinRoom() {
        if (!roomId) {
            try {
                const data = await fetch('/watch-together/active', { credentials: 'same-origin' }).then(r => r.json());
                if (data && data.roomId) {
                    roomId = data.roomId;
                    if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);
                }
            } catch {}
        }
        if (!roomId) return;

        try {
            const data = await postJSON(`/watch-together/join/${roomId}`);
            if (data.status === 'joined' || data.status === 'already-host') {
                hideInvites();

                if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);

                isHost = (data.host === currentUser) || (data.status === 'already-host');

                queryDOM();

                // If not currently on the session's video page, navigate directly
                if (data.videoId && data.videoId !== currentVideoId) {
                    window.location.href = `/watch/${encodeURIComponent(data.videoId)}?join=1`;
                    return;
                }

                startSSE();
                showSyncActive();

                // Clean URL ?join=1 query param without reload
                if (window.history && window.history.replaceState) {
                    const url = new URL(window.location.href);
                    url.searchParams.delete('join');
                    window.history.replaceState({}, document.title, url.pathname + (url.search ? url.search : ''));
                }

                // Apply initial playback state from Host
                if (!isHost && data.videoState && video) {
                    applyVideoState(data.videoState, true);
                }

                // Ingest chat history
                if (data.chatHistory && wtChatMessages) {
                    wtChatMessages.innerHTML = '';
                    data.chatHistory.forEach(msg => appendChatMessage(msg, false));
                }

                triggerSyncBadge(isHost ? 'Session Reconnected ⚡' : 'Connected with Host ⚡');
            }
        } catch (err) {
            console.error('[WT] Join error:', err);
        }
    }

    // ============================================================
    //  7. STOP / LEAVE SESSION
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
            const currentRoomId = roomId;
            try {
                await postJSON(`/watch-together/leave/${currentRoomId}`);
            } catch {}
            cleanup();
        }
    }

    // ============================================================
    //  8. SSE ROOM CONNECTION & REAL-TIME DISPATCH
    // ============================================================
    function startSSE() {
        if (!roomId) return;
        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        eventSource = new EventSource(`/watch-together/stream/${roomId}`);

        eventSource.addEventListener('connected', (e) => {
            try {
                const data = JSON.parse(e.data);
                syncActive = true;
                if (data.host) {
                    isHost = data.host === currentUser;
                }
                if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);
                updateStatusBar('connected', data.guest ? 2 : 1);

                if (!isHost && data.chatHistory && wtChatMessages) {
                    wtChatMessages.innerHTML = '';
                    data.chatHistory.forEach(msg => appendChatMessage(msg, false));
                }
            } catch {}
        });

        eventSource.addEventListener('sync', (e) => {
            if (isHost) return; // Host has master playback control
            try {
                const data = JSON.parse(e.data);
                applyVideoState(data);
            } catch {}
        });

        eventSource.addEventListener('chat', (e) => {
            try {
                const msg = JSON.parse(e.data);
                appendChatMessage(msg, true);
                if (msg.user !== currentUser) {
                    playChime('message');
                    showInPlayerChatToast(msg);
                }
            } catch {}
        });

        eventSource.addEventListener('reaction', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.user !== currentUser) {
                    spawnFloatingReaction(data.emoji || '💖');
                    playChime('reaction');
                }
            } catch {}
        });

        eventSource.addEventListener('user-joined', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);
                updateStatusBar('connected', 2);
                const joinerName = data.user === 'hajera' ? 'Hajera' : (data.user === 'muaj' ? 'Muaj' : data.user);
                appendSystemMessage(`${joinerName} joined the session 🎉`);
                playChime('invite');

                // Host syncs current state for the newly joined guest
                if (isHost && video) {
                    sendSync('join-sync');
                }
            } catch {}
        });

        eventSource.addEventListener('user-left', (e) => {
            try {
                const data = JSON.parse(e.data);
                updateStatusBar('waiting', 1);
                const leaverName = data.user === 'hajera' ? 'Hajera' : (data.user === 'muaj' ? 'Muaj' : data.user);
                appendSystemMessage(`${leaverName} left the session`);
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
                appendSystemMessage(`Session ended: ${data.reason || 'Closed by host'}`);
                cleanup();
            } catch {}
        });

        eventSource.onerror = () => {
            if (syncActive) {
                updateStatusBar('reconnecting', 0);
            }
        };
    }

    // ============================================================
    //  9. VIDEO SYNC ENGINE (SUB-SECOND PRECISION & LATENCY COMPENSATION)
    // ============================================================
    function triggerSyncBadge(customText) {
        queryDOM();
        if (!wtSyncOverlay) return;
        if (customText) {
            const span = wtSyncOverlay.querySelector('span:not(.wt-sync-pulse-dot)');
            if (span) span.textContent = customText;
        }
        wtSyncOverlay.classList.add('visible');
        setTimeout(() => {
            if (wtSyncOverlay) wtSyncOverlay.classList.remove('visible');
        }, 1600);
    }

    function applyVideoState(state, force = false) {
        queryDOM();
        if (!state || isHost || !video) return;

        // Latency offset compensation
        const now = Date.now();
        const latencySec = (state.timestamp && now > state.timestamp) ? Math.min(2.0, (now - state.timestamp) / 1000) : 0;
        const targetTime = state.currentTime + (state.playing ? latencySec * (state.playbackRate || 1) : 0);
        const timeDiff = Math.abs(video.currentTime - targetTime);

        // Seek if drift exceeds tolerance threshold or forced
        if (force || timeDiff > SYNC_TOLERANCE_SEC) {
            ignoreNextSeek = true;
            video.currentTime = targetTime;
            triggerSyncBadge('Synced with Host ⚡');
        }

        // Play / Pause Sync
        if (state.playing && video.paused) {
            ignoreNextPlay = true;
            const playPromise = video.play();
            if (playPromise !== undefined) {
                playPromise.catch(() => {
                    // Browser autoplay blocked -> show mute reminder
                    triggerSyncBadge('Tap video to unmute & play 🎬');
                });
            }
        } else if (!state.playing && !video.paused) {
            ignoreNextPause = true;
            video.pause();
        }

        // Playback Rate Sync
        if (state.playbackRate && Math.abs(video.playbackRate - state.playbackRate) > 0.01) {
            video.playbackRate = state.playbackRate;
        }
    }

    function sendSync(action = 'update') {
        queryDOM();
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

    function bindVideoListeners(vid) {
        if (!vid || vid.dataset.wtListenersBound === 'true') return;
        vid.dataset.wtListenersBound = 'true';

        vid.addEventListener('play', () => {
            if (!isHost || !syncActive) return;
            if (ignoreNextPlay) { ignoreNextPlay = false; return; }
            sendSync('play');
        });

        vid.addEventListener('pause', () => {
            if (!isHost || !syncActive) return;
            if (ignoreNextPause) { ignoreNextPause = false; return; }
            sendSync('pause');
        });

        vid.addEventListener('seeked', () => {
            if (!isHost || !syncActive) return;
            if (ignoreNextSeek) { ignoreNextSeek = false; return; }
            sendSync('seek');
        });

        vid.addEventListener('ratechange', () => {
            if (!isHost || !syncActive) return;
            sendSync('ratechange');
        });
    }

    // Periodic host alignment every 2.5s while playing
    if (!hostSyncInterval) {
        hostSyncInterval = setInterval(() => {
            queryDOM();
            if (isHost && syncActive && video && !video.paused) {
                sendSync('update');
            }
        }, 2500);
    }

    // Guest Manual Re-sync Button
    async function handleResync() {
        queryDOM();
        if (!roomId || isHost || !wtResyncBtn) return;

        wtResyncBtn.classList.add('syncing');
        try {
            const data = await fetch(`/watch-together/sync-state/${roomId}`, { credentials: 'same-origin' }).then(r => r.json());
            if (data && data.videoState) {
                applyVideoState(data.videoState, true);
                triggerSyncBadge('Re-synced with Host ⚡');
            }
        } catch (err) {
            console.error('[WT] Re-sync error:', err);
        } finally {
            setTimeout(() => {
                if (wtResyncBtn) wtResyncBtn.classList.remove('syncing');
            }, 800);
        }
    }

    // Reconcile on Tab Focus & Network Online
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && syncActive && roomId && !isHost) {
            fetch(`/watch-together/sync-state/${roomId}`, { credentials: 'same-origin' })
                .then(r => r.json())
                .then(data => {
                    if (data && data.videoState) applyVideoState(data.videoState, true);
                })
                .catch(() => {});
        }
    });

    window.addEventListener('online', () => {
        if (syncActive && roomId) {
            startSSE();
        }
    });

    // ============================================================
    //  10. FLOATING LIVE REACTIONS
    // ============================================================
    function spawnFloatingReaction(emoji = '💖') {
        queryDOM();
        const targetContainer = wtFloatingReactions || playerContainer || document.body;
        if (!targetContainer) return;

        const particle = document.createElement('div');
        particle.className = 'wt-floating-emoji';
        particle.textContent = emoji;

        const randomX = Math.floor(Math.random() * 80) + 10;
        const randomScale = (0.9 + Math.random() * 0.5).toFixed(2);
        const randomRotate = Math.floor(Math.random() * 40) - 20;
        const swayDuration = (2.2 + Math.random() * 0.8).toFixed(2);

        particle.style.left = `${randomX}%`;
        particle.style.setProperty('--target-scale', randomScale);
        particle.style.setProperty('--target-rotate', `${randomRotate}deg`);
        particle.style.animationDuration = `${swayDuration}s`;

        targetContainer.appendChild(particle);

        setTimeout(() => {
            if (particle.parentNode) {
                particle.parentNode.removeChild(particle);
            }
        }, parseFloat(swayDuration) * 1000 + 100);
    }

    function sendLiveReaction(emoji) {
        if (!roomId) return;
        spawnFloatingReaction(emoji);
        playChime('reaction');

        postJSON(`/watch-together/reaction/${roomId}`, { emoji }).catch(err => {
            console.error('[WT] Reaction error:', err);
        });
    }

    // ============================================================
    //  11. LIVE CINEMA CHAT
    // ============================================================
    function appendChatMessage(msg, animate = true) {
        queryDOM();
        if (!wtChatMessages || !msg) return;

        const isMine = msg.user === currentUser;
        const displayName = msg.user === 'muaj' ? 'Muaj' : (msg.user === 'hajera' ? 'Hajera' : msg.user);
        const avatarFile = msg.avatar || userAvatars[msg.user];
        const avatarHtml = renderAvatarElement(msg.user, avatarFile);

        const msgEl = document.createElement('div');
        msgEl.className = `wt-chat-msg ${isMine ? 'wt-msg-mine' : 'wt-msg-other'} ${animate ? 'wt-msg-enter' : ''}`;
        msgEl.innerHTML = `
            ${avatarHtml}
            <div class="wt-msg-bubble">
                <div class="wt-msg-header">
                    <span class="wt-msg-author">${escapeHtml(displayName)}</span>
                    <span class="wt-msg-time">${timeAgo(msg.timestamp || Date.now())}</span>
                </div>
                <div class="wt-msg-text">${escapeHtml(msg.text || '')}</div>
            </div>
        `;

        wtChatMessages.appendChild(msgEl);
        wtChatMessages.scrollTop = wtChatMessages.scrollHeight;

        if (!chatOpen && !isMine) {
            unreadCount++;
            updateUnreadBadge();
        }
    }

    function appendSystemMessage(text) {
        queryDOM();
        if (!wtChatMessages) return;

        const msgEl = document.createElement('div');
        msgEl.className = 'wt-chat-system';
        msgEl.innerHTML = `<span>${escapeHtml(text)}</span>`;
        wtChatMessages.appendChild(msgEl);
        wtChatMessages.scrollTop = wtChatMessages.scrollHeight;
    }

    function sendChatMessage() {
        queryDOM();
        if (!roomId || !wtChatInput) return;
        const text = wtChatInput.value.trim();
        if (!text) return;

        wtChatInput.value = '';

        postJSON(`/watch-together/chat/${roomId}`, { text }).catch(err => {
            console.error('[WT] Chat error:', err);
        });
    }

    function toggleChat(forceState) {
        queryDOM();
        chatOpen = typeof forceState === 'boolean' ? forceState : !chatOpen;
        if (wtChatPanel) wtChatPanel.classList.toggle('open', chatOpen);
        if (chatOpen) {
            unreadCount = 0;
            updateUnreadBadge();
            if (wtPlayerChatToast) {
                wtPlayerChatToast.classList.remove('visible');
                wtPlayerChatToast.style.display = 'none';
            }
            if (wtChatInput) setTimeout(() => wtChatInput.focus(), 150);
            if (wtChatMessages) wtChatMessages.scrollTop = wtChatMessages.scrollHeight;
        }
    }

    function updateUnreadBadge() {
        queryDOM();
        if (!wtUnreadBadge) return;
        if (unreadCount > 0) {
            wtUnreadBadge.textContent = unreadCount > 9 ? '9+' : unreadCount;
            wtUnreadBadge.style.display = '';
        } else {
            wtUnreadBadge.style.display = 'none';
        }
    }

    function showInPlayerChatToast(msg) {
        queryDOM();
        if (chatOpen || !wtPlayerChatToast || !msg) return;

        const senderName = msg.user === 'muaj' ? 'Muaj' : (msg.user === 'hajera' ? 'Hajera' : msg.user);
        if (wtToastSender) wtToastSender.textContent = senderName;
        if (wtToastMsg) wtToastMsg.textContent = msg.text || '';

        if (wtToastAvatar) {
            const avatarFile = msg.avatar || userAvatars[msg.user];
            if (avatarFile) {
                wtToastAvatar.innerHTML = `<img src="/avatars/${escapeHtml(avatarFile)}" alt="${escapeHtml(senderName)}" class="wt-toast-avatar-img">`;
            } else {
                wtToastAvatar.textContent = msg.user === 'muaj' ? '👑' : '🌸';
            }
        }

        wtPlayerChatToast.style.display = 'flex';
        void wtPlayerChatToast.offsetWidth;
        wtPlayerChatToast.classList.add('visible');

        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => {
            if (wtPlayerChatToast) {
                wtPlayerChatToast.classList.remove('visible');
                setTimeout(() => {
                    if (wtPlayerChatToast && !wtPlayerChatToast.classList.contains('visible')) {
                        wtPlayerChatToast.style.display = 'none';
                    }
                }, 300);
            }
        }, 4500);
    }

    // ============================================================
    //  12. UI STATE MANAGEMENT & CLEANUP
    // ============================================================
    function showSyncActive() {
        syncActive = true;
        queryDOM();

        if (wtPanel) wtPanel.classList.add('wt-active');

        if (isHost) {
            if (wtStartBtn) wtStartBtn.style.display = 'none';
            if (wtStopBtn) wtStopBtn.style.display = '';
            if (wtStopBtnGuest) wtStopBtnGuest.style.display = 'none';
            if (wtChatToggleGuest) wtChatToggleGuest.style.display = '';
        } else {
            if (wtStartBtn) wtStartBtn.style.display = 'none';
            if (wtStopBtn) wtStopBtn.style.display = 'none';
            if (wtStopBtnGuest) wtStopBtnGuest.style.display = '';
            if (wtChatToggleGuest) wtChatToggleGuest.style.display = '';
            if (wtResyncBtn) wtResyncBtn.style.display = '';
        }

        // Update stop button text inside drawer
        const drawerStopText = document.getElementById('wtChatStopBtnText');
        if (drawerStopText) drawerStopText.textContent = isHost ? 'Stop' : 'Leave';

        if (wtStatusBar) wtStatusBar.classList.add('visible');
        if (wtChatToggle) wtChatToggle.style.display = '';

        updateStatusBar('waiting', 1);
    }

    function updateStatusBar(status, count) {
        queryDOM();
        if (!wtStatusText) return;

        const otherName = currentUser === 'muaj' ? 'Hajera' : 'Muaj';
        const statusMap = {
            'connected': `🟢 Watch Together • Connected (${count || 2}/2)`,
            'waiting': `🟡 Waiting for ${otherName}...`,
            'reconnecting': '🔴 Reconnecting...'
        };

        wtStatusText.textContent = statusMap[status] || status;

        if (wtStatusBar) {
            wtStatusBar.className = 'wt-status-bar visible wt-status-' + status;
        }

        if (!isHost && wtResyncBtn) {
            wtResyncBtn.style.display = status === 'connected' ? '' : 'none';
        }
    }

    function cleanup() {
        syncActive = false;
        roomId = null;
        isHost = false;

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        queryDOM();

        if (wtPanel) wtPanel.classList.remove('wt-active');

        if (wtStartBtn) { wtStartBtn.style.display = ''; wtStartBtn.disabled = false; }
        if (wtStopBtn) wtStopBtn.style.display = 'none';
        if (wtStopBtnGuest) wtStopBtnGuest.style.display = 'none';
        if (wtChatToggleGuest) wtChatToggleGuest.style.display = 'none';
        if (wtResyncBtn) wtResyncBtn.style.display = 'none';

        if (wtStatusBar) wtStatusBar.classList.remove('visible');
        if (wtChatToggle) wtChatToggle.style.display = 'none';
        if (wtChatPanel) wtChatPanel.classList.remove('open');
        if (wtPlayerChatToast) {
            wtPlayerChatToast.classList.remove('visible');
            wtPlayerChatToast.style.display = 'none';
        }
        hideInvites();

        chatOpen = false;
        unreadCount = 0;
        updateUnreadBadge();
    }

    // ============================================================
    //  13. DELEGATED EVENT LISTENERS (Work across all SPA transitions)
    // ============================================================
    document.addEventListener('click', (e) => {
        // Start Session
        const startBtn = e.target.closest('#wtStartBtn');
        if (startBtn) {
            e.preventDefault();
            handleStartSession();
            return;
        }

        // Join Session
        const joinBtn = e.target.closest('#wtJoinBtn');
        if (joinBtn) {
            e.preventDefault();
            joinRoom();
            return;
        }

        // Dismiss In-Page Banner
        const dismissBtn = e.target.closest('#wtDismissBtn');
        if (dismissBtn) {
            e.preventDefault();
            if (roomId) markInviteDismissed(roomId);
            if (wtInviteBanner) wtInviteBanner.classList.remove('visible');
            return;
        }

        // Global Toast Close
        const toastClose = e.target.closest('#globalWtToastClose');
        if (toastClose) {
            e.preventDefault();
            e.stopPropagation();
            if (roomId) markInviteDismissed(roomId);
            hideInvites();
            return;
        }

        // Stop / Leave Session
        const stopBtn = e.target.closest('.wt-stop-session-btn');
        if (stopBtn) {
            e.preventDefault();
            endOrLeaveSession();
            return;
        }

        // Re-sync Button
        const resyncBtn = e.target.closest('#wtResyncBtn');
        if (resyncBtn) {
            e.preventDefault();
            handleResync();
            return;
        }

        // Chat Toggle
        const chatToggle = e.target.closest('.wt-chat-toggle-btn');
        if (chatToggle) {
            e.preventDefault();
            toggleChat();
            return;
        }

        // Chat Close
        const chatClose = e.target.closest('#wtChatClose');
        if (chatClose) {
            e.preventDefault();
            toggleChat(false);
            return;
        }

        // Chat Send
        const sendBtn = e.target.closest('#wtChatSendBtn');
        if (sendBtn) {
            e.preventDefault();
            sendChatMessage();
            return;
        }

        // Live Reaction Emoji Bar
        const emojiBtn = e.target.closest('.wt-emoji-btn');
        if (emojiBtn) {
            e.preventDefault();
            const emoji = emojiBtn.dataset.reaction || emojiBtn.textContent.trim();
            if (emoji) {
                sendLiveReaction(emoji);
                if (wtChatInput && (document.activeElement === wtChatInput || wtChatInput.value.length > 0)) {
                    wtChatInput.value += emoji;
                    wtChatInput.focus();
                }
            }
            return;
        }

        // Floating Toast inside player
        const playerToast = e.target.closest('#wtPlayerChatToast');
        if (playerToast) {
            toggleChat(true);
            playerToast.classList.remove('visible');
            playerToast.style.display = 'none';
            return;
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.target && e.target.id === 'wtChatInput') {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        }
        if (e.key === 'Escape' && chatOpen) {
            toggleChat(false);
        }
    });

    // ============================================================
    //  14. INITIALIZATION & RECOVERY
    // ============================================================
    queryDOM();

    // Delay checkActiveRoom to allow SSE connected event to deliver WT data first
    setTimeout(() => {
        if (!wtDataReceivedViaSSE) {
            checkActiveRoom();
        }
    }, 1200);

    // Auto-join check on watch page load with query param
    if (isWatchPage) {
        const urlParams = new URLSearchParams(window.location.search);
        if (urlParams.get('join') === '1' || urlParams.get('join') === 'true') {
            joinRoom();
        }
    }

    // Cleanup on page unload
    window.addEventListener('beforeunload', cleanup);
    window.addEventListener('pagehide', cleanup);

    // SPA Navigation Handlers
    window.addEventListener('page:cleanup', () => {
        queryDOM();
    });

    window.addEventListener('page:navigate', () => {
        queryDOM();
        if (isWatchPage && video) {
            checkActiveRoom();
            const urlParams = new URLSearchParams(window.location.search);
            if (urlParams.get('join') === '1' || urlParams.get('join') === 'true') {
                joinRoom();
            }
        }
    });

})();
