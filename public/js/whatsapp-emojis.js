/**
 * VideoHost — Global WhatsApp / Apple Color Emoji System
 * Provides Apple 3D/HD emoji rendering, Twemoji fallback,
 * universal WhatsApp emoji picker popups, and auto-parsing across all pages.
 */
(function (window, document) {
    'use strict';

    const WA_APPLE_EMOJI_BASE = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/';
    const WA_TWEMOJI_FALLBACK_BASE = 'https://unpkg.com/twemoji@14.0.2/dist/svg/';

    const WA_EMOJI_CATEGORIES = {
        smileys: {
            name: 'Smileys & Emotion',
            icon: '😀',
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
            icon: '❤️',
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
            icon: '🍿',
            emojis: [
                '🍿','🎬','🎥','📽️','📺','📷','📸','📹','📼','🎧',
                '🎤','🎵','🎶','🎸','🎹','🥁','🎮','🕹️','🎲','🎯',
                '🎨','🎭','🎪','🎟️','🎫','🏆','🥇','🥈','🥉','⚽',
                '🏀','🏈','⚾','🎾','🏐','🎱','🏓','🏸','🎳','🥊'
            ]
        },
        party: {
            name: 'Party & Lifestyle',
            icon: '🔥',
            emojis: [
                '🍕','🍔','🍟','🌭','🍿','🍩','🍪','🎂','🍰','🍫',
                '🍬','🍭','☕','🍵','🧋','🍺','🍻','🥂','🍷','🍸',
                '🍹','🍾','🎁','🎉','🎊','🎈','🌹','🌸','🌺','🌻',
                '🌼','💐','🧸','👑','💎','⚡','🌟','💫','🌈','☀️'
            ]
        }
    };

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Converts a raw unicode emoji into Apple HD img tag with SVG fallback
     */
    function toAppleEmojiImg(rawEmoji) {
        if (!rawEmoji) return '';
        if (!window.twemoji || !window.twemoji.convert) {
            return escapeHtml(rawEmoji);
        }
        try {
            const code = window.twemoji.convert.toCodePoint(rawEmoji, '-');
            const codeNoFE0F = code.replace(/-fe0f/g, '');
            const appleUrl = `${WA_APPLE_EMOJI_BASE}${code}.png`;
            const fallbackUrl = `${WA_TWEMOJI_FALLBACK_BASE}${codeNoFE0F}.svg`;
            const safeEmoji = escapeHtml(rawEmoji);
            return `<img class="wa-emoji" draggable="false" alt="${safeEmoji}" data-code="${code}" src="${appleUrl}" loading="lazy" decoding="async" onerror="this.onerror=null;if(this.src!=='${fallbackUrl}'){this.src='${fallbackUrl}';}else{this.outerHTML='<span class=\\'wa-raw-emoji\\'>${safeEmoji}</span>';}" />`;
        } catch (e) {
            return escapeHtml(rawEmoji);
        }
    }

    /**
     * Replaces all emojis in a given text/HTML string with Apple HD images
     */
    function parseWhatsAppEmoji(str) {
        if (!str) return '';
        if (!window.twemoji || typeof window.twemoji.replace !== 'function') {
            return str;
        }
        try {
            return window.twemoji.replace(String(str), function (rawEmoji) {
                return toAppleEmojiImg(rawEmoji);
            });
        } catch (e) {
            return str;
        }
    }

    /**
     * Inserts an emoji at the current cursor position in an input or textarea
     */
    function insertEmojiAtCursor(targetInput, emoji) {
        if (!targetInput) return;
        const start = targetInput.selectionStart ?? targetInput.value.length;
        const end = targetInput.selectionEnd ?? targetInput.value.length;
        const val = targetInput.value;
        targetInput.value = val.substring(0, start) + emoji + val.substring(end);
        const newPos = start + emoji.length;
        targetInput.focus();
        if (typeof targetInput.setSelectionRange === 'function') {
            targetInput.setSelectionRange(newPos, newPos);
        }
        if (targetInput.tagName === 'TEXTAREA') {
            targetInput.style.height = 'auto';
            targetInput.style.height = Math.min(targetInput.scrollHeight, 140) + 'px';
        }
        targetInput.dispatchEvent(new Event('input', { bubbles: true }));
        targetInput.dispatchEvent(new Event('change', { bubbles: true }));
    }

    /**
     * Creates a reusable WhatsApp Emoji Picker DOM element
     */
    function createWhatsAppEmojiPicker(onSelect) {
        const picker = document.createElement('div');
        picker.className = 'wa-emoji-picker';
        picker.setAttribute('role', 'dialog');
        picker.setAttribute('aria-label', 'WhatsApp Emoji Picker');

        const tabsHtml = Object.keys(WA_EMOJI_CATEGORIES).map((key, idx) => {
            const cat = WA_EMOJI_CATEGORIES[key];
            const activeClass = idx === 0 ? ' active' : '';
            return `<button type="button" class="wa-tab-btn${activeClass}" data-cat="${key}" title="${escapeHtml(cat.name)}">
                <span>${toAppleEmojiImg(cat.icon)}</span>
            </button>`;
        }).join('');

        picker.innerHTML = `
            <div class="wa-picker-header">
                <div class="wa-picker-tabs">
                    ${tabsHtml}
                </div>
            </div>
            <div class="wa-picker-body">
                <div class="wa-picker-grid"></div>
            </div>
        `;

        function renderCategory(categoryKey) {
            const grid = picker.querySelector('.wa-picker-grid');
            if (!grid) return;
            const catData = WA_EMOJI_CATEGORIES[categoryKey] || WA_EMOJI_CATEGORIES.smileys;
            const itemsHtml = catData.emojis.map(em => {
                const appleImg = toAppleEmojiImg(em);
                return `<button type="button" class="wa-picker-item" data-emoji="${escapeHtml(em)}" title="${escapeHtml(em)}">${appleImg}</button>`;
            }).join('');
            grid.innerHTML = itemsHtml;
        }

        // Category tab switches
        const tabBtns = picker.querySelectorAll('.wa-tab-btn');
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                const cat = btn.getAttribute('data-cat');
                renderCategory(cat);
            });
        });

        // Click on emoji item
        picker.addEventListener('click', (e) => {
            const emojiBtn = e.target.closest('.wa-picker-item');
            if (emojiBtn) {
                e.stopPropagation();
                const emoji = emojiBtn.getAttribute('data-emoji');
                if (typeof onSelect === 'function') {
                    onSelect(emoji, emojiBtn);
                }
            }
        });

        // Render initial category
        renderCategory('smileys');

        return picker;
    }

    // Global Active Emoji Picker State
    let activeGlobalPicker = null;
    let activeGlobalTrigger = null;
    let activeGlobalTargetInput = null;

    function closeGlobalEmojiPicker() {
        if (activeGlobalPicker && activeGlobalPicker.classList.contains('is-open')) {
            activeGlobalPicker.classList.remove('is-open');
            const pickerRef = activeGlobalPicker;
            setTimeout(() => {
                if (pickerRef && !pickerRef.classList.contains('is-open')) {
                    if (pickerRef.parentElement) {
                        pickerRef.parentElement.removeChild(pickerRef);
                    }
                }
            }, 220);
        }
        activeGlobalPicker = null;
        activeGlobalTrigger = null;
        activeGlobalTargetInput = null;
    }

    function toggleWhatsAppEmojiPicker(triggerBtn, targetInput, options = {}) {
        if (!triggerBtn || !targetInput) return;

        // If clicking the same trigger that's already open, close it
        if (activeGlobalTrigger === triggerBtn && activeGlobalPicker && activeGlobalPicker.classList.contains('is-open')) {
            closeGlobalEmojiPicker();
            return;
        }

        closeGlobalEmojiPicker();

        const picker = createWhatsAppEmojiPicker((emoji) => {
            insertEmojiAtCursor(targetInput, emoji);
            if (options.closeOnSelect) {
                closeGlobalEmojiPicker();
            }
        });

        activeGlobalPicker = picker;
        activeGlobalTrigger = triggerBtn;
        activeGlobalTargetInput = targetInput;

        // Positioning: Choose parent container or document body
        const container = triggerBtn.closest('.msg-composer-wrap, .msg-footer, .msg-input-row, .msg-composer-form, .comment-form, .comment-input-group, .wt-chat-footer, .form-group, .form-input-box, .title-edit-form') || triggerBtn.parentElement || document.body;
        
        container.style.position = container.style.position && container.style.position !== 'static' ? container.style.position : 'relative';
        container.appendChild(picker);

        // Adjust position dynamically
        const placement = options.placement || 'top';
        if (placement === 'bottom') {
            picker.classList.add('wa-picker-bottom');
        }

        // Force reflow and show animation
        void picker.offsetWidth;
        picker.classList.add('is-open');
    }

    /**
     * Attaches emoji picker click behavior to a trigger button and input target
     */
    function attachWhatsAppEmojiPicker(triggerBtn, targetInput, options = {}) {
        if (!triggerBtn || !targetInput) return;
        if (triggerBtn.dataset.waPickerBound === 'true') return;
        triggerBtn.dataset.waPickerBound = 'true';

        triggerBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleWhatsAppEmojiPicker(triggerBtn, targetInput, options);
        });
    }

    /**
     * Automatically scans and parses emojis in text elements, chips and buttons
     */
    function applyWhatsAppEmojis(container = document) {
        if (!container || !window.twemoji) return;

        // 1. Comment texts and message elements
        const textSelectors = '.comment-text, .wt-msg-text, .msg-text-content, .selected-name, .activity-summary';
        const commentTexts = container.querySelectorAll ? container.querySelectorAll(textSelectors) : [];
        commentTexts.forEach(el => {
            if (!el.querySelector('.wa-emoji') && !el.dataset.waParsed) {
                el.dataset.waParsed = 'true';
                el.innerHTML = parseWhatsAppEmoji(el.innerHTML);
            }
        });

        // 2. Emoji Chips & Reaction Buttons
        const chipSelectors = '.emoji-chip, .wt-emoji-btn, .call-quick-emoji-btn, .msg-react-emoji-btn, .msg-mobile-react-btn, .msg-quick-emoji-btn, .msg-reaction-badge span:first-child, .msg-empty-starter-chip';
        const chips = container.querySelectorAll ? container.querySelectorAll(chipSelectors) : [];
        chips.forEach(chip => {
            if (!chip.querySelector('.wa-emoji') && !chip.dataset.waParsed) {
                chip.dataset.waParsed = 'true';
                const text = chip.getAttribute('data-emoji') || chip.getAttribute('data-reaction') || chip.getAttribute('data-call-emoji') || chip.innerText || chip.textContent;
                if (text && text.trim()) {
                    chip.innerHTML = parseWhatsAppEmoji(text.trim());
                }
            }
        });
    }

    /**
     * Automatically wires up any known emoji buttons on the page
     */
    function autoBindEmojiPickers(root = document) {
        // 1. Video Watch Page Comments
        const commentForm = root.querySelector('#commentForm, .comment-form');
        if (commentForm) {
            const commentTextarea = commentForm.querySelector('#commentTextarea, textarea[name="text"]');
            const commentEmojiBtn = commentForm.querySelector('.comment-emoji-picker-toggle, .msg-emoji-toggle-btn');
            if (commentEmojiBtn && commentTextarea) {
                attachWhatsAppEmojiPicker(commentEmojiBtn, commentTextarea);
            }
        }

        // 2. Watch Together Live Chat
        const wtChatPanel = root.querySelector('#wtChatPanel, .wt-chat-drawer');
        if (wtChatPanel) {
            const wtChatInput = wtChatPanel.querySelector('#wtChatInput, .wt-chat-input');
            const wtEmojiBtn = wtChatPanel.querySelector('.wt-chat-emoji-btn, .msg-emoji-toggle-btn');
            if (wtEmojiBtn && wtChatInput) {
                attachWhatsAppEmojiPicker(wtEmojiBtn, wtChatInput);
            }
        }

        // 3. Watch Page Inline Title Rename
        const titleEditForm = root.querySelector('#titleEditForm, .title-edit-form');
        if (titleEditForm) {
            const titleInput = titleEditForm.querySelector('#titleEditInput, .title-edit-input');
            const titleEmojiBtn = titleEditForm.querySelector('.title-emoji-toggle-btn, .msg-emoji-toggle-btn');
            if (titleEmojiBtn && titleInput) {
                attachWhatsAppEmojiPicker(titleEmojiBtn, titleInput);
            }
        }

        // 4. Media Upload Page Title
        const uploadTitleGroup = root.querySelector('.upload-container, .upload-form, #uploadForm');
        if (uploadTitleGroup) {
            const titleInput = uploadTitleGroup.querySelector('#title');
            const titleEmojiBtn = uploadTitleGroup.querySelector('.upload-title-emoji-btn');
            if (titleEmojiBtn && titleInput) {
                attachWhatsAppEmojiPicker(titleEmojiBtn, titleInput);
            }

            const importTitleInput = uploadTitleGroup.querySelector('#importTitle');
            const importTitleEmojiBtn = uploadTitleGroup.querySelector('.import-title-emoji-btn');
            if (importTitleEmojiBtn && importTitleInput) {
                attachWhatsAppEmojiPicker(importTitleEmojiBtn, importTitleInput);
            }
        }

        // 5. Generic auto-bind by data attribute: data-emoji-target="#myInput"
        const genericBtns = root.querySelectorAll ? root.querySelectorAll('[data-emoji-target]') : [];
        genericBtns.forEach(btn => {
            const targetSelector = btn.getAttribute('data-emoji-target');
            const targetEl = root.querySelector(targetSelector);
            if (targetEl) {
                attachWhatsAppEmojiPicker(btn, targetEl);
            }
        });

        // 6. Direct Message Composers & Full-Page Chat
        const msgComposers = root.querySelectorAll ? root.querySelectorAll('.msg-composer-wrap, .msg-footer') : [];
        msgComposers.forEach(composer => {
            const textarea = composer.querySelector('.msg-textarea');
            const emojiBtn = composer.querySelector('.msg-emoji-toggle-btn');
            if (emojiBtn && textarea) {
                attachWhatsAppEmojiPicker(emojiBtn, textarea);
            }
        });

        // Apply emoji text parsing
        applyWhatsAppEmojis(root);
    }

    // Global Dismiss Handlers
    document.addEventListener('click', (e) => {
        if (activeGlobalPicker && activeGlobalPicker.classList.contains('is-open')) {
            if (!e.target.closest('.wa-emoji-picker') && !e.target.closest('.msg-emoji-toggle-btn, .comment-emoji-picker-toggle, .wt-chat-emoji-btn, .title-emoji-toggle-btn, .upload-title-emoji-btn, .import-title-emoji-btn, [data-emoji-target]')) {
                closeGlobalEmojiPicker();
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && activeGlobalPicker && activeGlobalPicker.classList.contains('is-open')) {
            closeGlobalEmojiPicker();
        }
    });

    // Auto-init on DOMContentLoaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => autoBindEmojiPickers(document));
    } else {
        autoBindEmojiPickers(document);
    }

    // Export API
    window.WA_EMOJI_CATEGORIES = WA_EMOJI_CATEGORIES;
    window.toAppleEmojiImg = toAppleEmojiImg;
    window.parseWhatsAppEmoji = parseWhatsAppEmoji;
    window.applyWhatsAppEmojis = applyWhatsAppEmojis;
    window.createWhatsAppEmojiPicker = createWhatsAppEmojiPicker;
    window.toggleWhatsAppEmojiPicker = toggleWhatsAppEmojiPicker;
    window.attachWhatsAppEmojiPicker = attachWhatsAppEmojiPicker;
    window.closeGlobalEmojiPicker = closeGlobalEmojiPicker;
    window.autoBindEmojiPickers = autoBindEmojiPickers;

})(window, document);
