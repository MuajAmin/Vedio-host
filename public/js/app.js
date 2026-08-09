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

    // ---- Initialize Plyr ----
    const playerElement = document.getElementById('player');
    if (playerElement && typeof Plyr !== 'undefined') {
        new Plyr(playerElement, {
            controls: [
                'play-large', 'play', 'progress', 'current-time',
                'duration', 'mute', 'volume', 'settings',
                'pip', 'fullscreen'
            ],
            settings: ['quality', 'speed'],
            speed: { selected: 1, options: [0.5, 0.75, 1, 1.25, 1.5, 2] },
            tooltips: { controls: true, seek: true },
            keyboard: { focused: true, global: true }
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
        card.style.animationDelay = `${index * 0.08}s`;
        card.classList.add('card-animate');
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

});
