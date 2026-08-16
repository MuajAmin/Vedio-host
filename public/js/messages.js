// ============================================================
//  MESSAGES SYSTEM — CLIENT-SIDE REAL-TIME CONTROLLER
//  Handles SSE stream, audio chime, typing, voice notes & UI
// ============================================================

(function () {
    let sseSource = null;
    let currentUser = document.body.getAttribute('data-user') || '';
    if (!currentUser) return; // Not logged in

    const partnerUser = currentUser === 'muaj' ? 'hajera' : 'muaj';
    let typingTimeout = null;
    let isCurrentlyTyping = false;
    let mediaRecorder = null;
    let audioChunks = [];
    let recordInterval = null;
    let recordSeconds = 0;

    // Web Audio Context for synthesized notification sound
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
        } catch (e) {
            // Audio not allowed or failed
        }
    }

    // ------------------------------------------------------------
    //  1. DOM ELEMENTS
    // ------------------------------------------------------------
    const launcher = document.getElementById('msgFloatingLauncher');
    const drawer = document.getElementById('msgDrawerWidget');
    const closeBtn = document.getElementById('msgDrawerCloseBtn');
    const unreadPill = document.getElementById('msgLauncherUnreadBadge');
    const navMsgBadges = document.querySelectorAll('.nav-msg-badge');
    const fullPageMessagesList = document.getElementById('msgFullpageList');
    const drawerMessagesList = document.getElementById('msgDrawerList');

    function getActiveContainers() {
        const list = [];
        if (drawerMessagesList) list.push(drawerMessagesList);
        if (fullPageMessagesList) list.push(fullPageMessagesList);
        return list;
    }

    // ------------------------------------------------------------
    //  2. UNREAD BADGE SYNCHRONIZER
    // ------------------------------------------------------------
    function updateUnreadBadges(count) {
        const num = Math.max(0, parseInt(count, 10) || 0);
        if (unreadPill) {
            if (num > 0) {
                unreadPill.textContent = num > 99 ? '99+' : num;
                unreadPill.style.display = 'flex';
            } else {
                unreadPill.style.display = 'none';
            }
        }
        navMsgBadges.forEach(badge => {
            if (num > 0) {
                badge.textContent = num > 99 ? '99+' : num;
                badge.style.display = 'flex';
            } else {
                badge.style.display = 'none';
            }
        });
    }

    // ------------------------------------------------------------
    //  3. SSE REAL-TIME CONNECTION
    // ------------------------------------------------------------
    function initSSE() {
        if (sseSource) {
            sseSource.close();
        }

        sseSource = new EventSource('/messages/stream');

        sseSource.addEventListener('connected', (e) => {
            try {
                const data = JSON.parse(e.data);
                if (typeof data.unreadCount === 'number') {
                    updateUnreadBadges(data.unreadCount);
                }
                if (data.partnerPresence) {
                    updatePartnerPresenceUI(data.partnerPresence);
                }
            } catch {}
        });

        sseSource.addEventListener('new-message', (e) => {
            try {
                const data = JSON.parse(e.data);
                const msg = data.message;
                if (!msg) return;

                // Append to all active containers
                getActiveContainers().forEach(container => {
                    appendMessageToDOM(container, msg);
                });

                // Play sound if incoming from partner
                if (msg.sender === partnerUser) {
                    playNotificationChime();

                    // If drawer is currently open or full page is active, mark read
                    const isDrawerOpen = drawer && drawer.classList.contains('is-open');
                    const isFullPage = !!fullPageMessagesList;

                    if (isDrawerOpen || isFullPage) {
                        markMessagesAsRead();
                    } else {
                        if (typeof data.unreadCount === 'number') {
                            updateUnreadBadges(data.unreadCount);
                        }
                    }
                }
            } catch (err) {
                console.error('[messages] SSE error parsing new-message:', err);
            }
        });

        sseSource.addEventListener('messages-read', (e) => {
            try {
                // Update all outgoing unread messages to seen
                document.querySelectorAll('.msg-seen-check').forEach(el => {
                    el.classList.add('is-seen');
                    el.innerHTML = '✓✓';
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
                const row = document.querySelector(`[data-msg-id="${data.messageId}"]`);
                if (row) {
                    row.style.opacity = '0';
                    row.style.transform = 'scale(0.9)';
                    setTimeout(() => row.remove(), 250);
                }
            } catch {}
        });

        sseSource.onerror = () => {
            // EventSource automatically attempts reconnection
        };
    }

    // ------------------------------------------------------------
    //  4. PRESENCE & TYPING UI
    // ------------------------------------------------------------
    function updatePartnerPresenceUI(presence) {
        if (!presence) return;
        const status = presence.status || 'offline';
        const isOnline = presence.isOnline || presence.isWatching;
        const isWatching = presence.isWatching;

        document.querySelectorAll('.msg-partner-status-dot').forEach(dot => {
            dot.className = `msg-status-dot msg-partner-status-dot dot-${status}`;
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

    // ------------------------------------------------------------
    //  5. MESSAGE RENDERING HELPER
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
        const d = new Date(isoStr);
        return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
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
                <a href="/watch/${encodeURIComponent(msg.video.id)}" class="msg-video-card">
                    <div class="msg-video-card-thumb-wrap">
                        ${thumbUrl ? `<img src="${thumbUrl}" class="msg-video-card-thumb-img" alt="" loading="lazy" />` : '<div class="thumb-fallback">🎬</div>'}
                        <div class="msg-video-card-play-overlay">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><polygon points="6,4 20,12 6,20"/></svg>
                        </div>
                        ${msg.video.duration ? `<div class="msg-video-card-duration">${escapeHtml(msg.video.duration)}</div>` : ''}
                    </div>
                    <div class="msg-video-card-info">
                        <div class="msg-video-card-title">${escapeHtml(msg.video.title)}</div>
                        <div class="msg-video-card-tag">
                            <svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><polygon points="6,4 20,12 6,20"/></svg>
                            <span>Watch Shared Video</span>
                        </div>
                    </div>
                </a>
            `;
        }

        // 2. Voice Audio Note
        if (msg.voiceUrl) {
            contentHtml += `
                <div class="msg-voice-player" data-audio-src="${escapeHtml(msg.voiceUrl)}">
                    <button type="button" class="msg-voice-play-btn" aria-label="Play voice message">
                        <svg class="icon-play" viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><polygon points="6,4 20,12 6,20"/></svg>
                        <svg class="icon-pause" viewBox="0 0 24 24" fill="currentColor" width="14" height="14" style="display:none;"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>
                    </button>
                    <div class="msg-voice-waveform">
                        <span class="msg-wave-bar"></span>
                        <span class="msg-wave-bar"></span>
                        <span class="msg-wave-bar"></span>
                        <span class="msg-wave-bar"></span>
                        <span class="msg-wave-bar"></span>
                        <span class="msg-wave-bar"></span>
                        <span class="msg-wave-bar"></span>
                        <span class="msg-wave-bar"></span>
                    </div>
                    <span class="msg-voice-time">Voice Note</span>
                </div>
            `;
        }

        // 3. Text Body
        if (msg.text) {
            contentHtml += `<div class="msg-text-content">${escapeHtml(msg.text).replace(/\n/g, '<br>')}</div>`;
        }

        return `
            <div class="msg-row ${rowClass}" data-msg-id="${msg.id}">
                <div class="msg-bubble-wrap">
                    <div class="msg-bubble">${contentHtml}</div>
                    <div class="msg-meta-row">
                        <span class="msg-time">${timeStr}</span>
                        ${seenHtml}
                    </div>
                </div>
            </div>
        `;
    }

    function appendMessageToDOM(container, msg) {
        if (!container) return;
        // Don't duplicate if already rendered
        if (container.querySelector(`[data-msg-id="${msg.id}"]`)) return;

        // Remove typing indicator if present
        const typingRow = container.querySelector('.msg-typing-row');
        if (typingRow) typingRow.remove();

        container.insertAdjacentHTML('beforeend', renderMessageHTML(msg));
        scrollToBottom(container);
    }

    function scrollToBottom(container) {
        if (container) {
            requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
            });
        }
    }

    // ------------------------------------------------------------
    //  6. SENDING MESSAGES & ACTIONS
    // ------------------------------------------------------------
    function sendMessage(text, videoId = null) {
        const cleanText = (text || '').trim();
        if (!cleanText && !videoId) return;

        fetch('/api/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text: cleanText, videoId })
        })
        .then(res => res.json())
        .then(data => {
            if (data.success && data.message) {
                getActiveContainers().forEach(c => appendMessageToDOM(c, data.message));
                sendTypingState(false);
            }
        })
        .catch(err => console.error('[messages] Send failed:', err));
    }

    function markMessagesAsRead() {
        fetch('/api/messages/read', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
        })
        .then(res => res.json())
        .then(data => {
            if (data.success) {
                updateUnreadBadges(0);
            }
        })
        .catch(() => {});
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

    // ------------------------------------------------------------
    //  7. VOICE RECORDING (MediaRecorder API)
    // ------------------------------------------------------------
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
                alert('Microphone access was denied or is not supported.');
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
                    if (blob.size < 1000) return; // Too short

                    const formData = new FormData();
                    formData.append('audio', blob, 'voice.webm');

                    fetch('/api/messages/voice', {
                        method: 'POST',
                        body: formData
                    })
                    .then(res => res.json())
                    .then(data => {
                        if (data.success && data.message) {
                            getActiveContainers().forEach(c => appendMessageToDOM(c, data.message));
                        }
                    })
                    .catch(err => console.error('[messages] Voice send failed:', err));
                };

                mediaRecorder.stop();
            });
        }
    }

    // ------------------------------------------------------------
    //  8. VOICE AUDIO PLAYER EVENT DELEGATION
    // ------------------------------------------------------------
    let currentPlayingAudio = null;
    let currentPlayingBtn = null;

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('.msg-voice-play-btn');
        if (!btn) return;

        const player = btn.closest('.msg-voice-player');
        const audioSrc = player.getAttribute('data-audio-src');
        if (!audioSrc) return;

        if (currentPlayingAudio && !currentPlayingAudio.paused) {
            currentPlayingAudio.pause();
            if (currentPlayingBtn) {
                currentPlayingBtn.querySelector('.icon-play').style.display = '';
                currentPlayingBtn.querySelector('.icon-pause').style.display = 'none';
                currentPlayingBtn.closest('.msg-voice-player').classList.remove('is-playing');
            }
            if (currentPlayingBtn === btn) {
                currentPlayingAudio = null;
                currentPlayingBtn = null;
                return;
            }
        }

        const audio = new Audio(audioSrc);
        currentPlayingAudio = audio;
        currentPlayingBtn = btn;

        btn.querySelector('.icon-play').style.display = 'none';
        btn.querySelector('.icon-pause').style.display = '';
        player.classList.add('is-playing');

        audio.play().catch(() => {});

        audio.onended = () => {
            btn.querySelector('.icon-play').style.display = '';
            btn.querySelector('.icon-pause').style.display = 'none';
            player.classList.remove('is-playing');
            currentPlayingAudio = null;
            currentPlayingBtn = null;
        };
    });

    // ------------------------------------------------------------
    //  9. COMPOSER SETUP (Drawer & Full Page)
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
                textarea.style.height = Math.min(textarea.scrollHeight, 100) + 'px';

                // Typing indicator throttle
                sendTypingState(true);
                clearTimeout(typingTimeout);
                typingTimeout = setTimeout(() => {
                    sendTypingState(false);
                }, 2500);
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

        // Quick Emojis
        emojiBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const emoji = btn.getAttribute('data-emoji') || btn.textContent.trim();
                if (textarea) {
                    textarea.value += emoji;
                    textarea.focus();
                    textarea.dispatchEvent(new Event('input'));
                }
            });
        });

        // Attach Video Modal Toggle
        if (attachBtn && attachModal) {
            attachBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                attachModal.classList.toggle('is-open');
            });

            document.addEventListener('click', (e) => {
                if (!attachModal.contains(e.target) && e.target !== attachBtn) {
                    attachModal.classList.remove('is-open');
                }
            });

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

        // Voice Recording Setup for this composer
        const recordBtn = formOrWrap.querySelector('.msg-mic-btn');
        const recordingBar = formOrWrap.querySelector('.msg-recording-bar');
        const cancelVoiceBtn = formOrWrap.querySelector('.msg-rec-cancel-btn');
        const sendVoiceBtn = formOrWrap.querySelector('.msg-rec-send-btn');
        setupVoiceRecording(recordBtn, recordingBar, cancelVoiceBtn, sendVoiceBtn);
    }

    // ------------------------------------------------------------
    //  10. FLOATING LAUNCHER & DRAWER INTERACTION
    // ------------------------------------------------------------
    if (launcher && drawer) {
        launcher.addEventListener('click', () => {
            const isOpen = drawer.classList.toggle('is-open');
            launcher.classList.toggle('is-open', isOpen);
            if (isOpen) {
                markMessagesAsRead();
                if (drawerMessagesList) {
                    scrollToBottom(drawerMessagesList);
                }
                const input = drawer.querySelector('.msg-textarea');
                if (input) input.focus();
            }
        });

        if (closeBtn) {
            closeBtn.addEventListener('click', () => {
                drawer.classList.remove('is-open');
                launcher.classList.remove('is-open');
            });
        }
    }

    // Initialize Composers
    document.querySelectorAll('.msg-composer-wrap').forEach(setupComposer);

    // Initial Auto-scroll
    getActiveContainers().forEach(scrollToBottom);

    // Start SSE listener
    initSSE();

    // ------------------------------------------------------------
    //  11. GLOBAL VIDEO SHARE BUTTON ("Share to Chat" on /watch/:id)
    // ------------------------------------------------------------
    const shareToChatBtn = document.getElementById('btnShareToChat');
    if (shareToChatBtn) {
        shareToChatBtn.addEventListener('click', () => {
            const videoId = shareToChatBtn.getAttribute('data-video-id');
            if (!videoId) return;

            sendMessage('', videoId);

            // Open floating drawer if present
            if (drawer && launcher) {
                drawer.classList.add('is-open');
                launcher.classList.add('is-open');
                if (drawerMessagesList) scrollToBottom(drawerMessagesList);
            }

            // Visual feedback
            const originalHtml = shareToChatBtn.innerHTML;
            shareToChatBtn.innerHTML = `
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="16" height="16">
                    <polyline points="20 6 9 17 4 12"/>
                </svg>
                <span>Shared!</span>
            `;
            setTimeout(() => {
                shareToChatBtn.innerHTML = originalHtml;
            }, 2000);
        });
    }

})();
