// ============================================================
//  MESSAGES SYSTEM — ULTRA-LUXE REAL-TIME CLIENT CONTROLLER
//  Handles SSE stream, audio chime, interactive waveform player,
//  reactions, speed controls, in-chat search & particle effects
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
        } catch (e) {}
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

        // Show launcher only when there is a new/unread message or the drawer is open
        if (launcher) {
            const isDrawerOpen = drawer && drawer.classList.contains('is-open');
            if (num > 0 || isDrawerOpen) {
                launcher.classList.add('has-unread');
                launcher.style.display = 'flex';
            } else {
                launcher.classList.remove('has-unread');
                launcher.style.display = 'none';
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

                getActiveContainers().forEach(container => {
                    appendMessageToDOM(container, msg);
                });

                if (msg.sender === partnerUser) {
                    playNotificationChime();

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

        sseSource.addEventListener('messages-read', () => {
            try {
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
                const rows = document.querySelectorAll(`[data-msg-id="${data.messageId}"]`);
                rows.forEach(row => {
                    row.style.opacity = '0';
                    row.style.transform = 'scale(0.9)';
                    setTimeout(() => row.remove(), 250);
                });
            } catch {}
        });

        sseSource.addEventListener('message-reaction', (e) => {
            try {
                const data = JSON.parse(e.data);
                updateMessageReactionsDOM(data.messageId, data.reactions);
            } catch {}
        });

        sseSource.onerror = () => {};
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

        // Update live watching banner in sidebar if exists
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

        // 3. Text Body
        if (msg.text) {
            contentHtml += `<div class="msg-text-content">${escapeHtml(msg.text).replace(/\n/g, '<br>')}</div>`;
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
                    ${msg.text ? `<button type="button" class="msg-action-btn btn-copy" title="Copy Text">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                    </button>` : ''}
                    ${canDelete ? `<button type="button" class="msg-action-btn btn-delete" title="Delete Message">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                    </button>` : ''}
                </div>
                <div class="msg-bubble-wrap">
                    <div class="msg-bubble">
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

    function appendMessageToDOM(container, msg) {
        if (!container) return;
        if (container.querySelector(`[data-msg-id="${msg.id}"]`)) return;

        // Remove empty state if present
        const emptyState = container.querySelector('.msg-empty-state');
        if (emptyState) emptyState.remove();

        // Remove typing indicator if present
        const typingRow = container.querySelector('.msg-typing-row');
        if (typingRow) typingRow.remove();

        container.insertAdjacentHTML('beforeend', renderMessageHTML(msg));
        scrollToBottom(container);
    }

    function updateMessageReactionsDOM(messageId, reactions) {
        document.querySelectorAll(`[data-msg-id="${messageId}"]`).forEach(row => {
            const bubbleWrap = row.querySelector('.msg-bubble-wrap');
            if (!bubbleWrap) return;
            let reactionsRow = bubbleWrap.querySelector('.msg-reactions-row');
            const newHtml = renderReactionsHtml(reactions, currentUser);
            if (reactionsRow) {
                if (newHtml) {
                    reactionsRow.outerHTML = newHtml;
                } else {
                    reactionsRow.remove();
                }
            } else if (newHtml) {
                const metaRow = bubbleWrap.querySelector('.msg-meta-row');
                if (metaRow) {
                    metaRow.insertAdjacentHTML('beforebegin', newHtml);
                } else {
                    bubbleWrap.insertAdjacentHTML('beforeend', newHtml);
                }
            }
        });
    }

    function scrollToBottom(container) {
        if (container) {
            requestAnimationFrame(() => {
                container.scrollTop = container.scrollHeight;
            });
        }
    }

    // ------------------------------------------------------------
    //  6. FLOATING EMOJI BURST PARTICLE EFFECT
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
    //  7. SENDING MESSAGES & ACTIONS
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
    //  8. VOICE RECORDING (MediaRecorder API)
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
    //  9. INTERACTIVE AUDIO PLAYER WITH SCRUBBER & SPEED
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
    //  10. MESSAGE ACTIONS: REACTIONS, COPY, DELETE
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
                            row.style.opacity = '0';
                            row.style.transform = 'scale(0.85)';
                            setTimeout(() => row.remove(), 250);
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
    //  11. COMPOSER SETUP (Drawer & Full Page)
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
    //  12. FLOATING LAUNCHER & DRAWER INTERACTION
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
                const badgeCount = parseInt(unreadPill ? unreadPill.textContent : '0', 10) || 0;
                if (badgeCount <= 0) {
                    launcher.classList.remove('has-unread');
                    launcher.style.display = 'none';
                }
            });
        }
    }

    // ------------------------------------------------------------
    //  13. IN-CHAT SEARCH & SHARED MEDIA TABS (/messages)
    // ------------------------------------------------------------
    const searchToggleBtn = document.getElementById('msgSearchToggleBtn');
    const inChatSearchBar = document.getElementById('msgInChatSearchBar');
    const inChatSearchInput = document.getElementById('msgInChatSearchInput');
    const inChatSearchClose = document.getElementById('msgInChatSearchClose');

    if (searchToggleBtn && inChatSearchBar && inChatSearchInput) {
        searchToggleBtn.addEventListener('click', () => {
            const isOpen = inChatSearchBar.classList.toggle('is-open');
            if (isOpen) {
                inChatSearchInput.value = '';
                inChatSearchInput.focus();
            } else {
                filterMessagesByKeyword('');
            }
        });

        if (inChatSearchClose) {
            inChatSearchClose.addEventListener('click', () => {
                inChatSearchBar.classList.remove('is-open');
                inChatSearchInput.value = '';
                filterMessagesByKeyword('');
            });
        }

        inChatSearchInput.addEventListener('input', () => {
            filterMessagesByKeyword(inChatSearchInput.value.toLowerCase().trim());
        });
    }

    function filterMessagesByKeyword(keyword) {
        const container = fullPageMessagesList || drawerMessagesList;
        if (!container) return;

        container.querySelectorAll('.msg-row').forEach(row => {
            if (!keyword) {
                row.style.display = 'flex';
                return;
            }
            const text = (row.querySelector('.msg-text-content')?.textContent || '').toLowerCase();
            const videoTitle = (row.querySelector('.msg-video-card-title')?.textContent || '').toLowerCase();
            if (text.includes(keyword) || videoTitle.includes(keyword)) {
                row.style.display = 'flex';
            } else {
                row.style.display = 'none';
            }
        });
    }

    // Shared Media Explorer Tabs in Sidebar
    document.querySelectorAll('.msg-media-tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.msg-media-tab-btn').forEach(b => b.classList.remove('is-active'));
            btn.classList.add('is-active');
            const tab = btn.getAttribute('data-tab');
            const container = fullPageMessagesList;
            if (!container) return;

            container.querySelectorAll('.msg-row').forEach(row => {
                if (tab === 'all') {
                    row.style.display = 'flex';
                } else if (tab === 'videos') {
                    row.style.display = row.querySelector('.msg-video-card') ? 'flex' : 'none';
                } else if (tab === 'voice') {
                    row.style.display = row.querySelector('.msg-voice-player') ? 'flex' : 'none';
                }
            });
        });
    });

    // Initialize Composers
    document.querySelectorAll('.msg-composer-wrap').forEach(setupComposer);

    // Initial Auto-scroll
    getActiveContainers().forEach(scrollToBottom);

    // Cleanup SSE on page unload to prevent connection overlap during navigation
    window.addEventListener('beforeunload', () => {
        if (sseSource) {
            sseSource.close();
            sseSource = null;
        }
    });

    // Start SSE listener
    initSSE();

    // ------------------------------------------------------------
    //  14. GLOBAL VIDEO SHARE BUTTON ("Share to Chat" on /watch/:id)
    // ------------------------------------------------------------
    const shareToChatBtn = document.getElementById('btnShareToChat');
    if (shareToChatBtn) {
        shareToChatBtn.addEventListener('click', () => {
            const videoId = shareToChatBtn.getAttribute('data-video-id');
            if (!videoId) return;

            sendMessage('', videoId);

            if (drawer && launcher) {
                drawer.classList.add('is-open');
                launcher.classList.add('is-open');
                if (drawerMessagesList) scrollToBottom(drawerMessagesList);
            }

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

    // ------------------------------------------------------------
    //  15. MOBILE VIRTUAL KEYBOARD / VIEWPORT ADAPTER
    // ------------------------------------------------------------
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', () => {
            if (fullPageMessagesList || (drawer && drawer.classList.contains('is-open'))) {
                setTimeout(() => {
                    getActiveContainers().forEach(scrollToBottom);
                }, 100);
            }
        });
    }

})();
