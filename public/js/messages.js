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
        stats: { totalMessages: 0, sharedVideos: 0, voiceMessages: 0, totalCalls: 0 },
        activeMediaTab: 'all',
        searchKeyword: '',
        replyToMessage: null,
        isSyncing: false,
        isInitialSyncDone: false,
        lastSyncAt: 0, // debounce timestamp for syncState()
        isSending: false,
        isLoadingOlder: false,
        hasMoreOlder: true
    };

    // ------------------------------------------------------------
    //  3. DOM ELEMENT REFERENCES & HELPERS
    // ------------------------------------------------------------
    function getFullpageList() {
        return document.getElementById('msgFullpageList');
    }

    function getDrawerList() {
        return document.getElementById('msgDrawerList');
    }

    function getActiveContainers() {
        const list = [];
        const dl = getDrawerList();
        const fl = getFullpageList();
        if (dl) list.push(dl);
        if (fl) list.push(fl);
        return list;
    }

    let toastDismissTimeout = null;
    let typingTimeout = null;
    let isCurrentlyTyping = false;
    let sseSource = null;

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

    function getDhakaDateParts(date) {
        const formatter = new Intl.DateTimeFormat('en-US', {
            timeZone: 'Asia/Dhaka',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric'
        });
        return formatter.format(date);
    }

    function formatDateHeader(isoStr) {
        if (!isoStr) return '';
        try {
            const d = new Date(isoStr);
            if (isNaN(d.getTime())) return '';
            const now = new Date();
            const msgDateStr = getDhakaDateParts(d);
            const todayDateStr = getDhakaDateParts(now);
            const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
            const yesterdayDateStr = getDhakaDateParts(yesterday);
            if (msgDateStr === todayDateStr) return 'Today';
            if (msgDateStr === yesterdayDateStr) return 'Yesterday';
            return d.toLocaleDateString('en-US', {
                timeZone: 'Asia/Dhaka',
                month: 'short',
                day: 'numeric',
                year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined
            });
        } catch {
            return '';
        }
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

    // ------------------------------------------------------------
    //  4.1. WHATSAPP / APPLE EMOJI PACK CONVERTER & JUMBO SYSTEM
    // ------------------------------------------------------------
    const WA_APPLE_EMOJI_BASE = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/';
    const WA_TWEMOJI_FALLBACK_BASE = 'https://unpkg.com/twemoji@14.0.2/dist/svg/';

    const WA_EMOJI_CATEGORIES = {
        smileys: {
            name: 'Smileys & Emotion',
            emojis: [
                '😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃',
                '😉','😊','😇','🥰','😍','🤩','😘','😗','😚','😋',
                '😛','😜','🤪','😝','🤗','🤭','🤫','🤔','🤐','🤨',
                '😐','😑','😶','😏','😒','🙄','😬','🤥','😌','😔',
                '😪','🤤','😴','😷','🤒','🤕','🤢','🤮','🤧','🥵',
                '🥶','🥴','😵','🤯','🤠','🥳','🥸','😎','🤓','🧐',
                '😕','😟','🙁','😮','😯','😲','😳','🥺','😦','😧',
                '😨','😰','😥','😢','😭','😱','😖','😣','😞','😓',
                '😩','😫','🥱','😤','😡','😠','🤬','😈','👿','💀'
            ]
        },
        love: {
            name: 'Love & Gestures',
            emojis: [
                '❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔',
                '❣️','💕','💞','💓','💗','💖','💘','💝','💟','💌',
                '💋','🫂','🫶','👍','👎','👏','🙌','👐','🤲','🤝',
                '🙏','✍️','💅','🤳','💪','👊','✊','🤛','🤜','✌️',
                '🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👋',
                '🫡','👀','👁️','👅','👄','🧠','🫀','🫁','🔥','✨'
            ]
        },
        fun: {
            name: 'Cinema & Entertainment',
            emojis: [
                '🍿','🎬','🎥','📽️','📺','📷','📸','📹','📼','🎧',
                '🎤','🎵','🎶','🎸','🎹','🥁','🎮','🕹️','🎲','🎯',
                '🎨','🎭','🎪','🎟️','🎫','🏆','🥇','🥈','🥉','⚽',
                '🏀','🏈','⚾','🎾','🏐','🎱','🏓','🏸','🎳','🥊'
            ]
        },
        party: {
            name: 'Party & Lifestyle',
            emojis: [
                '🍕','🍔','🍟','🌭','🍿','🍩','🍪','🎂','🍰','🍫',
                '🍬','🍭','☕','🍵','🧋','🍺','🍻','🥂','🍷','🍸',
                '🍹','🍾','🎁','🎉','🎊','🎈','🌹','🌸','🌺','🌻',
                '🌼','💐','🧸','👑','💎','⚡','🌟','💫','🌈','☀️'
            ]
        }
    };

    function toAppleEmojiImg(rawEmoji) {
        if (!rawEmoji) return '';
        // Android/system emoji avoid a network request per glyph on the full chat page.
        if (State.isMessagesPage || !window.twemoji || !window.twemoji.convert) {
            return escapeHtml(rawEmoji);
        }
        try {
            const code = window.twemoji.convert.toCodePoint(rawEmoji, '-');
            const codeNoFE0F = code.replace(/-fe0f/g, '');
            const appleUrl = `${WA_APPLE_EMOJI_BASE}${code}.png`;
            const fallbackUrl = `${WA_TWEMOJI_FALLBACK_BASE}${codeNoFE0F}.svg`;
            const safeEmoji = escapeHtml(rawEmoji);
            return `<img class="wa-emoji" draggable="false" alt="${safeEmoji}" data-code="${code}" src="${appleUrl}" loading="lazy" onerror="this.onerror=null;if(this.src!=='${fallbackUrl}'){this.src='${fallbackUrl}';}else{this.outerHTML='<span class=\\'wa-raw-emoji\\'>${safeEmoji}</span>';}" />`;
        } catch {
            return escapeHtml(rawEmoji);
        }
    }

    function parseWhatsAppEmoji(str) {
        if (!str) return '';
        if (!window.twemoji || typeof window.twemoji.replace !== 'function') {
            return str;
        }
        try {
            return window.twemoji.replace(String(str), function (rawEmoji) {
                return toAppleEmojiImg(rawEmoji);
            });
        } catch {
            return str;
        }
    }

    // Expose helpers globally
    window.toAppleEmojiImg = toAppleEmojiImg;
    window.parseWhatsAppEmoji = parseWhatsAppEmoji;
    window.applyWhatsAppEmojis = applyWhatsAppEmojis;

    function detectAndApplyJumbo(msgTextEl) {
        if (!msgTextEl) return;
        msgTextEl.classList.remove('msg-jumbo-1', 'msg-jumbo-2', 'msg-jumbo-3');
        const childNodes = Array.from(msgTextEl.childNodes);
        let emojiCount = 0;
        let hasOtherContent = false;

        for (const node of childNodes) {
            if (node.nodeType === Node.TEXT_NODE) {
                if (node.textContent.trim().length > 0) {
                    hasOtherContent = true;
                    break;
                }
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.classList.contains('wa-emoji') || node.classList.contains('emoji')) {
                    emojiCount++;
                } else if (node.tagName === 'BR') {
                    // allow line breaks
                } else {
                    hasOtherContent = true;
                    break;
                }
            }
        }

        const bubble = msgTextEl.closest('.msg-bubble');
        if (!hasOtherContent && emojiCount >= 1 && emojiCount <= 3) {
            msgTextEl.classList.add(`msg-jumbo-${emojiCount}`);
            if (bubble && !bubble.querySelector('.msg-video-card, .msg-voice-player, .msg-quote-card, .msg-call-event-card')) {
                bubble.classList.add('is-emoji-only-bubble');
            }
        } else {
            if (bubble) bubble.classList.remove('is-emoji-only-bubble');
        }
    }

    function formatMessageTextHtml(rawText) {
        if (!rawText) return '';
        const escaped = escapeHtml(rawText);
        const emojiFormatted = parseWhatsAppEmoji(escaped.replace(/\n/g, '<br>'));
        
        const temp = document.createElement('div');
        temp.innerHTML = emojiFormatted;
        const emojiImgs = temp.querySelectorAll('.wa-emoji, img.emoji');
        
        const clone = temp.cloneNode(true);
        clone.querySelectorAll('.wa-emoji, img.emoji').forEach(img => img.remove());
        const otherText = clone.textContent.replace(/[\s\r\n]+/g, '').trim();

        let jumboClass = '';
        if (otherText.length === 0 && emojiImgs.length >= 1 && emojiImgs.length <= 3) {
            jumboClass = ` msg-jumbo-${emojiImgs.length}`;
        }

        return `<div class="msg-text-content${jumboClass}">${emojiFormatted}</div>`;
    }

    function applyWhatsAppEmojis(container) {
        if (!container) return;
        if (!window.twemoji) return;

        // Process .msg-text-content
        const textElements = container.querySelectorAll ? container.querySelectorAll('.msg-text-content') : [];
        textElements.forEach(el => {
            if (!el.querySelector('.wa-emoji')) {
                const raw = el.innerHTML;
                el.innerHTML = parseWhatsAppEmoji(raw);
            }
            detectAndApplyJumbo(el);
        });

        // Process reaction buttons & badges
        const reactBtns = container.querySelectorAll ? container.querySelectorAll('.msg-react-emoji-btn, .msg-mobile-react-btn, .msg-reaction-badge span:first-child, .msg-empty-starter-chip, .call-quick-emoji-btn, .emoji-chip') : [];
        reactBtns.forEach(btn => {
            if (!btn.querySelector('.wa-emoji')) {
                const text = btn.innerText || btn.textContent;
                if (text) {
                    btn.innerHTML = parseWhatsAppEmoji(text);
                }
            }
        });

        // Process quote snippets
        const quotes = container.querySelectorAll ? container.querySelectorAll('.msg-quote-snippet, .msg-quote-media-indicator') : [];
        quotes.forEach(q => {
            if (!q.querySelector('.wa-emoji')) {
                q.innerHTML = parseWhatsAppEmoji(q.innerHTML);
            }
        });
    }

    function extractCleanText(element) {
        if (!element) return '';
        const clone = element.cloneNode(true);
        const emojiImgs = clone.querySelectorAll('.wa-emoji, img.emoji');
        emojiImgs.forEach(img => {
            const alt = img.getAttribute('alt') || '';
            img.replaceWith(document.createTextNode(alt));
        });
        return clone.innerText.trim();
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
            const emojiHtml = parseWhatsAppEmoji(escapeHtml(emoji));
            return `
                <button type="button" class="msg-reaction-badge ${isMine ? 'is-user-reacted' : ''}" data-emoji="${escapeHtml(emoji)}" title="${escapeHtml(users.join(', '))}">
                    <span>${emojiHtml}</span>
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
                snippet = `<span class="msg-quote-text">${parseWhatsAppEmoji(escapeHtml(replyTo.text))}</span>`;
            }
            if (replyTo.videoTitle || replyTo.videoId) {
                const vTitle = replyTo.videoTitle || 'Shared Video';
                const thumbUrl = replyTo.videoThumbnail ? `/thumbnails/${encodeURIComponent(replyTo.videoThumbnail)}` : '';
                snippet = `<span class="msg-quote-media-indicator">${parseWhatsAppEmoji('🎬')} ${escapeHtml(vTitle)}</span>` + (snippet ? ` — ${snippet}` : '');
                if (thumbUrl) {
                    thumbHtml = `<img src="${thumbUrl}" class="msg-quote-thumb" alt="" />`;
                }
            } else if (replyTo.voiceUrl) {
                snippet = `<span class="msg-quote-media-indicator">${parseWhatsAppEmoji('🎙️')} Voice Note</span>` + (snippet ? ` — ${snippet}` : '');
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

    function renderCallEventHtml(rawText, isOut, timeStr) {
        try {
            const jsonStr = rawText.replace('__CALL_EVENT__:', '');
            const data = JSON.parse(jsonStr);
            const isVideo = data.callType === 'video';
            const status = data.status || 'completed';
            const durationSeconds = Number(data.durationSeconds || 0);

            let title = '';
            let subtitle = '';
            let statusTag = '';
            let statusClass = '';
            let directionBadge = '';
            let iconSvg = '';

            if (status === 'completed') {
                statusClass = 'call-status-completed';
                const mins = Math.floor(durationSeconds / 60);
                const secs = durationSeconds % 60;
                const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
                
                title = isOut
                    ? (isVideo ? 'Outgoing Video Call' : 'Outgoing Voice Call')
                    : (isVideo ? 'Incoming Video Call' : 'Incoming Voice Call');
                statusTag = 'Connected';
                subtitle = `${durStr} • HD Audio/Video`;

                directionBadge = isOut
                    ? `<span class="msg-call-dir-badge dir-outgoing" title="Outgoing Answered"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></span>`
                    : `<span class="msg-call-dir-badge dir-incoming" title="Incoming Answered"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/></svg></span>`;

            } else if (status === 'missed') {
                statusClass = 'call-status-missed';
                if (isOut) {
                    title = isVideo ? 'Outgoing Video Call' : 'Outgoing Voice Call';
                    statusTag = 'No Answer';
                    subtitle = 'Partner was unavailable';
                    directionBadge = `<span class="msg-call-dir-badge dir-missed-out" title="Outgoing Unanswered"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3"><line x1="7" y1="17" x2="17" y2="7"/><polyline points="7 7 17 7 17 17"/></svg></span>`;
                } else {
                    title = isVideo ? 'Missed Video Call' : 'Missed Voice Call';
                    statusTag = 'Missed';
                    subtitle = 'Tap below to return call';
                    directionBadge = `<span class="msg-call-dir-badge dir-missed" title="Missed Call"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/></svg></span>`;
                }

            } else if (status === 'rejected') {
                statusClass = 'call-status-rejected';
                if (isOut) {
                    title = isVideo ? 'Video Call Declined' : 'Voice Call Declined';
                    statusTag = 'Busy';
                    subtitle = 'Partner declined the call';
                    directionBadge = `<span class="msg-call-dir-badge dir-rejected" title="Declined"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>`;
                } else {
                    title = isVideo ? 'Declined Video Call' : 'Declined Voice Call';
                    statusTag = 'Declined';
                    subtitle = 'You declined the call';
                    directionBadge = `<span class="msg-call-dir-badge dir-rejected" title="Declined"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>`;
                }

            } else {
                statusClass = 'call-status-cancelled';
                if (isOut) {
                    title = isVideo ? 'Cancelled Video Call' : 'Cancelled Voice Call';
                    statusTag = 'Cancelled';
                    subtitle = 'Cancelled before answer';
                    directionBadge = `<span class="msg-call-dir-badge dir-cancelled" title="Cancelled"><svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="3"><polyline points="9 14 4 9 9 4"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/></svg></span>`;
                } else {
                    title = isVideo ? 'Missed Video Call' : 'Missed Voice Call';
                    statusTag = 'Missed';
                    subtitle = 'Caller cancelled';
                    directionBadge = `<span class="msg-call-dir-badge dir-missed" title="Missed Call"><svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="3"><line x1="17" y1="7" x2="7" y2="17"/><polyline points="17 17 7 17 7 7"/></svg></span>`;
                }
            }

            if (isVideo) {
                iconSvg = `<svg class="msg-call-main-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="20" height="20">
                    <polygon points="23 7 16 12 23 17 23 7"/>
                    <rect x="1" y="5" width="15" height="14" rx="3" ry="3"/>
                </svg>`;
            } else {
                iconSvg = `<svg class="msg-call-main-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" width="19" height="19">
                    <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/>
                </svg>`;
            }

            const callBackBtn = `
                <button type="button" class="msg-call-action-pill ${isVideo ? 'btn-trigger-video-call' : 'btn-trigger-audio-call'}" title="${isVideo ? 'Start Video Call' : 'Start Voice Call'}">
                    ${isVideo
                        ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="13" height="13"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg><span>Video</span>`
                        : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" width="13" height="13"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg><span>Call Back</span>`
                    }
                </button>
            `;

            return `
                <div class="msg-call-event-card ${statusClass} ${isVideo ? 'is-video' : 'is-audio'} ${isOut ? 'is-outgoing' : 'is-incoming'}">
                    <div class="msg-call-glow-edge"></div>
                    <div class="msg-call-icon-container">
                        ${status === 'missed' && !isOut ? '<span class="msg-call-pulse-ring"></span>' : ''}
                        <div class="msg-call-icon-inner">
                            ${iconSvg}
                        </div>
                        ${directionBadge}
                    </div>
                    <div class="msg-call-info">
                        <div class="msg-call-headline">
                            <span class="msg-call-title">${escapeHtml(title)}</span>
                            <span class="msg-call-status-badge ${statusClass}">${escapeHtml(statusTag)}</span>
                        </div>
                        <div class="msg-call-meta-line">
                            <span class="msg-call-subtitle">${escapeHtml(subtitle)}</span>
                            ${timeStr ? `<span class="msg-call-time-dot">•</span><span class="msg-call-time-chip">${escapeHtml(timeStr)}</span>` : ''}
                        </div>
                    </div>
                    <div class="msg-call-actions">
                        ${callBackBtn}
                    </div>
                </div>
            `;
        } catch {
            return `<div class="msg-text-content">${escapeHtml(rawText)}</div>`;
        }
    }

    function renderMessageHTML(msg) {
        const isOut = msg.sender === currentUser;
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
        const isCallEvent = !!(msg.text && msg.text.startsWith('__CALL_EVENT__:'));
        if (msg.text) {
            if (isCallEvent) {
                contentHtml += renderCallEventHtml(msg.text, isOut, timeStr);
            } else {
                contentHtml += formatMessageTextHtml(msg.text);
            }
        }

        const reactionsHtml = renderReactionsHtml(msg.reactions, currentUser);
        const canDelete = isOut || currentUser === 'muaj';
        const rowClass = (isOut ? 'msg-row-outgoing' : 'msg-row-incoming') + (isCallEvent ? ' msg-row-call-event' : '');

        return `
            <div class="msg-row ${rowClass}" data-msg-id="${msg.id}" ${isCallEvent ? 'data-is-call="true"' : ''}>
                <div class="msg-action-toolbar">
                    <div class="msg-quick-react-pill">
                        <button type="button" class="msg-react-emoji-btn" data-emoji="❤️">${toAppleEmojiImg('❤️')}</button>
                        <button type="button" class="msg-react-emoji-btn" data-emoji="🔥">${toAppleEmojiImg('🔥')}</button>
                        <button type="button" class="msg-react-emoji-btn" data-emoji="😂">${toAppleEmojiImg('😂')}</button>
                        <button type="button" class="msg-react-emoji-btn" data-emoji="🍿">${toAppleEmojiImg('🍿')}</button>
                    </div>
                    ${!isCallEvent ? `
                    <button type="button" class="msg-action-btn btn-reply" title="Reply to Message" data-reply-id="${msg.id}">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" width="13" height="13"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
                    </button>
                    ` : ''}
                    ${msg.text && !isCallEvent ? `<button type="button" class="msg-action-btn btn-copy" title="Copy Text">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>` : ''}
                    ${canDelete ? `<button type="button" class="msg-action-btn btn-delete" title="Delete Message">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>` : ''}
                </div>
                <div class="msg-bubble-wrap">
                    <div class="msg-bubble ${!msg.video && !msg.voiceUrl && !msg.replyTo && contentHtml.includes('msg-jumbo-') ? 'is-emoji-only-bubble' : ''}">
                        ${renderReplyQuoteHtml(msg.replyTo, currentUser)}
                        ${contentHtml}
                    </div>
                    ${reactionsHtml}
                    ${!isCallEvent ? `
                    <div class="msg-meta-row">
                        <span class="msg-time">${timeStr}</span>
                        ${seenHtml}
                    </div>
                    ` : `
                    <div class="msg-meta-row msg-call-meta-bottom">
                        ${seenHtml}
                    </div>
                    `}
                </div>
            </div>
        `;
    }

    function isScrolledNearBottom(container) {
        if (!container) return true;
        const threshold = 150;
        return (container.scrollHeight - container.scrollTop - container.clientHeight) <= threshold;
    }

    function scrollToBottom(container, smooth = false) {
        if (!container) return;
        requestAnimationFrame(() => {
            if (smooth) {
                container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
            } else {
                container.scrollTop = container.scrollHeight;
            }
        });
    }

    // ------------------------------------------------------------
    //  5. UNREAD BADGES & TOAST SYNCHRONIZER
    // ------------------------------------------------------------
    function updateUnreadBadges(count) {
        State.unreadCount = Math.max(0, parseInt(count, 10) || 0);
        const text = State.unreadCount > 99 ? '99+' : String(State.unreadCount);

        const currentLauncher = document.getElementById('msgFloatingLauncher');
        const currentPill = document.getElementById('msgLauncherUnreadBadge');
        const currentDrawer = document.getElementById('msgDrawerWidget');
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
        const toast = document.getElementById('msgFloatingToast');
        if (!toast || !msg) return;
        const drawer = document.getElementById('msgDrawerWidget');
        const isDrawerOpen = drawer && drawer.classList.contains('is-open');
        if (isDrawerOpen || State.isMessagesPage) return;

        let previewText = 'New message';
        let isCallEvent = false;
        let isVideo = false;

        if (msg.text) {
            if (msg.text.startsWith('__CALL_EVENT__:')) {
                isCallEvent = true;
                try {
                    const data = JSON.parse(msg.text.replace('__CALL_EVENT__:', ''));
                    isVideo = data.callType === 'video';
                    const status = data.status || 'completed';
                    const durationSeconds = Number(data.durationSeconds || 0);
                    const mins = Math.floor(durationSeconds / 60);
                    const secs = durationSeconds % 60;
                    const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;

                    if (status === 'completed') {
                        previewText = isVideo ? `📹 Video call ended • ${durStr}` : `📞 Voice call ended • ${durStr}`;
                    } else if (status === 'rejected') {
                        previewText = isVideo ? '📹 Declined video call' : '📞 Declined voice call';
                    } else if (status === 'cancelled') {
                        previewText = isVideo ? '📹 Cancelled video call' : '📞 Cancelled voice call';
                    } else {
                        previewText = isVideo ? '📹 Missed video call' : '📞 Missed voice call';
                    }
                } catch {
                    previewText = '📞 Call notification';
                }
            } else {
                previewText = msg.text.length > 55 ? msg.text.slice(0, 55) + '…' : msg.text;
            }
        } else if (msg.voiceUrl) {
            previewText = '🎤 Voice note';
        } else if (msg.video) {
            previewText = `🎬 Shared video: ${msg.video.title || 'video'}`;
        }

        const toastText = document.getElementById('msgFloatingToastText');
        if (toastText) {
            toastText.textContent = previewText;
        }

        const toastReply = document.getElementById('msgFloatingToastReply');
        if (toastReply) {
            if (isCallEvent) {
                toastReply.textContent = isVideo ? '📹 Video Back' : '📞 Call Back';
                toastReply.className = `msg-floating-toast-reply-btn ${isVideo ? 'btn-trigger-video-call' : 'btn-trigger-audio-call'}`;
                toastReply.href = '#';
            } else {
                toastReply.textContent = 'Reply';
                toastReply.className = 'msg-floating-toast-reply-btn';
                toastReply.href = '/messages';
            }
        }

        toast.style.display = 'block';
        void toast.offsetWidth; // Force reflow
        toast.classList.add('is-visible');

        clearTimeout(toastDismissTimeout);
        toastDismissTimeout = setTimeout(() => {
            hideFloatingMessageToast();
        }, 6000);
    }

    function hideFloatingMessageToast() {
        const toast = document.getElementById('msgFloatingToast');
        if (!toast) return;
        toast.classList.remove('is-visible');
        clearTimeout(toastDismissTimeout);
        setTimeout(() => {
            if (!toast.classList.contains('is-visible')) {
                toast.style.display = 'none';
            }
        }, 350);
    }

    // ------------------------------------------------------------
    //  6. SIDEBAR STATS & PRESENCE UI
    // ------------------------------------------------------------
    function updateStatsUI(stats) {
        if (!stats) return;
        State.stats = { ...State.stats, ...stats };

        const elTotal = document.getElementById('msgStatTotalMessages');
        const elVideos = document.getElementById('msgStatSharedVideos');
        const elVoice = document.getElementById('msgStatVoiceMessages');
        const elCalls = document.getElementById('msgStatCalls');
        const tabVideos = document.getElementById('msgTabCountVideos');
        const tabVoice = document.getElementById('msgTabCountVoice');
        const tabCalls = document.getElementById('msgTabCountCalls');

        if (elTotal) elTotal.textContent = State.stats.totalMessages || 0;
        if (elVideos) elVideos.textContent = State.stats.sharedVideos || 0;
        if (elVoice) elVoice.textContent = State.stats.voiceMessages || 0;
        if (elCalls) elCalls.textContent = State.stats.totalCalls || 0;
        if (tabVideos) tabVideos.textContent = State.stats.sharedVideos || 0;
        if (tabVoice) tabVoice.textContent = State.stats.voiceMessages || 0;
        if (tabCalls) tabCalls.textContent = State.stats.totalCalls || 0;
    }

    function updatePartnerPresenceUI(presence) {
        if (!presence) return;
        State.partnerPresence = presence;

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

        const watchingBanner = document.getElementById('msgSidebarWatchingBanner');
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
    //  7. DOM MESSAGE INSERTION, DEDUPLICATION & DATE DIVIDERS
    // ------------------------------------------------------------
    function ensureDateDividerForAppend(container, dateStr) {
        if (!container || !dateStr) return;
        const allDividers = container.querySelectorAll('.msg-date-divider');
        const lastDivider = allDividers.length > 0 ? allDividers[allDividers.length - 1] : null;
        const lastDateText = lastDivider ? (lastDivider.getAttribute('data-date') || lastDivider.textContent.trim()) : '';

        if (lastDateText !== dateStr) {
            const div = document.createElement('div');
            div.className = 'msg-date-divider';
            div.setAttribute('data-date', dateStr);
            div.innerHTML = `<span>${escapeHtml(dateStr)}</span>`;
            container.appendChild(div);
        }
    }

    function appendOrUpdateMessage(msg, options = {}) {
        if (!msg || !msg.id) return;

        State.messages.set(msg.id, msg);
        if (msg.id > State.lastKnownId) {
            State.lastKnownId = msg.id;
        }

        const isOut = msg.sender === currentUser;
        const dateStr = formatDateHeader(msg.createdAt);

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
                updateMessageReactionsDOM(msg.id, msg.reactions);
                return;
            }

            const nearBottomBefore = isScrolledNearBottom(container);

            // Remove typing indicator if present
            const typingRow = container.querySelector('.msg-typing-row');
            if (typingRow) typingRow.remove();

            // Ensure date divider for new date
            ensureDateDividerForAppend(container, dateStr);

            // Insert new message row at end
            container.insertAdjacentHTML('beforeend', renderMessageHTML(msg));
            applyActiveFiltersToRow(container.lastElementChild);

            // Only auto-scroll if message is outgoing OR user was already near bottom
            if (isOut || nearBottomBefore || options.forceScroll) {
                scrollToBottom(container, !isOut);
            }
        });
    }

    function applyActiveFiltersToRow(row) {
        if (!row || !row.classList.contains('msg-row')) return;

        let visible = true;
        const tab = State.activeMediaTab || 'all';

        // Media tab filter
        if (tab === 'videos') {
            visible = !!row.querySelector('.msg-video-card');
        } else if (tab === 'voice') {
            visible = !!row.querySelector('.msg-voice-player');
        } else if (tab === 'calls') {
            visible = row.hasAttribute('data-is-call') || !!row.querySelector('.msg-call-event-card');
        }

        // Search keyword filter
        if (visible && State.searchKeyword) {
            const text = (row.innerText || '').toLowerCase();
            visible = text.includes(State.searchKeyword);
        }

        row.style.display = visible ? 'flex' : 'none';
    }

    function applyFiltersToAll() {
        const tab = State.activeMediaTab || 'all';
        const kw = (State.searchKeyword || '').toLowerCase().trim();

        getActiveContainers().forEach(container => {
            const rows = container.querySelectorAll('.msg-row');
            const dateDividers = container.querySelectorAll('.msg-date-divider');

            rows.forEach(row => {
                let matchesTab = true;
                if (tab === 'videos') {
                    matchesTab = !!row.querySelector('.msg-video-card');
                } else if (tab === 'voice') {
                    matchesTab = !!row.querySelector('.msg-voice-player');
                } else if (tab === 'calls') {
                    matchesTab = row.hasAttribute('data-is-call') || !!row.querySelector('.msg-call-event-card');
                }

                let matchesSearch = true;
                if (kw) {
                    const text = (row.innerText || '').toLowerCase();
                    matchesSearch = text.includes(kw);
                }

                const visible = matchesTab && matchesSearch;
                row.style.display = visible ? 'flex' : 'none';
            });

            // Clean up date dividers where all sibling rows until next divider are hidden
            dateDividers.forEach(divider => {
                let next = divider.nextElementSibling;
                let hasVisible = false;
                while (next && !next.classList.contains('msg-date-divider')) {
                    if (next.classList.contains('msg-row') && next.style.display !== 'none') {
                        hasVisible = true;
                        break;
                    }
                    next = next.nextElementSibling;
                }
                divider.style.display = hasVisible ? 'flex' : 'none';
            });
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
                    const drawer = document.getElementById('msgDrawerWidget');
                    if (State.isMessagesPage || (drawer && drawer.classList.contains('is-open'))) {
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
        const container = getFullpageList() || getDrawerList();
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
                    text: textEl ? extractCleanText(textEl) : null,
                    video,
                    videoId: video ? video.id : null,
                    voiceUrl: voicePlayer ? voicePlayer.getAttribute('data-audio-src') : null,
                    replyTo,
                    replyToId: replyTo ? replyTo.id : null,
                    isRead: row.querySelector('.msg-seen-check')?.classList.contains('is-seen') || false
                });
            }
        });

        // Upgrade SSR messages and reactions to WhatsApp emojis
        applyWhatsAppEmojis(container);

        // Set up infinite scroll for loaded containers
        getActiveContainers().forEach(setupInfiniteScroll);
        State.isInitialSyncDone = true;
    }

    // ------------------------------------------------------------
    //  8.5. INFINITE SCROLL & OLDER MESSAGE PAGINATION
    // ------------------------------------------------------------
    function setupInfiniteScroll(container) {
        if (!container || container.dataset.scrollBound === 'true') return;
        container.dataset.scrollBound = 'true';

        let scrollThrottle = false;
        container.addEventListener('scroll', () => {
            if (scrollThrottle) return;
            scrollThrottle = true;
            setTimeout(() => { scrollThrottle = false; }, 60);

            if (container.scrollTop < 120 && !State.isLoadingOlder && State.hasMoreOlder) {
                loadOlderMessages(container);
            }
        }, { passive: true });
    }

    function loadOlderMessages(container) {
        if (State.isLoadingOlder || !State.hasMoreOlder) return;

        const rows = container.querySelectorAll('.msg-row[data-msg-id]');
        if (rows.length === 0) return;

        let oldestId = Infinity;
        rows.forEach(r => {
            const id = parseInt(r.getAttribute('data-msg-id'), 10);
            if (id && id < oldestId) oldestId = id;
        });

        if (oldestId === Infinity) return;

        State.isLoadingOlder = true;
        showOlderLoadingSpinner(container, true);

        fetch(`/api/messages?limit=50&beforeId=${oldestId}`)
            .then(res => res.json())
            .then(data => {
                if (data.success && Array.isArray(data.messages)) {
                    if (data.messages.length < 50) {
                        State.hasMoreOlder = false;
                    }
                    if (data.messages.length > 0) {
                        prependOlderMessages(container, data.messages);
                    }
                } else {
                    State.hasMoreOlder = false;
                }
            })
            .catch(err => {
                console.warn('[messages] Error loading older messages:', err);
            })
            .finally(() => {
                State.isLoadingOlder = false;
                showOlderLoadingSpinner(container, false);
            });
    }

    function showOlderLoadingSpinner(container, show) {
        let spinner = container.querySelector('.msg-older-loading');
        if (show) {
            if (!spinner) {
                spinner = document.createElement('div');
                spinner.className = 'msg-older-loading is-active';
                spinner.innerHTML = `<span class="msg-older-spinner"></span><span>Loading history...</span>`;
                container.insertBefore(spinner, container.firstElementChild);
            } else {
                spinner.classList.add('is-active');
            }
        } else {
            if (spinner) spinner.classList.remove('is-active');
        }
    }

    function prependOlderMessages(container, messages) {
        if (!container || !messages || messages.length === 0) return;

        const prevScrollHeight = container.scrollHeight;
        const prevScrollTop = container.scrollTop;

        const spinner = container.querySelector('.msg-older-loading');
        const insertTarget = spinner ? spinner.nextSibling : container.firstChild;

        const fragment = document.createDocumentFragment();
        let curDate = '';

        messages.forEach(msg => {
            State.messages.set(msg.id, msg);
            const dateStr = formatDateHeader(msg.createdAt);
            if (dateStr && dateStr !== curDate) {
                curDate = dateStr;
                const div = document.createElement('div');
                div.className = 'msg-date-divider';
                div.setAttribute('data-date', dateStr);
                div.innerHTML = `<span>${escapeHtml(dateStr)}</span>`;
                fragment.appendChild(div);
            }

            const temp = document.createElement('div');
            temp.innerHTML = renderMessageHTML(msg);
            const rowEl = temp.firstElementChild;
            if (rowEl) {
                applyActiveFiltersToRow(rowEl);
                fragment.appendChild(rowEl);
            }
        });

        // If the top existing date divider matches the last date of prepended batch, remove duplicate
        const existingFirstDivider = container.querySelector('.msg-date-divider');
        if (existingFirstDivider && existingFirstDivider.getAttribute('data-date') === curDate) {
            existingFirstDivider.remove();
        }

        if (insertTarget) {
            container.insertBefore(fragment, insertTarget);
        } else {
            container.appendChild(fragment);
        }

        // Strictly preserve scroll position across layout recalculations
        const newScrollHeight = container.scrollHeight;
        const delta = newScrollHeight - prevScrollHeight;
        container.scrollTop = prevScrollTop + delta;
        requestAnimationFrame(() => {
            if (Math.abs(container.scrollTop - (prevScrollTop + delta)) > 2) {
                container.scrollTop = prevScrollTop + (container.scrollHeight - prevScrollHeight);
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

                    const drawer = document.getElementById('msgDrawerWidget');
                    const isDrawerOpen = drawer && drawer.classList.contains('is-open');
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
                // Update in-memory state
                State.messages.forEach(m => {
                    if (m.sender === currentUser) m.isRead = true;
                });
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
                    const nearBottom = isScrolledNearBottom(container);
                    container.appendChild(typingRow);
                    if (nearBottom) {
                        scrollToBottom(container, true);
                    }
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
                            prependOlderMessages(container, data.messages);
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

    function openMobileActionSheet(msgObj) {
        const mobileBackdrop = document.getElementById('msgMobileActionsBackdrop');
        const mobileSheet = document.getElementById('msgMobileActionsSheet');
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
        const mobileBackdrop = document.getElementById('msgMobileActionsBackdrop');
        if (!mobileBackdrop) return;
        mobileBackdrop.classList.remove('is-open');
        setTimeout(() => {
            if (!mobileBackdrop.classList.contains('is-open')) {
                mobileBackdrop.style.display = 'none';
            }
        }, 250);
    }

    // Delegated mobile actions sheet click
    document.addEventListener('click', (e) => {
        const mobileBackdrop = document.getElementById('msgMobileActionsBackdrop');
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

    // ------------------------------------------------------------
    //  10.7. TOUCH GESTURES: LONG-PRESS ACTION SHEET & SWIPE-TO-REPLY
    // ------------------------------------------------------------
    let hasTriggeredSwipeHaptic = false;

    document.addEventListener('touchstart', (e) => {
        const row = e.target.closest('.msg-row');
        if (!row) return;

        // Skip interactive elements
        if (e.target.closest('button, a, .msg-quote-card, .msg-voice-control-btn, .msg-reaction-badge')) return;

        const touch = e.touches[0];
        touchStartX = touch.clientX;
        touchStartY = touch.clientY;
        swipedRow = row;
        hasTriggeredSwipeHaptic = false;

        const msgId = parseInt(row.getAttribute('data-msg-id'), 10);
        const msgObj = State.messages.get(msgId) || {
            id: msgId,
            sender: row.classList.contains('msg-row-outgoing') ? currentUser : partnerUser,
            text: row.querySelector('.msg-text-content')?.innerText || null
        };

        touchTimer = setTimeout(() => {
            if (navigator.vibrate) {
                try { navigator.vibrate(30); } catch {}
            }
            openMobileActionSheet(msgObj);
            touchTimer = null;
            swipedRow = null;
        }, 480);
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

        // Cancel long press on movement
        if (Math.abs(dx) > 10 || Math.abs(dy) > 10) {
            clearTimeout(touchTimer);
            touchTimer = null;
        }

        // Swipe right to reply (WhatsApp/Telegram style)
        if (dx > 10 && Math.abs(dx) > Math.abs(dy) * 1.15) {
            const bubbleWrap = swipedRow.querySelector('.msg-bubble-wrap') || swipedRow;
            const dragDistance = Math.min(dx * 0.48, 68);
            
            // Ensure swipe hint icon exists
            let hint = swipedRow.querySelector('.msg-swipe-reply-hint');
            if (!hint) {
                hint = document.createElement('div');
                hint.className = 'msg-swipe-reply-hint';
                hint.innerHTML = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>`;
                swipedRow.appendChild(hint);
            }

            swipedRow.classList.add('is-swiping');
            bubbleWrap.style.transform = `translateX(${dragDistance}px)`;
            bubbleWrap.style.transition = 'none';

            // Positioning hint icon
            hint.style.left = `${Math.min(dx * 0.35, 36) - 34}px`;

            if (dragDistance >= 40) {
                if (!swipedRow.classList.contains('is-swipe-ready')) {
                    swipedRow.classList.add('is-swipe-ready');
                    if (!hasTriggeredSwipeHaptic && navigator.vibrate) {
                        hasTriggeredSwipeHaptic = true;
                        try { navigator.vibrate(14); } catch {}
                    }
                }
            } else {
                swipedRow.classList.remove('is-swipe-ready');
                hasTriggeredSwipeHaptic = false;
            }
        }
    }, { passive: true });

    function resetSwipedRow(row) {
        if (!row) return;
        const bubbleWrap = row.querySelector('.msg-bubble-wrap') || row;
        bubbleWrap.style.transition = 'transform 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)';
        bubbleWrap.style.transform = '';
        row.classList.remove('is-swiping', 'is-swipe-ready');
        setTimeout(() => {
            bubbleWrap.style.transition = '';
            const hint = row.querySelector('.msg-swipe-reply-hint');
            if (hint) hint.remove();
        }, 300);
    }

    document.addEventListener('touchend', () => {
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

            resetSwipedRow(swipedRow);

            if (wasReady && msgObj) {
                setReplyMessage(msgObj);
            }
            swipedRow = null;
        }
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
        clearTimeout(touchTimer);
        touchTimer = null;
        if (swipedRow) {
            resetSwipedRow(swipedRow);
            swipedRow = null;
        }
    }, { passive: true });

    // ------------------------------------------------------------
    //  11. SENDING MESSAGES & INTERACTIONS (Double-Send Protected)
    // ------------------------------------------------------------
    function sendMessage(text, videoId = null) {
        const cleanText = (text || '').trim();
        if (!cleanText && !videoId) return;
        if (State.isSending) return; // Prevent duplicate rapid sends
        State.isSending = true;

        const replyToId = State.replyToMessage ? State.replyToMessage.id : null;
        cancelReply();
        closeWhatsAppEmojiPicker();

        const sendBtns = document.querySelectorAll('.msg-send-btn');
        sendBtns.forEach(btn => { btn.style.opacity = '0.6'; btn.disabled = true; });

        fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanText, videoId, replyToId })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success && data.message) {
                appendOrUpdateMessage(data.message, { forceScroll: true });
                if (data.stats) updateStatsUI(data.stats);
                sendTypingState(false);
            }
        })
        .catch(err => console.error('[messages] Send failed:', err))
        .finally(() => {
            State.isSending = false;
            sendBtns.forEach(btn => { btn.style.opacity = ''; btn.disabled = false; });
        });
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
    //  12. VOICE RECORDING (MediaRecorder API with Track Cleanup)
    // ------------------------------------------------------------
    let mediaRecorder = null;
    let audioChunks = [];
    let recordInterval = null;
    let recordSeconds = 0;
    let activeMicrophoneStream = null;

    function cleanupMicrophoneStream() {
        if (activeMicrophoneStream) {
            activeMicrophoneStream.getTracks().forEach(track => {
                try { track.stop(); } catch {}
            });
            activeMicrophoneStream = null;
        }
    }

    function setupVoiceRecording(recordBtn, recordingBar, cancelBtn, sendVoiceBtn) {
        if (!recordBtn || !recordingBar) return;

        const composerWrap = recordingBar.closest('.msg-composer-wrap');

        function endVoiceRecordingState() {
            if (composerWrap) composerWrap.classList.remove('is-voice-recording');
            recordingBar.classList.remove('is-recording');
            recordingBar.style.display = 'none';
            const idleLabel = recordingBar.querySelector('.msg-rec-label');
            const activeLabel = recordingBar.querySelector('.msg-rec-active-label');
            if (idleLabel) idleLabel.style.display = '';
            if (activeLabel) activeLabel.style.display = 'none';
            
            // Re-evaluate button visibility
            const textarea = composerWrap ? composerWrap.querySelector('.msg-textarea') : null;
            const sendBtn = composerWrap ? composerWrap.querySelector('.msg-send-btn') : null;
            const hasText = textarea && textarea.value.trim().length > 0;
            if (sendBtn) sendBtn.style.display = hasText ? 'inline-flex' : 'none';
            if (recordBtn) recordBtn.style.display = hasText ? 'none' : 'inline-flex';
        }

        recordBtn.addEventListener('click', async () => {
            try {
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
                activeMicrophoneStream = stream;
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];

                mediaRecorder.ondataavailable = (e) => {
                    if (e.data.size > 0) audioChunks.push(e.data);
                };

                mediaRecorder.onstop = () => {
                    cleanupMicrophoneStream();
                };

                mediaRecorder.start();
                recordSeconds = 0;
                if (composerWrap) composerWrap.classList.add('is-voice-recording');
                recordingBar.classList.add('is-recording');
                recordingBar.style.display = 'flex';
                const idleLabel = recordingBar.querySelector('.msg-rec-label');
                const activeLabel = recordingBar.querySelector('.msg-rec-active-label');
                if (idleLabel) idleLabel.style.display = 'none';
                if (activeLabel) activeLabel.style.display = '';
                const timerEl = recordingBar.querySelector('.msg-rec-timer');
                if (timerEl) timerEl.textContent = '0:00';

                clearInterval(recordInterval);
                recordInterval = setInterval(() => {
                    recordSeconds++;
                    const m = Math.floor(recordSeconds / 60);
                    const s = recordSeconds % 60;
                    if (timerEl) timerEl.textContent = `${m}:${s < 10 ? '0' : ''}${s}`;
                }, 1000);
            } catch {
                alert('Microphone access was denied or is not supported in this browser.');
            }
        });

        if (cancelBtn) {
            cancelBtn.addEventListener('click', () => {
                if (mediaRecorder && mediaRecorder.state !== 'inactive') {
                    try { mediaRecorder.stop(); } catch {}
                }
                cleanupMicrophoneStream();
                clearInterval(recordInterval);
                audioChunks = [];
                endVoiceRecordingState();
            });
        }

        if (sendVoiceBtn) {
            sendVoiceBtn.addEventListener('click', () => {
                if (!mediaRecorder || mediaRecorder.state === 'inactive') return;

                mediaRecorder.onstop = () => {
                    cleanupMicrophoneStream();
                    clearInterval(recordInterval);
                    endVoiceRecordingState();

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
                            appendOrUpdateMessage(data.message, { forceScroll: true });
                            if (data.stats) updateStatsUI(data.stats);
                        }
                    })
                    .catch(err => console.error('[messages] Voice send failed:', err));
                };

                try {
                    mediaRecorder.stop();
                } catch {
                    cleanupMicrophoneStream();
                    endVoiceRecordingState();
                }
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
                const cleanText = extractCleanText(textEl);
                navigator.clipboard.writeText(cleanText).then(() => {
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
            return;
        }

        // 5. Drawer Close Button
        const drawerClose = e.target.closest('#msgDrawerCloseBtn');
        if (drawerClose) {
            const drawer = document.getElementById('msgDrawerWidget');
            const launcher = document.getElementById('msgFloatingLauncher');
            if (drawer) drawer.classList.remove('is-open');
            if (launcher) launcher.classList.remove('is-open');
            return;
        }

        // 6. In-Chat Search Bar Toggle & Close
        const searchToggle = e.target.closest('#msgSearchToggleBtn');
        if (searchToggle) {
            const searchBar = document.getElementById('msgInChatSearchBar');
            const searchInput = document.getElementById('msgInChatSearchInput');
            if (searchBar) {
                const isOpen = searchBar.classList.toggle('is-open');
                if (isOpen && searchInput) {
                    searchInput.value = '';
                    searchInput.focus();
                } else {
                    State.searchKeyword = '';
                    applyFiltersToAll();
                }
            }
            return;
        }

        const searchClose = e.target.closest('#msgInChatSearchClose');
        if (searchClose) {
            const searchBar = document.getElementById('msgInChatSearchBar');
            const searchInput = document.getElementById('msgInChatSearchInput');
            if (searchBar) searchBar.classList.remove('is-open');
            if (searchInput) searchInput.value = '';
            State.searchKeyword = '';
            applyFiltersToAll();
            return;
        }
    });

    // In-chat search input handler
    document.addEventListener('input', (e) => {
        if (e.target && e.target.id === 'msgInChatSearchInput') {
            State.searchKeyword = e.target.value.toLowerCase().trim();
            applyFiltersToAll();
        }
    });

    // ------------------------------------------------------------
    //  14.5. WHATSAPP EMOJI PICKER CONTROLLER
    // ------------------------------------------------------------
    let activeEmojiPicker = null;
    let activeEmojiTargetTextarea = null;

    function createWhatsAppEmojiPicker() {
        const picker = document.createElement('div');
        picker.className = 'wa-emoji-picker';
        picker.id = 'waEmojiPicker';
        picker.innerHTML = `
            <div class="wa-picker-header">
                <div class="wa-picker-tabs">
                    <button type="button" class="wa-tab-btn active" data-cat="smileys" title="Smileys & Emotion">
                        <span>${toAppleEmojiImg('😀')}</span>
                    </button>
                    <button type="button" class="wa-tab-btn" data-cat="love" title="Love & Gestures">
                        <span>${toAppleEmojiImg('❤️')}</span>
                    </button>
                    <button type="button" class="wa-tab-btn" data-cat="fun" title="Cinema & Media">
                        <span>${toAppleEmojiImg('🍿')}</span>
                    </button>
                    <button type="button" class="wa-tab-btn" data-cat="party" title="Party & Objects">
                        <span>${toAppleEmojiImg('🔥')}</span>
                    </button>
                </div>
            </div>
            <div class="wa-picker-body">
                <div class="wa-picker-grid" id="waPickerGrid"></div>
            </div>
        `;

        // Render category tab switching
        const tabBtns = picker.querySelectorAll('.wa-tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const cat = btn.getAttribute('data-cat');
                renderPickerCategory(picker, cat);
            });
        });

        // Delegate emoji click
        picker.addEventListener('click', (e) => {
            const emojiBtn = e.target.closest('.wa-picker-item');
            if (emojiBtn && activeEmojiTargetTextarea) {
                e.stopPropagation();
                const emoji = emojiBtn.getAttribute('data-emoji');
                insertEmojiAtCursor(activeEmojiTargetTextarea, emoji);
            }
        });

        // Render initial smileys category
        renderPickerCategory(picker, 'smileys');

        return picker;
    }

    function renderPickerCategory(pickerEl, categoryKey) {
        const grid = pickerEl.querySelector('#waPickerGrid');
        if (!grid) return;
        const catData = WA_EMOJI_CATEGORIES[categoryKey] || WA_EMOJI_CATEGORIES.smileys;
        const itemsHtml = catData.emojis.map(em => {
            const emojiMarkup = State.isMessagesPage ? escapeHtml(em) : toAppleEmojiImg(em);
            return `<button type="button" class="wa-picker-item" data-emoji="${escapeHtml(em)}" title="${escapeHtml(em)}">${emojiMarkup}</button>`;
        }).join('');
        grid.innerHTML = itemsHtml;
    }

    function insertEmojiAtCursor(textarea, emoji) {
        if (!textarea) return;
        const start = textarea.selectionStart ?? textarea.value.length;
        const end = textarea.selectionEnd ?? textarea.value.length;
        const val = textarea.value;
        textarea.value = val.substring(0, start) + emoji + val.substring(end);
        const newPos = start + emoji.length;
        textarea.focus();
        textarea.setSelectionRange(newPos, newPos);
        textarea.style.height = 'auto';
        textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    }

    function toggleWhatsAppEmojiPicker(formOrWrap, textarea) {
        if (!activeEmojiPicker) {
            activeEmojiPicker = createWhatsAppEmojiPicker();
        }

        if (activeEmojiPicker.parentElement === formOrWrap && activeEmojiPicker.classList.contains('is-open')) {
            closeWhatsAppEmojiPicker();
            return;
        }

        activeEmojiTargetTextarea = textarea;
        formOrWrap.appendChild(activeEmojiPicker);
        // Force reflow for smooth animation
        void activeEmojiPicker.offsetWidth;
        activeEmojiPicker.classList.add('is-open');
    }

    function closeWhatsAppEmojiPicker() {
        if (activeEmojiPicker && activeEmojiPicker.classList.contains('is-open')) {
            activeEmojiPicker.classList.remove('is-open');
            setTimeout(() => {
                if (activeEmojiPicker && !activeEmojiPicker.classList.contains('is-open')) {
                    if (activeEmojiPicker.parentElement) {
                        activeEmojiPicker.parentElement.removeChild(activeEmojiPicker);
                    }
                }
            }, 200);
        }
    }

    // Close picker on outside click or Escape
    document.addEventListener('click', (e) => {
        if (activeEmojiPicker && activeEmojiPicker.classList.contains('is-open')) {
            if (!e.target.closest('.wa-emoji-picker') && !e.target.closest('.msg-emoji-toggle-btn')) {
                closeWhatsAppEmojiPicker();
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && activeEmojiPicker && activeEmojiPicker.classList.contains('is-open')) {
            closeWhatsAppEmojiPicker();
        }
    });

    // ------------------------------------------------------------
    //  15. COMPOSER SETUP (Idempotent per DOM element)
    // ------------------------------------------------------------
    function setupComposer(formOrWrap) {
        if (!formOrWrap) return;
        if (formOrWrap.dataset.composerBound === 'true') return;
        formOrWrap.dataset.composerBound = 'true';

        const textarea = formOrWrap.querySelector('.msg-textarea');
        const sendBtn = formOrWrap.querySelector('.msg-send-btn');
        const recordBtn = formOrWrap.querySelector('.msg-mic-btn');
        const emojiToggleBtn = formOrWrap.querySelector('.msg-emoji-toggle-btn');
        const emojiBtns = formOrWrap.querySelectorAll('.msg-quick-emoji-btn');
        const attachBtn = formOrWrap.querySelector('.msg-attach-btn');
        const attachModal = formOrWrap.querySelector('.msg-attach-video-modal');

        function updateComposerControls() {
            const hasText = !!(textarea && textarea.value.trim().length > 0);
            if (sendBtn) {
                sendBtn.style.display = hasText ? 'inline-flex' : 'none';
            }
            if (recordBtn) {
                recordBtn.style.display = hasText ? 'none' : 'inline-flex';
            }
        }

        // Initialize button visibility
        updateComposerControls();

        // WhatsApp Emoji Picker Toggle
        if (emojiToggleBtn && textarea) {
            if (typeof window.attachWhatsAppEmojiPicker === 'function') {
                window.attachWhatsAppEmojiPicker(emojiToggleBtn, textarea);
            } else {
                emojiToggleBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    toggleWhatsAppEmojiPicker(formOrWrap, textarea);
                });
            }
        }

        if (textarea) {
            textarea.addEventListener('input', () => {
                textarea.style.height = 'auto';
                textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px';
                updateComposerControls();

                sendTypingState(true);
                clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                    sendTypingState(false);
                }, 2500);
            });

            textarea.addEventListener('focus', () => {
                setTimeout(() => {
                    getActiveContainers().forEach(c => {
                        if (isScrolledNearBottom(c)) scrollToBottom(c);
                    });
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
                    if (!text.trim() && !State.isSending) return;
                    textarea.value = '';
                    textarea.style.height = 'auto';
                    updateComposerControls();
                    sendMessage(text);
                }
            });
        }

        if (sendBtn && textarea) {
            sendBtn.addEventListener('click', () => {
                const text = textarea.value;
                if (!text.trim() && !State.isSending) return;
                textarea.value = '';
                textarea.style.height = 'auto';
                updateComposerControls();
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
                const isOpen = attachModal.classList.toggle('is-open');
                attachBtn.setAttribute('aria-expanded', String(isOpen));
                const searchInput = attachModal.querySelector('.msg-attach-search-input');
                if (isOpen && searchInput) {
                    searchInput.value = '';
                    searchInput.focus({ preventScroll: true });
                    filterAttachList(attachModal, '');
                }
            });

            document.addEventListener('click', (e) => {
                if (!attachModal.contains(e.target) && e.target !== attachBtn) {
                    attachModal.classList.remove('is-open');
                    attachBtn.setAttribute('aria-expanded', 'false');
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
                        attachBtn.setAttribute('aria-expanded', 'false');
                    }
                });
            });
        }

        // Voice Recording Setup
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
    //  16. SHARED MEDIA TABS IN SIDEBAR
    // ------------------------------------------------------------
    document.addEventListener('click', (e) => {
        const tabBtn = e.target.closest('.msg-media-tab-btn');
        if (tabBtn) {
            document.querySelectorAll('.msg-media-tab-btn').forEach(b => b.classList.remove('is-active'));
            tabBtn.classList.add('is-active');
            State.activeMediaTab = tabBtn.getAttribute('data-tab') || 'all';
            applyFiltersToAll();
        }
    });

    // ------------------------------------------------------------
    //  17. FLOATING TOAST & LAUNCHER INTERACTIONS
    // ------------------------------------------------------------
    document.addEventListener('click', (e) => {
        const toast = document.getElementById('msgFloatingToast');
        if (toast && toast.contains(e.target)) {
            if (e.target.closest('#msgFloatingToastClose') || e.target.closest('.msg-floating-toast-close-btn')) {
                hideFloatingMessageToast();
                return;
            }
            hideFloatingMessageToast();
            window.location.href = '/messages';
        }
    });

    // ------------------------------------------------------------
    //  18. GLOBAL VIDEO SHARE BUTTON ("Share to Chat" on /watch/:id)
    // ------------------------------------------------------------
    document.addEventListener('click', (e) => {
        const shareToChatBtn = e.target.closest('#btnShareToChat');
        if (shareToChatBtn) {
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
        }
    });

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
            const mobileBackdrop = document.getElementById('msgMobileActionsBackdrop');
            if (mobileBackdrop && mobileBackdrop.classList.contains('is-open')) {
                closeMobileActionSheet();
                return;
            }
            const details = document.getElementById('msgConversationDetails');
            if (details?.classList.contains('is-open')) {
                setConversationDetailsOpen(false);
                return;
            }
            const openAttachment = document.querySelector('.msg-attach-video-modal.is-open');
            if (openAttachment) {
                openAttachment.classList.remove('is-open');
                openAttachment.closest('.msg-composer-wrap')?.querySelector('.msg-attach-btn')?.setAttribute('aria-expanded', 'false');
                return;
            }
            if (State.replyToMessage) {
                cancelReply();
                return;
            }
        }
    });

    // ------------------------------------------------------------
    //  18.5. ANDROID RESPONSIVE SHEETS & VIEWPORT
    // ------------------------------------------------------------
    function setConversationDetailsOpen(isOpen) {
        const details = document.getElementById('msgConversationDetails');
        const backdrop = document.getElementById('msgDetailsBackdrop');
        const toggle = document.getElementById('msgDetailsToggleBtn');
        if (!details || !backdrop) return;

        details.classList.toggle('is-open', isOpen);
        backdrop.classList.toggle('is-open', isOpen);
        if (toggle) toggle.setAttribute('aria-expanded', String(isOpen));
        document.body.classList.toggle('msg-sheet-open', isOpen);

        if (isOpen) {
            details.querySelector('#msgDetailsCloseBtn')?.focus({ preventScroll: true });
        } else if (toggle && window.innerWidth < 960) {
            toggle.focus({ preventScroll: true });
        }
    }

    document.addEventListener('click', (e) => {
        if (e.target.closest('#msgDetailsToggleBtn')) {
            const details = document.getElementById('msgConversationDetails');
            setConversationDetailsOpen(!details?.classList.contains('is-open'));
            return;
        }
        if (e.target.closest('#msgDetailsCloseBtn') || e.target.closest('#msgDetailsBackdrop')) {
            setConversationDetailsOpen(false);
        }
    });

    let viewportFrame = 0;
    function syncMessagingViewport() {
        if (!State.isMessagesPage) return;
        cancelAnimationFrame(viewportFrame);
        viewportFrame = requestAnimationFrame(() => {
            const viewportHeight = window.visualViewport?.height || window.innerHeight;
            document.body.style.setProperty('--msg-app-height', `${Math.round(viewportHeight)}px`);
        });
    }

    syncMessagingViewport();
    window.addEventListener('resize', () => {
        syncMessagingViewport();
        if (window.innerWidth >= 960) setConversationDetailsOpen(false);
    }, { passive: true });

    // ------------------------------------------------------------
    //  19. LIFECYCLE, BFCACHE & NAVIGATION LISTENERS
    // ------------------------------------------------------------
    // Initialize Composers
    document.querySelectorAll('.msg-composer-wrap').forEach(setupComposer);

    // Ingest SSR messages & upgrade all emojis
    ingestSSRMessages();
    applyWhatsAppEmojis(document.body);

    // Initial Auto-scroll
    getActiveContainers().forEach(c => scrollToBottom(c));

    // Initial Unread Count Sync from DOM
    const initialBadge = document.getElementById('msgLauncherUnreadBadge') || document.querySelector('.nav-msg-badge');
    if (initialBadge && initialBadge.textContent) {
        updateUnreadBadges(parseInt(initialBadge.textContent, 10) || 0);
    }

    // Start Real-Time SSE Stream
    initSSE();

    // Initialize Push Notifications after SSE is set up
    initPushNotifications();

    // ------------------------------------------------------------
    //  20. WEB PUSH NOTIFICATION MANAGER
    // ------------------------------------------------------------
    function initPushNotifications() {
        // Check browser support
        if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
            return;
        }

        // Already granted — silently subscribe without prompting
        if (Notification.permission === 'granted') {
            subscribeToPush();
            return;
        }

        // Denied — nothing we can do, messaging works fine without push
        if (Notification.permission === 'denied') {
            return;
        }

        // Default (not yet decided) — show a non-intrusive prompt
        if (sessionStorage.getItem('pushPromptShown')) {
            return;
        }

        setTimeout(() => {
            showPushPermissionBanner();
        }, 5000);
    }

    function showPushPermissionBanner() {
        if (!currentUser) return;
        if (document.getElementById('pushPermBanner')) return;

        sessionStorage.setItem('pushPromptShown', '1');

        const partnerDisplay = partnerUser === 'muaj' ? 'Muaj' : 'Hajera';
        const banner = document.createElement('div');
        banner.id = 'pushPermBanner';
        banner.style.cssText = `
            position: fixed;
            bottom: 80px;
            left: 50%;
            transform: translateX(-50%);
            z-index: 99999;
            background: linear-gradient(135deg, rgba(20, 22, 35, 0.97), rgba(30, 34, 55, 0.97));
            border: 1px solid rgba(120, 130, 255, 0.25);
            border-radius: 16px;
            padding: 16px 20px;
            max-width: 360px;
            width: calc(100% - 32px);
            box-shadow: 0 12px 40px rgba(0,0,0,0.5), 0 0 60px rgba(100, 110, 255, 0.08);
            backdrop-filter: blur(20px);
            -webkit-backdrop-filter: blur(20px);
            display: flex;
            flex-direction: column;
            gap: 12px;
            animation: pushBannerSlideUp 0.4s cubic-bezier(0.16, 1, 0.3, 1);
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        `;

        banner.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px;">
                <div style="width:36px; height:36px; border-radius:10px; background:linear-gradient(135deg, #6366f1, #8b5cf6); display:flex; align-items:center; justify-content:center; flex-shrink:0;">
                    <span style="font-size:18px;">🔔</span>
                </div>
                <div style="flex:1; min-width:0;">
                    <div style="font-size:13.5px; font-weight:600; color:#e2e4f0; line-height:1.3;">
                        Get notified when ${escapeHtml(partnerDisplay)} messages you
                    </div>
                    <div style="font-size:12px; color:#8b8fa8; margin-top:2px; line-height:1.3;">
                        Even when this tab is closed
                    </div>
                </div>
            </div>
            <div style="display:flex; gap:8px; justify-content:flex-end;">
                <button type="button" id="pushPermDismiss" style="
                    background: transparent;
                    border: 1px solid rgba(255,255,255,0.1);
                    color: #8b8fa8;
                    padding: 7px 16px;
                    border-radius: 8px;
                    font-size: 12.5px;
                    font-weight: 500;
                    cursor: pointer;
                    transition: all 0.2s;
                ">Not now</button>
                <button type="button" id="pushPermEnable" style="
                    background: linear-gradient(135deg, #6366f1, #8b5cf6);
                    border: none;
                    color: #fff;
                    padding: 7px 18px;
                    border-radius: 8px;
                    font-size: 12.5px;
                    font-weight: 600;
                    cursor: pointer;
                    transition: all 0.2s;
                    box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
                ">Enable</button>
            </div>
        `;

        document.body.appendChild(banner);

        document.getElementById('pushPermDismiss').addEventListener('click', () => {
            banner.style.opacity = '0';
            banner.style.transform = 'translateX(-50%) translateY(20px)';
            banner.style.transition = 'all 0.3s ease';
            setTimeout(() => banner.remove(), 300);
        });

        document.getElementById('pushPermEnable').addEventListener('click', () => {
            banner.style.opacity = '0';
            banner.style.transform = 'translateX(-50%) translateY(20px)';
            banner.style.transition = 'all 0.3s ease';
            setTimeout(() => banner.remove(), 300);
            requestPushPermission();
        });
    }

    async function requestPushPermission() {
        try {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                await subscribeToPush();
            }
        } catch (err) {
            console.warn('[push] Permission request failed:', err);
        }
    }

    async function subscribeToPush() {
        try {
            let reg = window.__swRegistration;
            if (!reg) {
                reg = await navigator.serviceWorker.ready;
            }

            let subscription = await reg.pushManager.getSubscription();

            if (!subscription) {
                const resp = await fetch('/api/push/vapid-public-key', {
                    credentials: 'same-origin'
                });
                if (!resp.ok) return;
                const { publicKey } = await resp.json();
                if (!publicKey) return;

                const applicationServerKey = urlBase64ToUint8Array(publicKey);

                subscription = await reg.pushManager.subscribe({
                    userVisibleOnly: true,
                    applicationServerKey
                });
            }

            await fetch('/api/push/subscribe', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                credentials: 'same-origin',
                body: JSON.stringify({
                    subscription: {
                        endpoint: subscription.endpoint,
                        keys: {
                            p256dh: arrayBufferToBase64(subscription.getKey('p256dh')),
                            auth: arrayBufferToBase64(subscription.getKey('auth'))
                        }
                    }
                })
            });
        } catch (err) {
            console.warn('[push] Subscription failed:', err);
        }
    }

    function urlBase64ToUint8Array(base64String) {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; i++) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    }

    function arrayBufferToBase64(buffer) {
        if (!buffer) return '';
        const bytes = new Uint8Array(buffer);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }

    // Reconcile and reconnect on page restoration from bfcache
    window.addEventListener('pageshow', (event) => {
        if (event.persisted) {
            if (sseSource) { sseSource.close(); sseSource = null; }
            initSSE();
        }
    });

    // Reconcile on tab visibility change
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            initSSE();
            syncState();
        }
    });

    // Cleanup on page unload or navigation
    function cleanupSSEOnNav() {
        if (sseSource) {
            sseSource.close();
            sseSource = null;
        }
    }
    window.addEventListener('beforeunload', cleanupSSEOnNav);
    window.addEventListener('pagehide', cleanupSSEOnNav);

    // Mobile Virtual Keyboard Scroll Adjuster
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            if (State.isMessagesPage) {
                syncMessagingViewport();
                setTimeout(() => {
                    getActiveContainers().forEach(c => {
                        if (isScrolledNearBottom(c)) scrollToBottom(c);
                    });
                }, 100);
            }
        }, { passive: true });
    }

    // SPA Navigation Handler
    window.addEventListener('page:navigate', () => {
        const isMessagesNow = !!document.getElementById('msgFullpageList') || document.body.getAttribute('data-page') === 'messages';
        State.isMessagesPage = isMessagesNow;
        syncMessagingViewport();

        // Re-setup composers in newly swapped DOM
        document.querySelectorAll('.msg-composer-wrap').forEach(setupComposer);

        if (isMessagesNow) {
            const launcher = document.getElementById('msgFloatingLauncher');
            if (launcher) launcher.style.display = 'none';
            ingestSSRMessages();
            getActiveContainers().forEach(c => scrollToBottom(c));
            markMessagesAsRead();
        } else {
            const launcher = document.getElementById('msgFloatingLauncher');
            if (launcher) {
                launcher.style.display = State.unreadCount > 0 ? 'flex' : 'none';
            }
        }
    });

})();
