// ============================================================
//  MESSAGES SYSTEM — ULTRA-LUXE REAL-TIME CLIENT CONTROLLER
//  Unified State Store, SSE Real-Time Sync, Catch-up Sync,
//  Voice Audio Waveforms, Dynamic Stats & Micro-Interactions
// ============================================================

(function () {
    'use strict';

    const currentUser = document.body.getAttribute('data-user') || '';
    if (!currentUser) return; // Not logged in

    const partnerUser = currentUser === 'muaj' ? 'hajera' : 'muaj';
    const isMessagesPage = document.body.getAttribute('data-page') === 'messages' || !!document.getElementById('msgFullpageList');

    // ------------------------------------------------------------
    //  1. SYNTHESIZED NOTIFICATION AUDIO CHIME (Web Audio API)
    // ------------------------------------------------------------
    let audioCtx = null;
    function playNotificationChime() {
        try {
            if (!audioCtx) {
                audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            }
            if (audioCtx.state === 'suspended') {
                audioCtx.resume();
            }
            const now = audioCtx.currentTime;

            // Note 1: E5 (659.25 Hz)
            const osc1 = audioCtx.createOscillator();
            const gain1 = audioCtx.createGain();
            osc1.type = 'sine';
            osc1.frequency.setValueAtTime(659.25, now);
            gain1.gain.setValueAtTime(0.12, now);
            gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
            osc1.connect(gain1);
            gain1.connect(audioCtx.destination);
            osc1.start(now);
            osc1.stop(now + 0.35);

            // Note 2: B5 (987.77 Hz)
            const osc2 = audioCtx.createOscillator();
            const gain2 = audioCtx.createGain();
            osc2.type = 'sine';
            osc2.frequency.setValueAtTime(987.77, now + 0.12);
            gain2.gain.setValueAtTime(0.15, now + 0.12);
            gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
            osc2.connect(gain2);
            gain2.connect(audioCtx.destination);
            osc2.start(now + 0.12);
            osc2.stop(now + 0.55);
        } catch (e) {}
    }

    // ------------------------------------------------------------
    //  2. UNIFIED STATE STORE
    // ------------------------------------------------------------
    const State = {
        currentUser,
        partnerUser,
        isMessagesPage,
        messages: new Map(), // id -> msgObj
        lastKnownId: 0,
        unreadCount: 0,
        partnerPresence: null,
        stats: { totalMessages: 0, sharedVideos: 0, voiceMessages: 0 },
        activeMediaTab: 'all',
        searchKeyword: '',
        replyToMessage: null,
        isSyncing: false,
        isInitialSyncDone: false,
        lastSyncAt: 0 // debounce timestamp for syncState()
    };

    // ------------------------------------------------------------
    //  3. DOM ELEMENT REFERENCES
    // ------------------------------------------------------------
    const DOM = {
        launcher: document.getElementById('msgFloatingLauncher'),
        drawer: document.getElementById('msgDrawerWidget'),
        drawerCloseBtn: document.getElementById('msgDrawerCloseBtn'),
        unreadPill: document.getElementById('msgLauncherUnreadBadge'),
        fullPageList: document.getElementById('msgFullpageList'),
        drawerList: document.getElementById('msgDrawerList'),
        floatingToast: document.getElementById('msgFloatingToast'),
        floatingToastText: document.getElementById('msgFloatingToastText'),
        floatingToastReply: document.getElementById('msgFloatingToastReply'),
        floatingToastClose: document.getElementById('msgFloatingToastClose'),
        // Sidebar Stats
        statTotalMessages: document.getElementById('msgStatTotalMessages'),
        statSharedVideos: document.getElementById('msgStatSharedVideos'),
        statVoiceMessages: document.getElementById('msgStatVoiceMessages'),
        tabCountVideos: document.getElementById('msgTabCountVideos'),
        tabCountVoice: document.getElementById('msgTabCountVoice'),
        sidebarWatchingBanner: document.getElementById('msgSidebarWatchingBanner'),
        // In-chat Search
        searchToggleBtn: document.getElementById('msgSearchToggleBtn'),
        inChatSearchBar: document.getElementById('msgInChatSearchBar'),
        inChatSearchInput: document.getElementById('msgInChatSearchInput'),
        inChatSearchClose: document.getElementById('msgInChatSearchClose')
    };

    let toastDismissTimeout = null;
    let typingTimeout = null;
    let isCurrentlyTyping = false;
    let sseSource = null;

    function getActiveContainers() {
        const list = [];
        if (DOM.drawerList) list.push(DOM.drawerList);
        if (DOM.fullPageList) list.push(DOM.fullPageList);
        return list;
    }

    // ------------------------------------------------------------
    //  4. FORMATTING & HTML HELPERS
    // ------------------------------------------------------------
    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function formatTime(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            if (isNaN(d.getTime())) return '';
            return d.toLocaleTimeString('en-US', {
                timeZone: 'Asia/Dhaka',
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            });
        } catch {
            return '';
        }
    }

    function formatDateHeader(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            if (isNaN(d.getTime())) return '';
            const options = { timeZone: 'Asia/Dhaka', year: 'numeric', month: 'numeric', day: 'numeric' };
            const msgDateStr = d.toLocaleDateString('en-US', options);
            const todayDateStr = new Date().toLocaleDateString('en-US', options);
            const yesterday = new Date(Date.now() - 86400000);
            const yesterdayDateStr = yesterday.toLocaleDateString('en-US', options);
            if (msgDateStr === todayDateStr) return 'Today';
            if (msgDateStr === yesterdayDateStr) return 'Yesterday';
            return d.toLocaleDateString('en-US', { timeZone: 'Asia/Dhaka', month: 'short', day: 'numeric' });
        } catch {
            return '';
        }
    }

    function renderReactionsHtml(reactions, currentU) {
        if (!reactions || !Array.isArray(reactions) || reactions.length === 0) return '';
        const grouped = {};
        reactions.forEach(r => {
            if (!grouped[r.reaction]) grouped[r.reaction] = [];
            grouped[r.reaction].push(r.user);
        });

        const badges = Object.keys(grouped).map(emoji => {
            const users = grouped[emoji];
            const isMine = users.includes(currentU);
            return `
                <button type="button" class="msg-reaction-badge ${isMine ? 'is-user-reacted' : ''}" data-emoji="${escapeHtml(emoji)}" title="${escapeHtml(users.join(', '))}">
                    <span>${escapeHtml(emoji)}</span>
                    <span>${users.length}</span>
                </button>
            `;
        }).join('');

        return `<div class="msg-reactions-row">${badges}</div>`;
    }

    function renderReplyQuoteHtml(replyTo, currentU) {
        if (!replyTo) return '';
        const isReplyToMe = replyTo.sender === currentU;
        const authorName = isReplyToMe ? 'You' : (replyTo.sender === 'muaj' ? 'Muaj' : (replyTo.sender === 'hajera' ? 'Hajera' : (replyTo.sender || 'Unknown')));

        let snippet = '';
        let thumbHtml = '';

        if (replyTo.isDeleted) {
            snippet = '<span class="msg-quote-deleted">⚠️ Original message was deleted</span>';
        } else {
            if (replyTo.text) {
                snippet = `<span class="msg-quote-text">${escapeHtml(replyTo.text)}</span>`;
            }
            if (replyTo.videoTitle || replyTo.videoId) {
                const vTitle = replyTo.videoTitle || 'Shared Video';
                const thumbUrl = replyTo.videoThumbnail ? `/thumbnails/${encodeURIComponent(replyTo.videoThumbnail)}` : '';
                snippet = `<span class="msg-quote-media-indicator">🎬 ${escapeHtml(vTitle)}</span>` + (snippet ? ` — ${snippet}` : '');
                if (thumbUrl) {
                    thumbHtml = `<img src="${thumbUrl}" class="msg-quote-thumb" alt="" />`;
                }
            } else if (replyTo.voiceUrl) {
                snippet = `<span class="msg-quote-media-indicator">🎙️ Voice Note</span>` + (snippet ? ` — ${snippet}` : '');
            }
        }

        return `
            <div class="msg-quote-card ${isReplyToMe ? 'is-reply-to-me' : 'is-reply-to-partner'}" data-reply-id="${replyTo.id || ''}" title="Click to jump to original message">
                <div class="msg-quote-bar"></div>
                <div class="msg-quote-content">
                    <div class="msg-quote-author">
                        <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                        <span>${escapeHtml(authorName)}</span>
                    </div>
                    <div class="msg-quote-snippet">${snippet}</div>
                </div>
                ${thumbHtml}
            </div>
        `;
    }

    function renderCallEventHtml(rawText, isOut) {
        try {
            const jsonStr = rawText.replace('__CALL_EVENT__:', '');
            const data = JSON.parse(jsonStr);
            const isVideo = data.callType === 'video';
            const isCompleted = data.status === 'completed';

            let title = '';
            let subtitle = '';
            if (isCompleted) {
                const mins = Math.floor((data.durationSeconds || 0) / 60);
                const secs = (data.durationSeconds || 0) % 60;
                const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                title = isVideo ? 'Video Call Ended' : 'Audio Call Ended';
                subtitle = `Duration: ${durStr}`;
            } else if (data.status === 'rejected') {
                title = isVideo ? 'Declined Video Call' : 'Declined Audio Call';
                subtitle = isOut ? 'Call was declined' : 'You declined the call';
            } else {
                title = isVideo ? 'Missed Video Call' : 'Missed Audio Call';
                subtitle = isOut ? 'No answer' : 'Missed call';
            }

            const iconSvg = isVideo
                ? `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>`
                : `<svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56a.977.977 0 0 0-1.01.24l-2.2 2.2a15.053 15.053 0 0 1-6.59-6.59l2.2-2.21a.96.96 0 0 0 .25-1A11.36 11.36 0 0 1 8.57 3.99c.07-.55-.38-1-1-1H4.02C3.47 3 3 3.47 3 4.02c0 9.39 7.63 17.02 17.02 17.02.55 0 1.02-.47 1.02-1.02v-3.64c0-.55-.47-1-1.03-1z"/></svg>`;

            const callBackBtn = `<button type="button" class="msg-call-event-action-btn ${isVideo ? 'btn-trigger-video-call' : 'btn-trigger-audio-call'}" title="Call Back">
                <span>Call Back</span>
            </button>`;

            return `
                <div class="msg-call-event-card">
                    <div class="msg-call-event-icon-wrap ${isCompleted ? 'is-completed' : 'is-missed'}">
                        ${iconSvg}
                    </div>
                    <div class="msg-call-event-details">
                        <div class="msg-call-event-title">${escapeHtml(title)}</div>
                        <div class="msg-call-event-subtitle">${escapeHtml(subtitle)}</div>
                    </div>
                    ${callBackBtn}
                </div>
            `;
        } catch {
            return `<div class="msg-text-content">${escapeHtml(rawText)}</div>`;
        }
    }

    function renderMessageHTML(msg) {
        const isOut = msg.sender === currentUser;
        const rowClass = isOut ? 'msg-row-outgoing' : 'msg-row-incoming';
        const timeStr = formatTime(msg.createdAt);
        const seenHtml = isOut
            ? `<span class="msg-seen-check ${msg.isRead ? 'is-seen' : ''}" title="${msg.isRead ? 'Seen' : 'Sent'}">${msg.isRead ? '✓✓' : '✓'}</span>`
            : '';

        let contentHtml = '';

        // 1. Attached Video Card
        if (msg.video) {
            const thumbUrl = msg.video.thumbnail ? `/thumbnails/${encodeURIComponent(msg.video.thumbnail)}` : '';
            contentHtml += `
                <div class="msg-video-card" data-video-id="${escapeHtml(msg.video.id)}">
                    <div class="msg-video-card-thumb-wrap">
                        ${thumbUrl ? `<img src="${thumbUrl}" class="msg-video-card-thumb-img" alt="" loading="lazy" />` : '<div class="thumb-fallback">🎬</div>'}
                        <a href="/watch/${encodeURIComponent(msg.video.id)}" class="msg-video-card-play-overlay" title="Play Video">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20"><polygon points="6,4 20,12 6,20"/></svg>
                        </a>
                        ${msg.video.duration ? `<div class="msg-video-card-duration">${escapeHtml(msg.video.duration)}</div>` : ''}
                    </div>
                    <div class="msg-video-card-info">
                        <div class="msg-video-card-title">${escapeHtml(msg.video.title)}</div>
                        <div class="msg-video-card-actions">
                            <a href="/watch/${encodeURIComponent(msg.video.id)}" class="msg-video-action-btn btn-watch-now">
                                <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="6,4 20,12 6,20"/></svg>
                                <span>Watch</span>
                            </a>
                            <a href="/watch/${encodeURIComponent(msg.video.id)}?wt_invite=1" class="msg-video-action-btn btn-wt-together">
                                <span>🍿 Watch Together</span>
                            </a>
                        </div>
                    </div>
                </div>
            `;
        }

        // 2. Interactive Voice Audio Note
        if (msg.voiceUrl) {
            contentHtml += `
                <div class="msg-voice-player" data-audio-src="${escapeHtml(msg.voiceUrl)}">
                    <button type="button" class="msg-voice-play-btn" aria-label="Play voice note">
                        <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><polygon points="6,4 20,12 6,20"/></svg>
                        <svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" width="16" height="16" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    </button>
                    <div class="msg-voice-waveform-wrap">
                        <div class="msg-voice-waveform">
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                            <span class="msg-wave-bar"></span>
                        </div>
                        <div class="msg-voice-meta">
                            <span class="msg-voice-time">Voice Note</span>
                            <button type="button" class="msg-voice-speed-btn" data-speed="1">1x</button>
                        </div>
                    </div>
                </div>
            `;
        }

        // 3. Text Body or Call Event
        if (msg.text) {
            if (msg.text.startsWith('__CALL_EVENT__:')) {
                contentHtml += renderCallEventHtml(msg.text, isOut);
            } else {
                contentHtml += `<div class="msg-text-content">${escapeHtml(msg.text).replace(/\n/g, '<br>')}</div>`;
            }
        }


        const reactionsHtml = renderReactionsHtml(msg.reactions, currentUser);
        const canDelete = isOut || currentUser === 'muaj';

        return `
            <div class="msg-row ${rowClass}" data-msg-id="${msg.id}">
                <div class="msg-action-toolbar">
                    <div class="msg-quick-react-pill">
                        <button type="button" class="msg-react-emoji-btn" data-emoji="❤️">❤️</button>
                        <button type="button" class="msg-react-emoji-btn" data-emoji="🔥">🔥</button>
                        <button type="button" class="msg-react-emoji-btn" data-emoji="😂">😂</button>
                        <button type="button" class="msg-react-emoji-btn" data-emoji="🍿">🍿</button>
                    </div>
                    <button type="button" class="msg-action-btn btn-reply" title="Reply to Message" data-reply-id="${msg.id}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="13" height="13"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                    </button>
                    ${msg.text ? `<button type="button" class="msg-action-btn btn-copy" title="Copy Text">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>` : ''}
                    ${canDelete ? `<button type="button" class="msg-action-btn btn-delete" title="Delete Message">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>` : ''}
                </div>
                <div class="msg-bubble-wrap">
                    <div class="msg-bubble">
                        ${renderReplyQuoteHtml(msg.replyTo, currentUser)}
                        ${contentHtml}
                    </div>
                    ${reactionsHtml}
                    <div class="msg-meta-row">
                        <span class="msg-time">${timeStr}</span>
                        ${seenHtml}
                    </div>
                </div>
            </div>
        `;
    }

    function scrollToBottom(container) {
        if (!container) return;
        requestAnimationFrame(() => {
            container.scrollTop = container.scrollHeight;
        });
    }

    // ------------------------------------------------------------
    //  5. UNREAD BADGES & TOAST SYNCHRONIZER
    // ------------------------------------------------------------
    function updateUnreadBadges(count) {
        State.unreadCount = Math.max(0, parseInt(count, 10) || 0);
        const text = State.unreadCount > 99 ? '99+' : String(State.unreadCount);

        const currentLauncher = document.getElementById('msgFloatingLauncher') || DOM.launcher;
        const currentPill = document.getElementById('msgLauncherUnreadBadge') || DOM.unreadPill;
        const currentDrawer = document.getElementById('msgDrawerWidget') || DOM.drawer;
        const allNavBadges = document.querySelectorAll('.nav-msg-badge');

        if (currentPill) {
            currentPill.textContent = text;
            currentPill.style.display = State.unreadCount > 0 ? 'flex' : 'none';
        }

        if (currentLauncher) {
            const isDrawerOpen = currentDrawer && currentDrawer.classList.contains('is-open');
            if (State.unreadCount > 0) {
                currentLauncher.classList.add('has-unread');
                currentLauncher.style.display = 'flex';
            } else {
                currentLauncher.classList.remove('has-unread');
                if (isDrawerOpen) {
                    currentLauncher.style.display = 'flex';
                } else {
                    currentLauncher.style.display = 'none';
                }
            }
        }

        allNavBadges.forEach(badge => {
            badge.textContent = text;
            badge.style.display = State.unreadCount > 0 ? 'flex' : 'none';
        });

        if (State.unreadCount === 0) {
            hideFloatingMessageToast();
        }
    }

    function showFloatingMessageToast(msg) {
        if (!DOM.floatingToast || !msg) return;
        const isDrawerOpen = DOM.drawer && DOM.drawer.classList.contains('is-open');
        if (isDrawerOpen || State.isMessagesPage) return;

        let previewText = 'New message';
        if (msg.text) {
            if (msg.text.startsWith('__CALL_EVENT__:')) {
                try {
                    const data = JSON.parse(msg.text.replace('__CALL_EVENT__:', ''));
                    const isVideo = data.callType === 'video';
                    if (data.status === 'completed') {
                        previewText = isVideo ? '📹 Video call ended' : '📞 Audio call ended';
                    } else if (data.status === 'rejected') {
                        previewText = isVideo ? '📹 Declined video call' : '📞 Declined audio call';
                    } else {
                        previewText = isVideo ? '📹 Missed video call' : '📞 Missed audio call';
                    }
                } catch {
                    previewText = '📞 Call update';
                }
            } else {
                previewText = msg.text.length > 55 ? msg.text.slice(0, 55) + '…' : msg.text;
            }
        } else if (msg.voiceUrl) {
            previewText = '🎤 Voice note';
        } else if (msg.video) {
            previewText = `🎬 Shared video: ${msg.video.title || 'video'}`;
        }

        if (DOM.floatingToastText) {
            DOM.floatingToastText.textContent = previewText;
        }

        DOM.floatingToast.style.display = 'block';
        void DOM.floatingToast.offsetWidth; // Force reflow
        DOM.floatingToast.classList.add('is-visible');

        clearTimeout(toastDismissTimeout);
        toastDismissTimeout = setTimeout(() => {
            hideFloatingMessageToast();
        }, 6000);
    }

    function hideFloatingMessageToast() {
        if (!DOM.floatingToast) return;
        DOM.floatingToast.classList.remove('is-visible');
        clearTimeout(toastDismissTimeout);
        setTimeout(() => {
            if (!DOM.floatingToast.classList.contains('is-visible')) {
                DOM.floatingToast.style.display = 'none';
            }
        }, 350);
    }

    // ------------------------------------------------------------
    //  6. SIDEBAR STATS & PRESENCE UI
    // ------------------------------------------------------------
    function updateStatsUI(stats) {
        if (!stats) return;
        State.stats = { ...State.stats, ...stats };

        if (DOM.statTotalMessages) DOM.statTotalMessages.textContent = State.stats.totalMessages || 0;
        if (DOM.statSharedVideos) DOM.statSharedVideos.textContent = State.stats.sharedVideos || 0;
        if (DOM.statVoiceMessages) DOM.statVoiceMessages.textContent = State.stats.voiceMessages || 0;
        if (DOM.tabCountVideos) DOM.tabCountVideos.textContent = State.stats.sharedVideos || 0;
        if (DOM.tabCountVoice) DOM.tabCountVoice.textContent = State.stats.voiceMessages || 0;
    }

    function updatePartnerPresenceUI(presence) {
        if (!presence) return;
        State.partnerPresence = presence;

        const status = presence.status || 'offline';
        const isOnline = presence.isOnline || presence.isWatching;
        const isWatching = presence.isWatching;
        const statusClass = isWatching ? 'dot-watching' : (isOnline ? 'dot-online' : (presence.isIdle ? 'dot-idle' : 'dot-offline'));

        document.querySelectorAll('.msg-partner-status-dot').forEach(dot => {
            dot.className = `msg-status-dot msg-partner-status-dot ${statusClass}`;
        });

        document.querySelectorAll('.msg-partner-presence-text').forEach(el => {
            if (isWatching && presence.videoTitle) {
                el.innerHTML = `<span class="watching-highlight">🎬 Watching:</span> ${escapeHtml(presence.videoTitle)}`;
            } else if (isOnline) {
                el.textContent = '🟢 Active Now';
            } else if (presence.isIdle) {
                el.textContent = '🟡 Away';
            } else {
                el.textContent = '⚫ Offline';
            }
        });

        const watchingBanner = document.getElementById('msgSidebarWatchingBanner') || DOM.sidebarWatchingBanner;
        if (watchingBanner) {
            if (isWatching && presence.videoTitle) {
                watchingBanner.style.display = 'flex';
                const titleEl = watchingBanner.querySelector('.msg-sidebar-watching-title');
                if (titleEl) titleEl.textContent = presence.videoTitle;
                const joinBtn = watchingBanner.querySelector('.msg-sidebar-watching-join');
                if (joinBtn && presence.currentVideoId) {
                    joinBtn.href = `/watch/${encodeURIComponent(presence.currentVideoId)}`;
                }
            } else {
                watchingBanner.style.display = 'none';
            }
        }
    }

    // ------------------------------------------------------------
    //  7. DOM MESSAGE INSERTION & DEDUPLICATION
    // ------------------------------------------------------------
    function appendOrUpdateMessage(msg) {
        if (!msg || !msg.id) return;

        State.messages.set(msg.id, msg);
        if (msg.id > State.lastKnownId) {
            State.lastKnownId = msg.id;
        }

        getActiveContainers().forEach(container => {
            // Remove empty state if present
            const emptyState = container.querySelector('.msg-empty-state');
            if (emptyState) emptyState.remove();

            // Check if element already exists in container
            const existingRow = container.querySelector(`[data-msg-id="${msg.id}"]`);
            if (existingRow) {
                // Update read status if changed
                if (msg.isRead) {
                    const checkEl = existingRow.querySelector('.msg-seen-check');
                    if (checkEl) {
                        checkEl.classList.add('is-seen');
                        checkEl.textContent = '✓✓';
                        checkEl.title = 'Seen';
                    }
                }
                // Update reactions
                const bubbleWrap = existingRow.querySelector('.msg-bubble-wrap');
                if (bubbleWrap) {
                    const reactionsRow = bubbleWrap.querySelector('.msg-reactions-row');
                    const newHtml = renderReactionsHtml(msg.reactions, currentUser);
                    if (reactionsRow) {
                        if (newHtml) reactionsRow.outerHTML = newHtml;
                        else reactionsRow.remove();
                    } else if (newHtml) {
                        const metaRow = bubbleWrap.querySelector('.msg-meta-row');
                        if (metaRow) metaRow.insertAdjacentHTML('beforebegin', newHtml);
                        else bubbleWrap.insertAdjacentHTML('beforeend', newHtml);
                    }
                }
                return;
            }

            // Remove typing indicator if present
            const typingRow = container.querySelector('.msg-typing-row');
            if (typingRow) typingRow.remove();

            // Insert new message row at end
            container.insertAdjacentHTML('beforeend', renderMessageHTML(msg));
            applyActiveFiltersToRow(container.lastElementChild);
            scrollToBottom(container);
        });
    }

    function applyActiveFiltersToRow(row) {
        if (!row || !row.classList.contains('msg-row')) return;

        let visible = true;

        // Media tab filter
        if (State.activeMediaTab === 'videos') {
            visible = !!row.querySelector('.msg-video-card');
        } else if (State.activeMediaTab === 'voice') {
            visible = !!row.querySelector('.msg-voice-player');
        }

        // Search keyword filter
        if (visible && State.searchKeyword) {
            const text = (row.querySelector('.msg-text-content')?.textContent || '').toLowerCase();
            const videoTitle = (row.querySelector('.msg-video-card-title')?.textContent || '').toLowerCase();
            visible = text.includes(State.searchKeyword) || videoTitle.includes(State.searchKeyword);
        }

        row.style.display = visible ? 'flex' : 'none';
    }

    function applyFiltersToAll() {
        const container = DOM.fullPageList || DOM.drawerList;
        if (!container) return;

        container.querySelectorAll('.msg-row').forEach(row => {
            applyActiveFiltersToRow(row);
        });
    }

    // ------------------------------------------------------------
    //  8. STATE RECONCILIATION & SYNC
    // ------------------------------------------------------------
    function syncState(options = {}) {
        if (State.isSyncing) return Promise.resolve();

        // Debounce: prevent duplicate calls within 500ms (visibilitychange + focus fire together)
        const now = Date.now();
        if (!options.force && (now - State.lastSyncAt) < 500) return Promise.resolve();
        State.lastSyncAt = now;
        State.isSyncing = true;

        const params = new URLSearchParams();
        if (options.afterId) {
            params.set('afterId', String(options.afterId));
        } else if (options.full) {
            params.set('limit', '80');
        } else if (State.lastKnownId > 0 && State.isInitialSyncDone) {
            params.set('afterId', String(State.lastKnownId));
        } else {
            params.set('limit', '80');
        }

        return fetch(`/api/messages?${params.toString()}`)
            .then(res => res.json())
            .then(data => {
                if (data.success) {
                    if (Array.isArray(data.messages)) {
                        data.messages.forEach(msg => appendOrUpdateMessage(msg));
                    }
                    if (data.stats) updateStatsUI(data.stats);
                    if (data.partnerPresence) updatePartnerPresenceUI(data.partnerPresence);
                    if (typeof data.unreadCount === 'number') updateUnreadBadges(data.unreadCount);

                    State.isInitialSyncDone = true;

                    // If active on messages page, ensure messages are marked as read
                    if (State.isMessagesPage || (DOM.drawer && DOM.drawer.classList.contains('is-open'))) {
                        if (State.unreadCount > 0 || (data.messages && data.messages.some(m => m.sender === partnerUser && !m.isRead))) {
                            markMessagesAsRead();
                        }
                    }
                }
            })
            .catch(err => {
                console.warn('[messages] Sync error:', err.message);
            })
            .finally(() => {
                State.isSyncing = false;
            });
    }

    function markMessagesAsRead() {
        fetch('/api/messages/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                const remaining = typeof data.unreadCount === 'number' ? data.unreadCount : 0;
                updateUnreadBadges(remaining);
            }
        })
        .catch(() => {});
    }

    // Ingest initial SSR rendered messages from DOM on page load
    function ingestSSRMessages() {
        const container = DOM.fullPageList || DOM.drawerList;
        if (!container) return;

        container.querySelectorAll('.msg-row[data-msg-id]').forEach(row => {
            const id = parseInt(row.getAttribute('data-msg-id'), 10);
            if (id) {
                if (id > State.lastKnownId) State.lastKnownId = id;
                const isOut = row.classList.contains('msg-row-outgoing');
                const textEl = row.querySelector('.msg-text-content');
                const videoCard = row.querySelector('.msg-video-card');
                const voicePlayer = row.querySelector('.msg-voice-player');
                const quoteCard = row.querySelector('.msg-quote-card');

                let video = null;
                if (videoCard) {
                    video = {
                        id: videoCard.getAttribute('data-video-id'),
                        title: videoCard.querySelector('.msg-video-card-title')?.textContent || 'Video',
                        thumbnail: videoCard.querySelector('.msg-video-card-thumb-img')?.getAttribute('src')?.replace('/thumbnails/', '') || null
                    };
                }

                let replyTo = null;
                if (quoteCard) {
                    const rId = parseInt(quoteCard.getAttribute('data-reply-id'), 10);
                    if (rId) {
                        replyTo = {
                            id: rId,
                            sender: quoteCard.classList.contains('is-reply-to-me') ? currentUser : partnerUser,
                            text: quoteCard.querySelector('.msg-quote-text')?.textContent || null,
                            isDeleted: !!quoteCard.querySelector('.msg-quote-deleted')
                        };
                    }
                }

                State.messages.set(id, {
                    id,
                    sender: isOut ? currentUser : partnerUser,
                    recipient: isOut ? partnerUser : currentUser,
                    text: textEl ? textEl.innerText : null,
                    video,
                    videoId: video ? video.id : null,
                    voiceUrl: voicePlayer ? voicePlayer.getAttribute('data-audio-src') : null,
                    replyTo,
                    replyToId: replyTo ? replyTo.id : null
                });
            }
        });
    }

    // ------------------------------------------------------------
    //  9. SERVER-SENT EVENTS (SSE) REAL-TIME LISTENER
    // ------------------------------------------------------------
    function initSSE() {
        // Only create a new EventSource if none exists or the existing one is CLOSED
        if (sseSource && sseSource.readyState !== 2) {
            return; // CONNECTING (0) or OPEN (1) — let it be
        }
        if (sseSource) {
            sseSource.close();
            sseSource = null;
        }

        sseSource = new EventSource('/messages/stream');

        sseSource.addEventListener('connected', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (typeof data.unreadCount === 'number') updateUnreadBadges(data.unreadCount);
                if (data.partnerPresence) updatePartnerPresenceUI(data.partnerPresence);
                if (data.stats) updateStatsUI(data.stats);
                if (data.activeWatchTogether) {
                    window.dispatchEvent(new CustomEvent('wt:active-room', { detail: data.activeWatchTogether }));
                }

                // Incremental sync on connect/reconnect to catch any missed messages
                syncState({ force: true });
            } catch {}
        });

        // Watch Together Real-Time Global Notification Listeners
        sseSource.addEventListener('watch-together-invite', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('wt:invite', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('watch-together-ended', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('wt:ended', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('watch-together-status', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('wt:status', { detail: data }));
            } catch {}
        });

        // WebRTC Real-Time Calling SSE Listeners
        sseSource.addEventListener('incoming-call', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('call:incoming', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('call-accepted', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('call:accepted', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('call-signal', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('call:signal', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('call-rejected', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('call:rejected', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('call-cancelled', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('call:cancelled', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('call-ended', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('call:ended', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('call-timeout', (e) => {
            try {
                const data = JSON.parse(e.data);
                window.dispatchEvent(new CustomEvent('call:timeout', { detail: data }));
            } catch {}
        });

        sseSource.addEventListener('new-message', (e) => {
            try {
                const data = JSON.parse(e.data);
                const msg = data.message;
                if (!msg) return;

                appendOrUpdateMessage(msg);

                if (data.stats) {
                    updateStatsUI(data.stats);
                } else {
                    State.stats.totalMessages = (State.stats.totalMessages || 0) + 1;
                    if (msg.video) State.stats.sharedVideos = (State.stats.sharedVideos || 0) + 1;
                    if (msg.voiceUrl) State.stats.voiceMessages = (State.stats.voiceMessages || 0) + 1;
                    updateStatsUI(State.stats);
                }

                if (msg.sender === partnerUser) {
                    playNotificationChime();

                    const isDrawerOpen = DOM.drawer && DOM.drawer.classList.contains('is-open');
                    if (State.isMessagesPage || isDrawerOpen) {
                        markMessagesAsRead();
                    } else {
                        showFloatingMessageToast(msg);
                        if (typeof data.unreadCount === 'number') {
                            updateUnreadBadges(data.unreadCount);
                        }
                    }
                }
            } catch (err) {
                console.error('[messages] SSE new-message error:', err);
            }
        });

        sseSource.addEventListener('unread-count', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (typeof data.unreadCount === 'number') {
                    updateUnreadBadges(data.unreadCount);
                }
            } catch {}
        });

        sseSource.addEventListener('messages-read', () => {
            try {
                document.querySelectorAll('.msg-seen-check').forEach(el => {
                    el.classList.add('is-seen');
                    el.textContent = '✓✓';
                    el.title = 'Seen';
                });
            } catch {}
        });

        sseSource.addEventListener('user-typing', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (data.user === partnerUser) {
                    showTypingIndicator(data.isTyping);
                }
            } catch {}
        });

        sseSource.addEventListener('message-deleted', (e) => {
            try {
                const data = JSON.parse(e.data);
                const messageId = data.messageId;
                if (messageId) {
                    State.messages.delete(messageId);
                    document.querySelectorAll(`[data-msg-id="${messageId}"]`).forEach(row => {
                        row.style.opacity = '0';
                        row.style.transform = 'scale(0.9)';
                        setTimeout(() => row.remove(), 250);
                    });
                }
                if (data.stats) updateStatsUI(data.stats);
            } catch {}
        });

        sseSource.addEventListener('message-reaction', (e) => {
            try {
                const data = JSON.parse(e.data);
                const msgObj = State.messages.get(data.messageId);
                if (msgObj) msgObj.reactions = data.reactions;
                updateMessageReactionsDOM(data.messageId, data.reactions);
            } catch {}
        });

        sseSource.onerror = () => {
            // EventSource auto-reconnects; readyState check in initSSE() prevents duplicates
        };
    }

    function showTypingIndicator(show) {
        getActiveContainers().forEach(container => {
            let typingRow = container.querySelector('.msg-typing-row');
            if (show) {
                if (!typingRow) {
                    typingRow = document.createElement('div');
                    typingRow.className = 'msg-typing-row';
                    typingRow.innerHTML = `
                        <div class="msg-typing-bubble">
                            <span class="msg-typing-dot"></span>
                            <span class="msg-typing-dot"></span>
                            <span class="msg-typing-dot"></span>
                        </div>
                    `;
                    container.appendChild(typingRow);
                    scrollToBottom(container);
                }
            } else {
                if (typingRow) typingRow.remove();
            }
        });
    }

    function updateMessageReactionsDOM(messageId, reactions) {
        document.querySelectorAll(`[data-msg-id="${messageId}"]`).forEach(row => {
            const bubbleWrap = row.querySelector('.msg-bubble-wrap');
            if (!bubbleWrap) return;
            let reactionsRow = bubbleWrap.querySelector('.msg-reactions-row');
            const newHtml = renderReactionsHtml(reactions, currentUser);
            if (reactionsRow) {
                if (newHtml) reactionsRow.outerHTML = newHtml;
                else reactionsRow.remove();
            } else if (newHtml) {
                const metaRow = bubbleWrap.querySelector('.msg-meta-row');
                if (metaRow) metaRow.insertAdjacentHTML('beforebegin', newHtml);
                else bubbleWrap.insertAdjacentHTML('beforeend', newHtml);
            }
        });
    }

    // ------------------------------------------------------------
    //  10. FLOATING EMOJI BURST PARTICLES
    // ------------------------------------------------------------
    function spawnEmojiParticle(x, y, emoji) {
        const p = document.createElement('div');
        p.className = 'msg-emoji-burst-particle';
        p.textContent = emoji;
        p.style.left = `${x}px`;
        p.style.top = `${y}px`;
        p.style.setProperty('--dx', `${(Math.random() - 0.5) * 60}px`);
        p.style.setProperty('--rot', `${(Math.random() - 0.5) * 45}deg`);
        document.body.appendChild(p);
        setTimeout(() => p.remove(), 1200);
    }

    // ------------------------------------------------------------
    //  10.5. WHATSAPP-STYLE REPLY CONTROLLER & CLICK-TO-JUMP
    // ------------------------------------------------------------
    function setReplyMessage(msgObj) {
        if (!msgObj || !msgObj.id) return;
        State.replyToMessage = msgObj;

        const isReplyToMe = msgObj.sender === currentUser;
        const authorName = isReplyToMe ? 'Yourself' : (msgObj.sender === 'muaj' ? 'Muaj' : (msgObj.sender === 'hajera' ? 'Hajera' : (msgObj.sender || 'Partner')));

        let snippet = '';
        if (msgObj.text) {
            snippet = msgObj.text.length > 90 ? msgObj.text.slice(0, 90) + '…' : msgObj.text;
        } else if (msgObj.video) {
            snippet = `🎬 Shared Video: ${msgObj.video.title || 'Video'}`;
        } else if (msgObj.voiceUrl) {
            snippet = '🎙️ Voice Note';
        } else {
            snippet = 'Message';
        }

        const thumbUrl = msgObj.video && msgObj.video.thumbnail ? `/thumbnails/${encodeURIComponent(msgObj.video.thumbnail)}` : '';

        document.querySelectorAll('.msg-reply-bar').forEach(replyBar => {
            const nameEl = replyBar.querySelector('.msg-reply-bar-name');
            const snippetEl = replyBar.querySelector('.msg-reply-bar-snippet');
            const thumbEl = replyBar.querySelector('.msg-reply-bar-thumb');

            if (nameEl) nameEl.textContent = `Replying to ${authorName}`;
            if (snippetEl) snippetEl.textContent = snippet;
            if (thumbEl) {
                if (thumbUrl) {
                    thumbEl.innerHTML = `<img src="${thumbUrl}" alt="" />`;
                    thumbEl.style.display = 'block';
                } else {
                    thumbEl.innerHTML = '';
                    thumbEl.style.display = 'none';
                }
            }

            replyBar.style.display = 'flex';
            replyBar.classList.add('is-active');
        });

        // Focus composer textarea
        const activeTextarea = document.querySelector('.msg-fullpage-main .msg-textarea') || document.querySelector('.msg-drawer-widget .msg-textarea') || document.querySelector('.msg-textarea');
        if (activeTextarea) {
            activeTextarea.focus();
            if (window.innerWidth <= 900) {
                try {
                    activeTextarea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                } catch {}
            }
        }
    }

    function cancelReply() {
        State.replyToMessage = null;
        document.querySelectorAll('.msg-reply-bar').forEach(replyBar => {
            replyBar.classList.remove('is-active');
            replyBar.style.display = 'none';
        });
    }

    function jumpToMessage(targetId) {
        if (!targetId) return;
        const numId = parseInt(targetId, 10);
        if (!numId) return;

        let targetEl = document.querySelector(`.msg-row[data-msg-id="${numId}"]`);
        if (targetEl) {
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetEl.classList.remove('msg-row-target-highlight');
            void targetEl.offsetWidth; // Trigger reflow for animation
            targetEl.classList.add('msg-row-target-highlight');
            setTimeout(() => {
                targetEl.classList.remove('msg-row-target-highlight');
            }, 2200);
            return;
        }

        // Target not in DOM (older message), load older history
        const allMsgRows = document.querySelectorAll('.msg-row[data-msg-id]');
        let oldestId = null;
        allMsgRows.forEach(row => {
            const id = parseInt(row.getAttribute('data-msg-id'), 10);
            if (id && (oldestId === null || id < oldestId)) oldestId = id;
        });

        if (oldestId && oldestId > numId) {
            fetch(`/api/messages?limit=80&beforeId=${oldestId}`)
                .then(res => res.json())
                .then(data => {
                    if (data.success && Array.isArray(data.messages) && data.messages.length > 0) {
                        getActiveContainers().forEach(container => {
                            const fragment = document.createDocumentFragment();
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = data.messages.map(m => {
                                State.messages.set(m.id, m);
                                return renderMessageHTML(m);
                            }).join('');

                            const firstChild = container.firstElementChild;
                            while (tempDiv.firstChild) {
                                fragment.appendChild(tempDiv.firstChild);
                            }
                            if (firstChild) {
                                container.insertBefore(fragment, firstChild);
                            } else {
                                container.appendChild(fragment);
                            }
                        });

                        targetEl = document.querySelector(`.msg-row[data-msg-id="${numId}"]`);
                        if (targetEl) {
                            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                            targetEl.classList.add('msg-row-target-highlight');
                            setTimeout(() => targetEl.classList.remove('msg-row-target-highlight'), 2200);
                        }
                    }
                })
                .catch(() => {});
        }
    }

    // ------------------------------------------------------------
    //  10.6. MOBILE LONG-PRESS ACTION SHEET & SWIPE-TO-REPLY
    // ------------------------------------------------------------
    let touchTimer = null;
    let touchStartX = 0;
    let touchStartY = 0;
    let swipedRow = null;
    let selectedMobileMsg = null;

    const mobileBackdrop = document.getElementById('msgMobileActionsBackdrop');
    const mobileSheet = document.getElementById('msgMobileActionsSheet');

    function openMobileActionSheet(msgObj) {
        if (!msgObj || !mobileBackdrop || !mobileSheet) return;
        selectedMobileMsg = msgObj;

        const deleteItem = mobileSheet.querySelector('.btn-mobile-delete');
        const copyItem = mobileSheet.querySelector('.btn-mobile-copy');

        if (deleteItem) {
            const canDelete = msgObj.sender === currentUser || currentUser === 'muaj';
            deleteItem.style.display = canDelete ? 'flex' : 'none';
        }
        if (copyItem) {
            copyItem.style.display = msgObj.text ? 'flex' : 'none';
        }

        mobileBackdrop.style.display = 'block';
        void mobileBackdrop.offsetWidth;
        mobileBackdrop.classList.add('is-open');
    }

    function closeMobileActionSheet() {
        if (!mobileBackdrop) return;
        mobileBackdrop.classList.remove('is-open');
        setTimeout(() => {
            if (!mobileBackdrop.classList.contains('is-open')) {
                mobileBackdrop.style.display = 'none';
            }
        }, 250);
    }

    if (mobileBackdrop) {
        mobileBackdrop.addEventListener('click', (e) => {
            if (e.target === mobileBackdrop) {
                closeMobileActionSheet();
                return;
            }

            const reactBtn = e.target.closest('.msg-mobile-react-btn');
            if (reactBtn && selectedMobileMsg) {
                const emoji = reactBtn.getAttribute('data-emoji') || reactBtn.textContent.trim();
                toggleReaction(selectedMobileMsg.id, emoji, e.clientX, e.clientY);
                closeMobileActionSheet();
                return;
            }

            const replyBtn = e.target.closest('.btn-mobile-reply');
            if (replyBtn && selectedMobileMsg) {
                setReplyMessage(selectedMobileMsg);
                closeMobileActionSheet();
                return;
            }

            const copyBtn = e.target.closest('.btn-mobile-copy');
            if (copyBtn && selectedMobileMsg && selectedMobileMsg.text) {
                navigator.clipboard.writeText(selectedMobileMsg.text).then(() => {
                    closeMobileActionSheet();
                });
                return;
            }

            const deleteBtn = e.target.closest('.btn-mobile-delete');
            if (deleteBtn && selectedMobileMsg) {
                const targetMsgId = selectedMobileMsg.id;
                closeMobileActionSheet();
                if (confirm('Delete this message permanently?')) {
                    fetch(`/api/messages/delete/${targetMsgId}`, { method: 'POST' })
                        .then(res => res.json())
                        .then(data => {
                            if (data.success) {
                                State.messages.delete(targetMsgId);
                                document.querySelectorAll(`[data-msg-id="${targetMsgId}"]`).forEach(row => {
                                    row.style.opacity = '0';
                                    row.style.transform = 'scale(0.85)';
                                    setTimeout(() => row.remove(), 250);
                                });
                                if (data.stats) updateStatsUI(data.stats);
                            }
                        });
                }
                return;
            }
        });
    }

    // Touch events on messages for Long-Press and Swipe-to-Reply
    document.addEventListener('touchstart', (e) => {
        const row = e.target.closest('.msg-row');
        if (!row) return;

        // Skip if touching interactive items inside message like buttons or links
        if (e.target.closest('button') || e.target.closest('a') || e.target.closest('.msg-quote-card')) return;

        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        swipedRow = row;

        const msgId = parseInt(row.getAttribute('data-msg-id'), 10);
        const msgObj = State.messages.get(msgId) || {
            id: msgId,
            sender: row.classList.contains('msg-row-outgoing') ? currentUser : partnerUser,
            text: row.querySelector('.msg-text-content')?.innerText || null
        };

        touchTimer = setTimeout(() => {
            if (navigator.vibrate) {
                try { navigator.vibrate(35); } catch {}
            }
            openMobileActionSheet(msgObj);
            touchTimer = null;
            swipedRow = null;
        }, 450);
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!swipedRow || e.touches.length > 1) {
            clearTimeout(touchTimer);
            touchTimer = null;
            return;
        }

        const touch = e.touches[0];
        const dx = touch.clientX - touchStartX;
        const dy = touch.clientY - touchStartY;

        if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
            clearTimeout(touchTimer);
            touchTimer = null;
        }

        // Swipe right to reply
        if (dx > 15 && Math.abs(dy) < 30) {
            const dragDistance = Math.min(dx * 0.45, 65);
            swipedRow.style.transform = `translateX(${dragDistance}px)`;
            swipedRow.style.transition = 'none';
            if (dragDistance > 45) {
                swipedRow.classList.add('is-swipe-ready');
            } else {
                swipedRow.classList.remove('is-swipe-ready');
            }
        }
    }, { passive: true });

    document.addEventListener('touchend', (e) => {
        clearTimeout(touchTimer);
        touchTimer = null;

        if (swipedRow) {
            const wasReady = swipedRow.classList.contains('is-swipe-ready');
            const msgId = parseInt(swipedRow.getAttribute('data-msg-id'), 10);
            const msgObj = State.messages.get(msgId) || {
                id: msgId,
                sender: swipedRow.classList.contains('msg-row-outgoing') ? currentUser : partnerUser,
                text: swipedRow.querySelector('.msg-text-content')?.innerText || null
            };

            swipedRow.style.transition = 'transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)';
            swipedRow.style.transform = '';
            swipedRow.classList.remove('is-swipe-ready');

            if (wasReady && msgObj) {
                if (navigator.vibrate) {
                    try { navigator.vibrate(30); } catch {}
                }
                setReplyMessage(msgObj);
            }
            swipedRow = null;
        }
    }, { passive: true });

    // ------------------------------------------------------------
    //  11. SENDING MESSAGES & INTERACTIONS
    // ------------------------------------------------------------
    function sendMessage(text, videoId = null) {
        const cleanText = (text || '').trim();
        if (!cleanText && !videoId) return;

        const replyToId = State.replyToMessage ? State.replyToMessage.id : null;
        cancelReply();

        fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanText, videoId, replyToId })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success && data.message) {
                appendOrUpdateMessage(data.message);
                if (data.stats) updateStatsUI(data.stats);
                sendTypingState(false);
            }
        })
        .catch(err => console.error('[messages] Send failed:', err));
    }

    function sendTypingState(isTyping) {
        if (isCurrentlyTyping === isTyping) return;
        isCurrentlyTyping = isTyping;

        fetch('/api/messages/typing', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ isTyping })
        }).catch(() => {});
    }

    function toggleReaction(messageId, reaction, clientX = 0, clientY = 0) {
        if (!messageId || !reaction) return;
        if (clientX && clientY) spawnEmojiParticle(clientX, clientY, reaction);

        fetch('/api/messages/react', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messageId, reaction })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success && data.reactions) {
                updateMessageReactionsDOM(messageId, data.reactions);
            }
        })
        .catch(() => {});
    }

    // ------------------------------------------------------------
    //  12. VOICE RECORDING (MediaRecorder API)
    // ------------------------------------------------------------
    let mediaRecorder = null;
    let audioChunks = [];
    let recordInterval = null;
    let recordSeconds = 0;

    function setupVoiceRecording(recordBtn, recordingBar, cancelBtn, sendVoiceBtn) {
        if (!recordBtn || !recordingBar) return;

        recordBtn.addEventListener('click', async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];

                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) audioChunks.push(e.data);
                };

                mediaRecorder.onstop = () => {
                    stream.getTracks().forEach(track => track.stop());
                };

                mediaRecorder.start();
                recordSeconds = 0;
                recordingBar.classList.add('is-recording');
                const timerEl = recordingBar.querySelector('.msg-rec-timer');
                if (timerEl) timerEl.textContent = '0:00';

                recordInterval = setInterval(() => {
                    recordSeconds++;
                    const m = Math.floor(recordSeconds / 60);
                    const s = recordSeconds % 60;
                    if (timerEl) timerEl.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
                }, 1000);
            } catch (err) {
                alert('Microphone access was denied or is not supported in this browser.');
            }
        });

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    mediaRecorder.stop();
                }
                clearInterval(recordInterval);
                audioChunks = [];
                recordingBar.classList.remove('is-recording');
            });
        }

        if (sendVoiceBtn) {
            sendVoiceBtn.addEventListener('click', () => {
                if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

                mediaRecorder.onstop = () => {
                    clearInterval(recordInterval);
                    recordingBar.classList.remove('is-recording');

                    const blob = new Blob(audioChunks, { type: 'audio/webm' });
                    if (blob.size < 800) return; // Too short

                    const replyToId = State.replyToMessage ? State.replyToMessage.id : null;
                    cancelReply();

                    const formData = new FormData();
                    formData.append('audio', blob, 'voice.webm');
                    if (replyToId) formData.append('replyToId', replyToId);

                    fetch('/api/messages/voice', {
                        method: 'POST',
                        body: formData
                    })
                    .then(res => res.json())
                    .then(data => {
                        if (data.success && data.message) {
                            appendOrUpdateMessage(data.message);
                            if (data.stats) updateStatsUI(data.stats);
                        }
                    })
                    .catch(err => console.error('[messages] Voice send failed:', err));
                };

                mediaRecorder.stop();
            });
        }
    }

    // ------------------------------------------------------------
    //  13. INTERACTIVE AUDIO PLAYER WITH SCRUBBER & SPEED
    // ------------------------------------------------------------
    let activeAudio = null;
    let activePlayer = null;
    let activeInterval = null;

    function formatAudioTime(sec) {
        if (isNaN(sec) || sec < 0) return '0:00';
        const m = Math.floor(sec / 60);
        const s = Math.floor(sec % 60);
        return `${m}:${s < 10 ? '0' : ''}${s}`;
    }

    document.addEventListener('click', (e) => {
        // Speed Button Click
        const speedBtn = e.target.closest('.msg-voice-speed-btn');
        if (speedBtn) {
            e.stopPropagation();
            const currentSpeed = parseFloat(speedBtn.getAttribute('data-speed') || '1');
            let nextSpeed = 1;
            if (currentSpeed === 1) nextSpeed = 1.5;
            else if (currentSpeed === 1.5) nextSpeed = 2;
            else nextSpeed = 1;

            speedBtn.setAttribute('data-speed', nextSpeed);
            speedBtn.textContent = `${nextSpeed}x`;

            const player = speedBtn.closest('.msg-voice-player');
            if (player === activePlayer && activeAudio) {
                activeAudio.playbackRate = nextSpeed;
            }
            return;
        }

        // Waveform Scrubber Click
        const waveformWrap = e.target.closest('.msg-voice-waveform-wrap');
        if (waveformWrap) {
            const player = waveformWrap.closest('.msg-voice-player');
            if (player === activePlayer && activeAudio && activeAudio.duration) {
                const rect = waveformWrap.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const pct = Math.max(0, Math.min(1, clickX / rect.width));
                activeAudio.currentTime = pct * activeAudio.duration;
            }
        }

        // Play/Pause Button Click
        const playBtn = e.target.closest('.msg-voice-play-btn');
        if (playBtn) {
            const player = playBtn.closest('.msg-voice-player');
            const audioSrc = player.getAttribute('data-audio-src');
            if (!audioSrc) return;

            if (activeAudio && activePlayer === player) {
                if (activeAudio.paused) {
                    activeAudio.play();
                    player.classList.add('is-playing');
                    playBtn.querySelector('.icon-play').style.display = 'none';
                    playBtn.querySelector('.icon-pause').style.display = '';
                } else {
                    activeAudio.pause();
                    player.classList.remove('is-playing');
                    playBtn.querySelector('.icon-play').style.display = '';
                    playBtn.querySelector('.icon-pause').style.display = 'none';
                }
                return;
            }

            // Stop previous audio
            if (activeAudio) {
                activeAudio.pause();
                clearInterval(activeInterval);
                if (activePlayer) {
                    activePlayer.classList.remove('is-playing');
                    const btn = activePlayer.querySelector('.msg-voice-play-btn');
                    if (btn) {
                        btn.querySelector('.icon-play').style.display = '';
                        btn.querySelector('.icon-pause').style.display = 'none';
                    }
                }
            }

            // Start new audio
            const audio = new Audio(audioSrc);
            const speedEl = player.querySelector('.msg-voice-speed-btn');
            const speed = speedEl ? parseFloat(speedEl.getAttribute('data-speed') || '1') : 1;
            audio.playbackRate = speed;

            activeAudio = audio;
            activePlayer = player;

            playBtn.querySelector('.icon-play').style.display = 'none';
            playBtn.querySelector('.icon-pause').style.display = '';
            player.classList.add('is-playing');

            const timeEl = player.querySelector('.msg-voice-time');
            const bars = player.querySelectorAll('.msg-wave-bar');

            audio.addEventListener('loadedmetadata', () => {
                if (timeEl) timeEl.textContent = `0:00 / ${formatAudioTime(audio.duration)}`;
            });

            audio.play().catch(() => {});

            activeInterval = setInterval(() => {
                if (!audio || isNaN(audio.duration)) return;
                const current = audio.currentTime;
                const total = audio.duration;
                if (timeEl) timeEl.textContent = `${formatAudioTime(current)} / ${formatAudioTime(total)}`;

                const progress = current / total;
                const barCount = bars.length;
                const passedIdx = Math.floor(progress * barCount);
                bars.forEach((bar, idx) => {
                    bar.classList.toggle('is-passed', idx <= passedIdx);
                });
            }, 100);

            audio.onended = () => {
                clearInterval(activeInterval);
                player.classList.remove('is-playing');
                playBtn.querySelector('.icon-play').style.display = '';
                playBtn.querySelector('.icon-pause').style.display = 'none';
                bars.forEach(b => b.classList.remove('is-passed'));
                if (timeEl) timeEl.textContent = 'Voice Note';
                activeAudio = null;
                activePlayer = null;
            };
        }
    });

    // ------------------------------------------------------------
    //  14. ACTIONS: REACTIONS, COPY, DELETE, EMPTY STARTERS
    // ------------------------------------------------------------
    document.addEventListener('click', (e) => {
        // 1. Emoji Reaction Click from Toolbar or Badge
        const reactBtn = e.target.closest('.msg-react-emoji-btn') || e.target.closest('.msg-reaction-badge');
        if (reactBtn) {
            const row = reactBtn.closest('.msg-row');
            if (!row) return;
            const messageId = parseInt(row.getAttribute('data-msg-id'), 10);
            const emoji = reactBtn.getAttribute('data-emoji') || reactBtn.textContent.trim().split(/\s+/)[0];
            if (messageId && emoji) {
                toggleReaction(messageId, emoji, e.clientX, e.clientY);
            }
            return;
        }

        // 1.5. Reply Button Click from Toolbar
        const replyBtn = e.target.closest('.btn-reply');
        if (replyBtn) {
            const row = replyBtn.closest('.msg-row');
            if (row) {
                const msgId = parseInt(row.getAttribute('data-msg-id'), 10);
                const msgObj = State.messages.get(msgId) || {
                    id: msgId,
                    sender: row.classList.contains('msg-row-outgoing') ? currentUser : partnerUser,
                    text: row.querySelector('.msg-text-content')?.innerText || null
                };
                setReplyMessage(msgObj);
            }
            return;
        }

        // 1.6. Click-to-Jump Quoted Message Card Click
        const quoteCard = e.target.closest('.msg-quote-card');
        if (quoteCard) {
            const replyId = quoteCard.getAttribute('data-reply-id');
            if (replyId) {
                jumpToMessage(replyId);
            }
            return;
        }

        // 1.7. Cancel Reply Button in Composer
        const cancelReplyBtn = e.target.closest('.msg-reply-bar-cancel');
        if (cancelReplyBtn) {
            cancelReply();
            return;
        }

        // 2. Copy Message Text
        const copyBtn = e.target.closest('.btn-copy');
        if (copyBtn) {
            const row = copyBtn.closest('.msg-row');
            const textEl = row ? row.querySelector('.msg-text-content') : null;
            if (textEl) {
                navigator.clipboard.writeText(textEl.innerText.trim()).then(() => {
                    const originalHtml = copyBtn.innerHTML;
                    copyBtn.innerHTML = `✓`;
                    copyBtn.style.color = '#34d399';
                    setTimeout(() => {
                        copyBtn.innerHTML = originalHtml;
                        copyBtn.style.color = '';
                    }, 1500);
                });
            }
            return;
        }

        // 3. Delete Message
        const deleteBtn = e.target.closest('.btn-delete');
        if (deleteBtn) {
            const row = deleteBtn.closest('.msg-row');
            if (!row) return;
            const messageId = parseInt(row.getAttribute('data-msg-id'), 10);
            if (confirm('Delete this message permanently?')) {
                fetch(`/api/messages/delete/${messageId}`, { method: 'POST' })
                    .then(res => res.json())
                    .then(data => {
                        if (data.success) {
                            State.messages.delete(messageId);
                            row.style.opacity = '0';
                            row.style.transform = 'scale(0.85)';
                            setTimeout(() => row.remove(), 250);
                            if (data.stats) updateStatsUI(data.stats);
                        }
                    });
            }
            return;
        }

        // 4. Empty State Conversation Starter
        const starterChip = e.target.closest('.msg-empty-starter-chip');
        if (starterChip) {
            const action = starterChip.getAttribute('data-starter');
            const container = starterChip.closest('.msg-fullpage-main') || starterChip.closest('.msg-drawer-widget');
            const textarea = container ? container.querySelector('.msg-textarea') : null;
            if (action === 'hello') {
                sendMessage('Hey there! 👋 How are you doing?');
            } else if (action === 'movie') {
                sendMessage('Hey! Want to watch a movie together tonight? 🍿🎬');
            } else if (action === 'voice') {
                const micBtn = container ? container.querySelector('.msg-mic-btn') : null;
                if (micBtn) micBtn.click();
            } else if (textarea) {
                textarea.value = starterChip.textContent.trim();
                textarea.focus();
            }
        }
    });

    // ------------------------------------------------------------
    //  15. COMPOSER SETUP
    // ------------------------------------------------------------
    function setupComposer(formOrWrap) {
        if (!formOrWrap) return;

        const textarea = formOrWrap.querySelector('.msg-textarea');
        const sendBtn = formOrWrap.querySelector('.msg-send-btn');
        const emojiBtns = formOrWrap.querySelectorAll('.msg-quick-emoji-btn');
        const attachBtn = formOrWrap.querySelector('.msg-attach-btn');
        const attachModal = formOrWrap.querySelector('.msg-attach-video-modal');

        if (textarea) {
            textarea.addEventListener('input', () => {
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';

                sendTypingState(true);
                clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                    sendTypingState(false);
                }, 2500);
            });

            textarea.addEventListener('focus', () => {
                setTimeout(() => {
                    getActiveContainers().forEach(scrollToBottom);
                    if (window.innerWidth <= 900) {
                        try {
                            textarea.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
                        } catch {}
                    }
                }, 250);
            });

            textarea.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    const text = textarea.value;
                    textarea.value = '';
                    textarea.style.height = 'auto';
                    sendMessage(text);
                }
            });
        }

        if (sendBtn && textarea) {
            sendBtn.addEventListener('click', () => {
                const text = textarea.value;
                textarea.value = '';
                textarea.style.height = 'auto';
                sendMessage(text);
                textarea.focus();
            });
        }

        // Quick Emojis Bar
        emojiBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                const emoji = btn.getAttribute('data-emoji') || btn.textContent.trim();
                spawnEmojiParticle(e.clientX, e.clientY, emoji);
                if (textarea) {
                    textarea.value += emoji;
                    textarea.focus();
                    textarea.dispatchEvent(new Event('input'));
                }
            });
        });

        // Attach Video Modal
        if (attachBtn && attachModal) {
            attachBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                attachModal.classList.toggle('is-open');
                const searchInput = attachModal.querySelector('.msg-attach-search-input');
                if (searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                    filterAttachList(attachModal, '');
                }
            });

            document.addEventListener('click', (e) => {
                if (!attachModal.contains(e.target) && e.target !== attachBtn) {
                    attachModal.classList.remove('is-open');
                }
            });

            const searchInput = attachModal.querySelector('.msg-attach-search-input');
            if (searchInput) {
                searchInput.addEventListener('input', () => {
                    filterAttachList(attachModal, searchInput.value.toLowerCase().trim());
                });
            }

            attachModal.querySelectorAll('.msg-attach-item').forEach(item => {
                item.addEventListener('click', () => {
                    const videoId = item.getAttribute('data-video-id');
                    if (videoId) {
                        sendMessage('', videoId);
                        attachModal.classList.remove('is-open');
                    }
                });
            });
        }

        // Voice Recording Setup
        const recordBtn = formOrWrap.querySelector('.msg-mic-btn');
        const recordingBar = formOrWrap.querySelector('.msg-recording-bar');
        const cancelVoiceBtn = formOrWrap.querySelector('.msg-rec-cancel-btn');
        const sendVoiceBtn = formOrWrap.querySelector('.msg-rec-send-btn');
        setupVoiceRecording(recordBtn, recordingBar, cancelVoiceBtn, sendVoiceBtn);
    }

    function filterAttachList(modal, query) {
        modal.querySelectorAll('.msg-attach-item').forEach(item => {
            const title = (item.querySelector('.msg-attach-title')?.textContent || '').toLowerCase();
            item.style.display = title.includes(query) ? 'flex' : 'none';
        });
    }

    // ------------------------------------------------------------
    //  16. IN-CHAT SEARCH & SHARED MEDIA TABS
    // ------------------------------------------------------------
    if (DOM.searchToggleBtn && DOM.inChatSearchBar && DOM.inChatSearchInput) {
        DOM.searchToggleBtn.addEventListener('click', () => {
            const isOpen = DOM.inChatSearchBar.classList.toggle('is-open');
            if (isOpen) {
                DOM.inChatSearchInput.value = '';
                DOM.inChatSearchInput.focus();
            } else {
                State.searchKeyword = '';
                applyFiltersToAll();
            }
        });

        if (DOM.inChatSearchClose) {
            DOM.inChatSearchClose.addEventListener('click', () => {
                DOM.inChatSearchBar.classList.remove('is-open');
                DOM.inChatSearchInput.value = '';
                State.searchKeyword = '';
                applyFiltersToAll();
            });
        }

        DOM.inChatSearchInput.addEventListener('input', () => {
            State.searchKeyword = DOM.inChatSearchInput.value.toLowerCase().trim();
            applyFiltersToAll();
        });
    }

    // Shared Media Explorer Tabs in Sidebar
    document.querySelectorAll('.msg-media-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.msg-media-tab-btn').forEach(b => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            State.activeMediaTab = btn.getAttribute('data-tab') || 'all';
            applyFiltersToAll();
        });
    });

    // ------------------------------------------------------------
    //  17. FLOATING TOAST & LAUNCHER INTERACTIONS
    // ------------------------------------------------------------
    if (DOM.floatingToast) {
        DOM.floatingToast.addEventListener('click', (e) => {
            if (e.target.closest('#msgFloatingToastClose') || e.target.closest('.msg-floating-toast-close-btn')) {
                hideFloatingMessageToast();
                return;
            }
            hideFloatingMessageToast();
            window.location.href = '/messages';
        });
    }

    // ------------------------------------------------------------
    //  18. GLOBAL VIDEO SHARE BUTTON ("Share to Chat" on /watch/:id)
    // ------------------------------------------------------------
    const shareToChatBtn = document.getElementById('btnShareToChat');
    if (shareToChatBtn) {
        shareToChatBtn.addEventListener('click', () => {
            const videoId = shareToChatBtn.getAttribute('data-video-id');
            if (!videoId) return;

            sendMessage('', videoId);

            const originalHtml = shareToChatBtn.innerHTML;
            shareToChatBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>Shared to Chat!</span>
            `;
            setTimeout(() => {
                shareToChatBtn.innerHTML = originalHtml;
            }, 2000);
        });
    }

    // Right-click context menu handler on desktop
    document.addEventListener('contextmenu', (e) => {
        const row = e.target.closest('.msg-row');
        if (!row) return;

        if (e.target.closest('input') || e.target.closest('textarea') || e.target.closest('a') || e.target.closest('.msg-voice-player') || e.target.closest('.msg-video-card')) {
            return;
        }

        e.preventDefault();
        const msgId = parseInt(row.getAttribute('data-msg-id'), 10);
        const msgObj = State.messages.get(msgId) || {
            id: msgId,
            sender: row.classList.contains('msg-row-outgoing') ? currentUser : partnerUser,
            text: row.querySelector('.msg-text-content')?.innerText || null
        };
        openMobileActionSheet(msgObj);
    });

    // Escape key listener to close action sheets / cancel reply
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (mobileBackdrop && mobileBackdrop.classList.contains('is-open')) {
                closeMobileActionSheet();
                return;
            }
            if (State.replyToMessage) {
                cancelReply();
                return;
            }
        }
    });

    // ------------------------------------------------------------
    //  19. LIFECYCLE, BFCACHE & NAVIGATION LISTENERS
    // ------------------------------------------------------------
    // Initialize Composers
    document.querySelectorAll('.msg-composer-wrap').forEach(setupComposer);

    // Ingest SSR messages
    ingestSSRMessages();

    // Initial Auto-scroll
    getActiveContainers().forEach(scrollToBottom);

    // Initial Unread Count Sync from DOM
    if (DOM.unreadPill && DOM.unreadPill.textContent) {
        updateUnreadBadges(parseInt(DOM.unreadPill.textContent, 10) || 0);
    } else {
        const initialNavBadge = document.querySelector('.nav-msg-badge');
        if (initialNavBadge && initialNavBadge.textContent) {
            updateUnreadBadges(parseInt(initialNavBadge.textContent, 10) || 0);
        }
    }

    // Start Real-Time SSE Stream (syncState is called from the 'connected' handler)
    initSSE();

    // Reconcile and reconnect on page restoration from bfcache
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            // bfcache restore — SSE is dead, force reconnect
            if (sseSource) { sseSource.close(); sseSource = null; }
            initSSE();
        }
    });

    // Reconcile on tab visibility change (covers both focus and visibility)
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            initSSE(); // no-op if already connected (readyState check inside)
            syncState();
        }
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        if (sseSource) {
            sseSource.close();
            sseSource = null;
        }
    });

    // Mobile Virtual Keyboard Scroll Adjuster
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            if (State.isMessagesPage) {
                setTimeout(() => {
                    getActiveContainers().forEach(scrollToBottom);
                }, 100);
            }
        });
    }

})();
