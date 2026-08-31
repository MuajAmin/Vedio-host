// ========================================
// VideoHost — Client-side JavaScript
// ========================================

// Global CSRF protection: auto-inject x-csrf-token header on all mutating fetch() requests.
// Token is read from <meta name="csrf-token"> in layout.ejs.
(function () {
    const originalFetch = window.fetch;
    const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

    window.fetch = function (input, init) {
        init = init || {};
        const method = (init.method || 'GET').toUpperCase();

        if (!SAFE_METHODS.has(method)) {
            const csrfMeta = document.querySelector('meta[name="csrf-token"]');
            const token = csrfMeta ? csrfMeta.getAttribute('content') : '';

            if (token) {
                // Preserve existing headers (Headers object, plain object, or array)
                if (init.headers instanceof Headers) {
                    if (!init.headers.has('x-csrf-token')) {
                        init.headers.set('x-csrf-token', token);
                    }
                } else if (Array.isArray(init.headers)) {
                    const hasIt = init.headers.some(([k]) => k.toLowerCase() === 'x-csrf-token');
                    if (!hasIt) init.headers.push(['x-csrf-token', token]);
                } else {
                    init.headers = Object.assign({ 'x-csrf-token': token }, init.headers || {});
                }
            }
        }

        return originalFetch.call(this, input, init);
    };
})();
// ---- Global toast (accessible, single region, auto-dismiss) ----
// Referenced by UI mode / theme / scheme switchers. Defined globally so any
// module (messages.js, calling.js) can reuse it.
window.showToast = function showToast(message, duration) {
    try {
        let region = document.getElementById('vhToastRegion');
        if (!region) {
            region = document.createElement('div');
            region.id = 'vhToastRegion';
            region.className = 'vh-toast-region';
            region.setAttribute('role', 'status');
            region.setAttribute('aria-live', 'polite');
            document.body.appendChild(region);
        }
        const toast = document.createElement('div');
        toast.className = 'vh-toast';
        toast.textContent = String(message || '');
        region.appendChild(toast);
        // Keep at most 2 toasts on screen
        while (region.children.length > 2) region.removeChild(region.firstChild);
        requestAnimationFrame(() => toast.classList.add('vh-toast-visible'));
        const ttl = typeof duration === 'number' ? duration : 2600;
        setTimeout(() => {
            toast.classList.remove('vh-toast-visible');
            setTimeout(() => toast.remove(), 350);
        }, ttl);
    } catch (e) {}
};

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

    let vpsPollingInterval = null;

    // ========================================
    // SPA Router Engine (PJAX with Global Element Preservation)
    // ========================================
    function initSpaNavigation() {
        if (window.__SPA_ROUTER_ATTACHED__) return;
        window.__SPA_ROUTER_ATTACHED__ = true;

        const progressBar = document.getElementById('androidTopProgressBar');
        let isNavigating = false;

        function startProgress() {
            if (progressBar) {
                progressBar.style.width = '35%';
                progressBar.classList.add('is-loading');
                progressBar.classList.remove('is-finished');
            }
        }

        function advanceProgress() {
            if (progressBar) {
                progressBar.style.width = '75%';
            }
        }

        function finishProgress() {
            if (progressBar) {
                progressBar.style.width = '100%';
                setTimeout(() => {
                    progressBar.classList.add('is-finished');
                    progressBar.classList.remove('is-loading');
                    setTimeout(() => {
                        progressBar.style.width = '0%';
                        progressBar.classList.remove('is-finished');
                    }, 300);
                }, 150);
            }
        }

        function resetProgress() {
            if (progressBar) {
                progressBar.style.width = '0%';
                progressBar.classList.remove('is-loading', 'is-finished');
            }
        }

        function closeAllOpenModals() {
            const modals = ['shortcutsModal', 'downloadModal', 'deleteVideoModal', 'profileModal', 'themeModalBackdrop'];
            modals.forEach(id => {
                const el = document.getElementById(id);
                if (el) {
                    el.classList.remove('active', 'is-open');
                    if (id === 'profileModal') {
                        el.style.display = 'none';
                    }
                }
            });
            document.body.classList.remove('modal-open');
            document.documentElement.classList.remove('modal-open');
        }

        function cleanupCurrentPage() {
            // Close any open modals and reset backdrop/scroll locks
            closeAllOpenModals();

            // Cancel any pending typewriter timeouts
            if (window.__TYPEWRITER_TIMEOUT__) {
                clearTimeout(window.__TYPEWRITER_TIMEOUT__);
                window.__TYPEWRITER_TIMEOUT__ = null;
            }

            // Cancel any pending autoplay timers
            if (window.__AUTOPLAY_TIMER__) {
                clearTimeout(window.__AUTOPLAY_TIMER__);
                window.__AUTOPLAY_TIMER__ = null;
            }
            if (window.__AUTOPLAY_INTERVAL__) {
                clearInterval(window.__AUTOPLAY_INTERVAL__);
                window.__AUTOPLAY_INTERVAL__ = null;
            }

            // Clean video player memory
            const vid = document.getElementById('vpVideo');
            if (vid) {
                try {
                    vid.pause();
                    vid.removeAttribute('src');
                    vid.load();
                } catch (e) {}
            }
            if (vpsPollingInterval) {
                clearInterval(vpsPollingInterval);
                vpsPollingInterval = null;
            }
            if (window.hajeraLiveInterval) {
                clearInterval(window.hajeraLiveInterval);
                window.hajeraLiveInterval = null;
            }
            if (window.r2LiveInterval) {
                clearInterval(window.r2LiveInterval);
                window.r2LiveInterval = null;
            }
            if (window.__HEART_INTERVAL__) {
                clearInterval(window.__HEART_INTERVAL__);
                window.__HEART_INTERVAL__ = null;
            }
            if (window.__QUOTE_INTERVAL__) {
                clearInterval(window.__QUOTE_INTERVAL__);
                window.__QUOTE_INTERVAL__ = null;
            }
            if (window.__hajeraPollTimeout) {
                clearTimeout(window.__hajeraPollTimeout);
                window.__hajeraPollTimeout = null;
            }
            if (window.__liveTickerInterval) {
                clearInterval(window.__liveTickerInterval);
                window.__liveTickerInterval = null;
            }
            window.dispatchEvent(new CustomEvent('page:cleanup'));
        }

        async function navigateTo(url, push = true) {
            if (isNavigating) return;
            isNavigating = true;
            startProgress();

            try {
                cleanupCurrentPage();
                advanceProgress();

                const res = await fetch(url, {
                    headers: { 'X-Requested-With': 'VideoHost-PJAX' }
                });

                if (res.redirected) {
                    window.location.href = res.url;
                    return;
                }

                if (!res.ok) {
                    window.location.href = url;
                    return;
                }

                const html = await res.text();

                const parser = new DOMParser();
                const doc = parser.parseFromString(html, 'text/html');

                const currentContainer = document.querySelector('.app-container, .login-container') || document.querySelector('.main-content');
                const newContainer = doc.querySelector('.app-container, .login-container') || doc.querySelector('.main-content');

                if (currentContainer && newContainer) {
                    currentContainer.replaceWith(newContainer);
                } else {
                    window.location.href = url;
                    return;
                }

                // Update document title and data-page
                document.title = doc.title;
                const newPage = doc.body.getAttribute('data-page') || '';
                document.body.setAttribute('data-page', newPage);

                // Update theme, scheme & UI mode if changed.
                // The client is the source of truth for scheme (cookie synced),
                // so keep the current attribute when the fetched doc lacks one.
                const newScheme = doc.documentElement.getAttribute('data-scheme');
                if (newScheme === 'dark' || newScheme === 'light') {
                    document.documentElement.setAttribute('data-scheme', newScheme);
                }
                const newTheme = doc.documentElement.getAttribute('data-theme');
                if (newTheme) {
                    document.documentElement.setAttribute('data-theme', newTheme);
                    const activeScheme = document.documentElement.getAttribute('data-scheme');
                    const themeMetaColors = activeScheme === 'light'
                        ? { cinematic: '#f3f4f9', cyberpunk: '#eff6fb', emerald: '#f0f7f3', sunset: '#fdf3f5' }
                        : { cinematic: '#060609', cyberpunk: '#05050d', emerald: '#030806', sunset: '#0c040a' };
                    const metaTheme = document.querySelector('meta[name="theme-color"]');
                    if (metaTheme && themeMetaColors[newTheme]) {
                        metaTheme.setAttribute('content', themeMetaColors[newTheme]);
                    }
                }
                const newUiMode = doc.documentElement.getAttribute('data-ui-mode');
                if (newUiMode) {
                    document.documentElement.setAttribute('data-ui-mode', newUiMode);
                }
                if (typeof syncActiveThemeOption === 'function') syncActiveThemeOption();
                if (typeof syncActiveUiModeOption === 'function') syncActiveUiModeOption();

                // Update active bottom bar item
                const targetPath = new URL(url, window.location.origin).pathname;
                document.querySelectorAll('.mobile-bottom-bar a, .android-bottom-nav a').forEach(a => {
                    const href = a.getAttribute('href');
                    if (href && (href === targetPath || (href === '/dashboard' && targetPath === '/') || (targetPath.startsWith('/watch/') && href === '/dashboard'))) {
                        a.classList.add('active');
                    } else {
                        a.classList.remove('active');
                    }
                });

                if (push) {
                    window.history.pushState({ url }, doc.title, url);
                }

                window.scrollTo({ top: 0, behavior: 'instant' });

                // Run page-specific initializers for the new DOM
                initPageModules();

                // Dispatch global event for messages, calling, and watchTogether
                window.dispatchEvent(new CustomEvent('page:navigate', { detail: { url, page: newPage } }));

                finishProgress();
            } catch (err) {
                console.error('[SPA] Route error:', err);
                resetProgress();
                window.location.href = url;
            } finally {
                isNavigating = false;
            }
        }

        // Prefetching full HTML pages on every hover/touch can make a small VPS
        // render many pages that the visitor never opens. Navigation already uses
        // PJAX, so fetch the destination only after the user actually clicks it.

        document.addEventListener('click', (e) => {
            const link = e.target.closest('a');
            if (!link) return;

            if (link.target && link.target !== '_self') return;
            if (link.hasAttribute('download')) return;
            if (link.getAttribute('href')?.startsWith('#')) return;

            const href = link.getAttribute('href');
            if (!href || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) return;

            try {
                const destUrl = new URL(link.href, window.location.href);
                if (destUrl.origin !== window.location.origin) return;

                const path = destUrl.pathname;
                if (
                    path.startsWith('/stream/') ||
                    path.startsWith('/thumbnails/') ||
                    path.startsWith('/avatars/') ||
                    path.startsWith('/voice/') ||
                    path.startsWith('/download/') ||
                    path.startsWith('/login') ||
                    path.startsWith('/logout')
                ) {
                    return;
                }

                if (destUrl.pathname === window.location.pathname && destUrl.search === window.location.search) {
                    e.preventDefault();
                    return;
                }

                e.preventDefault();
                navigateTo(destUrl.href, true);
            } catch (err) {}
        });

        window.addEventListener('popstate', () => {
            navigateTo(window.location.href, false);
        });
    }

    // ========================================
    // Page Component Modules Initializer
    // ========================================
    function initPageModules() {
        // Dynamic navbar elevation on scroll
        const navbars = document.querySelectorAll('.navbar, .android-app-bar');
        if (navbars.length > 0) {
            const handleNavScroll = () => {
                const isScrolled = window.scrollY > 12;
                document.querySelectorAll('.navbar, .android-app-bar').forEach(nav => {
                    if (isScrolled) {
                        nav.classList.add('is-scrolled');
                    } else {
                        nav.classList.remove('is-scrolled');
                    }
                });
            };
            if (!window.__NAVBAR_SCROLL_ATTACHED__) {
                window.__NAVBAR_SCROLL_ATTACHED__ = true;
                window.addEventListener('scroll', handleNavScroll, { passive: true });
            }
            handleNavScroll();
        }

        // Global listeners (registered once)
        if (!window.__GLOBAL_APP_LISTENERS_ATTACHED__) {
            window.__GLOBAL_APP_LISTENERS_ATTACHED__ = true;

            // Thumbnail error fallback — replaces inline onerror blocked by CSP
            document.addEventListener('error', (e) => {
                if (e.target && e.target.matches && e.target.matches('.thumb-img, .suggestion-thumb-img, .msg-attach-thumb, .r2-card-thumb-img, .hajera-card-thumb-img, .admin-table-thumb-img, .admin-video-card-thumb-img')) {
                    e.target.classList.add('thumb-error');
                    const parent = e.target.parentElement;
                    if (parent) {
                        const placeholder = parent.querySelector('.thumb-placeholder, .suggestion-thumb-placeholder');
                        if (placeholder) {
                            placeholder.classList.remove('has-thumb');
                            placeholder.style.opacity = '0.7';
                        }
                    }
                }
            }, true); // capture phase — img error events don't bubble

            document.addEventListener('submit', (e) => {
                const form = e.target;
                if (!(form instanceof HTMLFormElement)) return;

                const message = form.getAttribute('data-confirm');
                if (message && !window.confirm(message)) {
                    e.preventDefault();
                }
            });

            document.addEventListener('click', (e) => {
                const el = e.target.closest('[data-confirm]');
                if (!el || el.tagName === 'FORM') return;

                const message = el.getAttribute('data-confirm');
                if (message && !window.confirm(message)) {
                    e.preventDefault();
                    e.stopPropagation();
                }
            });

            // Consolidated Modal Escape Key Listener
            document.addEventListener('keydown', (e) => {
                if (e.key !== 'Escape') return;
                const sm = document.getElementById('shortcutsModal');
                if (sm && sm.classList.contains('active')) sm.classList.remove('active');
                const dm = document.getElementById('downloadModal');
                if (dm && dm.classList.contains('active')) dm.classList.remove('active');
                const dvm = document.getElementById('deleteVideoModal');
                if (dvm && dvm.classList.contains('active')) dvm.classList.remove('active');
                const pm = document.getElementById('profileModal');
                if (pm && pm.classList.contains('active')) {
                    pm.classList.remove('active');
                    setTimeout(() => { if (!pm.classList.contains('active')) pm.style.display = 'none'; }, 250);
                }
                const tm = document.getElementById('themeModalBackdrop');
                if (tm && tm.classList.contains('active')) tm.classList.remove('active');
            });
        }

    // ---- Inline Title Edit ----
    const titleWrap = document.getElementById('videoTitleWrap');
    const titleText = document.getElementById('videoTitleText');
    const titleEditBtn = document.getElementById('titleEditBtn');
    const titleEditForm = document.getElementById('titleEditForm');
    const titleEditInput = document.getElementById('titleEditInput');
    const titleSaveBtn = document.getElementById('titleSaveBtn');
    const titleCancelBtn = document.getElementById('titleCancelBtn');

    if (titleWrap && titleEditBtn && titleEditForm && titleEditInput) {
        const renameUrl = titleWrap.getAttribute('data-rename-url');
        const csrfToken = titleWrap.getAttribute('data-csrf');

        function startEditing() {
            titleEditInput.value = titleText.textContent;
            titleWrap.classList.add('editing');
            titleEditForm.style.display = '';
            titleEditInput.focus();
            titleEditInput.select();
        }

        function cancelEditing() {
            titleWrap.classList.remove('editing');
            titleEditForm.style.display = 'none';
        }

        function saveTitle() {
            const newTitle = titleEditInput.value.trim();
            if (!newTitle || newTitle === titleText.textContent) {
                cancelEditing();
                return;
            }

            titleSaveBtn.disabled = true;
            fetch(renameUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-CSRF-Token': csrfToken
                },
                body: JSON.stringify({ title: newTitle })
            })
            .then(function(res) { return res.json(); })
            .then(function(data) {
                if (data.success) {
                    titleText.textContent = data.title;
                    document.title = data.title;
                    cancelEditing();
                }
            })
            .catch(function() {})
            .finally(function() { titleSaveBtn.disabled = false; });
        }

        titleEditBtn.addEventListener('click', startEditing);
        titleCancelBtn.addEventListener('click', cancelEditing);
        titleSaveBtn.addEventListener('click', saveTitle);
        titleEditInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { e.preventDefault(); saveTitle(); }
            if (e.key === 'Escape') { cancelEditing(); }
        });
    }

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

    // ---- Client-Side Video Metadata & Thumbnail Extractor (HTML5 Video + Canvas) ----
    function extractClientVideoMetadata(file) {
        return new Promise((resolve) => {
            try {
                const video = document.createElement('video');
                video.preload = 'metadata';
                video.muted = true;
                video.playsInline = true;

                const url = URL.createObjectURL(file);
                video.src = url;

                let settled = false;
                const cleanup = () => {
                    if (!settled) {
                        settled = true;
                        try { URL.revokeObjectURL(url); } catch {}
                        try {
                            video.removeAttribute('src');
                            video.load();
                        } catch {}
                    }
                };

                const timeout = setTimeout(() => {
                    cleanup();
                    resolve({ duration: null, thumbnailBase64: null });
                }, 5000);

                video.addEventListener('loadedmetadata', () => {
                    const dur = video.duration;
                    let formattedDuration = null;
                    if (Number.isFinite(dur) && dur > 0) {
                        const h = Math.floor(dur / 3600);
                        const m = Math.floor((dur % 3600) / 60);
                        const s = Math.floor(dur % 60);
                        if (h > 0) {
                            formattedDuration = `${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
                        } else {
                            formattedDuration = `${m}:${s < 10 ? '0' : ''}${s}`;
                        }
                    }

                    const seekTime = (Number.isFinite(dur) && dur > 3) ? Math.min(dur * 0.25, 30) : 0.5;
                    video.currentTime = seekTime;

                    video.addEventListener('seeked', () => {
                        clearTimeout(timeout);
                        try {
                            const canvas = document.createElement('canvas');
                            const targetWidth = 480;
                            const vWidth = video.videoWidth || 640;
                            const vHeight = video.videoHeight || 360;
                            const targetHeight = Math.round((vHeight / vWidth) * targetWidth) || 270;

                            canvas.width = targetWidth;
                            canvas.height = targetHeight;
                            const ctx = canvas.getContext('2d');
                            ctx.drawImage(video, 0, 0, targetWidth, targetHeight);

                            const thumbnailBase64 = canvas.toDataURL('image/jpeg', 0.82);
                            cleanup();
                            resolve({ duration: formattedDuration, thumbnailBase64 });
                        } catch (e) {
                            cleanup();
                            resolve({ duration: formattedDuration, thumbnailBase64: null });
                        }
                    }, { once: true });
                }, { once: true });

                video.addEventListener('error', () => {
                    clearTimeout(timeout);
                    cleanup();
                    resolve({ duration: null, thumbnailBase64: null });
                }, { once: true });
            } catch (e) {
                resolve({ duration: null, thumbnailBase64: null });
            }
        });
    }

    // ---- Enhanced Multi-Stage / Direct Upload Progress ----
    const uploadForm = document.getElementById('uploadForm');
    const uploadProgress = document.getElementById('uploadProgress');
    const progressFill = document.getElementById('progressFill');
    const progressText = document.getElementById('progressText');
    const uploadBtn = document.getElementById('uploadBtn');

    // Stage 1 & Stage 2 UI Elements
    const stage1Name = document.getElementById('stage1Name');
    const stageDeviceToVps = document.getElementById('stageDeviceToVps');
    const stageVpsToR2 = document.getElementById('stageVpsToR2');
    const stage1Badge = document.getElementById('stage1Badge');
    const stage2Badge = document.getElementById('stage2Badge');
    const r2ProgressFill = document.getElementById('r2ProgressFill');
    const r2ProgressText = document.getElementById('r2ProgressText');
    const r2StatsRow = document.getElementById('r2StatsRow');
    const r2UploadedSize = document.getElementById('r2UploadedSize');
    const r2Speed = document.getElementById('r2Speed');
    const r2Eta = document.getElementById('r2Eta');
    const uploadCompleteActions = document.getElementById('uploadCompleteActions');
    const btnWatchNow = document.getElementById('btnWatchNow');

    if (uploadForm && fileInput) {
        let activeXhr = null;
        let activeR2Sse = null;
        let isUploadingActive = false;

        uploadForm.addEventListener('submit', async (e) => {
            if (isUploadingActive) {
                e.preventDefault();
                return;
            }
            if (!fileInput.files || fileInput.files.length === 0) return;

            isUploadingActive = true;
            e.preventDefault();

            if (activeR2Sse) {
                try { activeR2Sse.close(); } catch {}
                activeR2Sse = null;
            }

            const file = fileInput.files[0];
            const titleInput = document.getElementById('title');
            const customTitle = (titleInput ? titleInput.value.trim() : '') || file.name;
            const csrfInput = uploadForm.querySelector('input[name="_csrf"]');
            const csrfToken = csrfInput ? csrfInput.value : '';

            // Reset progress UI
            if (uploadProgress) uploadProgress.style.display = 'flex';
            if (stageDeviceToVps) stageDeviceToVps.className = 'upload-stage-item active';
            if (stage1Badge) {
                stage1Badge.className = 'upload-stage-badge badge-running';
                stage1Badge.textContent = 'Initializing';
            }
            if (progressFill) progressFill.style.width = '0%';
            if (r2ProgressFill) r2ProgressFill.style.width = '0%';
            if (r2StatsRow) r2StatsRow.style.display = 'none';
            if (uploadCompleteActions) uploadCompleteActions.style.display = 'none';

            if (uploadBtn) {
                uploadBtn.disabled = true;
                uploadBtn.innerHTML = '<span>Preparing Upload...</span>';
            }

            // Start client-side thumbnail & duration extraction concurrently
            const metadataPromise = extractClientVideoMetadata(file);

            // 1. Try Direct-to-R2 Upload ticket first
            try {
                const initRes = await fetch('/api/upload/init', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json'
                    },
                    body: JSON.stringify({
                        filename: file.name,
                        title: customTitle,
                        size: file.size,
                        mimeType: file.type || 'video/mp4',
                        _csrf: csrfToken
                    })
                });

                const initData = await initRes.json();

                if (initData && initData.success && initData.directUpload && initData.uploadUrl) {
                    // Direct upload enabled! Stream directly to Cloudflare Edge (zero VPS outbound bandwidth)
                    return runDirectUpload(file, initData, metadataPromise, customTitle, csrfToken);
                }
            } catch (initErr) {
                console.warn('[upload] Direct upload initialization failed, using server fallback:', initErr);
            }

            // Fallback: standard server multipart upload
            runServerRelayUpload(metadataPromise);
        });

        // ---- Direct Upload to Cloudflare Edge Function ----
        function runDirectUpload(file, initData, metadataPromise, title, csrfToken) {
            if (stage1Name) stage1Name.textContent = 'Direct Upload: Device ➔ Cloudflare Edge CDN';
            if (stage1Badge) {
                stage1Badge.className = 'upload-stage-badge badge-running';
                stage1Badge.textContent = 'Uploading Direct';
            }
            if (stageVpsToR2) stageVpsToR2.style.display = 'none';
            if (progressText) progressText.textContent = 'Uploading directly to Cloudflare R2... 0%';
            if (uploadBtn) uploadBtn.innerHTML = '<span>Uploading Direct to Cloudflare Edge...</span>';

            const xhr = new XMLHttpRequest();
            activeXhr = xhr;

            const speedSamples = [];
            const SPEED_WINDOW_MS = 3000;

            function getRealtimeSpeed(loaded) {
                const now = Date.now();
                speedSamples.push({ time: now, bytes: loaded });
                while (speedSamples.length > 1 && now - speedSamples[0].time > SPEED_WINDOW_MS) {
                    speedSamples.shift();
                }
                if (speedSamples.length < 2) return 0;
                const oldest = speedSamples[0];
                const newest = speedSamples[speedSamples.length - 1];
                const timeDiff = (newest.time - oldest.time) / 1000;
                if (timeDiff < 0.2) return 0;
                return (newest.bytes - oldest.bytes) / timeDiff;
            }

            xhr.timeout = 20 * 60 * 1000;

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = Math.min(99, Math.round((e.loaded / e.total) * 100));
                    if (progressFill) progressFill.style.width = percent + '%';

                    const bytesPerSec = getRealtimeSpeed(e.loaded);
                    let speedText = '';

                    if (bytesPerSec > 0) {
                        if (bytesPerSec >= 1024 * 1024) {
                            speedText = ' • ' + (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
                        } else {
                            speedText = ' • ' + (bytesPerSec / 1024).toFixed(0) + ' KB/s';
                        }
                        if (percent < 100 && bytesPerSec > 0) {
                            const remaining = (e.total - e.loaded) / bytesPerSec;
                            if (remaining < 60) {
                                speedText += ' • ~' + Math.ceil(remaining) + 's left';
                            } else {
                                const mins = Math.floor(remaining / 60);
                                const secs = Math.ceil(remaining % 60);
                                speedText += ' • ~' + mins + 'm ' + secs + 's left';
                            }
                        }
                    }

                    const uploadedMB = (e.loaded / (1024 * 1024)).toFixed(1);
                    const totalMB = (e.total / (1024 * 1024)).toFixed(1);
                    const sizeText = ' • ' + uploadedMB + '/' + totalMB + ' MB';

                    if (progressText) progressText.textContent = 'Direct Uploading... ' + percent + '%' + sizeText + speedText;
                }
            });

            xhr.addEventListener('load', async () => {
                activeXhr = null;

                if (xhr.status >= 200 && xhr.status < 300) {
                    if (progressFill) progressFill.style.width = '100%';
                    if (progressText) progressText.textContent = 'Upload complete! Finalizing metadata...';
                    if (stage1Badge) {
                        stage1Badge.className = 'upload-stage-badge badge-done';
                        stage1Badge.textContent = '✓ Done';
                    }

                    // Await client-extracted thumbnail and duration
                    let meta = { duration: null, thumbnailBase64: null };
                    try {
                        meta = await metadataPromise;
                    } catch {}

                    try {
                        const finRes = await fetch('/api/upload/finalize', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                                'Accept': 'application/json'
                            },
                            body: JSON.stringify({
                                id: initData.id,
                                filename: initData.filename,
                                originalName: file.name,
                                title: title || file.name,
                                size: file.size,
                                duration: meta.duration,
                                thumbnailBase64: meta.thumbnailBase64,
                                _csrf: csrfToken
                            })
                        });

                        const finData = await finRes.json();

                        if (finData && finData.success) {
                            if (stageDeviceToVps) stageDeviceToVps.className = 'upload-stage-item completed';
                            if (progressText) progressText.textContent = 'Uploaded directly to Cloudflare R2 Edge ✓';
                            if (uploadCompleteActions) {
                                uploadCompleteActions.style.display = 'flex';
                                if (btnWatchNow && finData.id) {
                                    btnWatchNow.href = '/watch/' + encodeURIComponent(finData.id);
                                }
                            }
                            if (uploadBtn) {
                                uploadBtn.disabled = false;
                                uploadBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg><span>✓ Complete</span>';
                            }
                            setTimeout(() => {
                                if (window.location.pathname === '/upload') {
                                    window.location.href = '/dashboard';
                                }
                            }, 2500);
                            return;
                        }
                    } catch (finErr) {
                        console.error('[upload] Finalization error:', finErr);
                    }
                }

                // If direct PUT failed, seamlessly fallback to server relay upload
                console.warn(`[upload] Direct upload returned status ${xhr.status}, switching to server fallback...`);
                if (stageVpsToR2) stageVpsToR2.style.display = 'block';
                if (stage1Name) stage1Name.textContent = 'Step 1: Device ➔ Server (VPS)';
                runServerRelayUpload(metadataPromise);
            });

            xhr.addEventListener('error', () => {
                activeXhr = null;
                console.warn('[upload] Direct upload network error, switching to server fallback...');
                if (stageVpsToR2) stageVpsToR2.style.display = 'block';
                if (stage1Name) stage1Name.textContent = 'Step 1: Device ➔ Server (VPS)';
                runServerRelayUpload(metadataPromise);
            });

            xhr.open('PUT', initData.uploadUrl);
            const contentType = initData.headers && initData.headers['Content-Type']
                ? initData.headers['Content-Type']
                : (file.type || 'video/mp4');
            xhr.setRequestHeader('Content-Type', contentType);
            xhr.send(file);
        }

        // ---- Fallback Server Relay Upload Function ----
        function runServerRelayUpload(metadataPromise) {
            if (stage1Name) stage1Name.textContent = 'Step 1: Device ➔ Server (VPS)';
            if (stageDeviceToVps) stageDeviceToVps.className = 'upload-stage-item active';
            if (stage1Badge) {
                stage1Badge.className = 'upload-stage-badge badge-running';
                stage1Badge.textContent = 'Uploading';
            }
            if (stageVpsToR2) {
                stageVpsToR2.style.display = 'block';
                stageVpsToR2.className = 'upload-stage-item';
            }
            if (stage2Badge) {
                stage2Badge.className = 'upload-stage-badge badge-pending';
                stage2Badge.textContent = 'Waiting';
            }
            if (uploadBtn) {
                uploadBtn.disabled = true;
                uploadBtn.innerHTML = '<span>Uploading to Server...</span>';
            }

            const formData = new FormData(uploadForm);
            const xhr = new XMLHttpRequest();
            activeXhr = xhr;

            const speedSamples = [];
            const SPEED_WINDOW_MS = 3000;

            function getRealtimeSpeed(loaded) {
                const now = Date.now();
                speedSamples.push({ time: now, bytes: loaded });
                while (speedSamples.length > 1 && now - speedSamples[0].time > SPEED_WINDOW_MS) {
                    speedSamples.shift();
                }
                if (speedSamples.length < 2) return 0;
                const oldest = speedSamples[0];
                const newest = speedSamples[speedSamples.length - 1];
                const timeDiff = (newest.time - oldest.time) / 1000;
                if (timeDiff < 0.3) return 0;
                return (newest.bytes - oldest.bytes) / timeDiff;
            }

            xhr.timeout = 15 * 60 * 1000;

            xhr.upload.addEventListener('progress', (e) => {
                if (e.lengthComputable) {
                    const percent = Math.round((e.loaded / e.total) * 100);
                    if (progressFill) progressFill.style.width = percent + '%';

                    const bytesPerSec = getRealtimeSpeed(e.loaded);
                    let speedText = '';

                    if (bytesPerSec > 0) {
                        if (bytesPerSec >= 1024 * 1024) {
                            speedText = ' • ' + (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
                        } else {
                            speedText = ' • ' + (bytesPerSec / 1024).toFixed(0) + ' KB/s';
                        }
                        if (percent < 100 && bytesPerSec > 0) {
                            const remaining = (e.total - e.loaded) / bytesPerSec;
                            if (remaining < 60) {
                                speedText += ' • ~' + Math.ceil(remaining) + 's left';
                            } else {
                                const mins = Math.floor(remaining / 60);
                                const secs = Math.ceil(remaining % 60);
                                speedText += ' • ~' + mins + 'm ' + secs + 's left';
                            }
                        }
                    }

                    const uploadedMB = (e.loaded / (1024 * 1024)).toFixed(1);
                    const totalMB = (e.total / (1024 * 1024)).toFixed(1);
                    const sizeText = ' • ' + uploadedMB + '/' + totalMB + ' MB';

                    if (progressText) progressText.textContent = 'Uploading... ' + percent + '%' + sizeText + speedText;
                }
            });

            xhr.addEventListener('load', () => {
                activeXhr = null;

                if (xhr.status >= 200 && xhr.status < 400) {
                    if (progressFill) progressFill.style.width = '100%';
                    if (progressText) progressText.textContent = 'Uploaded to Server ✓';
                    if (stageDeviceToVps) stageDeviceToVps.className = 'upload-stage-item completed';
                    if (stage1Badge) {
                        stage1Badge.className = 'upload-stage-badge badge-done';
                        stage1Badge.textContent = '✓ Done';
                    }

                    let respData = null;
                    try {
                        respData = JSON.parse(xhr.responseText);
                    } catch (parseErr) {}

                    if (respData && respData.r2Enabled && respData.filename) {
                        if (stageVpsToR2) stageVpsToR2.className = 'upload-stage-item active';
                        if (stage2Badge) {
                            stage2Badge.className = 'upload-stage-badge badge-running';
                            stage2Badge.textContent = 'Syncing';
                        }
                        if (r2ProgressText) r2ProgressText.textContent = 'Starting Cloudflare R2 sync...';
                        if (r2StatsRow) r2StatsRow.style.display = 'flex';
                        if (uploadBtn) uploadBtn.innerHTML = '<span>Syncing to Cloudflare R2...</span>';

                        const sseUrl = '/api/r2-progress/' + encodeURIComponent(respData.filename);
                        const sse = new EventSource(sseUrl);
                        activeR2Sse = sse;

                        sse.onmessage = (event) => {
                            try {
                                const p = JSON.parse(event.data);
                                const r2Percent = p.percent || 0;

                                if (r2ProgressFill) r2ProgressFill.style.width = r2Percent + '%';

                                if (p.loaded && p.total && r2UploadedSize) {
                                    const upMB = (p.loaded / (1024 * 1024)).toFixed(1);
                                    const totMB = (p.total / (1024 * 1024)).toFixed(1);
                                    r2UploadedSize.textContent = `${upMB} / ${totMB} MB`;
                                }

                                if (r2Speed) r2Speed.textContent = p.speed ? ` • ${p.speed}` : '';
                                if (r2Eta) r2Eta.textContent = p.eta ? ` • ${p.eta}` : '';

                                if (r2ProgressText) {
                                    r2ProgressText.textContent = p.status === 'done'
                                        ? 'Synced to Cloudflare R2 Edge ✓'
                                        : `Syncing to Cloudflare R2... ${r2Percent}%`;
                                }

                                if (p.status === 'done' || r2Percent >= 100) {
                                    sse.close();
                                    activeR2Sse = null;
                                    if (stageVpsToR2) stageVpsToR2.className = 'upload-stage-item completed';
                                    if (stage2Badge) {
                                        stage2Badge.className = 'upload-stage-badge badge-done';
                                        stage2Badge.textContent = '✓ Synced';
                                    }
                                    if (uploadCompleteActions) {
                                        uploadCompleteActions.style.display = 'flex';
                                        if (btnWatchNow && respData.id) {
                                            btnWatchNow.href = '/watch/' + encodeURIComponent(respData.id);
                                        }
                                    }
                                    if (uploadBtn) {
                                        uploadBtn.disabled = false;
                                        uploadBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><polyline points="20 6 9 17 4 12"/></svg><span>✓ Complete</span>';
                                    }

                                    setTimeout(() => {
                                        if (window.location.pathname === '/upload') {
                                            window.location.href = '/dashboard';
                                        }
                                    }, 3000);
                                } else if (p.status === 'error') {
                                    sse.close();
                                    activeR2Sse = null;
                                    if (stage2Badge) {
                                        stage2Badge.className = 'upload-stage-badge badge-error';
                                        stage2Badge.textContent = 'Fallback';
                                    }
                                    if (r2ProgressText) r2ProgressText.textContent = 'R2 sync failed (Saved on server storage)';
                                    setTimeout(() => { window.location.href = '/dashboard'; }, 2000);
                                }
                            } catch (e) {}
                        };

                        sse.onerror = () => {
                            setTimeout(() => {
                                if (window.location.pathname === '/upload') {
                                    window.location.href = '/dashboard';
                                }
                            }, 4000);
                        };
                    } else {
                        if (uploadBtn) uploadBtn.innerHTML = '<span>Upload Complete! Redirecting...</span>';
                        setTimeout(() => {
                            window.location.href = '/dashboard';
                        }, 600);
                    }
                } else {
                    let errMsg = 'Upload failed.';
                    try {
                        const json = JSON.parse(xhr.responseText);
                        if (json && json.error) errMsg = json.error;
                    } catch {
                        try {
                            const tempDiv = document.createElement('div');
                            tempDiv.innerHTML = xhr.responseText;
                            const alertSpan = tempDiv.querySelector('.alert-error span');
                            if (alertSpan && alertSpan.textContent) {
                                errMsg = alertSpan.textContent;
                            }
                        } catch {}
                    }
                    if (progressText) progressText.textContent = errMsg;
                    if (stage1Badge) {
                        stage1Badge.className = 'upload-stage-badge badge-error';
                        stage1Badge.textContent = 'Error';
                    }
                    if (uploadBtn) {
                        uploadBtn.disabled = false;
                        uploadBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Try again</span>';
                    }
                }
            });

            xhr.addEventListener('error', () => {
                activeXhr = null;
                if (progressText) progressText.textContent = 'Upload failed. Network error — check your connection.';
                if (stage1Badge) {
                    stage1Badge.className = 'upload-stage-badge badge-error';
                    stage1Badge.textContent = 'Error';
                }
                if (uploadBtn) {
                    uploadBtn.disabled = false;
                    uploadBtn.innerHTML = '<span>Try again</span>';
                }
            });

            xhr.addEventListener('timeout', () => {
                activeXhr = null;
                if (progressText) progressText.textContent = 'Upload timed out. Connection too slow — try again later.';
                if (uploadBtn) {
                    uploadBtn.disabled = false;
                    uploadBtn.innerHTML = '<span>Try again</span>';
                }
            });

            xhr.addEventListener('abort', () => {
                activeXhr = null;
                if (progressText) progressText.textContent = 'Upload cancelled.';
                if (progressFill) progressFill.style.width = '0%';
                if (uploadBtn) {
                    uploadBtn.disabled = false;
                    uploadBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg><span>Upload</span>';
                }
            });

            xhr.open('POST', '/upload');
            xhr.setRequestHeader('Accept', 'application/json');
            xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');
            xhr.send(formData);
        }
    }

    // ---- Custom Video Player Logic ----
    const vid = document.getElementById('vpVideo');
    if (vid) {
        const playerAbort = new AbortController();
        const playerSignal = { signal: playerAbort.signal };
        window.addEventListener('page:cleanup', () => {
            try { playerAbort.abort(); } catch (e) {}
        }, { once: true });

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
        const loadingOverlay = document.getElementById('vpLoadingOverlay');
        const loadingTitle = document.getElementById('vpLoadingTitle');
        const loadingDetail = document.getElementById('vpLoadingDetail');
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

        // Only show overlay for errors and offline — no loading/buffering messages
        function setPlayerStatus(state, title, detail, options = {}) {
            const isError = state === 'error' || state === 'offline' || state === 'warning';
            const showOverlay = isError && options.showOverlay === true;

            if (!isError) {
                // For non-error states, just silently clear
                clearPlayerStatus();
                return;
            }

            if (statusHideTimer) window.clearTimeout(statusHideTimer);
            statusHideTimer = null;

            if (loadingTitle) loadingTitle.textContent = title;
            if (loadingDetail) loadingDetail.textContent = detail || '';
            if (retryBtn) retryBtn.hidden = options.canRetry !== true;
            if (loadingOverlay) loadingOverlay.setAttribute('aria-hidden', showOverlay ? 'false' : 'true');

            if (container) {
                container.classList.add('vp-has-status');
                container.classList.toggle('vp-error', state === 'error');
                container.classList.toggle('vp-offline', state === 'offline');
                container.classList.toggle('vp-warning', state === 'warning');
                if (showOverlay) container.classList.add('vp-controls-visible');
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
            // 5 seconds is generous — on mobile 4G, metadata typically loads in 1-3s.
            // Only show a warning if it takes significantly longer than normal.
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
            }, 5000);
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
            // Guard: don't destroy an active stream that's working fine.
            // vid.load() resets ALL buffered data — only call when truly needed.
            if (autoRetry && !vid.error && vid.readyState >= 3 && getBufferedAhead() >= 2) {
                clearPlayerStatus();
                return;
            }

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

            // Snapshot current buffer to detect growth
            const bufferBefore = getBufferedAhead();

            // Use connection-aware timeout: slower networks get more patience
            const connType = (connection && connection.effectiveType) || '4g';
            let timeout = 12000; // default 12s (increased to reduce false positives on loaded VPS)
            if (connType === 'slow-2g' || connType === '2g') timeout = 22000;
            else if (connType === '3g') timeout = 18000;

            recoveryTimer = window.setTimeout(() => {
                // Check if buffer grew since we started waiting
                const bufferNow = getBufferedAhead();
                if (vid.readyState >= 3 || bufferNow >= 1.5) return; // Recovered naturally

                // If buffer is growing (even slowly), don't retry — let it continue
                if (bufferNow > bufferBefore + 0.3) return;

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
            }, timeout);
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
        if (centerBtn) centerBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlay(); });

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
        }

        vid.addEventListener('timeupdate', updateProgress);
        vid.addEventListener('progress', updateBuffer);
        vid.addEventListener('loadstart', () => {
            startSlowStartTimer();
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
        // Show spinner immediately (loadstart may have already fired before JS runs)
        if (container && vid.readyState < 3) {
            container.classList.add('vp-buffering');
        }

        vid.addEventListener('loadstart', () => {
            if (container) container.classList.add('vp-buffering');
        });
        vid.addEventListener('loadeddata', () => {
            clearSlowStartTimer();
            updateBuffer();
            if (container && (vid.readyState >= 3 || !vid.paused)) container.classList.remove('vp-buffering');
        });
        vid.addEventListener('canplay', () => {
            if (container) container.classList.remove('vp-buffering');
            clearRecoveryTimer();
            clearSlowStartTimer();
            updateBuffer();
            clearPlayerStatus();
        });
        vid.addEventListener('playing', () => {
            if (container) container.classList.remove('vp-buffering');
            retryCount = 0;
            clearRecoveryTimer();
            clearSlowStartTimer();
            updateBuffer();
            clearPlayerStatus();
        });
        vid.addEventListener('canplaythrough', () => {
            if (container) container.classList.remove('vp-buffering');
            clearRecoveryTimer();
            clearSlowStartTimer();
            clearPlayerStatus();
        });
        vid.addEventListener('waiting', () => {
            if (vid.ended) return;
            if (container) container.classList.add('vp-buffering');
            queueRecovery();
        });
        vid.addEventListener('stalled', () => {
            if (container && !vid.paused) container.classList.add('vp-buffering');
            queueRecovery();
        });
        // Debounce buffering spinner during seeking to prevent rapid flicker.
        // On fast connections, seeking fires seeking→seeked within <100ms —
        // showing/hiding a spinner for that is distracting.
        let seekBufferTimer = null;

        vid.addEventListener('seeking', () => {
            clearTimeout(seekBufferTimer);
            seekBufferTimer = setTimeout(() => {
                if (container && vid.readyState < 3 && !vid.paused) {
                    container.classList.add('vp-buffering');
                }
            }, 500);
        });
        vid.addEventListener('seeked', () => {
            clearTimeout(seekBufferTimer);
            updateBuffer();
            if (container && vid.readyState >= 3) {
                container.classList.remove('vp-buffering');
                clearPlayerStatus();
            }
        });
        vid.addEventListener('error', () => {
            clearRecoveryTimer();
            clearSlowStartTimer();

            // If direct Worker stream failed, automatically try falling back to local origin VPS stream
            const fallbackUrl = vid.getAttribute('data-fallback-url');
            if (fallbackUrl && sourceEl) {
                const currentSrc = sourceEl.getAttribute('src') || '';
                if (currentSrc && currentSrc.startsWith('http') && currentSrc !== fallbackUrl) {
                    console.warn('[VideoPlayer] Worker stream failed, switching to origin fallback:', fallbackUrl);
                    sourceEl.setAttribute('src', fallbackUrl);
                    vid.src = fallbackUrl;
                    retryStream(true);
                    return;
                }
            }

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
        }, playerSignal);

        window.addEventListener('online', () => {
            setPlayerStatus(
                'loading',
                'Back online',
                'Retrying the stream from the current position.',
                { showOverlay: true, canRetry: false, persistent: true }
            );
            retryStream(true);
        }, playerSignal);

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
        } else {
            updateBuffer();
        }

        // --- Android foreground recovery ---
        // When the user switches to another app (phone call, notification, etc.)
        // and comes back, the video may have stalled. Check and recover gracefully
        // without calling vid.load() which resets all buffered data.
        let wasPlayingBeforeHidden = false;
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                // Remember if the video was playing when the user left
                wasPlayingBeforeHidden = !vid.paused && !vid.ended;
            } else {
                // User returned to the app
                if (wasPlayingBeforeHidden && vid.paused && !vid.ended) {
                    // Video was playing but got paused by the OS — try resuming
                    playVideo();
                } else if (wasPlayingBeforeHidden && !vid.paused && vid.readyState < 3) {
                    // Video is "playing" but stalled — queue a gentle recovery
                    queueRecovery();
                }
            }
        }, playerSignal);

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

        const cancelDrag = () => {
            if (isDragging) {
                isDragging = false;
                if (progressWrap) progressWrap.classList.remove('vp-dragging');
            }
        };

        const finishDrag = (clientX) => {
            if (isDragging) {
                isDragging = false;
                if (progressWrap) progressWrap.classList.remove('vp-dragging');
                if (vid.duration) {
                    if (clientX !== undefined && progressWrap) {
                        const rect = progressWrap.getBoundingClientRect();
                        let x = clientX - rect.left;
                        x = Math.max(0, Math.min(x, rect.width));
                        vid.currentTime = (x / rect.width) * vid.duration;
                    } else if (progressPlayed) {
                        const pct = parseFloat(progressPlayed.style.width) / 100;
                        if (Number.isFinite(pct)) {
                            vid.currentTime = pct * vid.duration;
                        }
                    }
                }
            }
        };

        document.addEventListener('mousemove', (e) => {
            if (isDragging && progressWrap && vid.duration) {
                const rect = progressWrap.getBoundingClientRect();
                let x = e.clientX - rect.left;
                x = Math.max(0, Math.min(x, rect.width));
                const pct = x / rect.width;
                if (progressPlayed) progressPlayed.style.width = (pct * 100) + '%';
                if (currentTimeEl) currentTimeEl.textContent = fmtTime(pct * vid.duration);
            }
        }, playerSignal);

        document.addEventListener('mouseup', (e) => finishDrag(e.clientX), playerSignal);

        document.addEventListener('touchend', (e) => {
            const touch = e.changedTouches && e.changedTouches[0];
            finishDrag(touch ? touch.clientX : undefined);
        }, playerSignal);

        document.addEventListener('touchcancel', cancelDrag, playerSignal);
        document.addEventListener('pointercancel', cancelDrag, playerSignal);
        window.addEventListener('blur', cancelDrag, playerSignal);

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
                // Trigger viewport and safe-area reflow on mobile browsers
                window.dispatchEvent(new Event('resize'));
            }
        }

        if (fullscreenBtn) fullscreenBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleFullscreen(); });
        document.addEventListener('fullscreenchange', updateFsIcons, playerSignal);
        document.addEventListener('webkitfullscreenchange', updateFsIcons, playerSignal);

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
            }, playerSignal);
        }

        // --- Click & Touch Double-Tap Gestures on Video Area ---
        let lastTapTime = 0;
        let lastTapX = 0;
        let tapTimer = null;

        function processTapGesture(clientX, isTouch = false) {
            const now = Date.now();
            const rect = container.getBoundingClientRect();
            const clickX = clientX - rect.left;
            const isLeftHalf = clickX < rect.width / 2;

            if (now - lastTapTime < 300 && Math.abs(clickX - lastTapX) < 140) {
                // Double tap detected -> Seek 10s
                clearTimeout(tapTimer);
                lastTapTime = 0;

                if (isLeftHalf) {
                    rewind(10);
                } else {
                    forward(10);
                }
                showControls();
            } else {
                // Single tap = toggle controls visibility only
                lastTapTime = now;
                lastTapX = clickX;

                tapTimer = setTimeout(() => {
                    if (container.classList.contains('vp-controls-visible')) {
                        if (!vid.paused) {
                            hideControls();
                        }
                        // If paused + controls visible, do nothing (user can tap center btn to play)
                    } else {
                        showControls();
                    }
                }, 220);
            }
        }

        // --- Auto-hide Controls (Android-optimized) ---
        let hideTimer = null;
        let cursorHideTimer = null;
        let controlsLocked = false; // When user is interacting with controls

        function showControls() {
            if (container) {
                container.classList.add('vp-controls-visible');
                container.classList.remove('vp-cursor-hidden');
                container.classList.remove('vp-idle');
            }
            clearTimeout(hideTimer);
            clearTimeout(cursorHideTimer);
            scheduleHide();
        }

        function scheduleHide() {
            clearTimeout(hideTimer);
            if (!vid.paused && !isDragging && !controlsLocked) {
                hideTimer = setTimeout(hideControls, 1400);
            }
        }

        function hideControls() {
            if (isDragging || controlsLocked) return;
            if (speedMenu && speedMenu.classList.contains('vp-menu-open')) return;
            if (vid.paused) return; // Never hide when paused

            if (container) {
                container.classList.remove('vp-controls-visible');
                cursorHideTimer = setTimeout(() => {
                    if (!vid.paused && container) {
                        container.classList.add('vp-cursor-hidden');
                        container.classList.add('vp-idle');
                    }
                }, 300);
            }
        }

        // Lock controls visible while interacting (touching seek bar, buttons etc.)
        function lockControls() {
            controlsLocked = true;
            clearTimeout(hideTimer);
        }

        function unlockControls() {
            controlsLocked = false;
            scheduleHide();
        }

        if (container) {
            // Touch gestures for Mobile / Android
            container.addEventListener('touchend', (e) => {
                if (e.target.closest('.vp-controls') ||
                    e.target.closest('.resume-toast') ||
                    e.target.closest('.vp-speed-menu') ||
                    e.target.closest('.vp-center-btn') ||
                    e.target.closest('.vp-center-nav-btn') ||
                    e.target.closest('.vp-loading-overlay')) return;

                const touch = e.changedTouches[0];
                if (!touch) return;

                e.preventDefault();
                processTapGesture(touch.clientX, true);
            }, { passive: false });

            // Click gestures for Desktop / Mouse
            container.addEventListener('click', (e) => {
                if (e.detail === 0 || ('ontouchstart' in window && e.pointerType === 'touch')) return;
                if (e.target.closest('.vp-controls') ||
                    e.target.closest('.resume-toast') ||
                    e.target.closest('.vp-speed-menu') ||
                    e.target.closest('.vp-center-btn') ||
                    e.target.closest('.vp-center-nav-btn') ||
                    e.target.closest('.vp-loading-overlay')) return;

                processTapGesture(e.clientX, false);
            });

            // Prevent touch on controls from bubbling to video toggle
            const controlsBar = container.querySelector('.vp-controls');

            if (controlsBar) {
                controlsBar.addEventListener('touchstart', (e) => {
                    e.stopPropagation();
                    lockControls();
                }, { passive: true });
                controlsBar.addEventListener('touchend', () => {
                    setTimeout(unlockControls, 300);
                }, { passive: true });
            }

            // Mouse support (for testing on desktop)
            container.addEventListener('mousemove', (e) => {
                if (container._lastMouseX !== undefined) {
                    const dx = Math.abs(e.clientX - container._lastMouseX);
                    const dy = Math.abs(e.clientY - container._lastMouseY);
                    if (dx < 3 && dy < 3) return;
                }
                container._lastMouseX = e.clientX;
                container._lastMouseY = e.clientY;
                showControls();
            });

            container.addEventListener('mouseleave', () => {
                if (!vid.paused) {
                    clearTimeout(hideTimer);
                    hideTimer = setTimeout(hideControls, 400);
                }
            });
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
            // Brief show then auto-hide
            showControls();
        });

        // --- Resume Feature ---
        if (videoId) {
            const savedPosKey = 'videohosk_pos_' + videoId;
            const progressUrl = vid.getAttribute('data-progress-url');
            const csrf = vid.getAttribute('data-csrf-token') || '';
            const dbSavedTime = parseFloat(vid.getAttribute('data-saved-position') || '0');
            const localSavedTime = parseFloat(storage.getItem(savedPosKey) || '0');
            const savedTime = Math.max(
                Number.isFinite(dbSavedTime) ? dbSavedTime : 0,
                Number.isFinite(localSavedTime) ? localSavedTime : 0
            );

            const edgeTrackerUrl = vid.getAttribute('data-edge-tracker-url');
            const videoTitle = vid.getAttribute('data-video-title') || '';
            let lastProgressSignature = '';

            function sendEdgeWatchTelemetry(options = {}) {
                const ended = options.ended === true || vid.ended;
                const position = Number.isFinite(vid.currentTime) ? Math.floor(vid.currentTime) : 0;
                const duration = Number.isFinite(vid.duration) ? Math.floor(vid.duration) : 0;
                const playing = options.playing !== undefined ? !!options.playing : (!vid.paused && !vid.ended);

                const payload = JSON.stringify({
                    videoId,
                    videoTitle,
                    position,
                    duration,
                    playing,
                    ended,
                    source: ('ontouchstart' in window) ? 'mobile' : 'desktop'
                });

                if (edgeTrackerUrl) {
                    if (options.beacon && navigator.sendBeacon) {
                        try {
                            const blob = new Blob([payload], { type: 'application/json' });
                            const queued = navigator.sendBeacon(edgeTrackerUrl, blob);
                            if (queued) return;
                        } catch (e) {}
                    }

                    fetch(edgeTrackerUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: payload,
                        keepalive: options.keepalive === true
                    }).then((response) => {
                        // A Worker 530 (and every 4xx/5xx) means the edge did
                        // not accept telemetry. Persist directly to the VPS.
                        if (!response.ok && (response.status === 530 || response.status >= 400)) {
                            saveWatchProgress({ ...options, force: true });
                        }
                    }).catch(() => {
                        saveWatchProgress(options);
                    });
                    return;
                }

                saveWatchProgress(options);
            }

            function saveWatchProgress(options = {}) {
                if (!progressUrl) return;

                const ended = options.ended === true || vid.ended;
                const position = Number.isFinite(vid.currentTime) ? Math.floor(vid.currentTime) : 0;
                const duration = Number.isFinite(vid.duration) ? Math.floor(vid.duration) : 0;
                const signature = `${position}:${duration}:${ended}`;

                // Several player lifecycle events can fire for the same video
                // frame. Do not issue an identical VPS progress write twice.
                if (!options.force && signature === lastProgressSignature) return;
                lastProgressSignature = signature;

                if (ended || position < 5) {
                    storage.removeItem(savedPosKey);
                } else {
                    storage.setItem(savedPosKey, String(position));
                }

                fetch(progressUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-csrf-token': csrf
                    },
                    body: JSON.stringify({ position, duration, ended }),
                    keepalive: options.keepalive === true
                }).catch(() => {});
            }

            vid.addEventListener('loadedmetadata', () => {
                if (savedTime > 5 && savedTime < vid.duration - 10) {
                    vid.currentTime = savedTime;
                }
            });

            vid.addEventListener('play', () => {
                sendEdgeWatchTelemetry({ playing: true });
                if (typeof window.__sendPresenceAction === 'function') {
                    window.__sendPresenceAction('watch_start');
                }
            });

            let lastEdgeTelemetry = 0;
            const edgeTelemetryInterval = 5000;
            let lastPositionSave = 0;
            vid.addEventListener('timeupdate', () => {
                const now = Date.now();
                if (vid.currentTime > 0.5 && !vid.ended) {
                    // Periodic telemetry is intentionally coarse; lifecycle
                    // events below still synchronize immediately.
                    if (now - lastEdgeTelemetry >= edgeTelemetryInterval) {
                        lastEdgeTelemetry = now;
                        sendEdgeWatchTelemetry({ playing: true });
                    }
                    // SQLite persistent progress save fallback (if Edge Worker is not configured)
                    if (!edgeTrackerUrl && now - lastPositionSave > 15000) {
                        lastPositionSave = now;
                        saveWatchProgress();
                    }
                }
            });

            vid.addEventListener('seeked', () => {
                if (!vid.ended && vid.currentTime > 1) {
                    storage.setItem(savedPosKey, String(Math.floor(vid.currentTime)));
                    sendEdgeWatchTelemetry();
                }
            });

            vid.addEventListener('pause', () => {
                if (!vid.ended && vid.currentTime > 1) {
                    sendEdgeWatchTelemetry({ playing: false });
                    if (!edgeTrackerUrl) saveWatchProgress();
                }
                if (typeof window.__sendPresenceAction === 'function') {
                    window.__sendPresenceAction('watch_pause');
                }
            });

            vid.addEventListener('ended', () => {
                sendEdgeWatchTelemetry({ ended: true, playing: false });
                if (!edgeTrackerUrl) saveWatchProgress({ ended: true });
                if (typeof window.__sendPresenceAction === 'function') {
                    window.__sendPresenceAction('watch_complete');
                }
            });

            const handleUnloadSave = () => {
                if (!vid.ended && vid.currentTime > 1) {
                    sendEdgeWatchTelemetry({ keepalive: true, beacon: true, playing: false });
                    if (!edgeTrackerUrl) saveWatchProgress({ keepalive: true });
                }
            };

            window.addEventListener('beforeunload', handleUnloadSave, playerSignal);
            window.addEventListener('pagehide', handleUnloadSave, playerSignal);
            window.addEventListener('page:cleanup', handleUnloadSave, { once: true });

            document.addEventListener('visibilitychange', () => {
                if (document.hidden && !vid.ended && vid.currentTime > 1) {
                    sendEdgeWatchTelemetry({ keepalive: true, beacon: true, playing: !vid.paused });
                }
            }, playerSignal);
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
        }, playerSignal);

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
    }

    // ---- Download Confirmation Modal ----
    const downloadBtn = document.getElementById('btnDownload');
    const downloadModal = document.getElementById('downloadModal');
    const downloadCloseBtn = document.getElementById('downloadCloseBtn');
    const downloadCancelBtn = document.getElementById('downloadCancelBtn');
    const downloadConfirmBtn = document.getElementById('downloadConfirmBtn');

    if (downloadBtn && downloadModal) {
        const closeModal = () => downloadModal.classList.remove('active');
        downloadBtn.addEventListener('click', () => downloadModal.classList.add('active'));
        if (downloadCloseBtn) downloadCloseBtn.addEventListener('click', closeModal);
        if (downloadCancelBtn) downloadCancelBtn.addEventListener('click', closeModal);
        if (downloadConfirmBtn) downloadConfirmBtn.addEventListener('click', closeModal);

        downloadModal.addEventListener('click', (e) => {
            if (e.target === downloadModal) closeModal();
        });
    }

    // ---- Delete Video Confirmation Modal ----
    const deleteVideoBtn = document.getElementById('btnDeleteVideo');
    const deleteVideoModal = document.getElementById('deleteVideoModal');
    const deleteVideoCloseBtn = document.getElementById('deleteVideoCloseBtn');
    const deleteVideoCancelBtn = document.getElementById('deleteVideoCancelBtn');

    if (deleteVideoBtn && deleteVideoModal) {
        const closeDeleteModal = () => deleteVideoModal.classList.remove('active');
        deleteVideoBtn.addEventListener('click', () => deleteVideoModal.classList.add('active'));
        if (deleteVideoCloseBtn) deleteVideoCloseBtn.addEventListener('click', closeDeleteModal);
        if (deleteVideoCancelBtn) deleteVideoCancelBtn.addEventListener('click', closeDeleteModal);

        deleteVideoModal.addEventListener('click', (e) => {
            if (e.target === deleteVideoModal) closeDeleteModal();
        });

        const deleteForm = deleteVideoModal.querySelector('form');
        if (deleteForm) {
            deleteForm.addEventListener('submit', (e) => {
                const submitBtn = deleteForm.querySelector('button[type="submit"]');
                if (submitBtn) {
                    if (submitBtn.disabled) {
                        e.preventDefault();
                        return;
                    }
                    submitBtn.disabled = true;
                    submitBtn.innerHTML = '<span>Deleting...</span>';

                    // Timeout safety reset in case network/browser fails or page navigation is interrupted
                    setTimeout(() => {
                        if (submitBtn.disabled) {
                            submitBtn.disabled = false;
                            submitBtn.innerHTML = `
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                </svg>
                                <span>Delete Video</span>`;
                        }
                    }, 10000);
                }
            });
        }
    }

    // ---- Profile Picture Modal Controller ----
    const profileModal = document.getElementById('profileModal');
    const profileCloseBtn = document.getElementById('profileCloseBtn');
    const profileTriggers = document.querySelectorAll('.user-profile-trigger');
    const profileAvatarInput = document.getElementById('profileAvatarInput');
    const profileChooseBtn = document.getElementById('profileChooseBtn');
    const profileUploadActions = document.getElementById('profileUploadActions');
    const profileCancelPickBtn = document.getElementById('profileCancelPickBtn');
    const profileAvatarBig = document.getElementById('profileAvatarBig');
    let originalAvatarBigHtml = profileAvatarBig ? profileAvatarBig.innerHTML : '';

    // Bug fix: closeProfileModal was block-scoped inside this `if`, so the
    // settings-modal opener (which checks `typeof closeProfileModal`) could
    // never see it and the profile modal stayed stuck open behind Settings.
    let closeProfileModal = null;
    if (profileModal) {
        const openProfileModal = () => {
            syncActiveUiModeOption();
            profileModal.style.display = 'flex';
            requestAnimationFrame(() => profileModal.classList.add('active'));
        };
        closeProfileModal = () => {
            profileModal.classList.remove('active');
            setTimeout(() => {
                if (!profileModal.classList.contains('active')) {
                    profileModal.style.display = 'none';
                }
            }, 250);
            resetAvatarPicker();
        };

        const resetAvatarPicker = () => {
            if (profileAvatarInput) profileAvatarInput.value = '';
            if (profileAvatarBig && originalAvatarBigHtml) profileAvatarBig.innerHTML = originalAvatarBigHtml;
            if (profileUploadActions) profileUploadActions.style.display = 'none';
            if (profileChooseBtn) profileChooseBtn.style.display = '';
        };

        profileTriggers.forEach(trigger => {
            trigger.addEventListener('click', (e) => {
                e.preventDefault();
                openProfileModal();
            });
        });

        if (profileCloseBtn) profileCloseBtn.addEventListener('click', closeProfileModal);
        profileModal.addEventListener('click', (e) => {
            if (e.target === profileModal) closeProfileModal();
        });

        if (profileChooseBtn && profileAvatarInput) {
            profileChooseBtn.addEventListener('click', () => profileAvatarInput.click());
        }

        if (profileAvatarInput) {
            profileAvatarInput.addEventListener('change', () => {
                const file = profileAvatarInput.files && profileAvatarInput.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = (e) => {
                    if (profileAvatarBig) {
                        profileAvatarBig.innerHTML = `<img src="${e.target.result}" alt="Preview" class="avatar-img profile-avatar-large" />`;
                    }
                    if (profileUploadActions) profileUploadActions.style.display = 'flex';
                    if (profileChooseBtn) profileChooseBtn.style.display = 'none';
                };
                reader.readAsDataURL(file);
            });
        }

        if (profileCancelPickBtn) {
            profileCancelPickBtn.addEventListener('click', resetAvatarPicker);
        }
    }

    // ---- Autoplay Next Video Logic (YouTube Style) ----
    const autoplayToggle = document.getElementById('autoplayToggle');
    const autoplayToast = document.getElementById('autoplayToast');
    const autoplayProgressCircle = document.getElementById('autoplayProgressCircle');
    const autoplayCountdownNum = document.getElementById('autoplayCountdownNum');
    const autoplaySecondsText = document.getElementById('autoplaySecondsText');
    const autoplayNextTitle = document.getElementById('autoplayNextTitle');
    const autoplayCancelBtn = document.getElementById('autoplayCancelBtn');
    const autoplayPlayNowBtn = document.getElementById('autoplayPlayNowBtn');

    if (autoplayToggle) {
        const savedAutoplay = storage.getItem('videohost_autoplay');
        if (savedAutoplay !== null) {
            autoplayToggle.checked = savedAutoplay === 'true';
        }
        autoplayToggle.addEventListener('change', () => {
            storage.setItem('videohost_autoplay', autoplayToggle.checked ? 'true' : 'false');
        });
    }

    let autoplayTimer = null;
    let autoplayInterval = null;

    function getNextVideoCard() {
        const visibleSuggestions = Array.from(document.querySelectorAll('.suggestion-card'))
            .filter(card => !card.classList.contains('is-hidden') && card.style.display !== 'none');
        return visibleSuggestions.length > 0 ? visibleSuggestions[0] : null;
    }

    function cancelAutoplay() {
        if (autoplayTimer || window.__AUTOPLAY_TIMER__) {
            clearTimeout(autoplayTimer || window.__AUTOPLAY_TIMER__);
            autoplayTimer = null;
            window.__AUTOPLAY_TIMER__ = null;
        }
        if (autoplayInterval || window.__AUTOPLAY_INTERVAL__) {
            clearInterval(autoplayInterval || window.__AUTOPLAY_INTERVAL__);
            autoplayInterval = null;
            window.__AUTOPLAY_INTERVAL__ = null;
        }
        if (autoplayToast) {
            autoplayToast.style.display = 'none';
        }
    }

    function triggerAutoplayCountdown(nextCard) {
        if (!nextCard || !autoplayToast) return;
        cancelAutoplay();

        const targetUrl = nextCard.getAttribute('href');
        const cardTitle = nextCard.querySelector('.suggestion-title')?.textContent || 'Next Video';

        if (autoplayNextTitle) autoplayNextTitle.textContent = cardTitle;
        autoplayToast.style.display = 'block';

        let remainingSeconds = 5;
        const totalSeconds = 5;

        function updateCountdownDisplay() {
            if (autoplayCountdownNum) autoplayCountdownNum.textContent = remainingSeconds;
            if (autoplaySecondsText) autoplaySecondsText.textContent = remainingSeconds + 's';
            if (autoplayProgressCircle) {
                const percent = (remainingSeconds / totalSeconds) * 100;
                autoplayProgressCircle.setAttribute('stroke-dasharray', `${percent}, 100`);
            }
        }

        updateCountdownDisplay();

        autoplayInterval = setInterval(() => {
            remainingSeconds -= 1;
            updateCountdownDisplay();
            if (remainingSeconds <= 0) {
                clearInterval(autoplayInterval);
                autoplayInterval = null;
                window.__AUTOPLAY_INTERVAL__ = null;
            }
        }, 1000);
        window.__AUTOPLAY_INTERVAL__ = autoplayInterval;

        autoplayTimer = setTimeout(() => {
            cancelAutoplay();
            if (targetUrl) window.location.href = targetUrl;
        }, 5000);
        window.__AUTOPLAY_TIMER__ = autoplayTimer;

        if (autoplayPlayNowBtn) {
            autoplayPlayNowBtn.onclick = () => {
                cancelAutoplay();
                if (targetUrl) window.location.href = targetUrl;
            };
        }

        if (autoplayCancelBtn) {
            autoplayCancelBtn.onclick = () => {
                cancelAutoplay();
            };
        }
    }

    // Attach to video ended event
    if (vid) {
        vid.addEventListener('ended', () => {
            if (autoplayToggle && autoplayToggle.checked) {
                const nextCard = getNextVideoCard();
                if (nextCard) {
                    triggerAutoplayCountdown(nextCard);
                }
            }
        });
    }

    // ---- Suggestions Filter Chips ----
    const suggestionChips = document.getElementById('suggestionChips');
    if (suggestionChips) {
        const chipButtons = suggestionChips.querySelectorAll('.chip-btn');
        const cards = document.querySelectorAll('.suggestion-card');

        chipButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                chipButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');

                const filter = btn.getAttribute('data-filter');
                cards.forEach(card => {
                    const uploader = card.getAttribute('data-uploader');
                    const isUnwatched = card.getAttribute('data-unwatched') === 'true';

                    let match = true;
                    if (filter === 'muaj') match = uploader === 'muaj';
                    else if (filter === 'hajera') match = uploader === 'hajera';
                    else if (filter === 'unwatched') match = isUnwatched;

                    if (match) {
                        card.classList.remove('is-hidden');
                        card.style.display = '';
                    } else {
                        card.classList.add('is-hidden');
                        card.style.display = 'none';
                    }
                });
            });
        });
    }

    // ---- Modern Comments Interactivity ----
    const commentForm = document.getElementById('commentForm') || document.querySelector('.comment-form');
    const commentTextarea = document.getElementById('commentTextarea') || commentForm?.querySelector('textarea[name="text"]');
    const commentCancelBtn = document.getElementById('commentCancelBtn');
    const emojiChips = document.querySelectorAll('.emoji-chip');

    // Emoji Insert
    emojiChips.forEach(chip => {
        chip.addEventListener('click', () => {
            const emoji = chip.getAttribute('data-emoji') || chip.textContent.trim();
            if (commentTextarea) {
                const start = commentTextarea.selectionStart || commentTextarea.value.length;
                const end = commentTextarea.selectionEnd || commentTextarea.value.length;
                const val = commentTextarea.value;
                commentTextarea.value = val.substring(0, start) + emoji + val.substring(end);
                commentTextarea.selectionStart = commentTextarea.selectionEnd = start + emoji.length;
                commentTextarea.focus();
                commentTextarea.dispatchEvent(new Event('input'));
            }
        });
    });

    // Cancel Button
    if (commentCancelBtn && commentTextarea) {
        commentCancelBtn.addEventListener('click', () => {
            commentTextarea.value = '';
            commentTextarea.style.height = 'auto';
            commentTextarea.blur();
        });
    }

    // Liked Comments in LocalStorage
    const likedCommentsKey = 'videohost_liked_comments';
    function getLikedComments() {
        try {
            return JSON.parse(storage.getItem(likedCommentsKey) || '{}');
        } catch (e) {
            return {};
        }
    }
    function saveLikedComments(map) {
        try {
            storage.setItem(likedCommentsKey, JSON.stringify(map));
        } catch (e) {}
    }

    function initCommentActions(container = document) {
        const likedMap = getLikedComments();

        // Init like buttons
        container.querySelectorAll('.comment-like-btn').forEach(btn => {
            const commentId = btn.getAttribute('data-comment-id');
            if (commentId && likedMap[commentId]) {
                btn.classList.add('liked');
                const counter = btn.querySelector('.like-counter');
                if (counter) counter.textContent = '1';
            }

            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const isLiked = btn.classList.toggle('liked');
                const counter = btn.querySelector('.like-counter');
                if (isLiked) {
                    likedMap[commentId] = 1;
                    if (counter) counter.textContent = '1';
                } else {
                    delete likedMap[commentId];
                    if (counter) counter.textContent = '';
                }
                saveLikedComments(likedMap);
            };
        });

        // Init reply buttons
        container.querySelectorAll('.comment-reply-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                const author = btn.getAttribute('data-author') || '';
                if (commentTextarea) {
                    commentTextarea.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    commentTextarea.value = `@${author} ` + commentTextarea.value.replace(new RegExp(`^@${author}\\s*`), '');
                    commentTextarea.focus();
                    commentTextarea.setSelectionRange(commentTextarea.value.length, commentTextarea.value.length);
                    commentTextarea.dispatchEvent(new Event('input'));
                }
            };
        });
    }

    initCommentActions();

    // AJAX Comment Submit
    if (commentForm && commentTextarea) {
        commentForm.addEventListener('submit', async (e) => {
            e.preventDefault();
            const submitBtn = document.getElementById('commentSubmitBtn') || commentForm.querySelector('button[type="submit"]');
            const text = (commentTextarea.value || '').trim();
            if (!text) return;

            const csrfInput = commentForm.querySelector('input[name="_csrf"]');
            const csrf = csrfInput ? csrfInput.value : '';
            const action = commentForm.getAttribute('action');

            submitBtn.disabled = true;
            commentTextarea.disabled = true;

            try {
                const res = await fetch(action, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                        'x-csrf-token': csrf
                    },
                    body: JSON.stringify({ text })
                });

                const data = await res.json();

                if (res.ok && data.success) {
                    const commentsList = document.getElementById('commentsList') || document.querySelector('.comments-list');
                    const noComments = commentsList?.querySelector('.no-comments-box') || commentsList?.querySelector('.no-comments');
                    if (noComments) noComments.remove();

                    const isAdmin = data.comment.user === 'muaj';
                    const displayName = isAdmin ? 'Muaj' : 'Hajera';
                    const avatarClass = isAdmin ? 'avatar-admin' : 'avatar-viewer';
                    const initial = isAdmin ? 'M' : 'H';
                    const timeStr = 'Just now';

                    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
                    const formattedText = typeof window.parseWhatsAppEmoji === 'function' ? window.parseWhatsAppEmoji(escaped) : escaped;

                    const avatarHtml = data.comment && data.comment.avatar
                        ? `<img src="/avatars/${encodeURIComponent(data.comment.avatar)}" alt="${displayName}" class="avatar-img comment-avatar-img" loading="lazy" />`
                        : `<div class="avatar-letter ${avatarClass}">${initial}</div>`;

                    const authorBadgeHtml = isAdmin
                        ? `<span class="comment-author-badge badge-admin"><svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M5 16L3 5l5.5 5L12 4l3.5 6L21 5l-2 11H5z"/></svg>Admin</span>`
                        : `<span class="comment-author-badge badge-viewer">💖 Hajera</span>`;

                    const tempCommentId = 'new_' + Date.now();

                    const commentHtml = `<div class="comment-item" id="comment-${tempCommentId}" style="opacity:0;transform:translateY(-8px);transition:all 0.3s ease"><div class="comment-avatar">${avatarHtml}</div><div class="comment-body"><div class="comment-header"><span class="comment-author">${displayName}</span>${authorBadgeHtml}<span class="comment-time">${timeStr}</span></div><div class="comment-text-box"><p class="comment-text">${formattedText}</p></div><div class="comment-actions-bar"><button type="button" class="comment-action-btn comment-like-btn" data-comment-id="${tempCommentId}" title="Like"><svg class="icon-heart" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="15" height="15"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg><span class="like-counter"></span></button><button type="button" class="comment-action-btn comment-reply-btn" data-author="${displayName}" title="Reply to ${displayName}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg><span>Reply</span></button></div></div></div>`;

                    if (commentsList) {
                        commentsList.insertAdjacentHTML('afterbegin', commentHtml);
                        const newComment = commentsList.firstElementChild;
                        if (newComment) {
                            requestAnimationFrame(() => {
                                newComment.style.opacity = '1';
                                newComment.style.transform = 'translateY(0)';
                            });
                            initCommentActions(newComment);
                            if (typeof window.applyWhatsAppEmojis === 'function') {
                                window.applyWhatsAppEmojis(newComment);
                            }
                        }
                    }

                    // Update comment counts in all badges
                    const countPill = document.getElementById('commentsCountPill');
                    if (countPill) {
                        const current = parseInt(countPill.textContent) || 0;
                        countPill.textContent = current + 1;
                    }
                    const countBadge = document.getElementById('commentsCountBadge');
                    if (countBadge) {
                        const current = parseInt(countBadge.textContent) || 0;
                        countBadge.textContent = current + 1;
                    }

                    commentTextarea.value = '';
                    commentTextarea.style.height = 'auto';
                } else {
                    commentForm.submit();
                }
            } catch (err) {
                commentForm.submit();
            } finally {
                submitBtn.disabled = false;
                commentTextarea.disabled = false;
            }
        });
    }

    // ---- Auto-resize textarea ----
    const commentInputs = document.querySelectorAll('.comment-input');
    commentInputs.forEach(textarea => {
        textarea.addEventListener('input', function() {
            this.style.height = 'auto';
            this.style.height = Math.max(42, this.scrollHeight) + 'px';
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

    // ---- Settings & Appearance Modal Logic (UI Mode & Themes) ----
    const themeBtn = document.getElementById('themeSwitcherBtn');
    const themeNavBtn = document.getElementById('themeSwitcherNavBtn');
    const themeBottomBtn = document.getElementById('themeSwitcherBottomBtn');
    const themeModal = document.getElementById('themeModalBackdrop');
    const themeCloseBtn = document.getElementById('themeCloseBtn');

    function syncActiveUiModeOption() {
        const currentMode = document.documentElement.getAttribute('data-ui-mode') || 'standard';
        const options = document.querySelectorAll('[data-set-ui-mode]');
        options.forEach(btn => {
            const isMatch = btn.getAttribute('data-set-ui-mode') === currentMode;
            btn.classList.toggle('is-active-ui-mode', isMatch);
            const radio = btn.querySelector('.ui-mode-radio-circle');
            if (radio) radio.classList.toggle('checked', isMatch);
            let badge = btn.querySelector('.active-ui-badge');
            if (isMatch) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'active-ui-badge';
                    badge.textContent = 'Active Mode';
                    const top = btn.querySelector('.ui-mode-card-top');
                    if (top) top.appendChild(badge);
                }
            } else if (badge) {
                badge.remove();
            }
        });
    }

    function syncActiveThemeOption() {
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'cinematic';
        const options = document.querySelectorAll('[data-set-theme]');
        options.forEach(btn => {
            const isMatch = btn.getAttribute('data-set-theme') === currentTheme;
            btn.classList.toggle('is-active-theme', isMatch);
            let badge = btn.querySelector('.active-theme-badge');
            if (isMatch) {
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'active-theme-badge';
                    badge.textContent = 'Active';
                    btn.appendChild(badge);
                }
            } else if (badge) {
                badge.remove();
            }
        });
    }

    function syncActiveSchemeOption() {
        const currentScheme = document.documentElement.getAttribute('data-scheme') || 'dark';
        document.querySelectorAll('[data-set-scheme]').forEach(btn => {
            const isMatch = btn.getAttribute('data-set-scheme') === currentScheme;
            btn.classList.toggle('is-active-scheme', isMatch);
            btn.setAttribute('aria-pressed', isMatch ? 'true' : 'false');
        });
    }

    // Immediately sync UI Mode, Theme and Scheme options on page init
    syncActiveUiModeOption();
    syncActiveThemeOption();
    syncActiveSchemeOption();

    function openThemeModal() {
        if (!themeModal) return;
        syncActiveUiModeOption();
        syncActiveThemeOption();
        syncActiveSchemeOption();
        themeModal.classList.add('active');
    }

    function closeThemeModal() {
        if (themeModal) themeModal.classList.remove('active');
    }

    if (!window.__THEME_CLICK_ATTACHED__) {
        window.__THEME_CLICK_ATTACHED__ = true;
        document.addEventListener('click', (e) => {
            // Open Settings Modal Trigger
            const openBtn = e.target.closest('#themeSwitcherBtn, #themeSwitcherNavBtn, #themeSwitcherBottomBtn, .open-settings-trigger, [data-open-settings]');
            if (openBtn) {
                e.preventDefault();
                if (profileModal && profileModal.classList.contains('active') && typeof closeProfileModal === 'function') {
                    closeProfileModal();
                }
                openThemeModal();
                return;
            }

            // Close Settings Modal
            const closeBtn = e.target.closest('#themeCloseBtn');
            if (closeBtn || e.target === themeModal) {
                closeThemeModal();
                return;
            }

            // UI Mode Option Clicked
            const uiModeBtn = e.target.closest('[data-set-ui-mode]');
            if (uiModeBtn) {
                e.preventDefault();
                const mode = uiModeBtn.getAttribute('data-set-ui-mode');
                if (mode === 'standard' || mode === 'minimal') {
                    document.documentElement.setAttribute('data-ui-mode', mode);
                    storage.setItem('videohosk_uimode', mode);
                    document.cookie = 'videohosk_uimode=' + encodeURIComponent(mode) + '; path=/; max-age=31536000; SameSite=Lax';
                    const user = (document.body && document.body.getAttribute('data-user')) ||
                                 document.documentElement.getAttribute('data-user');
                    if (user) {
                        storage.setItem('videohosk_uimode_' + user, mode);
                    }
                    syncActiveUiModeOption();

                    // Persist to database in background
                    fetch('/api/settings/ui-mode', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '' },
                        body: JSON.stringify({ ui_mode: mode })
                    }).catch(() => {});

                    // Show feedback toast
                    if (typeof showToast === 'function') {
                        showToast(mode === 'minimal' ? '⚡ Minimal UI enabled (Fast & Lightweight)' : '✨ Standard UI enabled (Full Design)');
                    }
                }
                return;
            }

            // Scheme Option Clicked (Dark / Light)
            const schemeBtn = e.target.closest('[data-set-scheme]');
            if (schemeBtn) {
                e.preventDefault();
                const scheme = schemeBtn.getAttribute('data-set-scheme');
                if (scheme === 'dark' || scheme === 'light') {
                    document.documentElement.setAttribute('data-scheme', scheme);
                    storage.setItem('videohosk_scheme', scheme);
                    document.cookie = 'videohosk_scheme=' + encodeURIComponent(scheme) + '; path=/; max-age=31536000; SameSite=Lax';
                    const user = (document.body && document.body.getAttribute('data-user')) ||
                                 document.documentElement.getAttribute('data-user');
                    if (user) {
                        storage.setItem('videohosk_scheme_' + user, scheme);
                    }
                    // Sync PWA theme-color to the new scheme
                    const currentTheme = document.documentElement.getAttribute('data-theme') || 'cinematic';
                    const darkColors = { cinematic: '#060609', cyberpunk: '#05050d', emerald: '#030806', sunset: '#0c040a' };
                    const lightColors = { cinematic: '#f3f4f9', cyberpunk: '#eff6fb', emerald: '#f0f7f3', sunset: '#fdf3f5' };
                    const metaTheme = document.querySelector('meta[name="theme-color"]');
                    if (metaTheme) {
                        metaTheme.setAttribute('content', (scheme === 'light' ? lightColors : darkColors)[currentTheme] || (scheme === 'light' ? '#f3f4f9' : '#060609'));
                    }
                    syncActiveSchemeOption();
                    if (typeof showToast === 'function') {
                        showToast(scheme === 'light' ? '☀️ Light mode enabled' : '🌙 Dark mode enabled');
                    }
                }
                return;
            }

            // Theme Option Clicked
            const themeBtnOption = e.target.closest('[data-set-theme]');
            if (themeBtnOption) {
                e.preventDefault();
                const theme = themeBtnOption.getAttribute('data-set-theme');
                if (theme) {
                    document.documentElement.setAttribute('data-theme', theme);
                    storage.setItem('videohosk_theme', theme);
                    document.cookie = 'videohosk_theme=' + encodeURIComponent(theme) + '; path=/; max-age=31536000; SameSite=Lax';
                    const user = (document.body && document.body.getAttribute('data-user')) ||
                                 document.documentElement.getAttribute('data-user');
                    if (user) {
                        storage.setItem('videohosk_theme_' + user, theme);
                    }
                    const isLightScheme = document.documentElement.getAttribute('data-scheme') === 'light';
                    const themeMetaColors = isLightScheme
                        ? { cinematic: '#f3f4f9', cyberpunk: '#eff6fb', emerald: '#f0f7f3', sunset: '#fdf3f5' }
                        : { cinematic: '#060609', cyberpunk: '#05050d', emerald: '#030806', sunset: '#0c040a' };
                    const metaTheme = document.querySelector('meta[name="theme-color"]');
                    if (metaTheme) {
                        metaTheme.setAttribute('content', themeMetaColors[theme] || (isLightScheme ? '#f3f4f9' : '#060609'));
                    }
                    syncActiveThemeOption();

                    // Persist to database in background
                    fetch('/api/settings/theme', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '' },
                        body: JSON.stringify({ theme: theme })
                    }).catch(() => {});

                    if (typeof showToast === 'function') {
                        showToast('🎨 Theme changed to ' + theme.charAt(0).toUpperCase() + theme.slice(1));
                    }
                }
                return;
            }
        });
    }

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
    const importQualitySelect = document.getElementById('importQuality');
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
            const quality = importQualitySelect ? importQualitySelect.value : '720';

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
                    body: JSON.stringify({ url, title, quality })
                });

                const data = await response.json();

                if (!response.ok) {
                    throw new Error(data.error || 'Import failed');
                }

                if (data.alreadyExists && data.videoId) {
                    if (importProgressSection) importProgressSection.style.display = 'none';
                    if (importResult) importResult.style.display = 'block';
                    if (importResultCard) importResultCard.className = 'import-result-card success';
                    if (importResultIcon) importResultIcon.textContent = '🎬';
                    if (importResultText) importResultText.textContent = data.message || 'Video is already in your library.';
                    if (importResultBtn) importResultBtn.style.display = 'inline-flex';
                    if (importWatchBtn) {
                        importWatchBtn.style.display = 'inline-flex';
                        importWatchBtn.href = '/watch/' + encodeURIComponent(data.videoId);
                    }
                    importBtn.disabled = false;
                    importBtn.innerHTML = '<span>Import Video</span>';
                    importUrlInput.value = '';
                    if (importTitleInput) importTitleInput.value = '';
                    return;
                }

                if (!data.jobId) {
                    throw new Error('Could not start import.');
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
    // ---- URL Import Queue ----
    const importQueueBtn = document.getElementById('importQueueBtn');
    if (importQueueBtn) {
        const importUrlInput = document.getElementById('importUrl');
        const importTitleInput = document.getElementById('importTitle');
        const importQualitySelect = document.getElementById('importQuality');
        const analyzeQualityBtn = document.getElementById('analyzeQualityBtn');
        const qualityAnalyzeStatus = document.getElementById('qualityAnalyzeStatus');
        const importQueueSection = document.getElementById('importQueueSection');
        const importQueueList = document.getElementById('importQueueList');
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
        const importJobs = new Map();
        const eventSources = new Map();

        function getImportCsrf() {
            return document.getElementById('importCsrfToken')?.value ||
                document.querySelector('input[name="_csrf"]')?.value ||
                '';
        }

        function getImportUrls() {
            if (!importUrlInput) return [];
            return importUrlInput.value.split(/\r?\n/).map(url => url.trim()).filter(Boolean);
        }

        function escapeText(value) {
            return String(value == null ? '' : value)
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;')
                .replace(/'/g, '&#39;');
        }

        function setImportQueueButton(label, disabled) {
            importQueueBtn.disabled = disabled === true;
            importQueueBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="20" height="20"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg><span>' + label + '</span>';
        }

        function jobDetail(job) {
            if (job.status === 'queued') return 'Waiting in queue #' + (job.queuePosition || 1);
            if (job.status === 'starting') return 'Starting download...';
            if (job.status === 'downloading') return 'Downloading video...';
            if (job.status === 'done') return 'Imported successfully';
            if (job.status === 'canceled') return 'Canceled';
            return job.error || 'Import failed';
        }

        function updateImportSummary(job) {
            if (!job) return;
            if (importProgressSection) importProgressSection.style.display = 'block';
            if (importStatusTitle) importStatusTitle.textContent = job.title || 'Import job';
            if (importStatusDetail) importStatusDetail.textContent = jobDetail(job);
            if (importProgressFill) importProgressFill.style.width = Math.max(0, job.progress || 0) + '%';
            if (importPercent) importPercent.textContent = (job.progress || 0) + '%';
            if (importSpeed) importSpeed.textContent = job.speed || '';
            if (importEta) importEta.textContent = job.eta ? 'ETA: ' + job.eta : '';
            if (importSpinner) {
                importSpinner.className = 'import-spinner';
                if (job.status === 'done') importSpinner.classList.add('done');
                if (job.status === 'error' || job.status === 'canceled') importSpinner.classList.add('error');
            }
        }

        function renderImportQueue() {
            const jobs = Array.from(importJobs.values()).sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
            if (importQueueSection) importQueueSection.style.display = jobs.length ? 'block' : 'none';

            if (importQueueList) {
                importQueueList.innerHTML = jobs.map(job => {
                    const progress = Math.max(0, Math.min(100, Number(job.progress || 0)));
                    const canCancel = ['queued', 'starting', 'downloading'].includes(job.status);
                    const canRetry = ['error', 'canceled'].includes(job.status);
                    const watch = job.videoId ? '<a class="btn btn-primary btn-sm" href="/watch/' + encodeURIComponent(job.videoId) + '">Watch</a>' : '';
                    const cancel = canCancel ? '<button type="button" class="btn btn-ghost btn-sm" data-import-cancel="' + escapeText(job.id) + '">Cancel</button>' : '';
                    const retry = canRetry ? '<button type="button" class="btn btn-ghost btn-sm" data-import-retry="' + escapeText(job.id) + '">Retry</button>' : '';

                    return '<div class="import-queue-item status-' + escapeText(job.status) + '">' +
                        '<div class="import-queue-main"><strong>' + escapeText(job.title || job.url || 'Import job') + '</strong><span>' + escapeText(jobDetail(job)) + '</span></div>' +
                        '<div class="import-queue-progress"><div class="admin-mini-bar"><span style="width:' + progress + '%"></span></div><em>' + progress + '%</em></div>' +
                        '<div class="import-queue-actions">' + watch + cancel + retry + '</div>' +
                    '</div>';
                }).join('');
            }

            const active = jobs.find(job => ['downloading', 'starting'].includes(job.status)) ||
                jobs.find(job => job.status === 'queued') ||
                jobs[jobs.length - 1];
            updateImportSummary(active);

            const allComplete = jobs.length > 0 && jobs.every(job => ['done', 'error', 'canceled'].includes(job.status));
            if (allComplete) {
                setImportQueueButton('Import More', false);
                const doneJobs = jobs.filter(job => job.status === 'done');
                if (importResult && importResultCard && importResultIcon && importResultText) {
                    importResult.style.display = 'block';
                    importResultCard.className = doneJobs.length ? 'import-result-card success' : 'import-result-card error';
                    importResultIcon.textContent = doneJobs.length ? 'OK' : '!';
                    importResultText.textContent = doneJobs.length ? doneJobs.length + ' import(s) completed.' : 'No imports completed. Check the queue errors.';
                    if (importResultBtn) importResultBtn.style.display = doneJobs.length ? 'inline-flex' : 'none';
                    if (importWatchBtn) {
                        const singleDone = doneJobs.length === 1 ? doneJobs[0] : null;
                        importWatchBtn.style.display = singleDone && singleDone.videoId ? 'inline-flex' : 'none';
                        if (singleDone && singleDone.videoId) importWatchBtn.href = '/watch/' + singleDone.videoId;
                    }
                }
            }
        }

        function connectImportJob(job) {
            if (!job || !job.id || eventSources.has(job.id)) return;
            const source = new EventSource('/import-progress/' + encodeURIComponent(job.id));
            eventSources.set(job.id, source);

            source.onmessage = (event) => {
                try {
                    const nextJob = JSON.parse(event.data);
                    importJobs.set(nextJob.id, nextJob);
                    renderImportQueue();
                    if (['done', 'error', 'canceled'].includes(nextJob.status)) {
                        source.close();
                        eventSources.delete(nextJob.id);
                    }
                } catch {}
            };

            source.onerror = () => {
                source.close();
                eventSources.delete(job.id);
            };
        }

        async function loadImportJobs() {
            try {
                const response = await fetch('/import-jobs');
                if (!response.ok) return;
                const data = await response.json();
                (data.jobs || []).forEach(job => {
                    importJobs.set(job.id, job);
                    if (!['done', 'error', 'canceled'].includes(job.status)) connectImportJob(job);
                });
                renderImportQueue();
            } catch {}
        }

        if (analyzeQualityBtn && importQualitySelect) {
            analyzeQualityBtn.addEventListener('click', async () => {
                const urls = getImportUrls();
                if (urls.length !== 1) {
                    if (qualityAnalyzeStatus) qualityAnalyzeStatus.textContent = 'Paste exactly one URL to analyze.';
                    return;
                }

                analyzeQualityBtn.disabled = true;
                if (qualityAnalyzeStatus) qualityAnalyzeStatus.textContent = 'Analyzing...';

                try {
                    const response = await fetch('/import-formats', {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'x-csrf-token': getImportCsrf()
                        },
                        body: JSON.stringify({ url: urls[0] })
                    });
                    const data = await response.json();
                    if (!response.ok) throw new Error(data.error || 'Could not analyze this URL.');

                    importQualitySelect.innerHTML = '';
                    (data.formats || []).forEach((format, index) => {
                        const option = document.createElement('option');
                        option.value = format.quality || 'best';
                        option.dataset.formatId = format.formatId || '';
                        option.dataset.qualityLabel = format.label || option.value;
                        option.textContent = (format.label || option.value) + (format.detail ? ' - ' + format.detail : '');
                        option.selected = index === 0;
                        importQualitySelect.appendChild(option);
                    });
                    if (data.title && importTitleInput && !importTitleInput.value.trim()) {
                        importTitleInput.value = data.title.slice(0, 180);
                    }
                    if (qualityAnalyzeStatus) qualityAnalyzeStatus.textContent = 'Available qualities loaded.';
                } catch (err) {
                    if (qualityAnalyzeStatus) qualityAnalyzeStatus.textContent = err.message || 'Analyze failed.';
                } finally {
                    analyzeQualityBtn.disabled = false;
                }
            });
        }

        importQueueBtn.addEventListener('click', async () => {
            const urls = getImportUrls();
            const selected = importQualitySelect ? importQualitySelect.options[importQualitySelect.selectedIndex] : null;
            const quality = importQualitySelect ? importQualitySelect.value : '720';
            const formatId = urls.length === 1 && selected ? (selected.dataset.formatId || '') : '';
            const qualityLabel = selected ? (selected.dataset.qualityLabel || selected.textContent || quality) : quality;
            const title = importTitleInput && urls.length === 1 ? importTitleInput.value.trim() : '';

            if (urls.length === 0) {
                importUrlInput.focus();
                importUrlInput.classList.add('shake');
                setTimeout(() => importUrlInput.classList.remove('shake'), 500);
                return;
            }

            setImportQueueButton('Queueing...', true);
            if (importProgressSection) importProgressSection.style.display = 'block';
            if (importResult) importResult.style.display = 'none';
            if (importStatusTitle) importStatusTitle.textContent = 'Queueing import...';
            if (importStatusDetail) importStatusDetail.textContent = 'Adding URL(s) to queue...';
            if (importProgressFill) importProgressFill.style.width = '0%';
            if (importPercent) importPercent.textContent = '0%';
            if (importSpeed) importSpeed.textContent = '';
            if (importEta) importEta.textContent = '';
            if (importSpinner) importSpinner.className = 'import-spinner';

            try {
                const response = await fetch('/import-url', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-csrf-token': getImportCsrf()
                    },
                    body: JSON.stringify({
                        url: urls.join('\n'),
                        title,
                        quality,
                        formatId,
                        qualityLabel
                    })
                });
                const data = await response.json();
                if (!response.ok) throw new Error(data.error || 'Import failed');

                if (data.alreadyExists && data.videoId) {
                    if (importProgressSection) importProgressSection.style.display = 'none';
                    if (importResult) importResult.style.display = 'block';
                    if (importResultCard) importResultCard.className = 'import-result-card success';
                    if (importResultIcon) importResultIcon.textContent = '🎬';
                    if (importResultText) importResultText.textContent = data.message || 'Video is already in your library.';
                    if (importResultBtn) importResultBtn.style.display = 'inline-flex';
                    if (importWatchBtn) {
                        importWatchBtn.style.display = 'inline-flex';
                        importWatchBtn.href = '/watch/' + encodeURIComponent(data.videoId);
                    }
                    importUrlInput.value = '';
                    if (importTitleInput) importTitleInput.value = '';
                    setImportQueueButton('Import Video', false);
                    return;
                }

                (data.jobs || []).forEach(job => {
                    importJobs.set(job.id, job);
                    connectImportJob(job);
                });
                renderImportQueue();
                importUrlInput.value = '';
                if (importTitleInput) importTitleInput.value = '';
                setImportQueueButton('Import More', false);
            } catch (err) {
                if (importResult) importResult.style.display = 'block';
                if (importResultCard) importResultCard.className = 'import-result-card error';
                if (importResultIcon) importResultIcon.textContent = '!';
                if (importResultText) importResultText.textContent = err.message || 'Could not start import.';
                if (importResultBtn) importResultBtn.style.display = 'none';
                if (importWatchBtn) importWatchBtn.style.display = 'none';
                setImportQueueButton('Try Again', false);
            }
        });

        if (importQueueList) {
            importQueueList.addEventListener('click', async (event) => {
                const cancelBtn = event.target.closest('[data-import-cancel]');
                const retryBtn = event.target.closest('[data-import-retry]');
                const jobId = cancelBtn?.getAttribute('data-import-cancel') || retryBtn?.getAttribute('data-import-retry');
                if (!jobId) return;

                const response = await fetch((cancelBtn ? '/import-cancel/' : '/import-retry/') + encodeURIComponent(jobId), {
                    method: 'POST',
                    headers: { 'x-csrf-token': getImportCsrf() }
                }).catch(() => null);
                if (!response || !response.ok) return;

                const data = await response.json().catch(() => ({}));
                if (data.job) {
                    importJobs.set(data.job.id, data.job);
                    connectImportJob(data.job);
                }
                await loadImportJobs();
            });
        }

        loadImportJobs();
    }

    // ========================================
    // Hajera Romantic Dashboard Features
    // ========================================
    const isHajeraMode = document.querySelector('.hajera-mode');

    if (isHajeraMode && !prefersReducedMotion) {

        const isMobileView = window.innerWidth <= 768;
        const isTabletView = window.innerWidth <= 1024;

        // ---- 1. Floating Hearts Background ----
        const heartsContainer = document.getElementById('floatingHeartsContainer');
        if (heartsContainer) {
            const heartSymbols = ['♥', '💕', '💗', '♡', '❤', '💖', '🌹'];
            const maxHearts = isMobileView ? 4 : (isTabletView ? 8 : 15);
            const spawnInterval = isMobileView ? 6000 : 3000;
            const initialBurst = isMobileView ? 3 : 8;
            let activeHearts = 0;

            function spawnHeart() {
                if (document.documentElement.getAttribute('data-ui-mode') === 'minimal') return;
                if (activeHearts >= maxHearts) return;
                activeHearts++;

                const heart = document.createElement('span');
                heart.className = 'floating-heart';
                heart.textContent = heartSymbols[Math.floor(Math.random() * heartSymbols.length)];

                const size = isMobileView ? (0.5 + Math.random() * 0.8) : (0.6 + Math.random() * 1.4);
                const left = Math.random() * 100;
                const duration = isMobileView ? (14 + Math.random() * 12) : (10 + Math.random() * 15);
                const delay = Math.random() * 2;

                heart.style.left = left + '%';
                heart.style.fontSize = size + 'rem';
                heart.style.animationDuration = duration + 's';
                heart.style.animationDelay = delay + 's';
                heart.style.opacity = (0.06 + Math.random() * 0.12).toString();

                heartsContainer.appendChild(heart);

                setTimeout(() => {
                    heart.remove();
                    activeHearts--;
                }, (duration + delay) * 1000);
            }

            // Initial burst
            for (let i = 0; i < initialBurst; i++) {
                setTimeout(spawnHeart, i * 800);
            }

            // Continuous spawn
            if (window.__HEART_INTERVAL__) clearInterval(window.__HEART_INTERVAL__);
            window.__HEART_INTERVAL__ = setInterval(spawnHeart, spawnInterval);
        }

        // ---- 2. Typewriter Effect ----
        const typewriterTarget = document.getElementById('typewriterTarget');
        if (typewriterTarget) {
            if (window.__TYPEWRITER_TIMEOUT__) {
                clearTimeout(window.__TYPEWRITER_TIMEOUT__);
                window.__TYPEWRITER_TIMEOUT__ = null;
            }

            const typewriterMessages = [
                'তুমি আমার সবকিছু 💖',
                'তুমিই আমার পুরো পৃথিবী 🌹',
                'চিরদিন শুধু তোমারই থাকবো 💕',
                'তুমি আমার জীবনের সেরা উপহার ✨',
                'আমার প্রতিটি নিঃশ্বাসে আছো তুমি 🥰',
                'তোমার ভালোবাসায় রঙিন আমার মন 🌸',
                'তুমি আমার হাসির মূল কারণ 💫',
                'তুমি কাছে থাকলে সময় যেন থমকে দাঁড়ায় ⏳💖',
                'সারাটা জীবন তোমার পাশে কাটাতে চাই 💍',
                'তোমার একটি মিষ্টি হাসিতেই আমার দিন শুভ হয় ☀️',
                'পৃথিবীর সব সুখের চেয়ে তোমার ভালোবাসা দামি 💎',
                'তোমার হাতটি ধরে আজীবন হাঁটতে চাই 👫💗',
                'তুমি আমার হৃদয়ের সবচেয়ে সুন্দর কবিতা 📜💖',
                'তুমি আমার চাওয়া, তুমি আমার পাওয়া 🦋',
                'আমার মনের প্রতিটি কোণে জড়িয়ে আছো তুমি 🌙✨',
            ];
            let currentMsgIndex = 0;
            let charIndex = 0;
            let isDeleting = false;

            function typeNextChar() {
                if (!document.getElementById('typewriterTarget')) return;
                const msg = typewriterMessages[currentMsgIndex];
                typewriterTarget.classList.remove('typing-done');

                if (!isDeleting) {
                    charIndex++;
                    typewriterTarget.textContent = msg.substring(0, charIndex);

                    if (charIndex >= msg.length) {
                        typewriterTarget.classList.add('typing-done');
                        window.__TYPEWRITER_TIMEOUT__ = setTimeout(() => {
                            isDeleting = true;
                            typeNextChar();
                        }, 4000);
                        return;
                    }
                    window.__TYPEWRITER_TIMEOUT__ = setTimeout(typeNextChar, 60 + Math.random() * 40);
                } else {
                    charIndex--;
                    typewriterTarget.textContent = msg.substring(0, charIndex);

                    if (charIndex <= 0) {
                        isDeleting = false;
                        currentMsgIndex = (currentMsgIndex + 1) % typewriterMessages.length;
                        window.__TYPEWRITER_TIMEOUT__ = setTimeout(typeNextChar, 500);
                        return;
                    }
                    window.__TYPEWRITER_TIMEOUT__ = setTimeout(typeNextChar, 30);
                }
            }

            window.__TYPEWRITER_TIMEOUT__ = setTimeout(typeNextChar, 800);
        }

        // ---- 3. Rotating Love Quotes ----
        const loveQuoteEl = document.getElementById('loveQuote');
        if (loveQuoteEl) {
            const quotes = [
                'আমাদের এই ছোট্ট ভালোবাসার কোণে তোমাকে স্বাগতম, হাজেরা ✨',
                'হাজেরা, তোমার প্রতিটি পদচারণায় আমার এই মন রঙিন হয়ে ওঠে 🌸',
                'তুমি হাসলে আমার পুরো পৃথিবী আলোকিত হয়ে যায়, হাজেরা 💖',
                'হাজেরা, তোমার জন্য সাজানো সুন্দর দৃশ্যগুলো আজ তোমার অপেক্ষায় 🎬',
                'তোমার চোখের ওই মায়ায় হারিয়ে যেতে মন চায় বারবার, হাজেরা 🌹',
                'পৃথিবীর সব ভালোবাসার রং মিশে আছে শুধু তোমাতে, হাজেরা 🎨',
                'আমার জীবনের সবচেয়ে সুন্দর উপহার হয়ে আছো তুমি, হাজেরা 💫',
                'হাজেরা, তোমার একটু হাসির জন্য আমি হাজারবার ভালোবাসতে পারি 💗',
            ];
            let quoteIndex = 0;

            if (window.__QUOTE_INTERVAL__) clearInterval(window.__QUOTE_INTERVAL__);
            window.__QUOTE_INTERVAL__ = setInterval(() => {
                quoteIndex = (quoteIndex + 1) % quotes.length;
                loveQuoteEl.style.opacity = '0';
                loveQuoteEl.style.transform = 'translateY(6px)';

                setTimeout(() => {
                    loveQuoteEl.textContent = quotes[quoteIndex];
                    loveQuoteEl.style.opacity = '1';
                    loveQuoteEl.style.transform = 'translateY(0)';
                }, 400);
            }, 6000);
        }

        // ---- 4. Touch Sparkle Burst (Android/Mobile) & 5. Cursor Trail ----
        if (!window.__SPARKLE_LISTENERS_ATTACHED__) {
            window.__SPARKLE_LISTENERS_ATTACHED__ = true;
            const burstSymbols = ['✦', '♥', '✧', '💕', '✨'];
            let lastTouchBurst = 0;

            document.addEventListener('touchstart', (e) => {
                const sparkleContainer = document.getElementById('sparkleTrailContainer');
                if (!sparkleContainer || window.matchMedia('(pointer: fine)').matches) return;
                if (document.documentElement.getAttribute('data-ui-mode') === 'minimal') return;
                const now = Date.now();
                if (now - lastTouchBurst < 400) return;
                lastTouchBurst = now;

                const touch = e.touches[0];
                if (!touch) return;

                const x = touch.clientX;
                const y = touch.clientY;

                for (let i = 0; i < 5; i++) {
                    const spark = document.createElement('span');
                    spark.className = 'sparkle-particle star';
                    spark.textContent = burstSymbols[Math.floor(Math.random() * burstSymbols.length)];

                    const angle = (Math.PI * 2 * i) / 5 + (Math.random() - 0.5) * 0.5;
                    const dist = 20 + Math.random() * 25;
                    const sx = Math.cos(angle) * dist;
                    const sy = Math.sin(angle) * dist;

                    spark.style.left = x + 'px';
                    spark.style.top = y + 'px';
                    spark.style.setProperty('--sx', sx + 'px');
                    spark.style.setProperty('--sy', sy + 'px');
                    spark.style.fontSize = (0.6 + Math.random() * 0.5) + 'rem';
                    spark.style.animationDelay = (i * 40) + 'ms';

                    sparkleContainer.appendChild(spark);
                    setTimeout(() => spark.remove(), 900);
                }
            }, { passive: true });

            // ---- 5. Sparkle Cursor Trail (Desktop only) ----
            const sparkleSymbols = ['✦', '✧', '♥', '✨'];
            let sparkleThrottle = 0;

            document.addEventListener('mousemove', (e) => {
                const sparkleContainer = document.getElementById('sparkleTrailContainer');
                if (!sparkleContainer || !window.matchMedia('(pointer: fine)').matches) return;
                const now = Date.now();
                if (now - sparkleThrottle < 60) return;
                sparkleThrottle = now;

                const sparkle = document.createElement('span');
                const isStar = Math.random() > 0.4;

                if (isStar) {
                    sparkle.className = 'sparkle-particle star';
                    sparkle.textContent = sparkleSymbols[Math.floor(Math.random() * sparkleSymbols.length)];
                } else {
                    sparkle.className = 'sparkle-particle';
                }

                const sx = (Math.random() - 0.5) * 30;
                const sy = -10 - Math.random() * 20;
                sparkle.style.left = e.clientX + 'px';
                sparkle.style.top = e.clientY + 'px';
                sparkle.style.setProperty('--sx', sx + 'px');
                sparkle.style.setProperty('--sy', sy + 'px');

                sparkleContainer.appendChild(sparkle);

                setTimeout(() => sparkle.remove(), 800);
            });
        }
    }

    // ========================================
    // Real-Time Presence & Heartbeat Engine
    // ========================================
    function initPresenceTracker() {
        if (window.__PRESENCE_TRACKER_INITIALIZED__) {
            if (typeof window.__sendPresenceAction === 'function') {
                window.__sendPresenceAction('page_navigate');
            }
            return;
        }
        const currentUser = document.body.getAttribute('data-user') || '';
        if (!currentUser || window.location.pathname === '/' || window.location.pathname === '/login') return;
        window.__PRESENCE_TRACKER_INITIALIZED__ = true;

        let isIdle = false;
        let idleTimer = null;
        let lastPing = 0;

        function getPlayerState() {
            const vid = document.getElementById('vpVideo');
            if (vid && vid.getAttribute('data-video-id')) {
                const isPlaying = !vid.paused && !vid.ended && vid.readyState > 2;
                const videoId = vid.getAttribute('data-video-id');
                const videoTitle = document.querySelector('.video-header-title, .watch-main-title, h1')?.textContent?.trim() || '';
                const currentTime = Math.floor(vid.currentTime || 0);
                const duration = Math.floor(vid.duration || 0);
                return { videoId, videoTitle, isPlaying, currentTime, duration };
            }
            return { videoId: null, videoTitle: null, isPlaying: false, currentTime: 0, duration: 0 };
        }

        function sendPresencePing(action = null) {
            const playerState = getPlayerState();
            const payload = {
                page: window.location.pathname,
                isIdle: isIdle || document.hidden,
                action,
                deltaSeconds: 10,
                ...playerState
            };

            fetch('/api/presence/ping', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || ''
                },
                body: JSON.stringify(payload),
                keepalive: true
            })
            .then(res => {
                if (res.status === 401 || (res.redirected && (res.url.endsWith('/') || res.url.includes('/login')))) {
                    if (window.location.pathname !== '/' && window.location.pathname !== '/login') {
                        window.location.href = '/';
                    }
                    return null;
                }
                return res.json();
            })
            .then(data => {
                if (data && data.loggedOut) {
                    if (window.location.pathname !== '/' && window.location.pathname !== '/login') {
                        window.location.href = '/';
                    }
                }
            })
            .catch(() => {});

            lastPing = Date.now();
        }

        function resetIdleTimer() {
            if (isIdle) {
                isIdle = false;
                sendPresencePing('came_online');
            }
            clearTimeout(idleTimer);
            idleTimer = setTimeout(() => {
                isIdle = true;
                sendPresencePing('went_idle');
            }, 90000);
        }

        ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'].forEach(evt => {
            window.addEventListener(evt, resetIdleTimer, { passive: true });
        });

        document.addEventListener('visibilitychange', () => {
            if (document.hidden) {
                isIdle = true;
                sendPresencePing('went_idle');
            } else {
                isIdle = false;
                sendPresencePing('came_online');
            }
        });

        // Send initial ping immediately
        sendPresencePing();

        // Periodic 10s heartbeat - pause when tab is hidden to save requests
        setInterval(() => {
            if (document.hidden) return;
            if (Date.now() - lastPing >= 9000) {
                sendPresencePing();
            }
        }, 10000);

        window.__sendPresenceAction = sendPresencePing;
    }

    initPresenceTracker();

    // ========================================
    // Admin Control Center Tabs & Navigation
    // ========================================
    function initAdminTabs() {
        const tabNav = document.getElementById('adminNavTabs');
        if (!tabNav) return;

        const tabBtns = tabNav.querySelectorAll('.admin-tab-btn');
        const tabPanes = document.querySelectorAll('.admin-tab-pane');
        if (!tabBtns.length || !tabPanes.length) return;

        function switchAdminTab(tabKey) {
            if (!tabKey) return;
            tabBtns.forEach(btn => {
                const isActive = (btn.getAttribute('data-tab') === tabKey);
                btn.classList.toggle('active', isActive);
                btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
            });
            tabPanes.forEach(pane => {
                const isTarget = (pane.id === 'tab-' + tabKey);
                pane.classList.toggle('active', isTarget);
            });
            try {
                history.replaceState(null, '', '#' + tabKey);
                sessionStorage.setItem('activeAdminTab', tabKey);
            } catch(e) {}
        }
        window.switchAdminTab = switchAdminTab;

        tabNav.addEventListener('click', (e) => {
            const btn = e.target.closest('.admin-tab-btn');
            if (!btn) return;
            const tabKey = btn.getAttribute('data-tab');
            if (tabKey) switchAdminTab(tabKey);
        });

        // Initialize from URL hash or stored session
        const initialHash = (window.location.hash || '').replace('#', '');
        const savedTab = sessionStorage.getItem('activeAdminTab');
        const validTabs = ['overview', 'hajera', 'storage', 'sessions', 'videos'];
        
        if (initialHash && validTabs.includes(initialHash)) {
            switchAdminTab(initialHash);
        } else if (savedTab && validTabs.includes(savedTab)) {
            switchAdminTab(savedTab);
        }
    }
    initAdminTabs();

    // Master Video Library Search Filter
    const adminVideoSearchInput = document.getElementById('adminVideoSearchInput');
    if (adminVideoSearchInput) {
        adminVideoSearchInput.addEventListener('input', (e) => {
            const q = e.target.value.trim().toLowerCase();
            const rows = document.querySelectorAll('#adminMasterVideosTable tbody tr');
            const cards = document.querySelectorAll('#adminMasterVideosList .admin-master-video-card');

            rows.forEach(r => {
                const title = (r.getAttribute('data-title') || '').toLowerCase();
                r.style.display = (!q || title.includes(q)) ? '' : 'none';
            });
            cards.forEach(c => {
                const title = (c.getAttribute('data-title') || '').toLowerCase();
                c.style.display = (!q || title.includes(q)) ? '' : 'none';
            });
        });
    }

    // ========================================
    // Admin Control Center Interactivity & Live Sync
    // ========================================
    const hajeraFilterChips = document.getElementById('hajeraFilterChips');
    const hajeraCardsList = document.getElementById('hajeraCardsList');
    const hajeraDesktopTable = document.getElementById('hajeraDesktopTable');
    const hajeraSearchInput = document.getElementById('hajeraSearchInput');
    const hajeraSearchClear = document.getElementById('hajeraSearchClear');
    const hajeraFilterCount = document.getElementById('hajeraFilterCount');
    const hajeraFilteredEmpty = document.getElementById('hajeraFilteredEmpty');
    const hajeraResetFilterBtn = document.getElementById('hajeraResetFilterBtn');
    const hajeraTimelineFeed = document.getElementById('hajeraTimelineFeed');
    const hajeraSearchBarWrap = document.getElementById('hajeraSearchBarWrap');

    if (hajeraFilterChips || hajeraSearchInput || hajeraTimelineFeed) {
        let activeStatusFilter = 'all';
        let searchQuery = '';

        function updateHajeraView() {
            if (activeStatusFilter === 'timeline') {
                if (hajeraTimelineFeed) hajeraTimelineFeed.style.display = 'block';
                if (hajeraSearchBarWrap) hajeraSearchBarWrap.style.display = 'none';
                if (hajeraCardsList) hajeraCardsList.style.display = 'none';
                if (hajeraDesktopTable) hajeraDesktopTable.style.display = 'none';
                if (hajeraFilteredEmpty) hajeraFilteredEmpty.style.display = 'none';
                return;
            }

            if (hajeraTimelineFeed) hajeraTimelineFeed.style.display = 'none';
            if (hajeraSearchBarWrap) hajeraSearchBarWrap.style.display = '';

            const cards = document.querySelectorAll('.hajera-android-card');
            const rows = document.querySelectorAll('#hajeraDesktopTable tbody tr');
            let visibleCount = 0;
            const totalCount = cards.length || rows.length;

            // Filter Mobile Cards
            cards.forEach(card => {
                const status = card.getAttribute('data-status') || '';
                const title = (card.getAttribute('data-title') || '').toLowerCase();
                const matchesStatus = (activeStatusFilter === 'all') || (status === activeStatusFilter);
                const matchesSearch = !searchQuery || title.includes(searchQuery);

                if (matchesStatus && matchesSearch) {
                    card.style.display = 'flex';
                    visibleCount++;
                } else {
                    card.style.display = 'none';
                }
            });

            // Filter Desktop Rows
            rows.forEach(row => {
                const status = row.getAttribute('data-status') || '';
                const title = (row.getAttribute('data-title') || '').toLowerCase();
                const matchesStatus = (activeStatusFilter === 'all') || (status === activeStatusFilter);
                const matchesSearch = !searchQuery || title.includes(searchQuery);

                if (matchesStatus && matchesSearch) {
                    row.style.display = '';
                } else {
                    row.style.display = 'none';
                }
            });

            // Update Counter
            if (hajeraFilterCount) {
                hajeraFilterCount.innerHTML = `Showing <strong>${visibleCount}</strong> of ${totalCount}`;
            }

            // Update Empty state
            if (hajeraFilteredEmpty) {
                if (visibleCount === 0 && totalCount > 0) {
                    hajeraFilteredEmpty.style.display = 'flex';
                    if (hajeraCardsList) hajeraCardsList.style.display = 'none';
                    if (hajeraDesktopTable) hajeraDesktopTable.style.display = 'none';
                } else {
                    hajeraFilteredEmpty.style.display = 'none';
                    if (hajeraCardsList) hajeraCardsList.style.display = '';
                    if (hajeraDesktopTable) hajeraDesktopTable.style.display = '';
                }
            }
        }

        // Chip Clicks
        if (hajeraFilterChips) {
            hajeraFilterChips.addEventListener('click', (e) => {
                const btn = e.target.closest('.hajera-chip');
                if (!btn) return;

                hajeraFilterChips.querySelectorAll('.hajera-chip').forEach(c => c.classList.remove('active'));
                btn.classList.add('active');

                activeStatusFilter = btn.getAttribute('data-filter') || 'all';
                updateHajeraView();
            });
        }

        // Search Input
        if (hajeraSearchInput) {
            hajeraSearchInput.addEventListener('input', (e) => {
                searchQuery = e.target.value.trim().toLowerCase();
                if (hajeraSearchClear) {
                    hajeraSearchClear.style.display = searchQuery ? 'flex' : 'none';
                }
                updateHajeraView();
            });
        }

        // Search Clear
        if (hajeraSearchClear) {
            hajeraSearchClear.addEventListener('click', () => {
                if (hajeraSearchInput) {
                    hajeraSearchInput.value = '';
                    searchQuery = '';
                    hajeraSearchClear.style.display = 'none';
                    updateHajeraView();
                    hajeraSearchInput.focus();
                }
            });
        }

        // Reset Filter Button
        if (hajeraResetFilterBtn) {
            hajeraResetFilterBtn.addEventListener('click', () => {
                activeStatusFilter = 'all';
                searchQuery = '';
                if (hajeraSearchInput) hajeraSearchInput.value = '';
                if (hajeraSearchClear) hajeraSearchClear.style.display = 'none';
                if (hajeraFilterChips) {
                    hajeraFilterChips.querySelectorAll('.hajera-chip').forEach(c => {
                        c.classList.toggle('active', c.getAttribute('data-filter') === 'all');
                    });
                }
                updateHajeraView();
            });
        }

        // ========================================
        // Admin Live Status Polling (4s Interval)
        // ========================================
        function parseSqliteDateHelper(str) {
            if (!str) return 0;
            if (typeof str === 'number') return str;
            const s = String(str).trim();
            const iso = s.includes('T') ? (s.endsWith('Z') ? s : s + 'Z') : s.replace(' ', 'T') + 'Z';
            const t = new Date(iso).getTime();
            return isNaN(t) ? new Date(str).getTime() : t;
        }

        function formatSecondsHelper(sec) {
            const s = Number(sec || 0);
            if (!s || isNaN(s)) return '0:00';
            const hrs = Math.floor(s / 3600);
            const mins = Math.floor((s % 3600) / 60);
            const secs = Math.floor(s % 60);
            if (hrs > 0) {
                return hrs + ':' + (mins < 10 ? '0' : '') + mins + ':' + (secs < 10 ? '0' : '') + secs;
            }
            return mins + ':' + (secs < 10 ? '0' : '') + secs;
        }

        function formatRelTimeHelper(dateStr) {
            if (!dateStr) return '-';
            const timestamp = parseSqliteDateHelper(dateStr);
            const seconds = Math.floor((Date.now() - timestamp) / 1000);
            if (isNaN(seconds) || seconds < 0) return 'Just now';
            if (seconds < 45) return 'Just now';
            const minutes = Math.floor(seconds / 60);
            if (minutes < 60) return minutes + 'm ago';
            const hours = Math.floor(minutes / 60);
            if (hours < 24) return hours + 'h ago';
            const days = Math.floor(hours / 24);
            if (days === 1) return 'Yesterday';
            return days + 'd ago';
        }

        // ─── Real-Time 1-Second Ticker & Jittered Poller Engine ───────────
        let _liveTickerInterval = null;
        let _hajeraPollTimeout = null;
        let _currentLiveState = {
            videoId: null,
            videoTitle: '',
            position: 0,
            duration: 0,
            playing: false,
            ended: false,
            device: '',
            thumbnail: '',
            lastServerSync: 0
        };

        function startLiveSecondTicker() {
            if (_liveTickerInterval) return;
            _liveTickerInterval = setInterval(() => {
                if (!_currentLiveState.playing || _currentLiveState.ended || !_currentLiveState.videoId) return;
                if (_currentLiveState.duration > 0 && _currentLiveState.position < _currentLiveState.duration) {
                    _currentLiveState.position += 1;
                    renderLiveCardProgressOnly();
                }
            }, 1000);
            window.__liveTickerInterval = _liveTickerInterval;
        }

        function stopLiveSecondTicker() {
            if (_liveTickerInterval || window.__liveTickerInterval) {
                clearInterval(_liveTickerInterval || window.__liveTickerInterval);
                _liveTickerInterval = null;
                window.__liveTickerInterval = null;
            }
        }

        function renderLiveCardProgressOnly() {
            const timeEl = document.getElementById('liveCardTime');
            const pctEl = document.getElementById('liveCardPct');
            const fillEl = document.getElementById('liveCardProgressFill');
            if (!timeEl || !pctEl || !fillEl) return;

            const pos = _currentLiveState.position;
            const dur = _currentLiveState.duration;
            const pct = dur > 0 ? Math.min(100, Math.round((pos / dur) * 100)) : 0;

            timeEl.textContent = formatSecondsHelper(pos) + ' / ' + formatSecondsHelper(dur);
            pctEl.textContent = pct + '%';
            fillEl.style.width = pct + '%';
        }

        function scheduleNextHajeraPoll(isWatching) {
            if (_hajeraPollTimeout || window.__hajeraPollTimeout) {
                clearTimeout(_hajeraPollTimeout || window.__hajeraPollTimeout);
            }
            if (window.location.pathname !== '/admin') return;
            if (document.hidden) {
                _hajeraPollTimeout = setTimeout(() => scheduleNextHajeraPoll(isWatching), 15000);
                window.__hajeraPollTimeout = _hajeraPollTimeout;
                return;
            }
            // Jitter: 1.4s ~ 1.9s if watching, 4.5s ~ 6.0s if idle/offline (prevents thundering herd)
            const base = isWatching ? 1400 : 4500;
            const jitter = isWatching ? Math.floor(Math.random() * 500) : Math.floor(Math.random() * 1500);
            _hajeraPollTimeout = setTimeout(pollHajeraLiveStatus, base + jitter);
            window.__hajeraPollTimeout = _hajeraPollTimeout;
        }

        function pollHajeraLiveStatus() {
            if (window.location.pathname !== '/admin') return;
            fetch('/admin/hajera/live-status')
                .then(res => res.json())
                .then(data => {
                    if (!data || !data.presence) {
                        scheduleNextHajeraPoll(false);
                        return;
                    }
                    const p = data.presence;
                    const isWatching = !!(p.isWatching && p.currentVideoId);

                    // Update live state for the 1-second ticker
                    if (isWatching) {
                        const serverPos = Number.isFinite(p.currentTime) ? p.currentTime : 0;
                        const serverDur = Number.isFinite(p.duration) ? p.duration : 0;
                        const isPlaying = p.status === 'watching' || p.playing !== false;

                        // Only resync position if server drifted by >= 2 seconds or video changed
                        if (_currentLiveState.videoId !== p.currentVideoId || Math.abs(serverPos - _currentLiveState.position) >= 2) {
                            _currentLiveState.position = serverPos;
                        }
                        _currentLiveState.videoId = p.currentVideoId;
                        _currentLiveState.videoTitle = p.videoTitle || 'Video';
                        _currentLiveState.duration = serverDur;
                        _currentLiveState.playing = isPlaying;
                        _currentLiveState.device = p.deviceInfo || 'Device';
                        _currentLiveState.thumbnail = p.thumbnail || '';
                        _currentLiveState.lastServerSync = Date.now();

                        if (isPlaying) {
                            startLiveSecondTicker();
                        } else {
                            stopLiveSecondTicker();
                        }
                    } else {
                        stopLiveSecondTicker();
                        _currentLiveState.videoId = null;
                        _currentLiveState.playing = false;
                    }

                    // Update Online Dot
                    const dot = document.getElementById('hajeraHeroOnlineDot');
                    if (dot) {
                        dot.className = 'hajera-hero-online-dot dot-' + (p.status || 'offline');
                        dot.title = p.status || 'offline';
                    }

                    // Update Hero Live Badge
                    const badge = document.getElementById('hajeraLiveBadge');
                    if (badge) {
                        if (p.isWatching) {
                            badge.className = 'hero-live-badge badge-live-watching';
                            badge.innerHTML = '<span class="live-pulse-anim"></span> 🎬 LIVE: Watching Now';
                        } else if (p.isOnline) {
                            badge.className = 'hero-live-badge badge-live-online';
                            badge.innerHTML = '<span class="live-pulse-anim"></span> 🟢 Online & Active';
                        } else if (p.isIdle) {
                            badge.className = 'hero-live-badge badge-live-idle';
                            badge.innerHTML = '<span class="idle-static-dot"></span> 🟡 Away / Idle';
                        } else {
                            badge.className = 'hero-live-badge badge-live-offline';
                            badge.innerHTML = '⚫ Offline';
                        }
                    }

                    // Update Last Active Text
                    const lastActive = document.getElementById('hajeraLastActiveText');
                    if (lastActive) {
                        if (p.isWatching || p.isOnline) {
                            lastActive.textContent = '⏱️ Active Now';
                        } else if (p.lastSeen) {
                            lastActive.textContent = '⏱️ ' + formatRelTimeHelper(p.lastSeen);
                        }
                    }

                    // Update Hero Description
                    const desc = document.getElementById('hajeraHeroDesc');
                    if (desc && p.deviceInfo) {
                        const baseText = desc.textContent.split('•')[0].trim();
                        desc.textContent = baseText + ' • ' + p.deviceInfo;
                    }

                    // Update Live Playing Card
                    const liveCard = document.getElementById('hajeraLiveCard');
                    if (liveCard) {
                        if (isWatching) {
                            liveCard.style.display = 'flex';
                            const titleEl = document.getElementById('liveCardTitle');
                            const timeEl = document.getElementById('liveCardTime');
                            const pctEl = document.getElementById('liveCardPct');
                            const fillEl = document.getElementById('liveCardProgressFill');
                            const tagTextEl = document.getElementById('liveCardTagText');
                            const devEl = document.getElementById('liveCardDevice');
                            const joinBtn = document.getElementById('liveCardJoinBtn');
                            const eqWrap = document.getElementById('liveCardEq');

                            if (titleEl && timeEl && pctEl && fillEl) {
                                titleEl.textContent = p.videoTitle || 'Video';
                                titleEl.href = `/watch/${encodeURIComponent(p.currentVideoId)}`;
                                if (joinBtn) joinBtn.href = `/watch/${encodeURIComponent(p.currentVideoId)}`;
                                if (devEl) devEl.textContent = p.deviceInfo || 'Device';
                                if (tagTextEl) {
                                    tagTextEl.textContent = p.playing === false ? '⏸️ PAUSED' : '▶️ PLAYING NOW';
                                }
                                if (eqWrap) {
                                    eqWrap.style.opacity = p.playing === false ? '0.3' : '1';
                                }
                                renderLiveCardProgressOnly();
                            } else {
                                const curTime = formatSecondsHelper(p.currentTime);
                                const durTime = formatSecondsHelper(p.duration);
                                const pct = p.duration > 0 ? Math.min(100, Math.round((p.currentTime / p.duration) * 100)) : 0;
                                const thumbHtml = p.thumbnail
                                    ? `<img src="/thumbnails/${p.thumbnail}" alt="" id="liveCardThumbImg" />`
                                    : '<div class="thumb-fallback" id="liveCardThumbFallback">🎬</div>';

                                liveCard.innerHTML = `
                                    <div class="live-card-eq" id="liveCardEq" style="opacity: ${p.playing === false ? '0.3' : '1'};">
                                        <span class="eq-bar bar-1"></span>
                                        <span class="eq-bar bar-2"></span>
                                        <span class="eq-bar bar-3"></span>
                                        <span class="eq-bar bar-4"></span>
                                    </div>
                                    <div class="live-card-thumb" id="liveCardThumb">${thumbHtml}</div>
                                    <div class="live-card-info">
                                        <div class="live-card-tag">
                                            <span class="live-tag-pulse" id="liveCardTagText">${p.playing === false ? '⏸️ PAUSED' : '▶️ PLAYING NOW'}</span>
                                            <span class="live-tag-device" id="liveCardDevice">${p.deviceInfo || 'Device'}</span>
                                        </div>
                                        <a href="/watch/${encodeURIComponent(p.currentVideoId)}" class="live-card-title" id="liveCardTitle">${p.videoTitle || 'Video'}</a>
                                        <div class="live-card-meta">
                                            <span class="live-time" id="liveCardTime">${curTime} / ${durTime}</span>
                                            <span class="live-pct" id="liveCardPct">${pct}%</span>
                                        </div>
                                        <div class="live-progress-bar">
                                            <div class="live-progress-fill" id="liveCardProgressFill" style="width: ${pct}%;"></div>
                                        </div>
                                    </div>
                                    <a href="/watch/${encodeURIComponent(p.currentVideoId)}" class="btn btn-primary btn-sm btn-join-watch" id="liveCardJoinBtn" title="Watch together or view">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                                            <polygon points="5 3 19 12 5 21 5 3"/>
                                        </svg>
                                        <span>Watch</span>
                                    </a>
                                `;
                            }
                        } else {
                            liveCard.style.display = 'none';
                        }
                    }

                    // Schedule next adaptive jittered poll (1.4s ~ 1.9s if watching)
                    scheduleNextHajeraPoll(isWatching);

                    // Update Watch Time Stats
                    if (data.watchStats) {
                        const totalEl = document.getElementById('hajeraTotalWatchTime');
                        const todayEl = document.getElementById('hajeraTodayWatchTime');
                        if (totalEl && data.watchStats.totalFormatted) totalEl.textContent = data.watchStats.totalFormatted;
                        if (todayEl && data.watchStats.todayFormatted) todayEl.textContent = data.watchStats.todayFormatted;
                    }

                    // Update Hajera Session Count Badge & Button
                    const hajeraSessText = document.getElementById('hajeraSessionText');
                    if (hajeraSessText && typeof data.hajeraSessionCount === 'number') {
                        hajeraSessText.textContent = `${data.hajeraSessionCount} Hajera Session${data.hajeraSessionCount !== 1 ? 's' : ''}`;
                    }
                    const btnHajeraLogout = document.getElementById('btnHajeraLogoutAll');
                    if (btnHajeraLogout && typeof data.hajeraSessionCount === 'number') {
                        btnHajeraLogout.disabled = (data.hajeraSessionCount === 0);
                    }

                    // Update Muaj Session Count Badge & Button
                    const muajSessText = document.getElementById('muajSessionText');
                    if (muajSessText && typeof data.muajSessionCount === 'number') {
                        muajSessText.textContent = `${data.muajSessionCount} Muaj Session${data.muajSessionCount !== 1 ? 's' : ''}`;
                    }
                    const btnMuajLogout = document.getElementById('btnMuajLogoutOther');
                    if (btnMuajLogout && typeof data.muajSessionCount === 'number') {
                        btnMuajLogout.disabled = (data.muajSessionCount <= 1);
                    }

                    // Update Total Sessions Counter
                    const sessCountEl = document.getElementById('detailedSessionsCount');
                    if (sessCountEl && typeof data.totalSessionCount === 'number') {
                        sessCountEl.textContent = data.totalSessionCount;
                    }

                    // Update Detailed Sessions Table & Cards (if available)
                    if (Array.isArray(data.detailedSessions)) {
                        function escHtml(str) {
                            if (!str) return '';
                            return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
                        }
                        const tableBody = document.getElementById('sessionsTableBody');
                        const mobileList = document.getElementById('sessionsMobileList');
                        const currentCsrf = document.querySelector('meta[name="csrf-token"]')?.content || '';

                        if (tableBody) {
                            if (data.detailedSessions.length === 0) {
                                tableBody.innerHTML = '<tr><td colspan="7" class="empty-sessions-cell">কোনো সক্রিয় সেশন পাওয়া যায়নি।</td></tr>';
                            } else {
                                tableBody.innerHTML = data.detailedSessions.map(s => {
                                    const isMuajUser = (s.user === 'muaj');
                                    const userBadge = isMuajUser 
                                        ? '<span class="session-user-pill pill-muaj"><span class="user-role-icon">👑</span> Muaj (Admin)</span>'
                                        : '<span class="session-user-pill pill-hajera"><span class="user-role-icon">💖</span> Hajera (Viewer)</span>';
                                    const currentTag = s.isCurrent 
                                        ? '<span class="session-current-badge"><span class="live-dot-pulse"></span> This Device (Active)</span>' 
                                        : '<span class="session-other-badge">Connected Device</span>';
                                    const lastActiveFmt = s.lastActive ? formatRelTimeHelper(s.lastActive) : 'Just now';
                                    const loginTimeFmt = s.loginTime ? new Date(parseSqliteDateHelper(s.loginTime)).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : '-';
                                    const shortSid = s.sid ? s.sid.substring(0, 10) + '...' : '-';
                                    const devIcon = (s.device && (s.device.toLowerCase().includes('android') || s.device.toLowerCase().includes('iphone'))) ? '📱' : '💻';

                                    return `
                                        <tr class="session-row ${s.isCurrent ? 'is-current-session' : ''}" id="session-row-${escHtml(s.sid)}">
                                            <td>${userBadge}</td>
                                            <td>
                                                <div class="session-device-cell">
                                                    <span class="device-icon">${devIcon}</span>
                                                    <div class="device-meta">
                                                        <span class="device-name">${escHtml(s.device || 'Web Browser')}</span>
                                                        <span class="device-sid" title="Session ID: ${escHtml(s.sid)}">${escHtml(shortSid)}</span>
                                                    </div>
                                                </div>
                                            </td>
                                            <td><code class="session-ip-code">${escHtml(s.ip || '—')}</code></td>
                                            <td><span class="session-time">${loginTimeFmt}</span></td>
                                            <td><span class="session-active-time">⏱️ ${lastActiveFmt}</span></td>
                                            <td>${currentTag}</td>
                                            <td class="session-actions-cell">
                                                <form action="/admin/sessions/destroy/${encodeURIComponent(s.sid)}" method="POST" data-confirm="${s.isCurrent ? '⚠️ এটি আপনার বর্তমান সেশন! এটি বন্ধ করলে আপনি এখনই লগআউট হয়ে যাবেন। চালিয়ে যেতে চান?' : 'এই ডিভাইসটির সেশন বন্ধ (Force Logout) করতে চান?'}">
                                                    <input type="hidden" name="_csrf" value="${currentCsrf}">
                                                    <button type="submit" class="btn-terminate-session ${s.isCurrent ? 'btn-terminate-self' : ''}" title="${s.isCurrent ? 'Logout This Device' : 'Force Logout This Device'}">
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14">
                                                            <line x1="18" y1="6" x2="6" y2="18"/>
                                                            <line x1="6" y1="6" x2="18" y2="18"/>
                                                        </svg>
                                                        <span>${s.isCurrent ? 'Logout Self' : 'Terminate'}</span>
                                                    </button>
                                                </form>
                                            </td>
                                        </tr>
                                    `;
                                }).join('');
                            }
                        }

                        if (mobileList) {
                            if (data.detailedSessions.length === 0) {
                                mobileList.innerHTML = '<div class="empty-sessions-card"><p>কোনো সক্রিয় সেশন পাওয়া যায়নি।</p></div>';
                            } else {
                                mobileList.innerHTML = data.detailedSessions.map(s => {
                                    const isMuajUser = (s.user === 'muaj');
                                    const userBadge = isMuajUser 
                                        ? '<span class="session-user-pill pill-muaj"><span class="user-role-icon">👑</span> Muaj (Admin)</span>'
                                        : '<span class="session-user-pill pill-hajera"><span class="user-role-icon">💖</span> Hajera (Viewer)</span>';
                                    const currentTag = s.isCurrent 
                                        ? '<span class="session-current-badge"><span class="live-dot-pulse"></span> This Device</span>' 
                                        : '<span class="session-other-badge">Connected</span>';
                                    const lastActiveFmt = s.lastActive ? formatRelTimeHelper(s.lastActive) : 'Just now';
                                    const loginTimeFmt = s.loginTime ? new Date(parseSqliteDateHelper(s.loginTime)).toLocaleTimeString('bn-BD', { hour: '2-digit', minute: '2-digit' }) : '-';

                                    return `
                                        <div class="session-mobile-card ${s.isCurrent ? 'is-current-card' : ''}" id="session-card-${escHtml(s.sid)}">
                                            <div class="session-card-top">
                                                <div class="session-card-user-info">
                                                    ${userBadge}
                                                    ${currentTag}
                                                </div>
                                                <form action="/admin/sessions/destroy/${encodeURIComponent(s.sid)}" method="POST" data-confirm="${s.isCurrent ? '⚠️ এটি আপনার বর্তমান সেশন! আপনি লগআউট হয়ে যাবেন।' : 'এই ডিভাইসটির সেশন বন্ধ করতে চান?'}">
                                                    <input type="hidden" name="_csrf" value="${currentCsrf}">
                                                    <button type="submit" class="btn-terminate-session btn-sm ${s.isCurrent ? 'btn-terminate-self' : ''}" title="Terminate Session">
                                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="13" height="13">
                                                            <line x1="18" y1="6" x2="6" y2="18"/>
                                                            <line x1="6" y1="6" x2="18" y2="18"/>
                                                        </svg>
                                                        <span>${s.isCurrent ? 'Logout' : 'Kill'}</span>
                                                    </button>
                                                </form>
                                            </div>
                                            <div class="session-card-body">
                                                <div class="session-card-detail-row">
                                                    <span class="session-detail-lbl">📱 Device:</span>
                                                    <strong class="session-detail-val">${escHtml(s.device || 'Web Browser')}</strong>
                                                </div>
                                                <div class="session-card-detail-row">
                                                    <span class="session-detail-lbl">🌐 IP Address:</span>
                                                    <code class="session-detail-ip">${escHtml(s.ip || '—')}</code>
                                                </div>
                                                <div class="session-card-detail-row">
                                                    <span class="session-detail-lbl">⏱️ Last Active:</span>
                                                    <span class="session-detail-val">${lastActiveFmt} (${loginTimeFmt})</span>
                                                </div>
                                            </div>
                                        </div>
                                    `;
                                }).join('');
                            }
                        }
                    }

                    // Update Timeline List & Count
                    if (Array.isArray(data.activityTimeline)) {
                        const countEl = document.getElementById('hajeraTimelineCount');
                        if (countEl) countEl.textContent = data.activityTimeline.length;

                        const timelineList = document.getElementById('hajeraTimelineList');
                        if (timelineList && data.activityTimeline.length > 0) {
                            timelineList.innerHTML = data.activityTimeline.map(act => {
                                let icon = '📌';
                                let actionLabel = act.action;
                                let actClass = 'act-generic';
                                switch (act.action) {
                                    case 'login': icon = '🔑'; actionLabel = 'Logged In'; actClass = 'act-login'; break;
                                    case 'logout': icon = '🚪'; actionLabel = 'Logged Out'; actClass = 'act-logout'; break;
                                    case 'watch_start': icon = '▶️'; actionLabel = 'Started Watching'; actClass = 'act-play'; break;
                                    case 'watch_pause': icon = '⏸️'; actionLabel = 'Paused Video'; actClass = 'act-pause'; break;
                                    case 'watch_resume': icon = '🔁'; actionLabel = 'Resumed Video'; actClass = 'act-play'; break;
                                    case 'watch_complete': icon = '🏆'; actionLabel = 'Completed Video'; actClass = 'act-complete'; break;
                                    case 'comment_added': icon = '💬'; actionLabel = 'Added Comment'; actClass = 'act-comment'; break;
                                    case 'went_idle': icon = '💤'; actionLabel = 'Went Away / Idle'; actClass = 'act-idle'; break;
                                    case 'came_online': icon = '⚡'; actionLabel = 'Active On Screen'; actClass = 'act-online'; break;
                                    case 'went_offline': icon = '🔴'; actionLabel = 'Left / Closed Tab'; actClass = 'act-offline'; break;
                                }

                                const videoLink = act.video_id
                                    ? `<a href="/watch/${encodeURIComponent(act.video_id)}" class="timeline-video-link">${act.video_title || 'Watch Video'}</a>`
                                    : '';

                                const detailsText = act.details ? `<span class="timeline-details">${act.details}</span>` : '';
                                const timeText = formatRelTimeHelper(act.created_at);

                                return `
                                    <div class="timeline-entry ${actClass}">
                                        <div class="timeline-icon-wrap">${icon}</div>
                                        <div class="timeline-content">
                                            <div class="timeline-head">
                                                <span class="timeline-action">${actionLabel}</span>
                                                <span class="timeline-time">${timeText}</span>
                                            </div>
                                            ${videoLink}
                                            ${detailsText}
                                            ${act.device_info ? `<span class="timeline-device">${act.device_info}</span>` : ''}
                                        </div>
                                    </div>
                                `;
                            }).join('');
                        }
                    }
                })
                .catch(() => {});
        }

        // Start initial adaptive jitter poll
        if (window.hajeraLiveInterval) clearInterval(window.hajeraLiveInterval);
        scheduleNextHajeraPoll(true);
        } // End of Hajera 'if' block

        // ========================================
        // VPS Telemetry & Real-Time Resource Polling
        // ========================================
        function pollVpsMetrics() {
            if (window.location.pathname !== '/admin' || document.hidden) return;
            const vpsCard = document.getElementById('vpsMonitorCard');
            if (!vpsCard) return;

            fetch('/admin/system/live-metrics', { credentials: 'same-origin' })
                .then(r => r.json())
                .then(sys => {
                    if (!sys) return;

                    // CPU
                    const cpuPctEl = document.getElementById('vpsCpuPct');
                    const cpuBarEl = document.getElementById('vpsCpuBar');
                    const cpuBoxEl = document.querySelector('.metric-cpu');
                    const loadAvgEl = document.getElementById('vpsLoadAvg');
                    if (cpuPctEl) cpuPctEl.textContent = `${sys.cpu.usagePercent}%`;
                    if (cpuBarEl) cpuBarEl.style.width = `${sys.cpu.usagePercent}%`;
                    if (loadAvgEl && sys.cpu.loadAvg) loadAvgEl.textContent = sys.cpu.loadAvg.join(' • ');

                    if (cpuBoxEl) {
                        cpuBoxEl.classList.remove('status-good', 'status-warn', 'status-critical');
                        if (sys.cpu.usagePercent > 85) cpuBoxEl.classList.add('status-critical');
                        else if (sys.cpu.usagePercent > 65) cpuBoxEl.classList.add('status-warn');
                        else cpuBoxEl.classList.add('status-good');
                    }

                    // RAM
                    const ramPctEl = document.getElementById('vpsRamPct');
                    const ramBarEl = document.getElementById('vpsRamBar');
                    const ramBoxEl = document.querySelector('.metric-ram');
                    const ramUsedEl = document.getElementById('vpsRamUsed');
                    const ramFreeEl = document.getElementById('vpsRamFree');
                    const nodeRssEl = document.getElementById('vpsNodeRss');
                    if (ramPctEl) ramPctEl.textContent = `${sys.ram.usagePercent}%`;
                    if (ramBarEl) ramBarEl.style.width = `${sys.ram.usagePercent}%`;
                    if (ramUsedEl) ramUsedEl.textContent = sys.ram.usedFormatted;
                    if (ramFreeEl) ramFreeEl.textContent = `${sys.ram.freeFormatted} Free of ${sys.ram.totalFormatted}`;
                    if (nodeRssEl && sys.process) nodeRssEl.textContent = `${sys.process.rssMb} MB`;

                    if (ramBoxEl) {
                        ramBoxEl.classList.remove('status-good', 'status-warn', 'status-critical');
                        if (sys.ram.usagePercent > 85) ramBoxEl.classList.add('status-critical');
                        else if (sys.ram.usagePercent > 70) ramBoxEl.classList.add('status-warn');
                        else ramBoxEl.classList.add('status-good');
                    }

                    // Disk
                    const diskPctEl = document.getElementById('vpsDiskPct');
                    const diskBarEl = document.getElementById('vpsDiskBar');
                    const diskBoxEl = document.querySelector('.metric-disk');
                    const diskUsedEl = document.getElementById('vpsDiskUsed');
                    const diskFreeEl = document.getElementById('vpsDiskFree');
                    if (diskPctEl) diskPctEl.textContent = `${sys.disk.usagePercent}%`;
                    if (diskBarEl) diskBarEl.style.width = `${sys.disk.usagePercent}%`;
                    if (diskUsedEl) diskUsedEl.textContent = sys.disk.usedFormatted;
                    if (diskFreeEl) diskFreeEl.textContent = `${sys.disk.freeFormatted} Free of ${sys.disk.totalFormatted}`;

                    if (diskBoxEl) {
                        diskBoxEl.classList.remove('status-good', 'status-warn', 'status-critical');
                        if (sys.disk.usagePercent > 90) diskBoxEl.classList.add('status-critical');
                        else if (sys.disk.usagePercent > 75) diskBoxEl.classList.add('status-warn');
                        else diskBoxEl.classList.add('status-good');
                    }

                    // Network Bandwidth / Internet Traffic
                    if (sys.network) {
                        const netTotalEl = document.getElementById('vpsNetTotal');
                        const netBarEl = document.getElementById('vpsNetBar');
                        const netTxEl = document.getElementById('vpsNetTx');
                        const netRxEl = document.getElementById('vpsNetRx');
                        const netBoxEl = document.querySelector('.metric-network');

                        if (netTotalEl) netTotalEl.textContent = sys.network.totalFormatted;
                        if (netBarEl) netBarEl.style.width = `${Math.max(2, sys.network.usagePercent)}%`;
                        if (netTxEl) netTxEl.textContent = sys.network.txFormatted;
                        if (netRxEl) netRxEl.textContent = sys.network.rxFormatted;

                        if (netBoxEl) {
                            netBoxEl.classList.remove('status-good', 'status-warn', 'status-critical');
                            if (sys.network.usagePercent > 90) netBoxEl.classList.add('status-critical');
                            else if (sys.network.usagePercent > 75) netBoxEl.classList.add('status-warn');
                            else netBoxEl.classList.add('status-good');
                        }
                    }

                    // Runtime
                    const runtimeNameEl = document.getElementById('vpsRuntimeName');
                    const nodeVerEl = document.getElementById('vpsNodeVer');
                    const srvUptimeEl = document.getElementById('vpsServerUptime');
                    const appUptimeEl = document.getElementById('vpsAppUptime');
                    const heapUsedEl = document.getElementById('vpsHeapUsed');
                    const heapTotalEl = document.getElementById('vpsHeapTotal');
                    if (runtimeNameEl && sys.process && sys.process.runtimeName) runtimeNameEl.textContent = sys.process.runtimeName;
                    if (nodeVerEl && sys.process && sys.process.nodeVersion) nodeVerEl.textContent = sys.process.nodeVersion;
                    if (srvUptimeEl && sys.os) srvUptimeEl.textContent = sys.os.uptimeFormatted;
                    if (appUptimeEl && sys.process) appUptimeEl.textContent = `App Up: ${sys.process.uptimeFormatted}`;
                    if (heapUsedEl && sys.process) heapUsedEl.textContent = `${sys.process.heapUsedMb} MB`;
                    if (heapTotalEl && sys.process) heapTotalEl.textContent = `${sys.process.heapTotalMb} MB`;

                    // Overall System Health Status
                    const healthPill = document.getElementById('vpsHealthPill');
                    const healthText = document.getElementById('vpsHealthText');
                    if (healthPill && healthText) {
                        healthPill.className = 'vps-status-pill';
                        if (sys.cpu.usagePercent > 85 || sys.ram.usagePercent > 90 || sys.disk.usagePercent > 92) {
                            healthPill.classList.add('pill-critical');
                            healthText.textContent = 'High Load / Warning';
                        } else if (sys.cpu.usagePercent > 65 || sys.ram.usagePercent > 75) {
                            healthPill.classList.add('pill-warn');
                            healthText.textContent = 'Elevated Load';
                        } else {
                            healthPill.classList.add('pill-optimal');
                            healthText.textContent = 'System Healthy';
                        }
                    }
                })
                .catch(() => {});
        }

        // Start VPS live polling if on admin page
        if (document.getElementById('vpsHealthPill') || document.getElementById('vpsCpuBar')) {
            if (vpsPollingInterval) clearInterval(vpsPollingInterval);
            vpsPollingInterval = setInterval(pollVpsMetrics, 10000);
        }

        // ============================================================
        // Cloudflare R2 & VPS Storage Tracker Live Sync Engine
        // ============================================================
        const r2EventSources = {};
        // Polling-fallback timers, keyed by video id, used when the SSE stream
        // is unavailable or gets cut by an intermediate proxy.
        const r2PollTimers = {};

        function attachR2ProgressListener(videoId, filename, totalSize) {
            if (r2EventSources[videoId]) {
                try { r2EventSources[videoId].close(); } catch(e){}
            }
            if (r2PollTimers[videoId]) {
                clearInterval(r2PollTimers[videoId]);
                delete r2PollTimers[videoId];
            }

            const actionCell = document.getElementById('r2Action_' + videoId);
            const pillCell = document.getElementById('r2Pill_' + videoId);
            const rowEl = document.getElementById('r2Row_' + videoId);

            if (!actionCell) return;

            actionCell.innerHTML = `
                <div class="r2-android-progress-box" id="r2SyncBox_${videoId}">
                    <div class="r2-prog-top">
                        <span class="r2-prog-status"><span class="r2-pulse-dot"></span> Uploading to R2...</span>
                        <span class="r2-prog-pct" id="r2Pct_${videoId}">0%</span>
                    </div>
                    <div class="r2-prog-track">
                        <div class="r2-prog-fill" id="r2Bar_${videoId}" style="width: 0%;"></div>
                    </div>
                    <div class="r2-prog-bottom">
                        <span class="r2-prog-bytes" id="r2Bytes_${videoId}">0 MB</span>
                        <span class="r2-prog-speed" id="r2Speed_${videoId}">Connecting...</span>
                        <span class="r2-prog-eta" id="r2Eta_${videoId}"></span>
                    </div>
                </div>
            `;

            function updateUI(data) {
                if (!data) return;
                const pct = Math.min(100, Math.max(0, data.percent || 0));
                const bar = document.getElementById('r2Bar_' + videoId);
                const pctEl = document.getElementById('r2Pct_' + videoId);
                const bytesEl = document.getElementById('r2Bytes_' + videoId);
                const speedEl = document.getElementById('r2Speed_' + videoId);
                const etaEl = document.getElementById('r2Eta_' + videoId);

                if (bar) bar.style.width = pct + '%';
                if (pctEl) pctEl.textContent = pct + '%';
                if (bytesEl) {
                    if (data.loaded && data.total) {
                        bytesEl.textContent = (data.loaded / 1024 / 1024).toFixed(1) + ' / ' + (data.total / 1024 / 1024).toFixed(1) + ' MB';
                    } else if (totalSize) {
                        bytesEl.textContent = ((pct / 100) * (totalSize / 1024 / 1024)).toFixed(1) + ' / ' + (totalSize / 1024 / 1024).toFixed(1) + ' MB';
                    }
                }
                if (speedEl && data.speed) speedEl.textContent = data.speed;
                if (etaEl && data.eta) etaEl.textContent = data.eta;

                // Every pre-transfer / post-transfer phase gets an explicit label.
                // Otherwise the box keeps the initial "Connecting..." text while
                // the server is busy remuxing or waiting on a retry backoff,
                // which reads as a frozen 0% bar.
                if (data.status === 'queued') {
                    if (speedEl) speedEl.textContent = 'Queued';
                    if (etaEl) etaEl.textContent = data.eta || 'Waiting for a transfer slot...';
                } else if (data.status === 'preparing' || data.status === 'starting') {
                    if (speedEl) speedEl.textContent = 'Preparing';
                    if (etaEl) etaEl.textContent = data.eta || 'Preparing transfer...';
                } else if (data.status === 'optimizing') {
                    if (speedEl) speedEl.textContent = 'Optimizing';
                    if (etaEl) etaEl.textContent = data.eta || 'Preparing for instant playback...';
                } else if (data.status === 'retrying') {
                    if (speedEl) speedEl.textContent = 'Retrying';
                    if (etaEl) etaEl.textContent = data.eta || 'Waiting before retry...';
                } else if (data.status === 'uploading' && !data.loaded) {
                    if (speedEl) speedEl.textContent = 'Starting';
                    if (etaEl) etaEl.textContent = data.eta || 'Starting transfer to R2...';
                } else if (data.status === 'finalizing') {
                    if (speedEl) speedEl.textContent = 'Finalizing';
                    if (etaEl) etaEl.textContent = data.eta || 'Finalizing with R2...';
                }

                if (data.status === 'done' || pct >= 100) {
                    if (r2EventSources[videoId]) {
                        try { r2EventSources[videoId].close(); } catch(e){}
                        delete r2EventSources[videoId];
                    }
                    if (r2PollTimers[videoId]) {
                        clearInterval(r2PollTimers[videoId]);
                        delete r2PollTimers[videoId];
                    }
                    if (actionCell) {
                        actionCell.innerHTML = `
                            <div class="r2-synced-pill glow-emerald">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
                                <span>Synced on Cloudflare Edge CDN</span>
                            </div>
                        `;
                    }
                    if (pillCell) {
                        pillCell.className = 'r2-mini-chip chip-r2';
                        pillCell.innerHTML = '⚡ Cloudflare R2';
                    }
                    if (rowEl) {
                        rowEl.classList.remove('is-pending');
                        rowEl.classList.add('is-synced');
                    }
                    refreshR2DashboardStats();
                } else if (data.status === 'error') {
                    if (r2EventSources[videoId]) {
                        try { r2EventSources[videoId].close(); } catch(e){}
                        delete r2EventSources[videoId];
                    }
                    if (r2PollTimers[videoId]) {
                        clearInterval(r2PollTimers[videoId]);
                        delete r2PollTimers[videoId];
                    }
                    if (actionCell) {
                        actionCell.innerHTML = `
                            <button type="button" class="btn-android-sync-r2" onclick="syncSingleVideo('${videoId}', '${filename}', ${totalSize}, this)">
                                ⚠️ Retry Sync
                            </button>
                        `;
                    }
                }
            }

            const es = new EventSource('/api/r2-progress/' + encodeURIComponent(filename));
            r2EventSources[videoId] = es;

            es.onmessage = function(e) {
                try {
                    const data = JSON.parse(e.data);
                    updateUI(data);
                } catch(err){}
            };

            // If the SSE stream dies (or is swallowed by an intermediate proxy
            // that buffers text/event-stream), fall back to *repeated* polling.
            // The old handler polled a single time and then gave up, which left
            // the progress box frozen on whatever frame it had last received.
            function pollOnce() {
                return fetch('/admin/r2/live-status')
                    .then(r => r.json())
                    .then(data => {
                        if (!data) return false;
                        if (Array.isArray(data.activeUploads)) {
                            const u = data.activeUploads.find(x => x.filename === filename);
                            if (u) {
                                updateUI(u);
                                return u.status === 'done' || u.status === 'error';
                            }
                        }
                        if (Array.isArray(data.videos)) {
                            const v = data.videos.find(x => x.id === videoId || x.filename === filename);
                            if (v && (v.onR2 || v.cdn_status === 'r2_ready' || v.cdn_status === 'r2_only')) {
                                updateUI({ filename, percent: 100, status: 'done' });
                                return true;
                            }
                        }
                        return false;
                    })
                    .catch(() => false);
            }

            function startPollingFallback() {
                if (r2PollTimers[videoId]) return;
                r2PollTimers[videoId] = setInterval(() => {
                    pollOnce().then((finished) => {
                        if (finished) {
                            clearInterval(r2PollTimers[videoId]);
                            delete r2PollTimers[videoId];
                        }
                    });
                }, 3000);
            }

            es.onerror = function() {
                try { es.close(); } catch (e) {}
                delete r2EventSources[videoId];
                pollOnce().then((finished) => {
                    if (!finished) startPollingFallback();
                });
            };
        }

        window.syncSingleVideo = async function(videoId, filename, totalSize, btn) {
            if (btn) btn.disabled = true;
            try {
                const res = await fetch('/admin/r2/sync-video/' + encodeURIComponent(videoId), {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json',
                        'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || ''
                    }
                });
                if (!res.ok) throw new Error('Server error: ' + res.status);
                const data = await res.json();
                if (data.success) {
                    if (data.alreadySynced || data.onR2) {
                        const actionCell = document.getElementById('r2Action_' + videoId);
                        const pillCell = document.getElementById('r2Pill_' + videoId);
                        const rowEl = document.getElementById('r2Row_' + videoId);
                        if (actionCell) {
                            actionCell.innerHTML = `
                                <div class="r2-synced-pill glow-emerald">
                                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>
                                    <span>Synced on Cloudflare Edge CDN</span>
                                </div>
                            `;
                        }
                        if (pillCell) {
                            pillCell.className = 'r2-mini-chip chip-r2';
                            pillCell.innerHTML = '⚡ Cloudflare R2';
                        }
                        if (rowEl) {
                            rowEl.classList.remove('is-pending');
                            rowEl.classList.add('is-synced');
                        }
                        if (typeof refreshR2DashboardStats === 'function') refreshR2DashboardStats();
                        return;
                    }
                    attachR2ProgressListener(videoId, filename, totalSize);
                } else {
                    alert('Sync failed: ' + (data.error || 'Unknown error'));
                    if (btn) btn.disabled = false;
                }
            } catch (e) {
                alert('Network error while starting sync.');
                if (btn) btn.disabled = false;
            }
        };

        window.syncAllR2 = async function(btn) {
            if (!confirm('Start background sync for all unsynced videos to Cloudflare R2?')) return;
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span>⚡ Syncing in Background...</span>';
            }
            try {
                const res = await fetch('/admin/r2/sync-all', {
                    method: 'POST',
                    headers: {
                        'X-Requested-With': 'XMLHttpRequest',
                        'Accept': 'application/json',
                        'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || ''
                    }
                });
                if (!res.ok) throw new Error('Server error: ' + res.status);
                const data = await res.json();
                if (data.success) {
                    const pendingRows = document.querySelectorAll('.r2-row.is-pending');
                    pendingRows.forEach(row => {
                        const vid = row.getAttribute('data-video-id');
                        const fn = row.getAttribute('data-filename');
                        const sz = Number(row.getAttribute('data-size') || 0);
                        if (vid && fn) {
                            attachR2ProgressListener(vid, fn, sz);
                        }
                    });
                } else {
                    alert('Sync failed: ' + (data.error || 'Unknown error'));
                    if (btn) btn.disabled = false;
                }
            } catch (e) {
                alert('Network error while starting R2 sync.');
                if (btn) btn.disabled = false;
            }
        };

        // Mirrors formatDataSize() in routes/admin.js so live-refreshed values
        // render identically to the server-rendered ones.
        function formatBytesClient(bytes) {
            const b = Number(bytes || 0);
            if (b >= 1024 ** 4) return (b / (1024 ** 4)).toFixed(2) + ' TB';
            if (b >= 1024 ** 3) return (b / (1024 ** 3)).toFixed(2) + ' GB';
            if (b >= 1024 ** 2) return (b / (1024 ** 2)).toFixed(1) + ' MB';
            if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
            return b + ' B';
        }

        function refreshR2DashboardStats() {
            fetch('/admin/r2/live-status')
                .then(r => r.json())
                .then(data => {
                    if (!data || !data.r2Stats) return;
                    const s = data.r2Stats;
                    const r2Text = document.getElementById('r2VideoCountText');
                    if (r2Text) r2Text.textContent = `${s.r2Count} / ${s.totalVideos}`;

                    const r2Pcts = document.querySelectorAll('.r2-tile-pct');
                    if (r2Pcts[0]) r2Pcts[0].textContent = `${s.r2Percent}% Synced`;

                    const r2Bar = document.querySelector('.r2-progress-fill');
                    if (r2Bar) r2Bar.style.width = `${s.r2Percent}%`;

                    const warnCount = document.querySelector('.r2-tile-count.color-warn, .r2-tile-count.color-ok');
                    if (warnCount) {
                        warnCount.textContent = s.unsyncedCount;
                        if (s.unsyncedCount === 0) {
                            warnCount.className = 'r2-tile-count color-ok';
                        }
                    }

                    // Real bytes stored on R2, straight from the bucket inventory.
                    const cdnSize = document.getElementById('r2CdnSizeText');
                    if (cdnSize && typeof s.r2TotalBytes === 'number') {
                        cdnSize.textContent = formatBytesClient(s.r2TotalBytes);
                    }

                    // Real measured VPS/client -> R2 transfer total.
                    if (data.transferStats) {
                        const xfer = document.getElementById('r2TransferredText');
                        if (xfer && data.transferStats.totalFormatted) {
                            xfer.textContent = data.transferStats.totalFormatted;
                        }
                    }
                })
                .catch(() => {});
        }

        // --- 1-Click Cloudflare Edge Cache Purge ---
        window.purgeEdgeCache = async function(btn) {
            if (!confirm('Cloudflare Global Edge Cache সম্পূর্ণ Purge (ক্লিয়ার) করতে চাও?')) return;
            const originalHtml = btn ? btn.innerHTML : '';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span>🧹 Purging Edge Cache...</span>';
            }
            try {
                const res = await fetch('/admin/cf/purge-cache', {
                    method: 'POST',
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json', 'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '' }
                });
                if (!res.ok) throw new Error('Server error: ' + res.status);
                const data = await res.json();
                if (data.success) {
                    alert('✅ ' + (data.message || 'Cloudflare edge cache purged successfully!'));
                } else {
                    alert('⚠️ ' + (data.error || 'Failed to purge edge cache.'));
                }
            } catch (err) {
                alert('Network error while purging edge cache: ' + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                }
            }
        };

        // --- Live R2 Bucket Inventory & Orphan Scanner ---
        window.scanR2Bucket = async function(btn) {
            const resultsBox = document.getElementById('r2ScanResultsBox');
            const originalHtml = btn ? btn.innerHTML : '';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span>🔍 Scanning R2 Bucket...</span>';
            }
            if (resultsBox) {
                resultsBox.style.display = 'block';
                resultsBox.innerHTML = '<div style="display:flex; align-items:center; gap:8px; color:var(--text-muted); font-size:13px;"><span class="spinner-inline"></span> Cloudflare R2 বাকেটের সমস্ত ফাইল স্ক্যান হচ্ছে...</div>';
            }

            try {
                const res = await fetch('/admin/r2/scan-bucket', {
                    method: 'POST',
                    headers: { 'X-Requested-With': 'XMLHttpRequest', 'Accept': 'application/json', 'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '' }
                });
                if (!res.ok) throw new Error('Server error: ' + res.status);
                const data = await res.json();
                if (!data.success) {
                    if (resultsBox) resultsBox.innerHTML = `<div style="color:#ef4444; font-size:13px;">❌ স্ক্যান ব্যর্থ: ${data.error || 'Unknown error'}</div>`;
                    return;
                }

                let html = `
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-wrap:wrap; gap:8px;">
                        <div>
                            <strong style="color:var(--text-primary); font-size:14px;">Cloudflare R2 Bucket Live Inventory</strong>
                            <div style="font-size:12px; color:var(--text-muted); margin-top:2px;">
                                মোট অবজেক্ট: <strong>${data.totalObjects}</strong> • মোট সাইজ: <strong>${data.totalBytesFormatted}</strong> • স্ক্যান সোর্স: <code>${data.source}</code>
                            </div>
                        </div>
                        <button type="button" class="btn btn-secondary btn-sm" onclick="document.getElementById('r2ScanResultsBox').style.display='none'" style="font-size:11px; padding:3px 8px;">✕ বন্ধ</button>
                    </div>
                `;

                if (data.orphanCount > 0) {
                    const orphanKeysJson = JSON.stringify(data.orphans.map(o => o.key)).replace(/"/g, '&quot;');
                    html += `
                        <div style="background:rgba(239, 68, 68, 0.08); border:1px solid rgba(239, 68, 68, 0.25); border-radius:8px; padding:12px; margin-top:8px;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:8px;">
                                <span style="color:#ef4444; font-weight:600; font-size:13px;">⚠️ ${data.orphanCount}টি Orphan ফাইল পাওয়া গেছে (ডাটাবেজে নেই কিন্তু R2-তে জমে আছে)</span>
                                <button type="button" class="btn btn-danger btn-sm" onclick="cleanR2Orphans(this, ${orphanKeysJson})" style="font-size:11px; padding:4px 10px;">
                                    🗑️ সমস্ত Orphan (${data.orphanCount}) ডিলিট করো
                                </button>
                            </div>
                            <div style="max-height:160px; overflow-y:auto; font-size:12px;">
                                ${data.orphans.map(o => `
                                    <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid rgba(255,255,255,0.05); color:var(--text-secondary);">
                                        <code style="color:var(--text-primary);">${o.key}</code>
                                        <span>${o.sizeFormatted}</span>
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                    `;
                } else {
                    html += `
                        <div style="background:rgba(34, 197, 94, 0.08); border:1px solid rgba(34, 197, 94, 0.25); border-radius:8px; padding:10px 14px; margin-top:8px; color:#22c55e; font-size:13px; font-weight:600;">
                            ✓ ০টি Orphan ফাইল • R2 বাকেট ডাটাবেজের সাথে ১০০% সিঙ্ক ও সম্পূর্ণ ক্লিন!
                        </div>
                    `;
                }

                if (resultsBox) resultsBox.innerHTML = html;
            } catch (err) {
                if (resultsBox) resultsBox.innerHTML = `<div style="color:#ef4444; font-size:13px;">❌ নেটওয়ার্ক এরর: ${err.message}</div>`;
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                }
            }
        };

        // --- Batch Delete Orphan Files from R2 ---
        window.cleanR2Orphans = async function(btn, keys) {
            if (!Array.isArray(keys) || keys.length === 0) return;
            if (!confirm(`R2 থেকে ${keys.length}টি orphan ফাইল স্থায়ীভাবে ডিলিট করতে চাও?`)) return;

            const originalHtml = btn ? btn.innerHTML : '';
            if (btn) {
                btn.disabled = true;
                btn.innerHTML = '<span>🗑️ Deleting...</span>';
            }

            try {
                const res = await fetch('/admin/r2/clean-orphans', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', 'x-csrf-token': document.querySelector('meta[name="csrf-token"]')?.content || '' },
                    body: JSON.stringify({ keys })
                });
                if (!res.ok) throw new Error('Server error: ' + res.status);
                const data = await res.json();
                if (data.success) {
                    alert(`✅ ${data.deletedCount}টি orphan ফাইল R2 বাকেট থেকে সফলভাবে মুছে ফেলা হয়েছে!`);
                    const scanBtn = document.getElementById('btnR2ScanBucket');
                    if (scanBtn) scanR2Bucket(scanBtn);
                } else {
                    alert('⚠️ ডিলিট ব্যর্থ: ' + (data.error || 'Unknown error'));
                }
            } catch (err) {
                alert('নেটওয়ার্ক এরর: ' + err.message);
            } finally {
                if (btn) {
                    btn.disabled = false;
                    btn.innerHTML = originalHtml;
                }
            }
        };

        // Live monitor active uploads on admin page every 4s
        if (document.getElementById('r2StorageHub')) {
            if (window.r2LiveInterval) clearInterval(window.r2LiveInterval);
            window.r2LiveInterval = setInterval(() => {
                if (window.location.pathname !== '/admin' || document.hidden) return;
                fetch('/admin/r2/live-status')
                    .then(r => r.json())
                    .then(data => {
                        if (!data || !Array.isArray(data.activeUploads)) return;
                        data.activeUploads.forEach(u => {
                            const row = document.querySelector(`[data-filename="${u.filename}"]`);
                            if (row) {
                                const vid = row.getAttribute('data-video-id');
                                if (vid && !r2EventSources[vid] && u.status === 'uploading') {
                                    attachR2ProgressListener(vid, u.filename, u.total);
                                }
                            }
                        });
                    })
                    .catch(() => {});
            }, 4000);
        }

        // --- Lazy-load suggestion thumbnails via IntersectionObserver ---
        initLazyThumbs();
    } // End initPageModules

    function initLazyThumbs() {
        const lazyImages = document.querySelectorAll('img.lazy-thumb[data-src]');
        if (!lazyImages.length) return;

        if ('IntersectionObserver' in window) {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach(entry => {
                    if (entry.isIntersecting) {
                        const img = entry.target;
                        img.src = img.getAttribute('data-src');
                        img.removeAttribute('data-src');
                        img.classList.remove('lazy-thumb');
                        observer.unobserve(img);
                    }
                });
            }, { rootMargin: '200px' });

            lazyImages.forEach(img => observer.observe(img));
        } else {
            // Fallback: load all immediately if IntersectionObserver not supported
            lazyImages.forEach(img => {
                img.src = img.getAttribute('data-src');
                img.removeAttribute('data-src');
                img.classList.remove('lazy-thumb');
            });
        }
    }

    // Initialize SPA navigation engine & current page modules on startup
    initSpaNavigation();
    initPageModules();
    if (typeof syncActiveUiModeOption === 'function') syncActiveUiModeOption();
    if (typeof syncActiveThemeOption === 'function') syncActiveThemeOption();
    initLazyThumbs();
    if (typeof window.autoBindEmojiPickers === 'function') window.autoBindEmojiPickers(document);
    if (typeof window.applyWhatsAppEmojis === 'function') window.applyWhatsAppEmojis(document);

});
