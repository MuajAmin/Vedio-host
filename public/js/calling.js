// ============================================================
//  WEBRTC REAL-TIME CALL CONTROLLER (AUDIO & VIDEO)
//  Frontend Design Fidelity, Web Audio Frequency Visualizer,
//  In-Call Reactions & High-Precision PeerConnection Lifecycle
// ============================================================

(function () {
    'use strict';

    const currentUser = document.body.getAttribute('data-user') || '';
    if (!currentUser) return; // Not logged in

    const partnerUser = currentUser === 'muaj' ? 'hajera' : 'muaj';
    const partnerName = partnerUser === 'muaj' ? 'Muaj' : 'Hajera';

    // ------------------------------------------------------------
    //  1. WEBRTC CONFIGURATION
    // ------------------------------------------------------------
    const RTC_CONFIG = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' },
            { urls: 'stun:stun3.l.google.com:19302' },
            { urls: 'stun:stun4.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 6
    };

    // ------------------------------------------------------------
    //  2. WEB AUDIO SYNTHESIZER & REAL-TIME SPECTRUM ANALYSER
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
            // Melodic ringtone pattern: F5 (698.46Hz) -> A5 (880Hz) -> C6 (1046.50Hz)
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
            // Dual tone ringback: 440Hz + 480Hz
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
            console.warn('[AudioVisualizer] Setup notice:', e.message);
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
                    // Min 6px, Max 36px
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
    //  3. CALL STATE STORE
    // ------------------------------------------------------------
    const CallState = {
        state: 'idle', // idle | calling | ringing | connecting | connected | reconnecting | ended
        callId: null,
        callType: 'audio', // audio | video
        isCaller: false,
        partner: partnerUser,
        localStream: null,
        remoteStream: null,
        peerConnection: null,
        durationSeconds: 0,
        timerInterval: null,
        isMuted: false,
        isCameraOff: false,
        isMinimized: false,
        iceCandidatesQueue: []
    };

    // ------------------------------------------------------------
    //  4. DOM REFERENCES
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
        activeAvatarBig: document.getElementById('activeAvatarBig'),
        activeSoundwaves: document.getElementById('activeSoundwaves'),
        activeAudioStage: document.getElementById('activeAudioStage'),
        activeVideoStage: document.getElementById('activeVideoStage'),
        remoteVideo: document.getElementById('remoteVideoTrack'),
        localVideo: document.getElementById('localVideoTrack'),
        localVideoPip: document.getElementById('localVideoPip'),
        remoteAudio: document.getElementById('remoteAudioTrack'),

        // Active Call Controls
        btnMute: document.getElementById('callBtnMute'),
        btnCamera: document.getElementById('callBtnCamera'),
        btnEnd: document.getElementById('callBtnEnd'),
        btnMinimize: document.getElementById('callBtnMinimize'),
        callMuteLabel: document.getElementById('callMuteLabel'),
        callCamLabel: document.getElementById('callCamLabel'),

        // Minimized Floating Pill
        minimizedPill: document.getElementById('callMinimizedPill'),
        minimizedName: document.getElementById('minimizedCallName'),
        minimizedTimer: document.getElementById('minimizedCallTimer'),
        minimizedQuickEnd: document.getElementById('minimizedQuickEndBtn')
    };

    // ------------------------------------------------------------
    //  5. UI UPDATERS
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
        if (DOM.activeCallSubstatus) {
            if (isConnected) {
                DOM.activeCallSubstatus.textContent = 'End-to-End Encrypted • HD Audio';
            } else if (CallState.state === 'reconnecting') {
                DOM.activeCallSubstatus.textContent = 'Network interrupted, reconnecting...';
            }
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
    //  6. WEBRTC CORE IMPLEMENTATION
    // ------------------------------------------------------------
    async function acquireLocalMedia(isVideo = false) {
        try {
            const constraints = {
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: isVideo ? {
                    facingMode: 'user',
                    width: { ideal: 1280, max: 1920 },
                    height: { ideal: 720, max: 1080 }
                } : false
            };

            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            CallState.localStream = stream;

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
            console.error('[WebRTC] Media access error:', err);
            alert('Unable to access microphone or camera. Please check browser permissions.');
            throw err;
        }
    }

    function createPeerConnection() {
        if (CallState.peerConnection) {
            try { CallState.peerConnection.close(); } catch (e) {}
        }

        const pc = new RTCPeerConnection(RTC_CONFIG);
        CallState.peerConnection = pc;

        // Add local tracks
        if (CallState.localStream) {
            CallState.localStream.getTracks().forEach(track => {
                pc.addTrack(track, CallState.localStream);
            });
        }

        // Handle remote stream tracks
        pc.ontrack = (event) => {
            if (!CallState.remoteStream) {
                CallState.remoteStream = new MediaStream();
            }
            CallState.remoteStream.addTrack(event.track);

            if (CallState.callType === 'video' && DOM.remoteVideo) {
                DOM.remoteVideo.srcObject = CallState.remoteStream;
                DOM.remoteVideo.play().catch(() => {});
            }

            if (DOM.remoteAudio) {
                DOM.remoteAudio.srcObject = CallState.remoteStream;
                DOM.remoteAudio.play().catch(() => {});
            }

            // Hook up remote audio to visualizer as well
            if (event.track.kind === 'audio') {
                setupAudioVisualizer(CallState.remoteStream);
            }
        };

        // ICE candidate exchange
        pc.onicecandidate = (event) => {
            if (event.candidate && CallState.callId) {
                sendSignalingMessage('ice-candidate', event.candidate);
            }
        };

        // Connection state monitoring
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            console.log('[WebRTC] Connection state:', state);

            if (state === 'connected') {
                CallState.state = 'connected';
                updateConnectionStatusUI('Connected', true);
                playCallConnectedChime();
                startCallTimer();
            } else if (state === 'connecting') {
                updateConnectionStatusUI('Connecting...');
            } else if (state === 'disconnected' || state === 'failed') {
                CallState.state = 'reconnecting';
                updateConnectionStatusUI('Reconnecting...');
            } else if (state === 'closed') {
                endCallLocally('Connection closed');
            }
        };

        pc.oniceconnectionstatechange = () => {
            const iceState = pc.iceConnectionState;
            if (iceState === 'failed') {
                pc.restartIce();
            }
        };

        return pc;
    }

    function sendSignalingMessage(type, data) {
        if (!CallState.callId) return;
        fetch('/api/call/signal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                callId: CallState.callId,
                type,
                data
            })
        }).catch(err => {
            console.warn('[WebRTC] Signal POST error:', err.message);
        });
    }

    // ------------------------------------------------------------
    //  7. CALL LIFECYCLE FLOWS
    // ------------------------------------------------------------
    async function startCall(callType = 'audio') {
        if (CallState.state !== 'idle') {
            alert('A call is already in progress.');
            return;
        }

        try {
            CallState.state = 'calling';
            CallState.callType = callType;
            CallState.isCaller = true;
            CallState.durationSeconds = 0;
            CallState.iceCandidatesQueue = [];

            // Acquire local media first
            await acquireLocalMedia(callType === 'video');

            // Send initiate call request
            const res = await fetch('/api/call/initiate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callType })
            });

            const data = await res.json();
            if (!data.success) {
                alert(data.error || 'Could not place call.');
                cleanupCallState();
                return;
            }

            CallState.callId = data.callId;

            // Show active call screen with calling state
            showActiveCallModal();
            updateConnectionStatusUI('Ringing...');
            startOutgoingRingback();

        } catch (err) {
            console.error('[Call] Start call failed:', err);
            cleanupCallState();
        }
    }

    async function acceptIncomingCall() {
        if (!CallState.callId) return;

        try {
            stopRingtone();
            hideIncomingCallModal();

            CallState.state = 'connecting';
            CallState.isCaller = false;

            await acquireLocalMedia(CallState.callType === 'video');
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
                alert(data.error || 'Failed to accept call.');
                endCallLocally('Failed to accept');
            }
        } catch (err) {
            console.error('[Call] Accept call failed:', err);
            endCallLocally('Accept failed');
        }
    }

    async function rejectIncomingCall() {
        if (!CallState.callId) return;
        const id = CallState.callId;
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

        const id = CallState.callId;
        const duration = CallState.durationSeconds;
        endCallLocally('Ended');

        if (id) {
            try {
                await fetch('/api/call/end', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        callId: id,
                        durationSeconds: duration,
                        reason: 'user_ended'
                    })
                });
            } catch (e) {}
        }
    }

    function endCallLocally(reason = 'Ended') {
        playCallEndedChime();
        stopAudioVisualizer();
        hideActiveCallModal();
        hideIncomingCallModal();
        hideMinimizedPill();
        cleanupCallState();
    }

    function cleanupCallState() {
        stopRingtone();
        stopCallTimer();
        stopAudioVisualizer();

        // Stop all local tracks
        if (CallState.localStream) {
            CallState.localStream.getTracks().forEach(track => {
                try { track.stop(); } catch (e) {}
            });
            CallState.localStream = null;
        }

        // Close peer connection
        if (CallState.peerConnection) {
            try { CallState.peerConnection.close(); } catch (e) {}
            CallState.peerConnection = null;
        }

        if (DOM.remoteVideo) DOM.remoteVideo.srcObject = null;
        if (DOM.localVideo) DOM.localVideo.srcObject = null;
        if (DOM.remoteAudio) DOM.remoteAudio.srcObject = null;

        CallState.state = 'idle';
        CallState.callId = null;
        CallState.remoteStream = null;
        CallState.isMuted = false;
        CallState.isCameraOff = false;
        CallState.isMinimized = false;
        CallState.iceCandidatesQueue = [];

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
    }

    // ------------------------------------------------------------
    //  8. CONTROLS TOGGLE (Mute & Camera)
    // ------------------------------------------------------------
    function toggleMute() {
        if (!CallState.localStream) return;
        const audioTracks = CallState.localStream.getAudioTracks();
        if (audioTracks.length === 0) return;

        CallState.isMuted = !CallState.isMuted;
        audioTracks.forEach(track => {
            track.enabled = !CallState.isMuted;
        });

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

    // ------------------------------------------------------------
    //  9. SSE SIGNALING HANDLERS
    // ------------------------------------------------------------
    async function handleIncomingCallEvent(data) {
        if (CallState.state !== 'idle') {
            // Already busy in another call
            fetch('/api/call/reject', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ callId: data.callId, reason: 'busy' })
            }).catch(() => {});
            return;
        }

        CallState.state = 'ringing';
        CallState.callId = data.callId;
        CallState.callType = data.callType || 'audio';
        CallState.isCaller = false;

        showIncomingCallModal(data);
    }

    async function handleCallAcceptedEvent(data) {
        if (!CallState.isCaller || CallState.callId !== data.callId) return;

        stopRingtone();
        updateConnectionStatusUI('Connecting...');

        // Caller initiates WebRTC offer
        try {
            const pc = createPeerConnection();
            const offer = await pc.createOffer({
                offerToReceiveAudio: true,
                offerToReceiveVideo: CallState.callType === 'video'
            });
            await pc.setLocalDescription(offer);

            sendSignalingMessage('offer', offer);
        } catch (err) {
            console.error('[WebRTC] Create offer error:', err);
            endCallLocally('Offer error');
        }
    }

    async function handleCallSignalEvent(signal) {
        if (!CallState.callId || CallState.callId !== signal.callId) return;

        // In-call emoji reaction message
        if (signal.type === 'call-emoji' && signal.data && signal.data.emoji) {
            spawnInCallEmoji(signal.data.emoji);
            return;
        }

        const pc = CallState.peerConnection;
        if (!pc) return;

        try {
            if (signal.type === 'offer') {
                await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
                
                // Process any queued ICE candidates
                while (CallState.iceCandidatesQueue.length > 0) {
                    const candidate = CallState.iceCandidatesQueue.shift();
                    await pc.addIceCandidate(new RTCIceCandidate(candidate));
                }

                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendSignalingMessage('answer', answer);

            } else if (signal.type === 'answer') {
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
            }
        } catch (err) {
            console.error('[WebRTC] Signal handling error:', err);
        }
    }

    // ------------------------------------------------------------
    //  10. EVENT LISTENERS & INTEGRATION
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

        // Quick In-Call Reaction Emojis
        document.querySelectorAll('.call-quick-emoji-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
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

        // Touch drag for Picture-in-Picture window on mobile
        setupPipDraggable();

        // Window unload cleanup
        window.addEventListener('beforeunload', () => {
            if (CallState.state !== 'idle' && CallState.callId) {
                navigator.sendBeacon('/api/call/end', JSON.stringify({
                    callId: CallState.callId,
                    durationSeconds: CallState.durationSeconds,
                    reason: 'page_unload'
                }));
            }
        });
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

    // Global custom event listeners dispatched from SSE
    window.addEventListener('call:incoming', (e) => handleIncomingCallEvent(e.detail));
    window.addEventListener('call:accepted', (e) => handleCallAcceptedEvent(e.detail));
    window.addEventListener('call:signal', (e) => handleCallSignalEvent(e.detail));
    window.addEventListener('call:rejected', () => endCallLocally('Rejected'));
    window.addEventListener('call:cancelled', () => endCallLocally('Cancelled'));
    window.addEventListener('call:ended', () => endCallLocally('Ended'));
    window.addEventListener('call:timeout', () => endCallLocally('No answer'));

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
