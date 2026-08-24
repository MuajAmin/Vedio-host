// ============================================================
//  WEBRTC REAL-TIME CALL CONTROLLER v2.0
//  Formal State Machine, Reconnection Strategy,
//  Memory-Leak Prevention, Mobile Lifecycle, Structured Logging
// ============================================================

(function () {
    'use strict';

    const currentUser = document.body.getAttribute('data-user') || '';
    if (!currentUser) return; // Not logged in

    const csrfMeta = document.querySelector('meta[name="csrf-token"]');
    const CSRF_TOKEN = csrfMeta ? csrfMeta.getAttribute('content') : '';

    const partnerUser = currentUser === 'muaj' ? 'hajera' : 'muaj';
    const partnerName = partnerUser === 'muaj' ? 'Muaj' : 'Hajera';

    // ------------------------------------------------------------
    //  1. STRUCTURED LOGGING
    // ------------------------------------------------------------
    function callLog(event, data = {}) {
        const ts = new Date().toISOString().slice(11, 23);
        const meta = Object.keys(data).length
            ? ' | ' + Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ')
            : '';
        console.log(`[CALL ${ts}] ${event}${meta}`);
    }

    // ------------------------------------------------------------
    //  2. WEBRTC CONFIGURATION & EDGE SIGNALING
    // ------------------------------------------------------------
    const RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' },
            { urls: 'stun:stun.cloudflare.com:3478' }
        ],
        iceCandidatePoolSize: 10,
        bundlePolicy: 'max-bundle',
        rtcpMuxPolicy: 'require'
    };

    let edgeWs = null;
    let edgeWsReady = false;
    let edgeWsPingInterval = null;

    function initEdgeSignaling() {
        if (!currentUser) return;
        fetch('/api/call/edge-token')
            .then(res => res.json())
            .then(data => {
                if (data.enabled && data.signalingUrl) {
                    connectEdgeWebSocket(data.signalingUrl);
                }
            })
            .catch(() => {});
    }

    function connectEdgeWebSocket(url) {
        try {
            if (edgeWs) {
                try { edgeWs.close(); } catch(e) {}
            }
            edgeWs = new WebSocket(url);
            edgeWs.onopen = () => {
                edgeWsReady = true;
                callLog('EDGE_WS_CONNECTED', { transport: 'Cloudflare Edge WebSocket (<10ms)' });
                if (edgeWsPingInterval) clearInterval(edgeWsPingInterval);
                edgeWsPingInterval = setInterval(() => {
                    if (edgeWs && edgeWs.readyState === WebSocket.OPEN) {
                        edgeWs.send(JSON.stringify({ type: 'ping' }));
                    }
                }, 25000);
            };

            edgeWs.onmessage = (event) => {
                try {
                    const msg = JSON.parse(event.data);
                    if (msg.type === 'pong') return;
                    handleIncomingEdgeSignal(msg);
                } catch(e) {}
            };

            edgeWs.onclose = () => {
                edgeWsReady = false;
                if (edgeWsPingInterval) clearInterval(edgeWsPingInterval);
                setTimeout(() => {
                    if (document.visibilityState !== 'hidden') initEdgeSignaling();
                }, 6000);
            };

            edgeWs.onerror = () => {
                edgeWsReady = false;
            };
        } catch(e) {
            edgeWsReady = false;
        }
    }

    function handleIncomingEdgeSignal(msg) {
        if (!msg || !msg.type) return;
        callLog('EDGE_WS_RECV', { type: msg.type });

        if (msg.type === 'offer' || msg.type === 'answer' || msg.type === 'ice-candidate' || msg.type === 'call-emoji' || msg.type === 'media-state' || msg.type === 'ice-restart') {
            handleCallSignalEvent({
                callId: msg.callId,
                type: msg.type,
                data: msg.data
            });
        } else if (msg.type === 'call:incoming' || msg.type === 'incoming') {
            handleIncomingCallEvent(msg.data || msg);
        } else if (msg.type === 'call:accepted' || msg.type === 'accepted') {
            handleCallAcceptedEvent(msg.data || msg);
        } else if (msg.type === 'call:rejected' || msg.type === 'rejected') {
            if (msg.callId && msg.callId !== CallState.callId) return;
            endCallLocally('Rejected');
        } else if (msg.type === 'call:ended' || msg.type === 'ended') {
            if (msg.callId && msg.callId !== CallState.callId) return;
            endCallLocally('Ended');
        }
    }

    // ------------------------------------------------------------
    //  3. STATE MACHINE
    // ------------------------------------------------------------
    // Valid state transitions
    const VALID_TRANSITIONS = {
        idle:         ['calling', 'ringing'],
        calling:      ['connecting', 'ended', 'failed', 'cancelled'],
        ringing:      ['connecting', 'ended', 'rejected', 'missed'],
        connecting:   ['connected', 'reconnecting', 'ended', 'failed'],
        connected:    ['reconnecting', 'ended'],
        reconnecting: ['connected', 'ended', 'failed'],
        // Terminal states - no transitions out
        ended:     [],
        rejected:  [],
        missed:    [],
        failed:    [],
        cancelled: []
    };

    const TERMINAL_STATES = new Set(['ended', 'rejected', 'missed', 'failed', 'cancelled']);

    function canTransition(from, to) {
        const allowed = VALID_TRANSITIONS[from];
        return allowed && allowed.includes(to);
    }

    // ------------------------------------------------------------
    //  4. WEB AUDIO SYNTHESIZER & REAL-TIME SPECTRUM ANALYSER
    // ------------------------------------------------------------
    let audioCtx = null;
    let ringInterval = null;
    let audioAnalyser = null;
    let analyserSource = null;
    let visualizerAnimationId = null;

    function getAudioContext() {
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
        }
        return audioCtx;
    }

    function playTone(freq, type = 'sine', duration = 0.2, startTime = 0, gainLevel = 0.15) {
        try {
            const ctx = getAudioContext();
            const now = ctx.currentTime + startTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.type = type;
            osc.frequency.setValueAtTime(freq, now);
            gain.gain.setValueAtTime(gainLevel, now);
            gain.gain.exponentialRampToValueAtTime(0.001, now + duration);
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.start(now);
            osc.stop(now + duration);
        } catch (e) {}
    }

    function startIncomingRingtone() {
        stopRingtone();
        const playRingPattern = () => {
            playTone(698.46, 'sine', 0.25, 0, 0.16);
            playTone(880.00, 'sine', 0.25, 0.2, 0.18);
            playTone(1046.50, 'sine', 0.45, 0.4, 0.20);
        };
        playRingPattern();
        ringInterval = setInterval(playRingPattern, 2400);
    }

    function startOutgoingRingback() {
        stopRingtone();
        const playRingback = () => {
            playTone(440, 'sine', 1.2, 0, 0.08);
            playTone(480, 'sine', 1.2, 0, 0.08);
        };
        playRingback();
        ringInterval = setInterval(playRingback, 3500);
    }

    function playCallConnectedChime() {
        stopRingtone();
        playTone(523.25, 'sine', 0.15, 0, 0.12);
        playTone(659.25, 'sine', 0.15, 0.1, 0.14);
        playTone(783.99, 'sine', 0.35, 0.2, 0.16);
    }

    function playCallEndedChime() {
        stopRingtone();
        playTone(659.25, 'sine', 0.2, 0, 0.12);
        playTone(523.25, 'sine', 0.35, 0.15, 0.12);
    }

    function stopRingtone() {
        if (ringInterval) {
            clearInterval(ringInterval);
            ringInterval = null;
        }
    }

    // Connect MediaStream to Web Audio AnalyserNode for Real-Time Soundwaves
    function setupAudioVisualizer(stream) {
        if (!stream) return;
        try {
            const ctx = getAudioContext();
            if (analyserSource) {
                try { analyserSource.disconnect(); } catch (e) {}
            }

            audioAnalyser = ctx.createAnalyser();
            audioAnalyser.fftSize = 64;
            audioAnalyser.smoothingTimeConstant = 0.8;

            analyserSource = ctx.createMediaStreamSource(stream);
            analyserSource.connect(audioAnalyser);

            startVisualizerLoop();
        } catch (e) {
            callLog('VISUALIZER_SETUP_ERROR', { error: e.message });
        }
    }

    function startVisualizerLoop() {
        if (visualizerAnimationId) {
            cancelAnimationFrame(visualizerAnimationId);
            visualizerAnimationId = null;
        }

        const bars = document.querySelectorAll('.active-call-soundwaves .soundwave-bar');
        if (!bars || bars.length === 0) return;

        const dataArray = new Uint8Array(audioAnalyser ? audioAnalyser.frequencyBinCount : 32);

        function draw() {
            if (CallState.state !== 'connected' && CallState.state !== 'connecting') {
                return;
            }

            visualizerAnimationId = requestAnimationFrame(draw);

            if (audioAnalyser) {
                audioAnalyser.getByteFrequencyData(dataArray);

                let sum = 0;
                bars.forEach((bar, idx) => {
                    const dataIdx = Math.floor((idx / bars.length) * (dataArray.length / 2));
                    const val = dataArray[dataIdx] || 0;
                    sum += val;
                    const height = Math.max(6, Math.min(36, (val / 255) * 36 + 6));
                    bar.style.height = `${height}px`;
                });

                const avg = sum / bars.length;
                const wavesContainer = document.getElementById('activeSoundwaves');
                const avatarRing = document.querySelector('.active-call-avatar-glow-ring.ring-inner');

                if (avg > 15) {
                    if (wavesContainer) wavesContainer.classList.add('is-speaking');
                    if (avatarRing) {
                        const scale = 1 + (avg / 255) * 0.25;
                        avatarRing.style.transform = `scale(${scale})`;
                        avatarRing.style.opacity = '0.8';
                    }
                } else {
                    if (wavesContainer) wavesContainer.classList.remove('is-speaking');
                    if (avatarRing) {
                        avatarRing.style.transform = 'scale(1)';
                        avatarRing.style.opacity = '0.3';
                    }
                }
            }
        }

        draw();
    }

    function stopAudioVisualizer() {
        if (visualizerAnimationId) {
            cancelAnimationFrame(visualizerAnimationId);
            visualizerAnimationId = null;
        }
        if (analyserSource) {
            try { analyserSource.disconnect(); } catch (e) {}
            analyserSource = null;
        }
        audioAnalyser = null;

        // Reset bars
        document.querySelectorAll('.active-call-soundwaves .soundwave-bar').forEach(bar => {
            bar.style.height = '6px';
        });
        const wavesContainer = document.getElementById('activeSoundwaves');
        if (wavesContainer) wavesContainer.classList.remove('is-speaking');
    }

    // ------------------------------------------------------------
    //  5. CALL STATE STORE
    // ------------------------------------------------------------
    let _callNonce = 0; // Monotonic counter to detect stale events

    const CallState = {
        state: 'idle',
        callId: null,
        callNonce: 0,
        callType: 'audio',
        isCaller: false,
        partner: partnerUser,
        localStream: null,
        remoteStream: null,
        peerConnection: null,
        durationSeconds: 0,
        timerInterval: null,
        isMuted: false,
        isCameraOff: false,
        isSpeakerOff: false,
        isMinimized: false,
        iceCandidatesQueue: [],
        // Timeouts
        ringTimeoutId: null,
        reconnectTimeoutId: null,
        iceRestartTimeoutId: null,
        // Reconnection tracking
        iceRestartAttempted: false
    };

    // Transition state with validation
    function transitionState(newState) {
        const oldState = CallState.state;
        if (oldState === newState) return true;

        if (TERMINAL_STATES.has(oldState)) {
            callLog('STATE_BLOCKED_TERMINAL', { from: oldState, to: newState });
            return false;
        }

        if (!canTransition(oldState, newState)) {
            callLog('STATE_BLOCKED_INVALID', { from: oldState, to: newState });
            return false;
        }

        CallState.state = newState;
        callLog('STATE_TRANSITION', { from: oldState, to: newState, callId: CallState.callId });
        return true;
    }

    // ------------------------------------------------------------
    //  6. DOM REFERENCES
    // ------------------------------------------------------------
    const DOM = {
        // Incoming Call Modal
        incomingModal: document.getElementById('globalIncomingCallModal'),
        incomingCallerName: document.getElementById('incomingCallerName'),
        incomingCallTypeBadge: document.getElementById('incomingCallTypeBadge'),
        incomingCallTypeLabel: document.getElementById('incomingCallTypeLabel'),
        incomingAvatarWrap: document.getElementById('incomingAvatarWrap'),
        incomingAcceptBtn: document.getElementById('incomingAcceptBtn'),
        incomingDeclineBtn: document.getElementById('incomingDeclineBtn'),

        // Active Call Modal
        activeModal: document.getElementById('globalActiveCallModal'),
        activePartnerName: document.getElementById('activePartnerName'),
        activeCallTypeTag: document.getElementById('activeCallTypeTag'),
        activeCallStatusText: document.getElementById('activeCallStatusText'),
        activeCallSubstatus: document.getElementById('activeCallSubstatus'),
        activeCallTimer: document.getElementById('activeCallTimer'),
        activeCallLiveDot: document.getElementById('activeCallLiveDot'),
        activeAvatarBig: document.getElementById('activeAvatarBig'),
        activeSoundwaves: document.getElementById('activeSoundwaves'),
        activeAudioStage: document.getElementById('activeAudioStage'),
        activeVideoStage: document.getElementById('activeVideoStage'),
        remoteVideo: document.getElementById('remoteVideoTrack'),
        localVideo: document.getElementById('localVideoTrack'),
        localVideoPip: document.getElementById('localVideoPip'),
        remoteAudio: document.getElementById('remoteAudioTrack'),
        remoteCameraOffOverlay: document.getElementById('remoteCameraOffOverlay'),

        // Reconnecting / Error Banners
        reconnectBanner: document.getElementById('callReconnectBanner'),
        reconnectText: document.getElementById('callReconnectText'),
        inlineAlert: document.getElementById('callInlineAlert'),
        inlineAlertText: document.getElementById('callInlineAlertText'),
        inlineAlertClose: document.getElementById('callInlineAlertClose'),

        // Active Call Controls
        btnMute: document.getElementById('callBtnMute'),
        btnCamera: document.getElementById('callBtnCamera'),
        btnCameraFlip: document.getElementById('callBtnCameraFlip'),
        btnSpeaker: document.getElementById('callBtnSpeaker'),
        btnEnd: document.getElementById('callBtnEnd'),
        btnMinimize: document.getElementById('callBtnMinimize'),
        callMuteLabel: document.getElementById('callMuteLabel'),
        callCamLabel: document.getElementById('callCamLabel'),
        callCameraItem: document.getElementById('callCameraItem'),
        callCameraFlipItem: document.getElementById('callCameraFlipItem'),
        callSpeakerLabel: document.getElementById('callSpeakerLabel'),
        callSpeakerItem: document.getElementById('callSpeakerItem'),

        // Minimized Floating Pill
        minimizedPill: document.getElementById('callMinimizedPill'),
        minimizedName: document.getElementById('minimizedCallName'),
        minimizedTimer: document.getElementById('minimizedCallTimer'),
        minimizedQuickEnd: document.getElementById('minimizedQuickEndBtn')
    };

    // ------------------------------------------------------------
    //  7. UI UPDATERS
    // ------------------------------------------------------------
    function formatDuration(sec) {
        const mins = Math.floor(sec / 60);
        const remaining = sec % 60;
        return `${mins < 10 ? '0' : ''}${mins}:${remaining < 10 ? '0' : ''}${remaining}`;
    }

    function startCallTimer() {
        stopCallTimer();
        CallState.durationSeconds = 0;
        if (DOM.activeCallTimer) DOM.activeCallTimer.textContent = '00:00';
        if (DOM.minimizedTimer) DOM.minimizedTimer.textContent = '00:00';

        CallState.timerInterval = setInterval(() => {
            CallState.durationSeconds++;
            const text = formatDuration(CallState.durationSeconds);
            if (DOM.activeCallTimer) DOM.activeCallTimer.textContent = text;
            if (DOM.minimizedTimer) DOM.minimizedTimer.textContent = text;
        }, 1000);
    }

    function stopCallTimer() {
        if (CallState.timerInterval) {
            clearInterval(CallState.timerInterval);
            CallState.timerInterval = null;
        }
    }

    function showIncomingCallModal(data) {
        if (!DOM.incomingModal) return;
        const isVideo = data.callType === 'video';

        if (DOM.incomingCallerName) {
            DOM.incomingCallerName.textContent = partnerName;
        }
        if (DOM.incomingCallTypeBadge) {
            DOM.incomingCallTypeBadge.className = `incoming-call-type-badge ${isVideo ? 'is-video' : ''}`;
        }
        if (DOM.incomingCallTypeLabel) {
            DOM.incomingCallTypeLabel.textContent = isVideo ? 'Incoming Video Call' : 'Incoming Audio Call';
        }

        DOM.incomingModal.classList.add('is-active');
        startIncomingRingtone();
    }

    function hideIncomingCallModal() {
        if (DOM.incomingModal) {
            DOM.incomingModal.classList.remove('is-active');
        }
        stopRingtone();
    }

    function showActiveCallModal() {
        if (!DOM.activeModal) return;
        const isVideo = CallState.callType === 'video';

        if (DOM.activePartnerName) DOM.activePartnerName.textContent = partnerName;
        if (DOM.activeCallTypeTag) DOM.activeCallTypeTag.textContent = isVideo ? 'Video Call' : 'Audio Call';
        if (DOM.activeCallStatusText) {
            DOM.activeCallStatusText.textContent = CallState.isCaller ? 'Calling...' : 'Connecting...';
        }
        if (DOM.activeCallSubstatus) {
            DOM.activeCallSubstatus.textContent = 'Private 1-on-1 End-to-End Media';
        }

        if (DOM.activeAudioStage) DOM.activeAudioStage.style.display = isVideo ? 'none' : 'flex';
        if (DOM.activeVideoStage) {
            DOM.activeVideoStage.className = `active-call-video-stage ${isVideo ? 'is-visible' : ''}`;
        }
        if (DOM.btnCamera) {
            DOM.btnCamera.style.display = isVideo ? 'flex' : 'none';
        }
        if (DOM.callCamLabel) {
            DOM.callCamLabel.style.display = isVideo ? 'block' : 'none';
        }
        if (DOM.callCameraItem) {
            DOM.callCameraItem.style.display = isVideo ? 'flex' : 'none';
        }
        if (DOM.callCameraFlipItem) {
            DOM.callCameraFlipItem.style.display = isVideo ? 'flex' : 'none';
        }

        // Hide reconnect banner
        if (DOM.reconnectBanner) DOM.reconnectBanner.style.display = 'none';

        DOM.activeModal.classList.add('is-active');
        hideMinimizedPill();
    }

    function hideActiveCallModal() {
        if (DOM.activeModal) {
            DOM.activeModal.classList.remove('is-active');
        }
    }

    function showMinimizedPill() {
        if (!DOM.minimizedPill) return;
        if (DOM.minimizedName) DOM.minimizedName.textContent = partnerName;
        DOM.minimizedPill.style.display = 'flex';
        CallState.isMinimized = true;
    }

    function hideMinimizedPill() {
        if (!DOM.minimizedPill) return;
        DOM.minimizedPill.style.display = 'none';
        CallState.isMinimized = false;
    }

    function updateConnectionStatusUI(statusText, isConnected = false) {
        if (DOM.activeCallStatusText) {
            DOM.activeCallStatusText.textContent = statusText;
        }
        // Update live dot color
        if (DOM.activeCallLiveDot) {
            if (isConnected) {
                DOM.activeCallLiveDot.style.background = 'var(--call-accent-green)';
                DOM.activeCallLiveDot.style.boxShadow = '0 0 12px var(--call-accent-green)';
            } else if (CallState.state === 'reconnecting') {
                DOM.activeCallLiveDot.style.background = 'var(--call-accent-gold)';
                DOM.activeCallLiveDot.style.boxShadow = '0 0 12px var(--call-accent-gold)';
            } else {
                DOM.activeCallLiveDot.style.background = 'var(--call-accent-cyan)';
                DOM.activeCallLiveDot.style.boxShadow = '0 0 12px var(--call-accent-cyan)';
            }
        }
        if (DOM.activeCallSubstatus) {
            if (isConnected) {
                DOM.activeCallSubstatus.textContent = 'End-to-End Encrypted • HD Audio';
            } else if (CallState.state === 'reconnecting') {
                DOM.activeCallSubstatus.textContent = 'Network interrupted, reconnecting...';
            }
        }
        // Reconnect banner
        if (DOM.reconnectBanner) {
            DOM.reconnectBanner.style.display = CallState.state === 'reconnecting' ? 'flex' : 'none';
        }
        if (DOM.reconnectText) {
            DOM.reconnectText.textContent = statusText;
        }
    }

    function showInlineAlert(msg) {
        if (DOM.inlineAlert && DOM.inlineAlertText) {
            DOM.inlineAlertText.textContent = msg;
            DOM.inlineAlert.style.display = 'flex';
            // Auto-hide after 8s
            setTimeout(() => {
                if (DOM.inlineAlert) DOM.inlineAlert.style.display = 'none';
            }, 8000);
        }
    }

    // In-Call Emoji Burst Animation
    function spawnInCallEmoji(emoji) {
        const stage = document.querySelector('.active-call-body') || document.body;
        const p = document.createElement('div');
        p.style.position = 'absolute';
        p.style.fontSize = '34px';
        p.style.left = `${40 + Math.random() * 20}%`;
        p.style.bottom = '120px';
        p.style.zIndex = '100';
        p.style.pointerEvents = 'none';
        p.style.transition = 'all 1.2s cubic-bezier(0.16, 1, 0.3, 1)';
        p.style.opacity = '1';
        p.textContent = emoji;

        stage.appendChild(p);

        requestAnimationFrame(() => {
            p.style.transform = `translate(${(Math.random() - 0.5) * 80}px, -180px) scale(1.35)`;
            p.style.opacity = '0';
        });

        setTimeout(() => p.remove(), 1300);
    }

    // ------------------------------------------------------------
    //  8. WEBRTC CORE IMPLEMENTATION
    // ------------------------------------------------------------
    async function acquireLocalMedia(isVideo = false) {
        try {
            const isCellular = !!(navigator.connection && (navigator.connection.type === 'cellular' || navigator.connection.effectiveType === '3g' || navigator.connection.effectiveType === '4g'));
            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    sampleRate: 48000,
                    sampleSize: 16,
                    channelCount: { ideal: 2, max: 2 },
                    latency: { ideal: 0.01 }
                },
                video: isVideo ? {
                    facingMode: 'user',
                    width: isCellular ? { ideal: 854, max: 1280 } : { ideal: 1280, max: 1920 },
                    height: isCellular ? { ideal: 480, max: 720 } : { ideal: 720, max: 1080 },
                    frameRate: { ideal: isCellular ? 24 : 30, max: 30 }
                } : false
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            CallState.localStream = stream;

            // Apply content hints for mobile hardware encoder acceleration
            stream.getAudioTracks().forEach(t => {
                if ('contentHint' in t) t.contentHint = 'speech';
            });
            stream.getVideoTracks().forEach(t => {
                if ('contentHint' in t) t.contentHint = 'motion';
            });

            callLog('MEDIA_ACQUIRED', { audio: true, video: isVideo });

            // Connect local stream to sound visualizer if audio call
            if (!isVideo) {
                setupAudioVisualizer(stream);
            }

            if (isVideo && DOM.localVideo) {
                DOM.localVideo.srcObject = stream;
                DOM.localVideo.play().catch(() => {});
            }

            return stream;
        } catch (err) {
            callLog('MEDIA_ERROR', { error: err.name, message: err.message });
            showInlineAlert(
                err.name === 'NotAllowedError'
                    ? 'Camera/microphone permission was denied. Please allow access in your browser settings.'
                    : 'Unable to access camera or microphone. Please check your device.'
            );
            throw err;
        }
    }

    function createPeerConnection() {
        // Always close existing connection first
        if (CallState.peerConnection) {
            try { CallState.peerConnection.close(); } catch (e) {}
            CallState.peerConnection = null;
        }

        const pc = new RTCPeerConnection(RTC_CONFIG);
        CallState.peerConnection = pc;
        CallState.iceRestartAttempted = false;

        callLog('PEER_CONNECTION_CREATED');

        // Add local tracks
        if (CallState.localStream) {
            CallState.localStream.getTracks().forEach(track => {
                pc.addTrack(track, CallState.localStream);
            });
        }

        // Handle remote stream tracks with zero artificial jitter buffer delay (<50ms audio/video)
        pc.ontrack = (event) => {
            if (event.receiver) {
                if ('playoutDelayHint' in event.receiver) {
                    event.receiver.playoutDelayHint = 0;
                }
                if ('jitterBufferTarget' in event.receiver) {
                    event.receiver.jitterBufferTarget = 0;
                }
            }

            // Reset remoteStream for fresh tracks to prevent accumulation
            if (!CallState.remoteStream) {
                CallState.remoteStream = new MediaStream();
            }

            // Check for duplicate tracks
            const existingTrack = CallState.remoteStream.getTrackById(event.track.id);
            if (existingTrack) return;

            CallState.remoteStream.addTrack(event.track);
            callLog('REMOTE_TRACK_ADDED', { kind: event.track.kind, id: event.track.id });

            if (CallState.callType === 'video' && DOM.remoteVideo) {
                DOM.remoteVideo.srcObject = CallState.remoteStream;
                DOM.remoteVideo.play().catch(() => {});
            }

            if (DOM.remoteAudio) {
                DOM.remoteAudio.srcObject = CallState.remoteStream;
                DOM.remoteAudio.play().catch(() => {});
            }

            // Hook up remote audio to visualizer
            if (event.track.kind === 'audio') {
                setupAudioVisualizer(CallState.remoteStream);
            }

            // Monitor track ended for remote camera-off detection
            event.track.onended = () => {
                callLog('REMOTE_TRACK_ENDED', { kind: event.track.kind });
            };
            event.track.onmute = () => {
                if (event.track.kind === 'video' && DOM.remoteCameraOffOverlay) {
                    DOM.remoteCameraOffOverlay.style.display = 'flex';
                }
            };
            event.track.onunmute = () => {
                if (event.track.kind === 'video' && DOM.remoteCameraOffOverlay) {
                    DOM.remoteCameraOffOverlay.style.display = 'none';
                }
            };
        };

        // ICE candidate exchange
        pc.onicecandidate = (event) => {
            if (event.candidate && CallState.callId) {
                sendSignalingMessage('ice-candidate', event.candidate);
            }
        };

        // Connection state monitoring
        pc.onconnectionstatechange = () => {
            if (pc !== CallState.peerConnection) return; // Stale PC
            const state = pc.connectionState;
            callLog('WEBRTC_CONNECTION_STATE', { state });

            if (state === 'connected') {
                clearReconnectTimers();
                if (transitionState('connected')) {
                    updateConnectionStatusUI('Connected', true);
                    playCallConnectedChime();
                    startCallTimer();
                }
            } else if (state === 'connecting') {
                updateConnectionStatusUI('Connecting...');
            } else if (state === 'disconnected') {
                handleDisconnected();
            } else if (state === 'failed') {
                handleConnectionFailed();
            } else if (state === 'closed') {
                if (!TERMINAL_STATES.has(CallState.state)) {
                    endCallLocally('Connection closed');
                }
            }
        };

        pc.oniceconnectionstatechange = () => {
            if (pc !== CallState.peerConnection) return;
            const iceState = pc.iceConnectionState;
            callLog('ICE_CONNECTION_STATE', { state: iceState });

            if (iceState === 'failed' && !CallState.iceRestartAttempted) {
                attemptIceRestart();
            }
        };

        return pc;
    }

    function sendSignalingMessage(type, data) {
        if (!CallState.callId) return;

        // 1. Fast Path: Cloudflare Edge WebSocket (<10ms transmission)
        if (edgeWsReady && edgeWs && edgeWs.readyState === WebSocket.OPEN) {
            try {
                edgeWs.send(JSON.stringify({
                    callId: CallState.callId,
                    type,
                    data
                }));
                callLog('SIGNAL_SENT_EDGE_WS', { type });
                return;
            } catch (e) {
                // Fall through to VPS HTTP fallback
            }
        }

        // 2. Fallback Path: VPS HTTP POST
        fetch('/api/call/signal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callId: CallState.callId,
                type,
                data
            })
        }).catch(err => {
            callLog('SIGNAL_POST_ERROR', { type, error: err.message });
        });
    }

    // ------------------------------------------------------------
    //  9. RECONNECTION STRATEGY
    // ------------------------------------------------------------
    function handleDisconnected() {
        // WebRTC 'disconnected' is often temporary (network hiccup)
        // Wait 15s before considering it a failure
        if (CallState.state === 'connected') {
            transitionState('reconnecting');
            updateConnectionStatusUI('Reconnecting...');
            callLog('RECONNECT_WAITING', { timeout: '15s' });

            clearReconnectTimers();
            CallState.reconnectTimeoutId = setTimeout(() => {
                if (CallState.state === 'reconnecting') {
                    callLog('RECONNECT_TIMEOUT_EXPIRED');
                    attemptIceRestart();
                }
            }, 15000);
        }
    }

    function handleConnectionFailed() {
        if (CallState.iceRestartAttempted) {
            callLog('WEBRTC_FAILED_AFTER_RESTART');
            endCallLocally('Connection failed');
            notifyServerEndCall('webrtc_failed');
        } else {
            attemptIceRestart();
        }
    }

    function attemptIceRestart() {
        if (CallState.iceRestartAttempted) {
            callLog('ICE_RESTART_ALREADY_ATTEMPTED');
            endCallLocally('Connection could not be restored');
            notifyServerEndCall('ice_restart_failed');
            return;
        }

        CallState.iceRestartAttempted = true;
        callLog('ICE_RESTART_ATTEMPTING');

        if (!transitionState('reconnecting')) {
            // Already in reconnecting or terminal state
            return;
        }
        updateConnectionStatusUI('Reconnecting...');

        const pc = CallState.peerConnection;
        if (!pc || pc.connectionState === 'closed') {
            endCallLocally('Connection lost');
            notifyServerEndCall('pc_closed');
            return;
        }

        try {
            pc.restartIce();
        } catch (e) {
            callLog('ICE_RESTART_ERROR', { error: e.message });
        }

        // Give ICE restart 10s to recover
        clearReconnectTimers();
        CallState.iceRestartTimeoutId = setTimeout(() => {
            if (CallState.state === 'reconnecting') {
                callLog('ICE_RESTART_TIMEOUT');
                endCallLocally('Unable to reconnect');
                notifyServerEndCall('reconnect_timeout');
            }
        }, 10000);
    }

    function clearReconnectTimers() {
        if (CallState.reconnectTimeoutId) {
            clearTimeout(CallState.reconnectTimeoutId);
            CallState.reconnectTimeoutId = null;
        }
        if (CallState.iceRestartTimeoutId) {
            clearTimeout(CallState.iceRestartTimeoutId);
            CallState.iceRestartTimeoutId = null;
        }
    }

    // Helper to notify server an end-call
    function notifyServerEndCall(reason) {
        const id = CallState.callId;
        const dur = CallState.durationSeconds;
        if (id) {
            fetch('/api/call/end', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callId: id, durationSeconds: dur, reason, _csrf: CSRF_TOKEN })
            }).catch(() => {});
        }
    }

    // ------------------------------------------------------------
    //  10. CALL LIFECYCLE FLOWS
    // ------------------------------------------------------------
    async function startCall(callType = 'audio') {
        if (CallState.state !== 'idle') {
            showInlineAlert('A call is already in progress.');
            return;
        }

        _callNonce++;
        const nonce = _callNonce;

        try {
            if (!transitionState('calling')) return;
            CallState.callNonce = nonce;
            CallState.callType = callType;
            CallState.isCaller = true;
            CallState.durationSeconds = 0;
            CallState.iceCandidatesQueue = [];

            // Acquire local media first
            await acquireLocalMedia(callType === 'video');

            // Check nonce hasn't changed (user may have cancelled during permission dialog)
            if (CallState.callNonce !== nonce) return;

            // Send initiate call request
            const res = await fetch('/api/call/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callType })
            });

            const data = await res.json();
            if (!data.success) {
                showInlineAlert(data.error || 'Could not place call.');
                cleanupCallState();
                return;
            }

            // Check nonce again
            if (CallState.callNonce !== nonce) return;

            CallState.callId = data.callId;
            callLog('CALL_STARTED', { callId: data.callId, type: callType });

            // Show active call screen with calling state
            showActiveCallModal();
            updateConnectionStatusUI('Ringing...');
            startOutgoingRingback();

            // Client-side ring timeout (50s to give server 45s timeout room)
            CallState.ringTimeoutId = setTimeout(() => {
                if (CallState.state === 'calling' && CallState.callNonce === nonce) {
                    callLog('CLIENT_RING_TIMEOUT');
                    endCallLocally('No answer');
                }
            }, 50000);

        } catch (err) {
            callLog('START_CALL_FAILED', { error: err.message });
            cleanupCallState();
        }
    }

    async function acceptIncomingCall() {
        if (!CallState.callId) return;
        if (CallState.state !== 'ringing') {
            callLog('ACCEPT_BLOCKED', { state: CallState.state });
            return;
        }

        const nonce = CallState.callNonce;

        try {
            stopRingtone();
            hideIncomingCallModal();

            // Prime audio playback & Web Audio context within direct user gesture (bypasses mobile autoplay policies)
            getAudioContext();
            if (DOM.remoteAudio) {
                DOM.remoteAudio.play().catch(() => {});
            }

            if (!transitionState('connecting')) return;
            CallState.isCaller = false;

            await acquireLocalMedia(CallState.callType === 'video');
            if (CallState.callNonce !== nonce) return;

            // Create peer connection AFTER media acquired
            createPeerConnection();

            showActiveCallModal();
            updateConnectionStatusUI('Connecting...');

            const res = await fetch('/api/call/accept', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callId: CallState.callId })
            });

            const data = await res.json();
            if (!data.success) {
                callLog('ACCEPT_SERVER_ERROR', { error: data.error });
                showInlineAlert(data.error || 'Failed to accept call.');
                endCallLocally('Failed to accept');
            }
        } catch (err) {
            callLog('ACCEPT_CALL_FAILED', { error: err.message });
            endCallLocally('Accept failed');
        }
    }

    async function rejectIncomingCall() {
        if (!CallState.callId) return;
        const id = CallState.callId;
        callLog('CALL_REJECTED_BY_USER', { callId: id });

        hideIncomingCallModal();
        cleanupCallState();

        try {
            await fetch('/api/call/reject', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callId: id, reason: 'declined' })
            });
        } catch (e) {}
    }

    async function cancelCall() {
        if (!CallState.callId) return;
        const id = CallState.callId;
        callLog('CALL_CANCELLED_BY_CALLER', { callId: id });

        endCallLocally('Cancelled');

        try {
            await fetch('/api/call/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callId: id })
            });
        } catch (e) {}
    }

    async function endCall() {
        if (CallState.state === 'idle') return;

        // If still in calling state (not yet connected), cancel instead
        if (CallState.state === 'calling') {
            return cancelCall();
        }

        const id = CallState.callId;
        const duration = CallState.durationSeconds;
        callLog('CALL_END_BY_USER', { callId: id, duration });

        endCallLocally('Ended');

        if (id) {
            try {
                await fetch('/api/call/end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callId: id,
                        durationSeconds: duration,
                        reason: 'user_ended',
                        _csrf: CSRF_TOKEN
                    })
                });
            } catch (e) {}
        }
    }

    function showCallHudToast(title, subtitle, variant = 'info') {
        let toast = document.getElementById('globalCallHudToast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'globalCallHudToast';
            toast.className = 'call-hud-toast';
            document.body.appendChild(toast);
        }

        const iconSvg = variant === 'success'
            ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#34d399" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>`
            : (variant === 'danger'
                ? `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#fb7185" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`
                : `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="#38bdf8" stroke-width="2.5"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>`);

        toast.className = `call-hud-toast call-hud-${variant} is-visible`;
        toast.innerHTML = `
            <div class="call-hud-icon">${iconSvg}</div>
            <div class="call-hud-text">
                <span class="call-hud-title">${title}</span>
                ${subtitle ? `<span class="call-hud-subtitle">${subtitle}</span>` : ''}
            </div>
        `;

        clearTimeout(toast._dismissTimer);
        toast._dismissTimer = setTimeout(() => {
            toast.classList.remove('is-visible');
        }, 3500);
    }

    function endCallLocally(reason = 'Ended') {
        if (CallState.state === 'idle') return; // Already cleaned up

        const duration = CallState.durationSeconds;
        callLog('CALL_ENDED_LOCALLY', { reason, callId: CallState.callId, duration });

        playCallEndedChime();
        stopAudioVisualizer();
        hideActiveCallModal();
        hideIncomingCallModal();
        hideMinimizedPill();

        // Show HUD Feedback
        if (duration > 0) {
            const mins = Math.floor(duration / 60);
            const secs = duration % 60;
            const durStr = mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
            showCallHudToast('Call Ended', `Duration: ${durStr}`, 'info');
        } else if (reason === 'Rejected') {
            showCallHudToast('Call Declined', 'Call was declined', 'danger');
        } else if (reason === 'No answer' || reason === 'Timeout') {
            showCallHudToast('Call Missed', 'No answer', 'danger');
        } else if (reason === 'Cancelled') {
            showCallHudToast('Call Cancelled', 'Call was cancelled', 'info');
        }

        // Hide reconnect/error banners
        if (DOM.reconnectBanner) DOM.reconnectBanner.style.display = 'none';
        if (DOM.inlineAlert) DOM.inlineAlert.style.display = 'none';
        if (DOM.remoteCameraOffOverlay) DOM.remoteCameraOffOverlay.style.display = 'none';

        cleanupCallState();
    }

    // IDEMPOTENT cleanup — safe to call multiple times
    function cleanupCallState() {
        stopRingtone();
        stopCallTimer();
        stopAudioVisualizer();
        clearReconnectTimers();

        // Clear ring timeout
        if (CallState.ringTimeoutId) {
            clearTimeout(CallState.ringTimeoutId);
            CallState.ringTimeoutId = null;
        }

        // Stop all local tracks
        if (CallState.localStream) {
            CallState.localStream.getTracks().forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            CallState.localStream = null;
        }

        // Stop remote tracks
        if (CallState.remoteStream) {
            CallState.remoteStream.getTracks().forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            CallState.remoteStream = null;
        }

        // Close peer connection
        if (CallState.peerConnection) {
            // Remove event handlers to prevent further callbacks
            const pc = CallState.peerConnection;
            pc.ontrack = null;
            pc.onicecandidate = null;
            pc.onconnectionstatechange = null;
            pc.oniceconnectionstatechange = null;
            try { pc.close(); } catch (e) {}
            CallState.peerConnection = null;
        }

        // Clear media element references
        if (DOM.remoteVideo) DOM.remoteVideo.srcObject = null;
        if (DOM.localVideo) DOM.localVideo.srcObject = null;
        if (DOM.remoteAudio) DOM.remoteAudio.srcObject = null;

        // Reset state
        CallState.state = 'idle';
        CallState.callId = null;
        CallState.isMuted = false;
        CallState.isCameraOff = false;
        CallState.isSpeakerOff = false;
        CallState.isMinimized = false;
        CallState.iceCandidatesQueue = [];
        CallState.iceRestartAttempted = false;

        // Reset control button styles
        if (DOM.btnMute) {
            DOM.btnMute.classList.remove('is-disabled-state');
            const micOn = DOM.btnMute.querySelector('.icon-mic-on');
            const micOff = DOM.btnMute.querySelector('.icon-mic-off');
            if (micOn) micOn.style.display = 'block';
            if (micOff) micOff.style.display = 'none';
        }
        if (DOM.callMuteLabel) DOM.callMuteLabel.textContent = 'Mute';

        if (DOM.btnCamera) {
            DOM.btnCamera.classList.remove('is-disabled-state');
            const camOn = DOM.btnCamera.querySelector('.icon-cam-on');
            const camOff = DOM.btnCamera.querySelector('.icon-cam-off');
            if (camOn) camOn.style.display = 'block';
            if (camOff) camOff.style.display = 'none';
        }

        if (DOM.btnSpeaker) {
            DOM.btnSpeaker.classList.remove('is-disabled-state');
            const spkOn = DOM.btnSpeaker.querySelector('.icon-speaker-on');
            const spkOff = DOM.btnSpeaker.querySelector('.icon-speaker-off');
            if (spkOn) spkOn.style.display = 'block';
            if (spkOff) spkOff.style.display = 'none';
        }
        if (DOM.callSpeakerLabel) DOM.callSpeakerLabel.textContent = 'Speaker';
    }

    // ------------------------------------------------------------
    //  11. CONTROLS TOGGLE (Mute, Camera, Speaker)
    // ------------------------------------------------------------
    function toggleMute() {
        if (!CallState.localStream) return;
        const audioTracks = CallState.localStream.getAudioTracks();
        if (audioTracks.length === 0) return;

        CallState.isMuted = !CallState.isMuted;
        audioTracks.forEach(track => {
            track.enabled = !CallState.isMuted;
        });

        callLog('TOGGLE_MUTE', { muted: CallState.isMuted });

        // Notify partner of media state change
        sendSignalingMessage('media-state', { muted: CallState.isMuted });

        if (DOM.btnMute) {
            const micOn = DOM.btnMute.querySelector('.icon-mic-on');
            const micOff = DOM.btnMute.querySelector('.icon-mic-off');

            if (CallState.isMuted) {
                DOM.btnMute.classList.add('is-disabled-state');
                if (micOn) micOn.style.display = 'none';
                if (micOff) micOff.style.display = 'block';
                if (DOM.callMuteLabel) DOM.callMuteLabel.textContent = 'Unmute';
            } else {
                DOM.btnMute.classList.remove('is-disabled-state');
                if (micOn) micOn.style.display = 'block';
                if (micOff) micOff.style.display = 'none';
                if (DOM.callMuteLabel) DOM.callMuteLabel.textContent = 'Mute';
            }
        }
    }

    function toggleCamera() {
        if (!CallState.localStream || CallState.callType !== 'video') return;
        const videoTracks = CallState.localStream.getVideoTracks();
        if (videoTracks.length === 0) return;

        CallState.isCameraOff = !CallState.isCameraOff;
        videoTracks.forEach(track => {
            track.enabled = !CallState.isCameraOff;
        });

        callLog('TOGGLE_CAMERA', { cameraOff: CallState.isCameraOff });

        // Notify partner of media state change
        sendSignalingMessage('media-state', { cameraOff: CallState.isCameraOff });

        if (DOM.btnCamera) {
            const camOn = DOM.btnCamera.querySelector('.icon-cam-on');
            const camOff = DOM.btnCamera.querySelector('.icon-cam-off');

            if (CallState.isCameraOff) {
                DOM.btnCamera.classList.add('is-disabled-state');
                if (camOn) camOn.style.display = 'none';
                if (camOff) camOff.style.display = 'block';
                if (DOM.callCamLabel) DOM.callCamLabel.textContent = 'Turn On';
            } else {
                DOM.btnCamera.classList.remove('is-disabled-state');
                if (camOn) camOn.style.display = 'block';
                if (camOff) camOff.style.display = 'none';
                if (DOM.callCamLabel) DOM.callCamLabel.textContent = 'Camera';
            }
        }
    }

    function toggleSpeaker() {
        if (!DOM.remoteAudio) return;
        CallState.isSpeakerOff = !CallState.isSpeakerOff;
        DOM.remoteAudio.muted = CallState.isSpeakerOff;
        if (DOM.remoteVideo) DOM.remoteVideo.muted = CallState.isSpeakerOff;

        callLog('TOGGLE_SPEAKER', { speakerOff: CallState.isSpeakerOff });

        if (DOM.btnSpeaker) {
            const spkOn = DOM.btnSpeaker.querySelector('.icon-speaker-on');
            const spkOff = DOM.btnSpeaker.querySelector('.icon-speaker-off');

            if (CallState.isSpeakerOff) {
                DOM.btnSpeaker.classList.add('is-disabled-state');
                if (spkOn) spkOn.style.display = 'none';
                if (spkOff) spkOff.style.display = 'block';
                if (DOM.callSpeakerLabel) DOM.callSpeakerLabel.textContent = 'Unmute';
            } else {
                DOM.btnSpeaker.classList.remove('is-disabled-state');
                if (spkOn) spkOn.style.display = 'block';
                if (spkOff) spkOff.style.display = 'none';
                if (DOM.callSpeakerLabel) DOM.callSpeakerLabel.textContent = 'Speaker';
            }
        }
    }

    async function flipCamera() {
        if (!CallState.localStream || CallState.callType !== 'video') return;
        const currentFacing = CallState.facingMode || 'user';
        const nextFacing = currentFacing === 'user' ? 'environment' : 'user';
        CallState.facingMode = nextFacing;

        try {
            const oldTrack = CallState.localStream.getVideoTracks()[0];
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: nextFacing,
                    width: { ideal: 1280, max: 1920 },
                    height: { ideal: 720, max: 1080 }
                }
            }).catch(() => {
                return navigator.mediaDevices.getUserMedia({ video: true });
            });

            const newTrack = newStream.getVideoTracks()[0];
            if (newTrack) {
                if (CallState.peerConnection) {
                    const senders = CallState.peerConnection.getSenders();
                    const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                    if (videoSender) {
                        videoSender.replaceTrack(newTrack);
                    }
                }
                if (oldTrack) {
                    oldTrack.stop();
                    CallState.localStream.removeTrack(oldTrack);
                }
                CallState.localStream.addTrack(newTrack);
                if (DOM.localVideo) {
                    DOM.localVideo.srcObject = CallState.localStream;
                    DOM.localVideo.style.transform = nextFacing === 'user' ? 'scaleX(-1)' : 'none';
                }
                callLog('CAMERA_FLIPPED', { facingMode: nextFacing });
            }
        } catch (e) {
            callLog('CAMERA_FLIP_ERROR', { error: e.message });
        }
    }

    // ------------------------------------------------------------
    //  12. SSE SIGNALING HANDLERS
    // ------------------------------------------------------------
    async function handleIncomingCallEvent(data) {
        if (CallState.state !== 'idle') {
            // Already busy — auto-reject
            callLog('INCOMING_REJECTED_BUSY', { callId: data.callId });
            fetch('/api/call/reject', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callId: data.callId, reason: 'busy' })
            }).catch(() => {});
            return;
        }

        _callNonce++;
        CallState.callNonce = _callNonce;

        if (!transitionState('ringing')) return;
        CallState.callId = data.callId;
        CallState.callType = data.callType || 'audio';
        CallState.isCaller = false;

        callLog('INCOMING_CALL', { callId: data.callId, type: data.callType, from: data.caller });

        showIncomingCallModal(data);
    }

    function optimizeSdp(sdp) {
        if (!sdp) return sdp;
        let modified = sdp;
        // 1. Opus voice ultra-low latency packetization (ptime=10ms, maxaveragebitrate=64000, cbr=1)
        if (modified.includes('opus/48000')) {
            modified = modified.replace(
                /(a=fmtp:\d+ .*?minptime=\d+;useinbandfec=1[^\r\n]*)/g,
                '$1;ptime=10;minptime=10;maxaveragebitrate=64000;cbr=1;usedtx=1'
            );
            if (!modified.includes('ptime=10')) {
                modified = modified.replace(
                    /(a=rtpmap:(\d+) opus\/48000\/2[^\r\n]*)/g,
                    '$1\r\na=fmtp:$2 ptime=10;minptime=10;maxaveragebitrate=64000;stereo=0;sprop-stereo=0;useinbandfec=1;usedtx=1;cbr=1'
                );
            }
        }
        return modified;
    }

    async function handleCallAcceptedEvent(data) {
        if (!CallState.isCaller || CallState.callId !== data.callId) return;
        if (CallState.state !== 'calling') {
            callLog('ACCEPTED_IGNORED_WRONG_STATE', { state: CallState.state });
            return;
        }

        callLog('CALL_ACCEPTED_BY_REMOTE', { callId: data.callId });

        stopRingtone();
        // Clear ring timeout
        if (CallState.ringTimeoutId) {
            clearTimeout(CallState.ringTimeoutId);
            CallState.ringTimeoutId = null;
        }

        if (!transitionState('connecting')) return;
        updateConnectionStatusUI('Connecting...');

        // Caller initiates WebRTC offer
        try {
            const pc = createPeerConnection();
            const rawOffer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: CallState.callType === 'video'
            });
            const offer = {
                type: rawOffer.type,
                sdp: optimizeSdp(rawOffer.sdp)
            };
            await pc.setLocalDescription(offer);

            callLog('WEBRTC_OFFER_SENT', { sdpOptimized: true });
            sendSignalingMessage('offer', offer);
        } catch (err) {
            callLog('WEBRTC_OFFER_ERROR', { error: err.message });
            endCallLocally('Offer error');
            notifyServerEndCall('offer_failed');
        }
    }

    async function handleCallSignalEvent(signal) {
        if (!CallState.callId || CallState.callId !== signal.callId) return;

        // In-call emoji reaction message
        if (signal.type === 'call-emoji' && signal.data && signal.data.emoji) {
            spawnInCallEmoji(signal.data.emoji);
            return;
        }

        // Media state update from partner
        if (signal.type === 'media-state' && signal.data) {
            if (signal.data.cameraOff !== undefined && DOM.remoteCameraOffOverlay) {
                DOM.remoteCameraOffOverlay.style.display = signal.data.cameraOff ? 'flex' : 'none';
            }
            return;
        }

        const pc = CallState.peerConnection;
        if (!pc) return;

        try {
            if (signal.type === 'offer') {
                callLog('WEBRTC_OFFER_RECEIVED');
                await pc.setRemoteDescription(new RTCSessionDescription(signal.data));

                // Process any queued ICE candidates
                while (CallState.iceCandidatesQueue.length > 0) {
                    const candidate = CallState.iceCandidatesQueue.shift();
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }

                const rawAnswer = await pc.createAnswer();
                const answer = {
                    type: rawAnswer.type,
                    sdp: optimizeSdp(rawAnswer.sdp)
                };
                await pc.setLocalDescription(answer);
                callLog('WEBRTC_ANSWER_SENT', { sdpOptimized: true });
                sendSignalingMessage('answer', answer);

            } else if (signal.type === 'answer') {
                callLog('WEBRTC_ANSWER_RECEIVED');
                await pc.setRemoteDescription(new RTCSessionDescription(signal.data));

                // Process any queued ICE candidates
                while (CallState.iceCandidatesQueue.length > 0) {
                    const candidate = CallState.iceCandidatesQueue.shift();
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }

            } else if (signal.type === 'ice-candidate') {
                if (pc.remoteDescription && pc.remoteDescription.type) {
                    await pc.addIceCandidate(new RTCIceCandidate(signal.data));
                } else {
                    CallState.iceCandidatesQueue.push(signal.data);
                }
            } else if (signal.type === 'ice-restart') {
                callLog('ICE_RESTART_SIGNAL_RECEIVED');
                // Partner requested ICE restart — recreate offer/answer
            }
        } catch (err) {
            callLog('SIGNAL_HANDLING_ERROR', { type: signal.type, error: err.message });
        }
    }

    // ------------------------------------------------------------
    //  13. EVENT LISTENERS & INTEGRATION
    // ------------------------------------------------------------
    function setupDomEvents() {
        if (DOM.incomingAcceptBtn) {
            DOM.incomingAcceptBtn.addEventListener('click', acceptIncomingCall);
        }
        if (DOM.incomingDeclineBtn) {
            DOM.incomingDeclineBtn.addEventListener('click', rejectIncomingCall);
        }

        if (DOM.btnEnd) {
            DOM.btnEnd.addEventListener('click', endCall);
        }
        if (DOM.btnMute) {
            DOM.btnMute.addEventListener('click', toggleMute);
        }
        if (DOM.btnCamera) {
            DOM.btnCamera.addEventListener('click', toggleCamera);
        }
        if (DOM.btnCameraFlip) {
            DOM.btnCameraFlip.addEventListener('click', flipCamera);
        }
        if (DOM.btnSpeaker) {
            DOM.btnSpeaker.addEventListener('click', toggleSpeaker);
        }

        if (DOM.btnMinimize) {
            DOM.btnMinimize.addEventListener('click', () => {
                hideActiveCallModal();
                showMinimizedPill();
            });
        }

        if (DOM.minimizedPill) {
            DOM.minimizedPill.addEventListener('click', (e) => {
                if (e.target.closest('#minimizedQuickEndBtn')) return;
                hideMinimizedPill();
                showActiveCallModal();
            });
        }

        if (DOM.minimizedQuickEnd) {
            DOM.minimizedQuickEnd.addEventListener('click', (e) => {
                e.stopPropagation();
                endCall();
            });
        }

        // Inline alert close
        if (DOM.inlineAlertClose) {
            DOM.inlineAlertClose.addEventListener('click', () => {
                if (DOM.inlineAlert) DOM.inlineAlert.style.display = 'none';
            });
        }

        // Quick In-Call Reaction Emojis
        document.querySelectorAll('.call-quick-emoji-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const emoji = btn.getAttribute('data-call-emoji') || btn.textContent.trim();
                spawnInCallEmoji(emoji);
                sendSignalingMessage('call-emoji', { emoji });
            });
        });

        // Header call buttons in messages view
        document.addEventListener('click', (e) => {
            const audioBtn = e.target.closest('#msgHeaderAudioCallBtn, .btn-trigger-audio-call');
            if (audioBtn) {
                e.preventDefault();
                startCall('audio');
                return;
            }

            const videoBtn = e.target.closest('#msgHeaderVideoCallBtn, .btn-trigger-video-call');
            if (videoBtn) {
                e.preventDefault();
                startCall('video');
                return;
            }
        });

        // Touch drag for Picture-in-Picture window and Minimized Pill on mobile
        setupPipDraggable();
        setupMinimizedPillDraggable();

        // Window unload cleanup — use Blob for proper Content-Type
        window.addEventListener('beforeunload', () => {
            if (CallState.state !== 'idle' && CallState.callId) {
                const payload = JSON.stringify({
                    callId: CallState.callId,
                    durationSeconds: CallState.durationSeconds,
                    reason: 'page_unload',
                    _csrf: CSRF_TOKEN
                });
                const blob = new Blob([payload], { type: 'application/json' });
                navigator.sendBeacon('/api/call/end', blob);
            }
        });

        // Page hide (tab close / navigation on mobile)
        window.addEventListener('pagehide', (e) => {
            if (CallState.state !== 'idle' && CallState.callId && !e.persisted) {
                const payload = JSON.stringify({
                    callId: CallState.callId,
                    durationSeconds: CallState.durationSeconds,
                    reason: 'page_hide',
                    _csrf: CSRF_TOKEN
                });
                const blob = new Blob([payload], { type: 'application/json' });
                navigator.sendBeacon('/api/call/end', blob);
            }
        });

        // Visibility change — pause/resume visualizer & optimize video track on Android backgrounding
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                // Pause visualizer to save CPU & battery
                if (visualizerAnimationId) {
                    cancelAnimationFrame(visualizerAnimationId);
                    visualizerAnimationId = null;
                }
                // If in a video call, temporarily pause local video track to save battery & data
                if (CallState.localStream && CallState.callType === 'video' && !CallState.isCameraOff) {
                    const videoTracks = CallState.localStream.getVideoTracks();
                    videoTracks.forEach(t => { t.enabled = false; });
                    sendSignalingMessage('media-state', { cameraOff: true });
                }
            } else if (document.visibilityState === 'visible') {
                // Resume visualizer if in a call
                if ((CallState.state === 'connected' || CallState.state === 'connecting') && audioAnalyser) {
                    startVisualizerLoop();
                }
                // Resume video track if user had camera active
                if (CallState.localStream && CallState.callType === 'video' && !CallState.isCameraOff) {
                    const videoTracks = CallState.localStream.getVideoTracks();
                    videoTracks.forEach(t => { t.enabled = true; });
                    sendSignalingMessage('media-state', { cameraOff: false });
                }
                // Check WebRTC connection state
                if (CallState.peerConnection && CallState.state === 'connected') {
                    const pcState = CallState.peerConnection.connectionState;
                    if (pcState === 'disconnected' || pcState === 'failed') {
                        handleDisconnected();
                    }
                }
            }
        });

        // Online/Offline detection
        window.addEventListener('offline', () => {
            if (CallState.state === 'connected') {
                callLog('NETWORK_OFFLINE');
                transitionState('reconnecting');
                updateConnectionStatusUI('Network disconnected...');
            }
        });

        window.addEventListener('online', () => {
            if (!edgeWsReady) initEdgeSignaling();
            if (CallState.state === 'reconnecting') {
                callLog('NETWORK_ONLINE');
                updateConnectionStatusUI('Reconnecting...');
                // Check if WebRTC connection recovered
                if (CallState.peerConnection) {
                    const pcState = CallState.peerConnection.connectionState;
                    if (pcState === 'connected') {
                        transitionState('connected');
                        updateConnectionStatusUI('Connected', true);
                    } else if (pcState === 'failed' || pcState === 'disconnected') {
                        attemptIceRestart();
                    }
                }
            }
        });

        // Start Cloudflare Edge WebSocket signaling in background
        initEdgeSignaling();
    }

    function setupPipDraggable() {
        const pip = DOM.localVideoPip;
        if (!pip) return;

        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        const onTouchStart = (e) => {
            isDragging = true;
            const touch = e.touches ? e.touches[0] : e;
            startX = touch.clientX;
            startY = touch.clientY;
            const rect = pip.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
        };

        const onTouchMove = (e) => {
            if (!isDragging) return;
            const touch = e.touches ? e.touches[0] : e;
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;

            let newLeft = Math.max(10, Math.min(window.innerWidth - pip.offsetWidth - 10, initialLeft + dx));
            let newTop = Math.max(60, Math.min(window.innerHeight - pip.offsetHeight - 80, initialTop + dy));

            pip.style.left = `${newLeft}px`;
            pip.style.top = `${newTop}px`;
            pip.style.right = 'auto';
        };

        const onTouchEnd = () => {
            isDragging = false;
        };

        pip.addEventListener('touchstart', onTouchStart, { passive: true });
        window.addEventListener('touchmove', onTouchMove, { passive: true });
        window.addEventListener('touchend', onTouchEnd);
        pip.addEventListener('mousedown', onTouchStart);
        window.addEventListener('mousemove', onTouchMove);
        window.addEventListener('mouseup', onTouchEnd);
    }

    function setupMinimizedPillDraggable() {
        const pill = DOM.minimizedPill;
        if (!pill) return;

        let isDragging = false;
        let hasMoved = false;
        let startX, startY, initialLeft, initialTop;

        const onTouchStart = (e) => {
            if (e.target.closest('#minimizedQuickEndBtn')) return;
            isDragging = true;
            hasMoved = false;
            const touch = e.touches ? e.touches[0] : e;
            startX = touch.clientX;
            startY = touch.clientY;
            const rect = pill.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
        };

        const onTouchMove = (e) => {
            if (!isDragging) return;
            const touch = e.touches ? e.touches[0] : e;
            const dx = touch.clientX - startX;
            const dy = touch.clientY - startY;

            if (Math.abs(dx) > 6 || Math.abs(dy) > 6) {
                hasMoved = true;
            }

            let newLeft = Math.max(8, Math.min(window.innerWidth - pill.offsetWidth - 8, initialLeft + dx));
            let newTop = Math.max(10, Math.min(window.innerHeight - pill.offsetHeight - 60, initialTop + dy));

            pill.style.left = `${newLeft}px`;
            pill.style.top = `${newTop}px`;
            pill.style.bottom = 'auto';
        };

        const onTouchEnd = () => {
            isDragging = false;
        };

        pill.addEventListener('touchstart', onTouchStart, { passive: true });
        window.addEventListener('touchmove', onTouchMove, { passive: true });
        window.addEventListener('touchend', onTouchEnd);
        pill.addEventListener('mousedown', onTouchStart);
        window.addEventListener('mousemove', onTouchMove);
        window.addEventListener('mouseup', onTouchEnd);
    }

    // Global custom event listeners dispatched from SSE (registered ONCE)
    window.addEventListener('call:incoming', (e) => handleIncomingCallEvent(e.detail));
    window.addEventListener('call:accepted', (e) => handleCallAcceptedEvent(e.detail));
    window.addEventListener('call:signal', (e) => handleCallSignalEvent(e.detail));
    window.addEventListener('call:rejected', (e) => {
        if (e.detail && e.detail.callId && e.detail.callId !== CallState.callId) return;
        callLog('CALL_REJECTED_BY_REMOTE');
        endCallLocally('Rejected');
    });
    window.addEventListener('call:cancelled', (e) => {
        if (e.detail && e.detail.callId && e.detail.callId !== CallState.callId) return;
        callLog('CALL_CANCELLED_BY_REMOTE');
        endCallLocally('Cancelled');
    });
    window.addEventListener('call:ended', (e) => {
        if (e.detail && e.detail.callId && e.detail.callId !== CallState.callId) return;
        callLog('CALL_ENDED_BY_REMOTE');
        endCallLocally('Ended');
    });
    window.addEventListener('call:timeout', (e) => {
        if (e.detail && e.detail.callId && e.detail.callId !== CallState.callId) return;
        callLog('CALL_TIMEOUT_FROM_SERVER');
        endCallLocally('No answer');
    });

    // Clean up call on page navigation or unload
    function handlePageUnload() {
        if (CallState.callId && !TERMINAL_STATES.has(CallState.state)) {
            const payload = JSON.stringify({
                callId: CallState.callId,
                durationSeconds: CallState.durationSeconds,
                reason: 'page_unload',
                _csrf: CSRF_TOKEN
            });

            if (navigator.sendBeacon) {
                const blob = new Blob([payload], { type: 'application/json' });
                navigator.sendBeacon('/api/call/end', blob);
            } else {
                fetch('/api/call/end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: payload,
                    keepalive: true
                }).catch(() => {});
            }
        }
    }
    window.addEventListener('beforeunload', handlePageUnload);
    window.addEventListener('pagehide', handlePageUnload);

    // Global API object
    window.VideoHostCall = {
        startCall,
        acceptIncomingCall,
        rejectIncomingCall,
        cancelCall,
        endCall,
        getState: () => ({ ...CallState })
    };

    // Initialize on DOM load
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', setupDomEvents);
    } else {
        setupDomEvents();
    }

})();
