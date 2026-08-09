// ========================================
// VideoHost — Client-side JavaScript
// ========================================

document.addEventListener('DOMContentLoaded', () => {

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
                eyeOpen.style.display = 'none';
                eyeClosed.style.display = 'block';
            } else {
                eyeOpen.style.display = 'block';
                eyeClosed.style.display = 'none';
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
                fileInput.files = e.dataTransfer.files;
                showSelectedFile(e.dataTransfer.files[0]);
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
                    if (progressText) progressText.textContent = 'Upload সম্পন্ন! ✅';
                    setTimeout(() => {
                        window.location.href = '/dashboard';
                    }, 500);
                } else {
                    let errMsg = 'Upload ব্যর্থ হয়েছে!';
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
                        uploadBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>আবার চেষ্টা করো</span>';
                    }
                }
            });

            xhr.addEventListener('error', () => {
                if (progressText) progressText.textContent = 'Upload ব্যর্থ হয়েছে! Network error.';
                if (uploadBtn) {
                    uploadBtn.disabled = false;
                    uploadBtn.innerHTML = '<span>আবার চেষ্টা করো</span>';
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

        // --- Utility ---
        function fmtTime(s) {
            if (isNaN(s) || !isFinite(s)) return '0:00';
            const m = Math.floor(s / 60);
            const sec = Math.floor(s % 60);
            return m + ':' + (sec < 10 ? '0' : '') + sec;
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

        function togglePlay() {
            if (vid.paused) {
                vid.play();
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

        vid.addEventListener('play', updatePlayState);
        vid.addEventListener('pause', updatePlayState);
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
            if (!vid.duration || vid.buffered.length === 0) return;
            const end = vid.buffered.end(vid.buffered.length - 1);
            const pct = (end / vid.duration) * 100;
            if (progressBuffer) progressBuffer.style.width = pct + '%';
        }

        vid.addEventListener('timeupdate', updateProgress);
        vid.addEventListener('progress', updateBuffer);
        vid.addEventListener('loadedmetadata', () => {
            if (durationEl) durationEl.textContent = fmtTime(vid.duration);
            updatePlayState();
        });
        vid.addEventListener('durationchange', () => {
            if (durationEl) durationEl.textContent = fmtTime(vid.duration);
        });

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
                isDragging = true;
                progressWrap.classList.add('vp-dragging');
                seekFromEvent(e.touches[0]);
            }, { passive: true });

            progressWrap.addEventListener('touchmove', (e) => {
                if (isDragging) seekFromEvent(e.touches[0]);
            }, { passive: true });
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
        if (volumeSlider) {
            volumeSlider.addEventListener('input', (e) => {
                e.stopPropagation();
                vid.volume = e.target.value / 100;
                vid.muted = vid.volume === 0;
                updateVolIcons();
            });
        }

        function updateVolIcons() {
            if (vid.muted || vid.volume === 0) {
                if (iconVolOn) iconVolOn.style.display = 'none';
                if (iconVolOff) iconVolOff.style.display = '';
            } else {
                if (iconVolOn) iconVolOn.style.display = '';
                if (iconVolOff) iconVolOff.style.display = 'none';
            }
        }

        if (muteBtn) {
            muteBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                vid.muted = !vid.muted;
                if (volumeSlider) volumeSlider.value = vid.muted ? 0 : vid.volume * 100;
                updateVolIcons();
            });
        }

        vid.addEventListener('volumechange', () => {
            if (volumeSlider && !vid.muted) volumeSlider.value = vid.volume * 100;
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
                (document.exitFullscreen || document.webkitExitFullscreen).call(document);
            } else {
                (container.requestFullscreen || container.webkitRequestFullscreen).call(container);
            }
        }

        function updateFsIcons() {
            if (isFullscreen()) {
                if (iconFsEnter) iconFsEnter.style.display = 'none';
                if (iconFsExit) iconFsExit.style.display = '';
            } else {
                if (iconFsEnter) iconFsEnter.style.display = '';
                if (iconFsExit) iconFsExit.style.display = 'none';
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

                if (now - lastClickTime < 300) {
                    // Double tap — seek
                    clearTimeout(clickTimer);
                    if (isLeftHalf) {
                        rewind(10);
                    } else {
                        forward(10);
                    }
                    lastClickTime = 0;
                } else {
                    // Single tap — play/pause with delay to check for double
                    lastClickTime = now;
                    clickTimer = setTimeout(() => {
                        togglePlay();
                        animateCenterBtn();
                    }, 300);
                }
            });
        }

        // --- Auto-hide Controls ---
        let hideTimer = null;

        function showControls() {
            if (container) container.classList.add('vp-controls-visible');
            clearTimeout(hideTimer);
            if (!vid.paused) {
                hideTimer = setTimeout(() => {
                    if (container) container.classList.remove('vp-controls-visible');
                }, 3000);
            }
        }

        if (container) {
            container.addEventListener('mousemove', showControls);
            container.addEventListener('touchstart', showControls, { passive: true });
        }

        vid.addEventListener('pause', () => {
            if (container) container.classList.add('vp-controls-visible');
            clearTimeout(hideTimer);
        });

        vid.addEventListener('play', () => {
            showControls();
        });

        // --- Resume Feature ---
        if (videoId) {
            const savedPosKey = 'videohosk_pos_' + videoId;
            const savedTime = parseFloat(localStorage.getItem(savedPosKey) || '0');

            vid.addEventListener('loadedmetadata', () => {
                if (savedTime > 5 && savedTime < vid.duration - 10) {
                    const resumeToast = document.getElementById('resumeToast');
                    const resumeTimeStr = document.getElementById('resumeTimeStr');
                    if (resumeToast && resumeTimeStr) {
                        resumeTimeStr.textContent = fmtTime(savedTime);
                        resumeToast.style.display = 'flex';

                        document.getElementById('btnResumeYes')?.addEventListener('click', () => {
                            vid.currentTime = savedTime;
                            vid.play();
                            resumeToast.style.display = 'none';
                        });

                        document.getElementById('btnResumeNo')?.addEventListener('click', () => {
                            localStorage.removeItem(savedPosKey);
                            resumeToast.style.display = 'none';
                            vid.play();
                        });
                    }
                }
            });

            // Save position periodically
            vid.addEventListener('timeupdate', () => {
                if (vid.currentTime > 2 && !vid.ended) {
                    localStorage.setItem(savedPosKey, vid.currentTime);
                }
            });

            vid.addEventListener('ended', () => {
                localStorage.removeItem(savedPosKey);
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
                    vid.muted = !vid.muted;
                    if (volumeSlider) volumeSlider.value = vid.muted ? 0 : vid.volume * 100;
                    updateVolIcons();
                    break;
                case 'arrowup':
                    e.preventDefault();
                    vid.volume = Math.min(1, vid.volume + 0.05);
                    if (volumeSlider) volumeSlider.value = vid.volume * 100;
                    break;
                case 'arrowdown':
                    e.preventDefault();
                    vid.volume = Math.max(0, vid.volume - 0.05);
                    if (volumeSlider) volumeSlider.value = vid.volume * 100;
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
            localStorage.setItem('videohosk_theater', isTheater ? '1' : '0');
        });
        if (localStorage.getItem('videohosk_theater') === '1') {
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
    videoCards.forEach((card, index) => {
        card.style.animationDelay = `${index * 0.1}s`;
    });

    // ---- Live Search Filter ----
    const searchInput = document.getElementById('searchInput');
    if (searchInput && videoCards.length > 0) {
        searchInput.addEventListener('input', (e) => {
            const query = e.target.value.toLowerCase().trim();
            videoCards.forEach(card => {
                const title = card.getAttribute('data-title') || '';
                if (!query || title.includes(query)) {
                    card.style.display = 'flex';
                } else {
                    card.style.display = 'none';
                }
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
                localStorage.setItem('videohosk_theme', theme);
                closeThemeModal();
            }
        });
    });

});
