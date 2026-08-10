// ========================================
// VideoHost — Client-side JavaScript
// ========================================

document.addEventListener('DOMContentLoaded', () => {
    const storage = (() => {
        try {
            const testKey = 'videohost_storage_test';
            window.localStorage.setItem(testKey, '1');
            window.localStorage.removeItem(testKey);
            return window.localStorage;
        } catch (err) {
            return {
                getItem: () => null,
                setItem: () => {},
                removeItem: () => {}
            };
        }
    })();
    const prefersReducedMotion = window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    document.addEventListener('submit', (e) => {
        const form = e.target;
        if (!(form instanceof HTMLFormElement)) return;

        const message = form.getAttribute('data-confirm');
        if (message && !window.confirm(message)) {
            e.preventDefault();
        }
    });

    // ---- Password Toggle ----
    const toggleBtn = document.getElementById('togglePassword');
    const passwordInput = document.getElementById('password');
    if (toggleBtn && passwordInput) {
        toggleBtn.addEventListener('click', () => {
            const type = passwordInput.getAttribute('type') === 'password' ? 'text' : 'password';
            passwordInput.setAttribute('type', type);
            const eyeOpen = toggleBtn.querySelector('.eye-open');
            const eyeClosed = toggleBtn.querySelector('.eye-closed');
            if (type === 'text') {
                if (eyeOpen) eyeOpen.style.display = 'none';
                if (eyeClosed) eyeClosed.style.display = 'block';
            } else {
                if (eyeOpen) eyeOpen.style.display = 'block';
                if (eyeClosed) eyeClosed.style.display = 'none';
            }
        });
    }

    // ---- Dropzone ----
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('videoFile');
    const dropzoneContent = document.getElementById('dropzoneContent');
    const dropzoneSelected = document.getElementById('dropzoneSelected');
    const selectedName = document.getElementById('selectedName');
    const selectedSize = document.getElementById('selectedSize');

    if (dropzone && fileInput) {
        // Click to select
        dropzone.addEventListener('click', () => {
            fileInput.click();
        });

        // Drag events
        dropzone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropzone.classList.add('dragover');
        });

        dropzone.addEventListener('dragleave', () => {
            dropzone.classList.remove('dragover');
        });

        dropzone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropzone.classList.remove('dragover');
            if (e.dataTransfer.files.length > 0) {
                try {
                    fileInput.files = e.dataTransfer.files;
                    showSelectedFile(fileInput.files[0]);
                } catch (err) {
                    showSelectedFile(e.dataTransfer.files[0]);
                }
            }
        });

        // File selected
        fileInput.addEventListener('change', () => {
            if (fileInput.files.length > 0) {
                showSelectedFile(fileInput.files[0]);
            }
        });

        function showSelectedFile(file) {
            if (dropzoneContent && dropzoneSelected) {
                dropzoneContent.style.display = 'none';
                dropzoneSelected.style.display = 'block';
                if (selectedName) selectedName.textContent = file.name;
                if (selectedSize) {
                    const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
                    selectedSize.textContent = sizeMB + ' MB';
                }
            }
        }
    }

    // ---- Upload Progress (XHR) ----
    const uploadForm = document.getElementById('uploadForm');
    const uploadProgress = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const uploadBtn = document.getElementById('uploadBtn');

    if (uploadForm && fileInput) {
        uploadForm.addEventListener('submit', (e) => {
            if (!fileInput.files || fileInput.files.length === 0) return;

            e.preventDefault();

            const formData = new FormData(uploadForm);
            const xhr = new XMLHttpRequest();

            // Show progress
            if (uploadProgress) uploadProgress.style.display = 'block';
            if (uploadBtn) {
                uploadBtn.disabled = true;
                uploadBtn.innerHTML = '<span>Uploading...</span>';
            }

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    if (progressFill) progressFill.style.width = percent + '%';
                    if (progressText) progressText.textContent = 'Uploading... ' + percent + '%';
                }
            });

            xhr.addEventListener('load', () => {
                if (xhr.status === 200) {
                    if (progressText) progressText.textContent = 'Upload complete.';
                    setTimeout(() => {
                        window.location.href = '/dashboard';
                    }, 500);
                } else {
                    let errMsg = 'Upload failed.';
                    try {
                        const tempDiv = document.createElement('div');
                        tempDiv.innerHTML = xhr.responseText;
                        const alertSpan = tempDiv.querySelector('.alert-error span');
                        if (alertSpan && alertSpan.textContent) {
                            errMsg = alertSpan.textContent;
                        }
                    } catch (e) {}
                    if (progressText) progressText.textContent = errMsg;
                    if (uploadBtn) {
                        uploadBtn.disabled = false;
                        uploadBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Try again</span>';
                    }
                }
            });

            xhr.addEventListener('error', () => {
                if (progressText) progressText.textContent = 'Upload failed. Network error.';
                if (uploadBtn) {
                    uploadBtn.disabled = false;
                    uploadBtn.innerHTML = '<span>Try again</span>';
                }
            });

            xhr.open('POST', '/upload');
            xhr.send(formData);
        });
    }

    // ---- Custom Video Player Logic ----
    const vid = document.getElementById('vpVideo');
    if (vid) {
        const videoId = vid.getAttribute('data-video-id');
        const container = document.getElementById('playerContainer');
        const controls = document.getElementById('vpControls');

        // Buttons
        const playBtn = document.getElementById('vpPlayBtn');
        const rewindBtn = document.getElementById('vpRewindBtn');
        const forwardBtn = document.getElementById('vpForwardBtn');
        const muteBtn = document.getElementById('vpMuteBtn');
        const volumeSlider = document.getElementById('vpVolumeSlider');
        const fullscreenBtn = document.getElementById('vpFullscreenBtn');
        const pipBtn = document.getElementById('vpPipBtn');
        const speedBtn = document.getElementById('vpSpeedBtn');
        const speedMenu = document.getElementById('vpSpeedMenu');
        const speedLabel = document.getElementById('vpSpeedLabel');
        const speedOptions = document.querySelectorAll('.vp-speed-option');

        // Center overlay
        const centerBtn = document.getElementById('vpCenterPlayBtn');

        // Progress
        const progressWrap = document.getElementById('vpProgressWrap');
        const progressPlayed = document.getElementById('vpProgressPlayed');
        const progressBuffer = document.getElementById('vpProgressBuffer');
        const hoverTime = document.getElementById('vpHoverTime');
        const currentTimeEl = document.getElementById('vpCurrentTime');
        const durationEl = document.getElementById('vpDuration');

        // Seek ripples
        const seekRippleLeft = document.getElementById('seekRippleLeft');
        const seekRippleRight = document.getElementById('seekRippleRight');

        // Icons
        const iconPlay = playBtn?.querySelector('.vp-icon-play');
        const iconPause = playBtn?.querySelector('.vp-icon-pause');
        const iconVolOn = muteBtn?.querySelector('.vp-icon-vol-on');
        const iconVolOff = muteBtn?.querySelector('.vp-icon-vol-off');
        const iconFsEnter = fullscreenBtn?.querySelector('.vp-icon-fs-enter');
        const iconFsExit = fullscreenBtn?.querySelector('.vp-icon-fs-exit');
        const centerPlayIcon = centerBtn?.querySelector('.vp-play-icon');
        const centerPauseIcon = centerBtn?.querySelector('.vp-pause-icon');

        // Playback status / slow network UI
        const audioChip = document.getElementById('vpAudioChip');
        const statusBadge = document.getElementById('vpStatusBadge');
        const statusText = document.getElementById('vpStatusText');
        const loadingOverlay = document.getElementById('vpLoadingOverlay');
        const loadingTitle = document.getElementById('vpLoadingTitle');
        const loadingDetail = document.getElementById('vpLoadingDetail');
        const loadMeterFill = document.getElementById('vpLoadMeterFill');
        const retryBtn = document.getElementById('vpRetryBtn');
        const sourceEl = vid.querySelector('source');
        const sourceType = vid.getAttribute('data-source-type') || sourceEl?.getAttribute('type') || '';
        const unsupportedSourceType = sourceType &&
            typeof vid.canPlayType === 'function' &&
            vid.canPlayType(sourceType) === '';
        const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
        let statusHideTimer = null;
        let recoveryTimer = null;
        let slowStartTimer = null;
        let retryCount = 0;
        const DEFAULT_AUDIBLE_VOLUME = 1;
        let lastAudibleVolume = DEFAULT_AUDIBLE_VOLUME;

        vid.defaultMuted = true;
        vid.muted = true;
        try {
            vid.volume = DEFAULT_AUDIBLE_VOLUME;
        } catch (err) {}
        if (volumeSlider) volumeSlider.value = '0';

        // --- Utility ---
        function fmtTime(s) {
            if (isNaN(s) || !isFinite(s)) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return m + ':' + (sec < 10 ? '0' : '') + sec;
        }

        function getBufferedEnd() {
            if (!vid.buffered || vid.buffered.length === 0) return 0;

            let end = 0;
            for (let i = 0; i < vid.buffered.length; i++) {
                try {
                    end = Math.max(end, vid.buffered.end(i));
                } catch (err) {
                    return end;
                }
            }
            return end;
        }

        function getBufferedPercent() {
            if (!vid.duration || !isFinite(vid.duration)) return 0;
            return Math.max(0, Math.min(100, (getBufferedEnd() / vid.duration) * 100));
        }

        function getBufferedAhead() {
            if (!vid.buffered || vid.buffered.length === 0 || !isFinite(vid.currentTime)) return 0;

            for (let i = 0; i < vid.buffered.length; i++) {
                try {
                    const start = vid.buffered.start(i);
                    const end = vid.buffered.end(i);
                    if (vid.currentTime >= start - 0.25 && vid.currentTime <= end + 0.25) {
                        return Math.max(0, end - vid.currentTime);
                    }
                } catch (err) {
                    return 0;
                }
            }
            return 0;
        }

        function connectionDetail(fallback) {
            const parts = [];
            if (connection && connection.effectiveType) {
                parts.push(String(connection.effectiveType).toUpperCase());
            }

            const bufferedPercent = Math.round(getBufferedPercent());
            if (bufferedPercent > 0) {
                parts.push('buffered ' + bufferedPercent + '%');
            }

            return parts.length ? parts.join(' - ') : fallback;
        }

        function clearPlayerStatus() {
            if (statusHideTimer) window.clearTimeout(statusHideTimer);
            statusHideTimer = null;
            if (container) {
                container.classList.remove('vp-has-status', 'vp-loading', 'vp-buffering', 'vp-error', 'vp-offline', 'vp-warning');
            }
            if (loadingOverlay) loadingOverlay.setAttribute('aria-hidden', 'true');
        }

        function setPlayerStatus(state, title, detail, options = {}) {
            const showOverlay = options.showOverlay === true;
            const persistent = options.persistent === true || showOverlay;

            if (statusHideTimer) window.clearTimeout(statusHideTimer);
            statusHideTimer = null;

            if (statusBadge) {
                statusBadge.className = 'vp-status-badge vp-status-' + state;
            }
            if (statusText) statusText.textContent = title;
            if (loadingTitle) loadingTitle.textContent = title;
            if (loadingDetail) loadingDetail.textContent = detail || '';
            if (retryBtn) retryBtn.hidden = options.canRetry !== true;
            if (loadingOverlay) loadingOverlay.setAttribute('aria-hidden', showOverlay ? 'false' : 'true');

            if (container) {
                container.classList.add('vp-has-status');
                container.classList.toggle('vp-loading', showOverlay && state === 'loading');
                container.classList.toggle('vp-buffering', showOverlay && state === 'buffering');
                container.classList.toggle('vp-error', showOverlay && state === 'error');
                container.classList.toggle('vp-offline', showOverlay && state === 'offline');
                container.classList.toggle('vp-warning', showOverlay && state === 'warning');
                if (showOverlay) container.classList.add('vp-controls-visible');
            }

            if (!persistent) {
                statusHideTimer = window.setTimeout(clearPlayerStatus, 1800);
            }
        }

        function clearRecoveryTimer() {
            if (recoveryTimer) window.clearTimeout(recoveryTimer);
            recoveryTimer = null;
        }

        function clearSlowStartTimer() {
            if (slowStartTimer) window.clearTimeout(slowStartTimer);
            slowStartTimer = null;
        }

        function startSlowStartTimer() {
            clearSlowStartTimer();
            slowStartTimer = window.setTimeout(() => {
                if (vid.readyState >= 2 || vid.error) return;

                if (unsupportedSourceType) {
                    setPlayerStatus(
                        'warning',
                        'Video format may not play here',
                        'MP4 or WebM works best on phones and weak networks.',
                        { showOverlay: true, canRetry: true, persistent: true }
                    );
                    return;
                }

                setPlayerStatus(
                    'buffering',
                    'Still loading video',
                    connectionDetail('The connection is slow. Trying to buffer enough video before playback.'),
                    { showOverlay: true, canRetry: true, persistent: true }
                );
            }, 3500);
        }

        function videoErrorMessage() {
            if (!vid.error) return 'The stream stopped unexpectedly. Please retry.';

            switch (vid.error.code) {
                case 1:
                    return 'Playback was stopped before the video finished loading.';
                case 2:
                    return 'The network dropped while loading the video. Retry when the signal is stable.';
                case 3:
                    return 'The file loaded, but this browser could not decode it.';
                case 4:
                    return unsupportedSourceType
                        ? 'This format is not supported here. MP4 or WebM will play best.'
                        : 'This browser cannot play this video format.';
                default:
                    return 'The stream stopped unexpectedly. Please retry.';
            }
        }

        function retryStream(autoRetry = false) {
            const resumeAt = Number.isFinite(vid.currentTime) ? vid.currentTime : 0;
            const shouldPlay = !vid.paused || autoRetry;
            let restored = false;

            clearRecoveryTimer();
            clearSlowStartTimer();
            setPlayerStatus(
                'loading',
                autoRetry ? 'Reconnecting stream...' : 'Retrying stream...',
                'Keeping your current position while the stream opens again.',
                { showOverlay: true, canRetry: false, persistent: true }
            );

            const restorePosition = () => {
                if (restored) return;
                restored = true;

                if (resumeAt > 1 && vid.duration && resumeAt < vid.duration - 1) {
                    try {
                        vid.currentTime = resumeAt;
                    } catch (err) {}
                }

                if (shouldPlay) {
                    playVideo();
                }
            };

            vid.addEventListener('loadedmetadata', restorePosition, { once: true });

            try {
                vid.load();
            } catch (err) {}

            startSlowStartTimer();
            window.setTimeout(() => {
                if (vid.readyState >= 1) restorePosition();
            }, 350);
        }

        function queueRecovery() {
            clearRecoveryTimer();
            if (vid.paused || vid.ended || navigator.onLine === false) return;

            recoveryTimer = window.setTimeout(() => {
                if (vid.readyState >= 3 || getBufferedAhead() >= 1.5) return;

                if (retryCount < 2) {
                    retryCount += 1;
                    retryStream(true);
                    return;
                }

                setPlayerStatus(
                    'warning',
                    'Still buffering',
                    'The connection is not stable enough right now. Retry when the signal improves.',
                    { showOverlay: true, canRetry: true, persistent: true }
                );
            }, 10000);
        }

        // --- Play/Pause ---
        function updatePlayState() {
            if (vid.paused) {
                if (iconPlay) iconPlay.style.display = '';
                if (iconPause) iconPause.style.display = 'none';
                if (centerPlayIcon) centerPlayIcon.style.display = '';
                if (centerPauseIcon) centerPauseIcon.style.display = 'none';
            } else {
                if (iconPlay) iconPlay.style.display = 'none';
                if (iconPause) iconPause.style.display = '';
                if (centerPlayIcon) centerPlayIcon.style.display = 'none';
                if (centerPauseIcon) centerPauseIcon.style.display = '';
            }
        }

        function playVideo() {
            const playPromise = vid.play();
            if (playPromise && typeof playPromise.catch === 'function') {
                playPromise.catch((err) => {
                    if (err && err.name === 'NotAllowedError') return;
                    setPlayerStatus(
                        'error',
                        'Could not start playback',
                        'Tap play again or retry the stream.',
                        { showOverlay: true, canRetry: true, persistent: true }
                    );
                });
            }
        }

        function togglePlay() {
            if (vid.paused) {
                playVideo();
            } else {
                vid.pause();
            }
        }

        function animateCenterBtn() {
            if (!centerBtn) return;
            centerBtn.classList.remove('vp-animate');
            void centerBtn.offsetWidth;
            centerBtn.classList.add('vp-animate');
            setTimeout(() => centerBtn.classList.remove('vp-animate'), 550);
        }

        vid.addEventListener('play', () => {
            updatePlayState();
            if (container) container.classList.add('vp-playing');
        });
        vid.addEventListener('pause', () => {
            updatePlayState();
            if (container) container.classList.remove('vp-playing');
        });
        vid.addEventListener('ended', () => {
            if (container) container.classList.remove('vp-playing');
        });
        if (playBtn) playBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });

        // --- Progress Bar ---
        let isDragging = false;

        function updateProgress() {
            if (!vid.duration || isDragging) return;
            const pct = (vid.currentTime / vid.duration) * 100;
            if (progressPlayed) progressPlayed.style.width = pct + '%';
            if (currentTimeEl) currentTimeEl.textContent = fmtTime(vid.currentTime);
        }

        function updateBuffer() {
            const pct = getBufferedPercent();
            if (progressBuffer) progressBuffer.style.width = pct + '%';
            if (loadMeterFill) loadMeterFill.style.width = pct + '%';
        }

        vid.addEventListener('timeupdate', updateProgress);
        vid.addEventListener('progress', updateBuffer);
        vid.addEventListener('loadstart', () => {
            startSlowStartTimer();
            setPlayerStatus(
                'loading',
                'Preparing video',
                'Opening the private stream.',
                { showOverlay: vid.readyState < 2, canRetry: false, persistent: true }
            );
        });
        vid.addEventListener('loadedmetadata', () => {
            clearSlowStartTimer();
            if (durationEl) durationEl.textContent = fmtTime(vid.duration);
            updatePlayState();
            updateBuffer();
        });
        vid.addEventListener('durationchange', () => {
            if (durationEl) durationEl.textContent = fmtTime(vid.duration);
        });
        vid.addEventListener('loadeddata', () => {
            clearSlowStartTimer();
            updateBuffer();
        });
        vid.addEventListener('canplay', () => {
            clearRecoveryTimer();
            clearSlowStartTimer();
            updateBuffer();
            setPlayerStatus(
                'ready',
                'Ready to play',
                connectionDetail('Enough video data is ready.'),
                { showOverlay: false }
            );
        });
        vid.addEventListener('playing', () => {
            retryCount = 0;
            clearRecoveryTimer();
            clearSlowStartTimer();
            updateBuffer();
            setPlayerStatus(
                'ready',
                'Playing',
                connectionDetail('The stream is running.'),
                { showOverlay: false }
            );
        });
        vid.addEventListener('waiting', () => {
            if (vid.ended) return;
            setPlayerStatus(
                'buffering',
                'Buffering video',
                connectionDetail('Slow connection detected. Waiting for more video data.'),
                { showOverlay: true, canRetry: true, persistent: true }
            );
            queueRecovery();
        });
        vid.addEventListener('stalled', () => {
            setPlayerStatus(
                'buffering',
                'Connection stalled',
                connectionDetail('The stream stopped receiving data. Retrying may help.'),
                { showOverlay: true, canRetry: true, persistent: true }
            );
            queueRecovery();
        });
        vid.addEventListener('seeking', () => {
            if (getBufferedAhead() < 0.5) {
                setPlayerStatus(
                    'buffering',
                    'Finding that moment',
                    'Loading video data around the new position.',
                    { showOverlay: true, canRetry: false, persistent: true }
                );
            }
        });
        vid.addEventListener('seeked', () => {
            updateBuffer();
            if (vid.readyState >= 3) {
                setPlayerStatus(
                    'ready',
                    'Ready',
                    connectionDetail('Playback can continue.'),
                    { showOverlay: false }
                );
            }
        });
        vid.addEventListener('error', () => {
            clearRecoveryTimer();
            clearSlowStartTimer();
            setPlayerStatus(
                'error',
                'Video could not play',
                videoErrorMessage(),
                { showOverlay: true, canRetry: true, persistent: true }
            );
        });

        window.addEventListener('offline', () => {
            clearRecoveryTimer();
            setPlayerStatus(
                'offline',
                'You are offline',
                'Connect to the internet, then retry the stream.',
                { showOverlay: true, canRetry: true, persistent: true }
            );
        });

        window.addEventListener('online', () => {
            setPlayerStatus(
                'loading',
                'Back online',
                'Retrying the stream from the current position.',
                { showOverlay: true, canRetry: false, persistent: true }
            );
            retryStream(true);
        });

        if (retryBtn) {
            retryBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                retryCount = 0;
                retryStream(false);
            });
        }

        if (loadingOverlay) {
            loadingOverlay.addEventListener('click', (e) => {
                e.stopPropagation();
            });
        }

        if (navigator.onLine === false) {
            setPlayerStatus(
                'offline',
                'You are offline',
                'Connect to the internet, then retry the stream.',
                { showOverlay: true, canRetry: true, persistent: true }
            );
        } else if (vid.readyState < 2) {
            startSlowStartTimer();
            setPlayerStatus(
                'loading',
                'Preparing video',
                'Opening the private stream.',
                { showOverlay: true, canRetry: false, persistent: true }
            );
        } else {
            updateBuffer();
        }

        // Progress bar click/drag
        function seekFromEvent(e) {
            if (!progressWrap || !vid.duration) return;
            const rect = progressWrap.getBoundingClientRect();
            let x = (e.clientX || (e.touches && e.touches[0]?.clientX) || 0) - rect.left;
            x = Math.max(0, Math.min(x, rect.width));
            const pct = x / rect.width;
            vid.currentTime = pct * vid.duration;
            if (progressPlayed) progressPlayed.style.width = (pct * 100) + '%';
            if (currentTimeEl) currentTimeEl.textContent = fmtTime(vid.currentTime);
        }

        if (progressWrap) {
            progressWrap.addEventListener('mousedown', (e) => {
                isDragging = true;
                progressWrap.classList.add('vp-dragging');
                seekFromEvent(e);
            });

            progressWrap.addEventListener('mousemove', (e) => {
                if (!vid.duration) return;
                const rect = progressWrap.getBoundingClientRect();
                let x = e.clientX - rect.left;
                x = Math.max(0, Math.min(x, rect.width));
                const pct = x / rect.width;
                const t = pct * vid.duration;
                if (hoverTime) {
                    hoverTime.textContent = fmtTime(t);
                    hoverTime.style.left = x + 'px';
                    hoverTime.style.transform = 'translateX(-50%)';
                }
                if (isDragging) {
                    if (progressPlayed) progressPlayed.style.width = (pct * 100) + '%';
                    if (currentTimeEl) currentTimeEl.textContent = fmtTime(t);
                }
            });

            progressWrap.addEventListener('touchstart', (e) => {
                e.preventDefault();
                isDragging = true;
                progressWrap.classList.add('vp-dragging');
                seekFromEvent(e.touches[0]);
            }, { passive: false });

            progressWrap.addEventListener('touchmove', (e) => {
                if (isDragging) {
                    e.preventDefault();
                    seekFromEvent(e.touches[0]);
                }
            }, { passive: false });
        }

        document.addEventListener('mousemove', (e) => {
            if (isDragging && progressWrap && vid.duration) {
                const rect = progressWrap.getBoundingClientRect();
                let x = e.clientX - rect.left;
                x = Math.max(0, Math.min(x, rect.width));
                const pct = x / rect.width;
                if (progressPlayed) progressPlayed.style.width = (pct * 100) + '%';
                if (currentTimeEl) currentTimeEl.textContent = fmtTime(pct * vid.duration);
            }
        });

        document.addEventListener('mouseup', () => {
            if (isDragging) {
                isDragging = false;
                if (progressWrap) progressWrap.classList.remove('vp-dragging');
                // Seek to final position
                if (progressPlayed && vid.duration) {
                    const pct = parseFloat(progressPlayed.style.width) / 100;
                    vid.currentTime = pct * vid.duration;
                }
            }
        });

        document.addEventListener('touchend', () => {
            if (isDragging) {
                isDragging = false;
                if (progressWrap) progressWrap.classList.remove('vp-dragging');
                if (progressPlayed && vid.duration) {
                    const pct = parseFloat(progressPlayed.style.width) / 100;
                    vid.currentTime = pct * vid.duration;
                }
            }
        });

        // --- Volume ---
        function updateVolIcons() {
            const isMuted = vid.muted || vid.volume === 0;

            if (isMuted) {
                if (iconVolOn) iconVolOn.style.display = 'none';
                if (iconVolOff) iconVolOff.style.display = '';
            } else {
                if (iconVolOn) iconVolOn.style.display = '';
                if (iconVolOff) iconVolOff.style.display = 'none';
            }

            if (muteBtn) {
                muteBtn.classList.toggle('vp-btn-muted', isMuted);
                muteBtn.title = isMuted ? 'Unmute (M)' : 'Mute (M)';
                muteBtn.setAttribute('aria-label', isMuted ? 'Unmute' : 'Mute');
                muteBtn.setAttribute('aria-pressed', String(isMuted));
            }

            if (container) container.classList.toggle('vp-muted', isMuted);
            if (audioChip) audioChip.hidden = !isMuted;
        }

        function setVolumeLevel(nextVolume) {
            const normalized = Math.max(0, Math.min(1, Number(nextVolume) || 0));
            vid.volume = normalized;

            if (normalized > 0) {
                lastAudibleVolume = normalized;
                vid.muted = false;
            } else {
                vid.muted = true;
            }

            if (volumeSlider) volumeSlider.value = String(Math.round(normalized * 100));
            updateVolIcons();
        }

        function setMutedState(shouldMute) {
            if (!shouldMute && vid.volume === 0) {
                vid.volume = lastAudibleVolume || DEFAULT_AUDIBLE_VOLUME;
            }

            vid.muted = shouldMute;

            if (!shouldMute && vid.volume > 0) {
                lastAudibleVolume = vid.volume;
            }

            if (volumeSlider) {
                volumeSlider.value = shouldMute ? '0' : String(Math.round(vid.volume * 100));
            }

            updateVolIcons();
        }

        function adjustVolume(delta) {
            if ((vid.muted || vid.volume === 0) && delta < 0) return;
            const baseVolume = (vid.muted || vid.volume === 0)
                ? lastAudibleVolume || DEFAULT_AUDIBLE_VOLUME
                : vid.volume;
            setVolumeLevel(baseVolume + delta);
        }

        updateVolIcons();

        if (volumeSlider) {
            volumeSlider.addEventListener('input', (e) => {
                e.stopPropagation();
                setVolumeLevel(e.target.value / 100);
            });
        }

        if (muteBtn) {
            muteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                setMutedState(!(vid.muted || vid.volume === 0));
            });
        }

        vid.addEventListener('volumechange', () => {
            if (vid.volume > 0) lastAudibleVolume = vid.volume;
            if (volumeSlider) {
                volumeSlider.value = (vid.muted || vid.volume === 0)
                    ? '0'
                    : String(Math.round(vid.volume * 100));
            }
            updateVolIcons();
        });

        // --- Seek Buttons ---
        function triggerRipple(el) {
            if (!el) return;
            el.classList.remove('vp-ripple-active');
            void el.offsetWidth;
            el.classList.add('vp-ripple-active');
            setTimeout(() => el.classList.remove('vp-ripple-active'), 600);
        }

        function rewind(s) {
            vid.currentTime = Math.max(0, vid.currentTime - s);
            triggerRipple(seekRippleLeft);
        }

        function forward(s) {
            vid.currentTime = Math.min(vid.duration || Infinity, vid.currentTime + s);
            triggerRipple(seekRippleRight);
        }

        if (rewindBtn) rewindBtn.addEventListener('click', (e) => { e.stopPropagation(); rewind(10); });
        if (forwardBtn) forwardBtn.addEventListener('click', (e) => { e.stopPropagation(); forward(10); });

        // --- Fullscreen ---
        function isFullscreen() {
            return !!(document.fullscreenElement || document.webkitFullscreenElement);
        }

        function toggleFullscreen() {
            if (!container) return;
            if (isFullscreen()) {
                const exitFullscreen = document.exitFullscreen || document.webkitExitFullscreen;
                if (exitFullscreen) {
                    const exitPromise = exitFullscreen.call(document);
                    if (exitPromise && typeof exitPromise.catch === 'function') exitPromise.catch(() => {});
                }
                // Unlock screen orientation when exiting fullscreen
                try {
                    if (screen.orientation && screen.orientation.unlock) {
                        screen.orientation.unlock();
                    }
                } catch (e) { /* not supported or not allowed */ }
            } else {
                const requestFullscreen = container.requestFullscreen || container.webkitRequestFullscreen;
                if (requestFullscreen) {
                    const requestPromise = requestFullscreen.call(container);
                    if (requestPromise && typeof requestPromise.then === 'function') {
                        requestPromise.then(() => {
                            // Lock to landscape after fullscreen is granted
                            try {
                                if (screen.orientation && screen.orientation.lock) {
                                    screen.orientation.lock('landscape').catch(() => {});
                                }
                            } catch (e) { /* not supported */ }
                        }).catch(() => {});
                    } else {
                        // Fallback for browsers that don't return a promise
                        try {
                            if (screen.orientation && screen.orientation.lock) {
                                screen.orientation.lock('landscape').catch(() => {});
                            }
                        } catch (e) { /* not supported */ }
                    }
                }
            }
        }

        function updateFsIcons() {
            if (isFullscreen()) {
                if (iconFsEnter) iconFsEnter.style.display = 'none';
                if (iconFsExit) iconFsExit.style.display = '';
            } else {
                if (iconFsEnter) iconFsEnter.style.display = '';
                if (iconFsExit) iconFsExit.style.display = 'none';
                // Unlock orientation on any fullscreen exit (Escape, swipe, etc.)
                try {
                    if (screen.orientation && screen.orientation.unlock) {
                        screen.orientation.unlock();
                    }
                } catch (e) { /* not supported */ }
            }
        }

        if (fullscreenBtn) fullscreenBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
        document.addEventListener('fullscreenchange', updateFsIcons);
        document.addEventListener('webkitfullscreenchange', updateFsIcons);

        // --- PiP ---
        if (pipBtn) {
            if (!document.pictureInPictureEnabled) {
                pipBtn.style.display = 'none';
            } else {
                pipBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try {
                        if (document.pictureInPictureElement) {
                            await document.exitPictureInPicture();
                        } else {
                            await vid.requestPictureInPicture();
                        }
                    } catch (err) { /* ignore */ }
                });
            }
        }

        // --- Speed ---
        if (speedBtn && speedMenu) {
            speedBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                speedMenu.classList.toggle('vp-menu-open');
            });

            speedOptions.forEach(opt => {
                opt.addEventListener('click', (e) => {
                    e.stopPropagation();
                    const rate = parseFloat(opt.dataset.speed);
                    vid.playbackRate = rate;
                    if (speedLabel) speedLabel.textContent = rate === 1 ? '1x' : rate + 'x';
                    speedOptions.forEach(o => o.classList.remove('active'));
                    opt.classList.add('active');
                    speedMenu.classList.remove('vp-menu-open');
                });
            });

            // Close speed menu on outside click
            document.addEventListener('click', (e) => {
                if (!speedMenu.contains(e.target) && e.target !== speedBtn) {
                    speedMenu.classList.remove('vp-menu-open');
                }
            });
        }

        // --- Click on video area to play/pause ---
        let lastClickTime = 0;
        let clickTimer = null;

        if (container) {
            container.addEventListener('click', (e) => {
                // Ignore clicks on controls
                if (e.target.closest('.vp-controls') || e.target.closest('.resume-toast') || e.target.closest('.vp-speed-menu')) return;

                const now = Date.now();
                const rect = container.getBoundingClientRect();
                const clickX = e.clientX - rect.left;
                const isLeftHalf = clickX < rect.width / 2;

                if (now - lastClickTime < 280) {
                    // Double tap — seek
                    clearTimeout(clickTimer);
                    if (isLeftHalf) {
                        rewind(10);
                    } else {
                        forward(10);
                    }
                    lastClickTime = 0;
                } else {
                    // Single tap — play/pause with shorter delay
                    lastClickTime = now;
                    clickTimer = setTimeout(() => {
                        togglePlay();
                        animateCenterBtn();
                    }, 250);
                }
            });
        }

        // --- Auto-hide Controls (Improved Immersive Experience) ---
        let hideTimer = null;
        let cursorHideTimer = null;
        let isUserInteracting = false;

        function getHideDelay() {
            // Faster hide in fullscreen for immersive viewing
            return isFullscreen() ? 1500 : 2000;
        }

        function showControls() {
            if (container) {
                container.classList.add('vp-controls-visible');
                container.classList.remove('vp-cursor-hidden');
                container.classList.remove('vp-idle');
            }
            clearTimeout(hideTimer);
            clearTimeout(cursorHideTimer);

            if (!vid.paused && !isDragging) {
                hideTimer = setTimeout(hideControls, getHideDelay());
            }
        }

        function hideControls() {
            if (isDragging) return;
            // Don't hide if speed menu is open
            if (speedMenu && speedMenu.classList.contains('vp-menu-open')) return;

            if (container) {
                container.classList.remove('vp-controls-visible');
                // Hide cursor after controls fade out
                cursorHideTimer = setTimeout(() => {
                    if (!vid.paused && container) {
                        container.classList.add('vp-cursor-hidden');
                        container.classList.add('vp-idle');
                    }
                }, 400);
            }
        }

        if (container) {
            // Mouse movement shows controls, but only triggers re-hide
            container.addEventListener('mousemove', (e) => {
                // Ignore micro-movements (less than 3px)
                if (container._lastMouseX !== undefined) {
                    const dx = Math.abs(e.clientX - container._lastMouseX);
                    const dy = Math.abs(e.clientY - container._lastMouseY);
                    if (dx < 3 && dy < 3) return;
                }
                container._lastMouseX = e.clientX;
                container._lastMouseY = e.clientY;
                showControls();
            });

            // Mouse leave hides controls faster
            container.addEventListener('mouseleave', () => {
                if (!vid.paused) {
                    clearTimeout(hideTimer);
                    hideTimer = setTimeout(hideControls, 600);
                }
            });

            container.addEventListener('touchstart', () => {
                // On touch: toggle controls visibility
                if (container.classList.contains('vp-controls-visible') && !vid.paused) {
                    hideControls();
                } else {
                    showControls();
                }
            }, { passive: true });
        }

        vid.addEventListener('pause', () => {
            // Always show controls when paused
            if (container) {
                container.classList.add('vp-controls-visible');
                container.classList.remove('vp-cursor-hidden');
                container.classList.remove('vp-idle');
            }
            clearTimeout(hideTimer);
            clearTimeout(cursorHideTimer);
        });

        vid.addEventListener('play', () => {
            showControls();
        });

        // --- Resume Feature ---
        if (videoId) {
            const savedPosKey = 'videohosk_pos_' + videoId;
            const savedTime = parseFloat(storage.getItem(savedPosKey) || '0');

            vid.addEventListener('loadedmetadata', () => {
                if (savedTime > 5 && savedTime < vid.duration - 10) {
                    const resumeToast = document.getElementById('resumeToast');
                    const resumeTimeStr = document.getElementById('resumeTimeStr');
                    if (resumeToast && resumeTimeStr) {
                        resumeTimeStr.textContent = fmtTime(savedTime);
                        resumeToast.style.display = 'flex';

                        document.getElementById('btnResumeYes')?.addEventListener('click', () => {
                            vid.currentTime = savedTime;
                            playVideo();
                            resumeToast.style.display = 'none';
                        });

                        document.getElementById('btnResumeNo')?.addEventListener('click', () => {
                            storage.removeItem(savedPosKey);
                            resumeToast.style.display = 'none';
                            playVideo();
                        });
                    }
                }
            });

            // Save position periodically
            let lastPositionSave = 0;
            vid.addEventListener('timeupdate', () => {
                const now = Date.now();
                if (vid.currentTime > 2 && !vid.ended && now - lastPositionSave > 5000) {
                    lastPositionSave = now;
                    storage.setItem(savedPosKey, String(Math.floor(vid.currentTime)));
                }
            });

            vid.addEventListener('ended', () => {
                storage.removeItem(savedPosKey);
            });
        }

        // --- Keyboard Shortcuts ---
        document.addEventListener('keydown', (e) => {
            if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

            switch (e.key.toLowerCase()) {
                case ' ':
                case 'k':
                    e.preventDefault();
                    togglePlay();
                    animateCenterBtn();
                    break;
                case 'j':
                case 'arrowleft':
                    e.preventDefault();
                    rewind(10);
                    break;
                case 'l':
                case 'arrowright':
                    e.preventDefault();
                    forward(10);
                    break;
                case 'f':
                    e.preventDefault();
                    toggleFullscreen();
                    break;
                case 'm':
                    e.preventDefault();
                    setMutedState(!(vid.muted || vid.volume === 0));
                    break;
                case 'arrowup':
                    e.preventDefault();
                    adjustVolume(0.05);
                    break;
                case 'arrowdown':
                    e.preventDefault();
                    adjustVolume(-0.05);
                    break;
            }
        });

        // Show controls initially
        showControls();
    }

    // ---- Theater Mode Toggle ----
    const theaterBtn = document.getElementById('btnTheaterMode');
    const watchPage = document.querySelector('.watch-page');
    if (theaterBtn && watchPage) {
        theaterBtn.addEventListener('click', () => {
            watchPage.classList.toggle('theater-mode');
            const isTheater = watchPage.classList.contains('theater-mode');
            storage.setItem('videohosk_theater', isTheater ? '1' : '0');
        });
        if (storage.getItem('videohosk_theater') === '1') {
            watchPage.classList.add('theater-mode');
        }
    }

    // ---- Shortcuts Modal ----
    const shortcutsBtn = document.getElementById('btnShortcuts');
    const shortcutsModal = document.getElementById('shortcutsModal');
    const shortcutsCloseBtn = document.getElementById('shortcutsCloseBtn');

    if (shortcutsBtn && shortcutsModal) {
        shortcutsBtn.addEventListener('click', () => shortcutsModal.classList.add('active'));
        if (shortcutsCloseBtn) shortcutsCloseBtn.addEventListener('click', () => shortcutsModal.classList.remove('active'));
        shortcutsModal.addEventListener('click', (e) => {
            if (e.target === shortcutsModal) shortcutsModal.classList.remove('active');
        });
        // Close shortcuts modal on Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && shortcutsModal.classList.contains('active')) {
                shortcutsModal.classList.remove('active');
            }
        });
    }

    // ---- Auto-resize textarea ----
    const commentInputs = document.querySelectorAll('.comment-input');
    commentInputs.forEach(textarea => {
        textarea.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = this.scrollHeight + 'px';
        });
    });

    // ---- Stagger animation for video cards ----
    const videoCards = document.querySelectorAll('.video-card');
    if (!prefersReducedMotion) {
        videoCards.forEach((card, index) => {
            card.style.animationDelay = `${Math.min(index, 12) * 0.035}s`;
        });
    }

    // ---- Live Search Filter ----
    const searchInput = document.getElementById('searchInput');
    if (searchInput && videoCards.length > 0) {
        let searchFrame = 0;
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            window.cancelAnimationFrame(searchFrame);
            searchFrame = window.requestAnimationFrame(() => {
                videoCards.forEach(card => {
                    const title = card.getAttribute('data-title') || '';
                    card.style.display = !query || title.includes(query) ? '' : 'none';
                });
            });
        });
    }

    // ---- Theme Switcher Modal Logic ----
    const themeBtn = document.getElementById('themeSwitcherBtn');
    const themeNavBtn = document.getElementById('themeSwitcherNavBtn');
    const themeBottomBtn = document.getElementById('themeSwitcherBottomBtn');
    const themeModal = document.getElementById('themeModalBackdrop');
    const themeCloseBtn = document.getElementById('themeCloseBtn');
    const themeOptions = document.querySelectorAll('[data-set-theme]');

    function openThemeModal() {
        if (themeModal) themeModal.classList.add('active');
    }

    function closeThemeModal() {
        if (themeModal) themeModal.classList.remove('active');
    }

    if (themeBtn) themeBtn.addEventListener('click', openThemeModal);
    if (themeNavBtn) themeNavBtn.addEventListener('click', openThemeModal);
    if (themeBottomBtn) themeBottomBtn.addEventListener('click', openThemeModal);
    if (themeCloseBtn) themeCloseBtn.addEventListener('click', closeThemeModal);

    if (themeModal) {
        themeModal.addEventListener('click', (e) => {
            if (e.target === themeModal) closeThemeModal();
        });
    }

    themeOptions.forEach(btn => {
        btn.addEventListener('click', () => {
            const theme = btn.getAttribute('data-set-theme');
            if (theme) {
                document.documentElement.setAttribute('data-theme', theme);
                storage.setItem('videohosk_theme', theme);
                closeThemeModal();
            }
        });
    });

    // ---- Upload Tabs ----
    const uploadTabs = document.querySelectorAll('.upload-tab');
    const uploadPanels = document.querySelectorAll('.upload-panel');

    uploadTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const target = tab.dataset.tab;
            uploadTabs.forEach(t => t.classList.remove('active'));
            uploadPanels.forEach(p => p.classList.remove('active'));
            tab.classList.add('active');
            const panel = document.getElementById('panel' + target.charAt(0).toUpperCase() + target.slice(1));
            if (panel) panel.classList.add('active');
        });
    });

    // ---- URL Import ----
    const importBtn = document.getElementById('importBtn');
    const importUrlInput = document.getElementById('importUrl');
    const importTitleInput = document.getElementById('importTitle');
    const importProgressSection = document.getElementById('importProgressSection');
    const importResult = document.getElementById('importResult');
    const importResultCard = document.getElementById('importResultCard');
    const importResultIcon = document.getElementById('importResultIcon');
    const importResultText = document.getElementById('importResultText');
    const importResultBtn = document.getElementById('importResultBtn');
    const importWatchBtn = document.getElementById('importWatchBtn');
    const importSpinner = document.getElementById('importSpinner');
    const importStatusTitle = document.getElementById('importStatusTitle');
    const importStatusDetail = document.getElementById('importStatusDetail');
    const importProgressFill = document.getElementById('importProgressFill');
    const importPercent = document.getElementById('importPercent');
    const importSpeed = document.getElementById('importSpeed');
    const importEta = document.getElementById('importEta');

    if (importBtn && importUrlInput) {
        importBtn.addEventListener('click', async () => {
            const url = importUrlInput.value.trim();
            const title = importTitleInput ? importTitleInput.value.trim() : '';

            if (!url) {
                importUrlInput.focus();
                importUrlInput.classList.add('shake');
                setTimeout(() => importUrlInput.classList.remove('shake'), 500);
                return;
            }

            // Get CSRF token
            const csrfMeta = document.querySelector('input[name="_csrf"]');
            const csrf = csrfMeta ? csrfMeta.value : '';

            // Disable button and show progress
            importBtn.disabled = true;
            importBtn.innerHTML = '<span>Importing...</span>';
            if (importProgressSection) importProgressSection.style.display = 'block';
            if (importResult) importResult.style.display = 'none';
            if (importStatusTitle) importStatusTitle.textContent = 'Starting import...';
            if (importStatusDetail) importStatusDetail.textContent = 'Connecting to site and extracting video...';
            if (importProgressFill) importProgressFill.style.width = '0%';
            if (importPercent) importPercent.textContent = '0%';
            if (importSpeed) importSpeed.textContent = '';
            if (importEta) importEta.textContent = '';
            if (importSpinner) importSpinner.className = 'import-spinner';

            try {
                // Start the import
                const response = await fetch('/import-url', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-csrf-token': csrf
                    },
                    body: JSON.stringify({ url, title })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Import failed');
                }

                // Connect to SSE for progress
                const eventSource = new EventSource('/import-progress/' + data.jobId);

                eventSource.onmessage = (event) => {
                    try {
                        const progress = JSON.parse(event.data);

                        if (progress.title && importStatusTitle) {
                            importStatusTitle.textContent = progress.title;
                        }

                        if (progress.status === 'downloading') {
                            if (importStatusDetail) importStatusDetail.textContent = 'Downloading video...';
                            if (importProgressFill) importProgressFill.style.width = progress.progress + '%';
                            if (importPercent) importPercent.textContent = progress.progress + '%';
                            if (importSpeed) importSpeed.textContent = progress.speed || '';
                            if (importEta && progress.eta) importEta.textContent = 'ETA: ' + progress.eta;
                        }

                        if (progress.status === 'done') {
                            eventSource.close();
                            if (importSpinner) importSpinner.className = 'import-spinner done';
                            if (importProgressFill) importProgressFill.style.width = '100%';
                            if (importPercent) importPercent.textContent = '100%';
                            if (importStatusDetail) importStatusDetail.textContent = 'Video imported successfully!';
                            if (importSpeed) importSpeed.textContent = '';
                            if (importEta) importEta.textContent = '';

                            // Show result
                            setTimeout(() => {
                                if (importProgressSection) importProgressSection.style.display = 'none';
                                if (importResult) importResult.style.display = 'block';
                                if (importResultCard) importResultCard.className = 'import-result-card success';
                                if (importResultIcon) importResultIcon.textContent = '✅';
                                if (importResultText) importResultText.textContent = '"' + (progress.title || 'Video') + '" imported successfully!';
                                if (importResultBtn) importResultBtn.style.display = 'inline-flex';
                                if (importWatchBtn && progress.videoId) {
                                    importWatchBtn.style.display = 'inline-flex';
                                    importWatchBtn.href = '/watch/' + progress.videoId;
                                }

                                importBtn.disabled = false;
                                importBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Import Another</span>';
                                importUrlInput.value = '';
                                if (importTitleInput) importTitleInput.value = '';
                            }, 800);
                        }

                        if (progress.status === 'error') {
                            eventSource.close();
                            if (importSpinner) importSpinner.className = 'import-spinner error';
                            if (importStatusDetail) importStatusDetail.textContent = progress.error || 'Download failed';

                            setTimeout(() => {
                                if (importProgressSection) importProgressSection.style.display = 'none';
                                if (importResult) importResult.style.display = 'block';
                                if (importResultCard) importResultCard.className = 'import-result-card error';
                                if (importResultIcon) importResultIcon.textContent = '❌';
                                if (importResultText) importResultText.textContent = progress.error || 'Import failed. Try a different URL.';
                                if (importResultBtn) importResultBtn.style.display = 'none';
                                if (importWatchBtn) importWatchBtn.style.display = 'none';

                                importBtn.disabled = false;
                                importBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Try Again</span>';
                            }, 1200);
                        }
                    } catch (parseErr) {
                        // Ignore parse errors
                    }
                };

                eventSource.onerror = () => {
                    eventSource.close();
                    if (importStatusDetail) importStatusDetail.textContent = 'Lost connection. Check if the import completed on the dashboard.';
                    importBtn.disabled = false;
                    importBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Import Video</span>';
                };

            } catch (err) {
                if (importProgressSection) importProgressSection.style.display = 'none';
                if (importResult) importResult.style.display = 'block';
                if (importResultCard) importResultCard.className = 'import-result-card error';
                if (importResultIcon) importResultIcon.textContent = '❌';
                if (importResultText) importResultText.textContent = err.message || 'Could not start import.';
                if (importResultBtn) importResultBtn.style.display = 'none';
                if (importWatchBtn) importWatchBtn.style.display = 'none';

                importBtn.disabled = false;
                importBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>Try Again</span>';
            }
        });
    }

});
