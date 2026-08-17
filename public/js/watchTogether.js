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
    const currentUser = (document.body.dataset.user ||
        (document.body.querySelector('.badge-admin') ? 'muaj' :
            (document.body.querySelector('.badge-viewer') ? 'hajera' : ''))).toLowerCase();

    if (!currentUser) return; // Not logged in

    const isHost = currentUser === 'muaj';
    const isGuest = currentUser === 'hajera';

    // Video & Player element (present only on watch pages)
    const video = document.getElementById('vpVideo');
    const playerContainer = document.getElementById('playerContainer');
    const isWatchPage = !!video;
    const currentVideoId = video ? video.dataset.videoId : null;

    // Internal State
    let roomId = null;
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
    const globalWtToast = document.getElementById('globalWtToast');
    const globalWtToastTitle = document.getElementById('globalWtToastTitle');
    const globalWtToastJoin = document.getElementById('globalWtToastJoin');
    const globalWtToastClose = document.getElementById('globalWtToastClose');

    // Watch Page DOM Elements (present only on /watch/:id)
    const wtPanel = document.getElementById('wtPanel');
    const wtChatPanel = document.getElementById('wtChatPanel');
    const wtStartBtn = document.getElementById('wtStartBtn');
    const wtStopBtn = document.getElementById('wtStopBtn');
    const wtInviteBanner = document.getElementById('wtInviteBanner');
    const wtJoinBtn = document.getElementById('wtJoinBtn');
    const wtDismissBtn = document.getElementById('wtDismissBtn');
    const wtStatusBar = document.getElementById('wtStatusBar');
    const wtStatusText = document.getElementById('wtStatusText');
    const wtResyncBtn = document.getElementById('wtResyncBtn');
    const wtChatToggle = document.getElementById('wtChatToggle');
    const wtChatClose = document.getElementById('wtChatClose');
    const wtChatMessages = document.getElementById('wtChatMessages');
    const wtChatInput = document.getElementById('wtChatInput');
    const wtChatSendBtn = document.getElementById('wtChatSendBtn');
    const wtUnreadBadge = document.getElementById('wtUnreadBadge');
    const wtSyncOverlay = document.getElementById('wtSyncOverlay');
    const wtFloatingReactions = document.getElementById('wtFloatingReactions');
    const wtPlayerChatToast = document.getElementById('wtPlayerChatToast');
    const wtToastAvatar = document.getElementById('wtToastAvatar');
    const wtToastSender = document.getElementById('wtToastSender');
    const wtToastMsg = document.getElementById('wtToastMsg');
    const emojiBar = document.getElementById('wtEmojiBar');

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
        if (!globalWtToast || !data || !data.roomId) return;
        if (isInviteDismissed(data.roomId)) return;

        // If currently on the watch page for this video and already in session, skip toast
        if (isWatchPage && data.videoId === currentVideoId && syncActive) {
            hideInvites();
            return;
        }

        roomId = data.roomId;

        const videoTitle = data.videoTitle || 'a video';
        const hostName = data.host === 'muaj' ? 'Muaj' : 'Hajera';

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
        if (!wtInviteBanner || !data) return;
        if (isInviteDismissed(data.roomId)) return;

        const titleEl = wtInviteBanner.querySelector('.wt-invite-video-title');
        if (titleEl) titleEl.textContent = data.videoTitle || 'this video';
        wtInviteBanner.classList.add('visible');
    }

    function hideInvites() {
        if (wtInviteBanner) wtInviteBanner.classList.remove('visible');
        if (globalWtToast) {
            globalWtToast.classList.remove('visible');
            setTimeout(() => {
                if (!globalWtToast.classList.contains('visible')) {
                    globalWtToast.style.display = 'none';
                }
            }, 300);
        }
    }

    // Dismiss Listeners
    if (globalWtToastClose) {
        globalWtToastClose.addEventListener('click', (e) => {
            e.preventDefault();
            e.stopPropagation();
            if (roomId) markInviteDismissed(roomId);
            hideInvites();
        });
    }

    if (wtDismissBtn) {
        wtDismissBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (roomId) markInviteDismissed(roomId);
            if (wtInviteBanner) wtInviteBanner.classList.remove('visible');
        });
    }

    if (wtJoinBtn) {
        wtJoinBtn.addEventListener('click', (e) => {
            e.preventDefault();
            joinRoom();
        });
    }

    // ============================================================
    //  4. REAL-TIME EVENT BUS HANDLERS (Dispatched via SSE)
    // ============================================================
    window.addEventListener('wt:invite', (e) => {
        const data = e.detail;
        if (!data) return;

        wtDataReceivedViaSSE = true; // SSE already delivered WT data

        if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);

        if (isGuest || (!isHost && data.host !== currentUser)) {
            roomId = data.roomId;
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

        wtDataReceivedViaSSE = true; // SSE already delivered WT data

        if (data.avatars) userAvatars = Object.assign({}, userAvatars, data.avatars);

        // Host reconnecting on watch page
        if (isHost && isWatchPage && data.role === 'host' && data.videoId === currentVideoId) {
            if (!roomId || !syncActive) {
                roomId = data.roomId;
                startSSE();
                showSyncActive();
            }
            return;
        }

        // Guest invited / active room present
        if (isGuest || (!isHost && data.host !== currentUser)) {
            roomId = data.roomId;
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

            if (isHost && isWatchPage && data.role === 'host' && data.videoId === currentVideoId) {
                if (!roomId || !syncActive) {
                    roomId = data.roomId;
                    startSSE();
                    showSyncActive();
                }
                return;
            }

            if (isGuest || (!isHost && data.host !== currentUser)) {
                roomId = data.roomId;
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
    //  5. WATCH PAGE: HOST CREATE ROOM
    // ============================================================
    if (wtStartBtn && isWatchPage && isHost) {
        wtStartBtn.addEventListener('click', async () => {
            try {
                wtStartBtn.disabled = true;
                const titleEl = document.getElementById('videoTitleText');
                const videoTitle = titleEl ? titleEl.textContent.trim() : '';

                const initialCurrentTime = video ? video.currentTime : 0;
                const initialPlaying = video ? !video.paused : false;
                const initialPlaybackRate = video ? video.playbackRate : 1;

                const data = await postJSON('/watch-together/create', {
                    videoId: currentVideoId,
                    videoTitle,
                    currentTime: initialCurrentTime,
                    playing: initialPlaying,
                    playbackRate: initialPlaybackRate
                });

                if (data && data.roomId) {
                    roomId = data.roomId;
                    startSSE();
                    showSyncActive();
                    triggerSyncBadge('Session Live • Waiting for Hajera');
                }
            } catch (err) {
                console.error('[WT] Create error:', err);
            } finally {
                wtStartBtn.disabled = false;
            }
        });
    }

    // ============================================================
    //  6. WATCH PAGE: GUEST JOIN ROOM
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
                if (data.videoState && video) {
                    applyVideoState(data.videoState, true);
                }

                // Ingest chat history
                if (data.chatHistory && wtChatMessages) {
                    wtChatMessages.innerHTML = '';
                    data.chatHistory.forEach(msg => appendChatMessage(msg, false));
                }

                triggerSyncBadge('Connected with Host ⚡');
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

    document.querySelectorAll('.wt-stop-session-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            endOrLeaveSession();
        });
    });

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
                appendSystemMessage(`${data.user === 'hajera' ? 'Hajera' : 'Muaj'} joined the session 🎉`);
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
        if (!wtSyncOverlay) return;
        if (customText) {
            const span = wtSyncOverlay.querySelector('span:not(.wt-sync-pulse-dot)');
            if (span) span.textContent = customText;
        }
        wtSyncOverlay.classList.add('visible');
        setTimeout(() => wtSyncOverlay.classList.remove('visible'), 1600);
    }

    function applyVideoState(state, force = false) {
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

    // Host Playback Listeners
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

        // Periodic alignment every 2.5s while playing
        hostSyncInterval = setInterval(() => {
            if (!video.paused && syncActive) {
                sendSync('update');
            }
        }, 2500);
    }

    // Guest Manual Re-sync Button
    if (wtResyncBtn) {
        wtResyncBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            if (!roomId || isHost) return;

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
                setTimeout(() => wtResyncBtn.classList.remove('syncing'), 800);
            }
        });
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

    if (emojiBar) {
        emojiBar.addEventListener('click', (e) => {
            const btn = e.target.closest('.wt-emoji-btn');
            if (!btn) return;

            const emoji = btn.dataset.reaction || btn.textContent.trim();
            if (emoji) {
                sendLiveReaction(emoji);
                if (wtChatInput && (document.activeElement === wtChatInput || wtChatInput.value.length > 0)) {
                    wtChatInput.value += emoji;
                    wtChatInput.focus();
                }
            }
        });
    }

    // ============================================================
    //  11. LIVE CINEMA CHAT
    // ============================================================
    function appendChatMessage(msg, animate = true) {
        if (!wtChatMessages || !msg) return;

        const isMine = msg.user === currentUser;
        const displayName = msg.user === 'muaj' ? 'Muaj' : 'Hajera';
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

    function toggleChat(forceState) {
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

    function showInPlayerChatToast(msg) {
        if (chatOpen || !wtPlayerChatToast || !msg) return;

        const senderName = msg.user === 'muaj' ? 'Muaj' : 'Hajera';
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

    if (wtPlayerChatToast) {
        wtPlayerChatToast.addEventListener('click', () => {
            toggleChat(true);
            wtPlayerChatToast.classList.remove('visible');
            wtPlayerChatToast.style.display = 'none';
        });
    }

    // ============================================================
    //  12. UI STATE MANAGEMENT & CLEANUP
    // ============================================================
    function showSyncActive() {
        syncActive = true;
        if (wtPanel) wtPanel.classList.add('wt-active');

        if (isHost) {
            if (wtStartBtn) wtStartBtn.style.display = 'none';
            if (wtStopBtn) wtStopBtn.style.display = '';
        } else {
            const guestStop = document.getElementById('wtStopBtnGuest');
            if (guestStop) guestStop.style.display = '';
            if (wtResyncBtn) wtResyncBtn.style.display = '';
        }

        if (wtStatusBar) wtStatusBar.classList.add('visible');
        if (wtChatToggle) wtChatToggle.style.display = '';

        updateStatusBar('waiting', 1);
    }

    function updateStatusBar(status, count) {
        if (!wtStatusText) return;

        const otherName = isHost ? 'Hajera' : 'Muaj';
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

        if (eventSource) {
            eventSource.close();
            eventSource = null;
        }

        // Clear host sync interval to prevent leaked timers
        if (hostSyncInterval) {
            clearInterval(hostSyncInterval);
            hostSyncInterval = null;
        }

        if (wtPanel) wtPanel.classList.remove('wt-active');

        if (isHost) {
            if (wtStartBtn) { wtStartBtn.style.display = ''; wtStartBtn.disabled = false; }
            if (wtStopBtn) wtStopBtn.style.display = 'none';
        } else {
            const guestStop = document.getElementById('wtStopBtnGuest');
            if (guestStop) guestStop.style.display = 'none';
            if (wtResyncBtn) wtResyncBtn.style.display = 'none';
        }

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
    //  13. INITIALIZATION & RECOVERY
    // ============================================================
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

})();
