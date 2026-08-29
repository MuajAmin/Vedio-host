/**
 * VideoHost — Global WhatsApp / Apple Color Emoji System
 * Provides Apple HD emoji rendering, Twemoji SVG fallback, and a
 * WhatsApp-style emoji picker with search, categories, recents and
 * skin-tone variations. Preserves the public API used across the app.
 */
(function (window, document) {
    'use strict';

    const WA_APPLE_EMOJI_BASE = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@15.0.1/img/apple/64/';
    const WA_TWEMOJI_FALLBACK_BASE = 'https://unpkg.com/twemoji@14.0.2/dist/svg/';

    // Rich categorized dataset (auto-generated in emoji-data.js)
    const WA_EMOJI_DATA = window.WA_EMOJI_DATA || {};

    // Legacy raw-string category map (kept for messages.js fallback picker compat)
    const WA_EMOJI_CATEGORIES = {};
    Object.keys(WA_EMOJI_DATA).forEach(key => {
        WA_EMOJI_CATEGORIES[key] = {
            name: WA_EMOJI_DATA[key].name,
            icon: WA_EMOJI_DATA[key].icon,
            emojis: WA_EMOJI_DATA[key].emojis.map(it => it.e)
        };
    });

    // Category tab order + icons
    const CATEGORY_ORDER = [
        { key: 'recent',    name: 'Recently Used', icon: '🕘' },
        { key: 'smileys',   name: (WA_EMOJI_DATA.smileys && WA_EMOJI_DATA.smileys.name) || 'Smileys',   icon: '😀' },
        { key: 'people',    name: (WA_EMOJI_DATA.people && WA_EMOJI_DATA.people.name) || 'People',      icon: '👋' },
        { key: 'nature',    name: (WA_EMOJI_DATA.nature && WA_EMOJI_DATA.nature.name) || 'Nature',      icon: '🐻' },
        { key: 'food',      name: (WA_EMOJI_DATA.food && WA_EMOJI_DATA.food.name) || 'Food',            icon: '🍕' },
        { key: 'travel',    name: (WA_EMOJI_DATA.travel && WA_EMOJI_DATA.travel.name) || 'Travel',      icon: '✈️' },
        { key: 'activities',name: (WA_EMOJI_DATA.activities && WA_EMOJI_DATA.activities.name) || 'Activities', icon: '⚽' },
        { key: 'objects',   name: (WA_EMOJI_DATA.objects && WA_EMOJI_DATA.objects.name) || 'Objects',   icon: '💡' },
        { key: 'symbols',   name: (WA_EMOJI_DATA.symbols && WA_EMOJI_DATA.symbols.name) || 'Symbols',   icon: '❤️' }
    ];

    // Skin-tone modifiers ( Fitzpatrick ) mapped to their codepoint hex
    const SKIN_TONES = [
        { key: '',        hex: '',      emoji: '👋' },
        { key: 'light',   hex: '1f3fb', emoji: '👋🏻' },
        { key: 'mediuml', hex: '1f3fc', emoji: '👋🏼' },
        { key: 'medium',  hex: '1f3fd', emoji: '👋🏽' },
        { key: 'mediumd', hex: '1f3fe', emoji: '👋🏾' },
        { key: 'dark',    hex: '1f3ff', emoji: '👋🏿' }
    ];

    const RECENT_KEY = 'wa_recent_emojis';
    const TONE_KEY = 'wa_skin_tone_hex';
    const MAX_RECENT = 24;

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function toCodePoint(emoji) {
        if (!window.twemoji || !window.twemoji.convert) return '';
        try { return window.twemoji.convert.toCodePoint(emoji, '-'); } catch { return ''; }
    }

    /**
     * Apply a Fitzpatrick skin-tone modifier to a base emoji character.
     * Inserts the tone after the first codepoint and drops a directly-following
     * FE0F (matches emoji-datasource unified codes 100%).
     */
    function applySkinTone(emojiChar, toneHex) {
        if (!toneHex || !emojiChar) return emojiChar;
        const base = toCodePoint(emojiChar);
        if (!base) return emojiChar;
        const cps = base.split('-');
        let rest = cps.slice(1);
        if (rest[0] === 'fe0f') rest = rest.slice(1);
        const toned = cps[0] + '-' + toneHex + (rest.length ? '-' + rest.join('-') : '');
        try {
            return toned.split('-').map(h => String.fromCodePoint(parseInt(h, 16))).join('');
        } catch {
            return emojiChar;
        }
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
            return `<img class="wa-emoji" draggable="false" alt="${safeEmoji}" data-code="${code}" src="${appleUrl}" loading="lazy" decoding="async" onerror="this.onerror=null;if(this.src!=='${fallbackUrl}'){this.src='${fallbackUrl}';}else{this.outerHTML='<span class=\'wa-raw-emoji\'>${safeEmoji}</span>';}" />`;
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

    /* ------------------------- Recents & tone state ------------------------- */
    function getRecents() {
        try {
            const raw = localStorage.getItem(RECENT_KEY);
            const arr = raw ? JSON.parse(raw) : [];
            return Array.isArray(arr) ? arr.filter(x => typeof x === 'string') : [];
        } catch { return []; }
    }
    function pushRecent(emoji) {
        try {
            let arr = getRecents().filter(e => e !== emoji);
            arr.unshift(emoji);
            if (arr.length > MAX_RECENT) arr = arr.slice(0, MAX_RECENT);
            localStorage.setItem(RECENT_KEY, JSON.stringify(arr));
        } catch {}
    }
    function getSkinTone() {
        try { return localStorage.getItem(TONE_KEY) || ''; } catch { return ''; }
    }
    function setSkinTone(hex) {
        try { localStorage.setItem(TONE_KEY, hex); } catch {}
    }

    /**
     * Creates a full-featured WhatsApp Emoji Picker DOM element
     */
    function createWhatsAppEmojiPicker(onSelect) {
        const picker = document.createElement('div');
        picker.className = 'wa-emoji-picker';
        picker.setAttribute('role', 'dialog');
        picker.setAttribute('aria-label', 'Emoji picker');

        let currentTone = getSkinTone();
        let activeCat = 'smileys';
        let searchQuery = '';

        // Flatten all emojis once for search
        const allEmojis = [];
        Object.keys(WA_EMOJI_DATA).forEach(catKey => {
            (WA_EMOJI_DATA[catKey].emojis || []).forEach(it => allEmojis.push(it));
        });

        const tabsHtml = CATEGORY_ORDER.map(c => {
            const activeClass = c.key === activeCat ? ' active' : '';
            return `<button type="button" class="wa-tab-btn${activeClass}" data-cat="${c.key}" title="${escapeHtml(c.name)}" aria-label="${escapeHtml(c.name)}">
                <span>${toAppleEmojiImg(c.icon)}</span>
            </button>`;
        }).join('');

        const currentToneEmoji = (SKIN_TONES.find(t => t.hex === currentTone) || SKIN_TONES[0]).emoji;

        picker.innerHTML = `
            <div class="wa-picker-search">
                <input type="text" class="wa-picker-search-input" placeholder="Search emoji" aria-label="Search emoji" autocomplete="off" />
                <button type="button" class="wa-skin-tone-btn" title="Skin tone" aria-label="Choose skin tone">${escapeHtml(currentToneEmoji)}</button>
            </div>
            <div class="wa-picker-header">
                <div class="wa-picker-tabs">${tabsHtml}</div>
            </div>
            <div class="wa-picker-body">
                <div class="wa-picker-grid" id="waPickerGrid"></div>
            </div>
            <div class="wa-skin-tone-row" style="display:none;">
                ${SKIN_TONES.map(t => `<button type="button" class="wa-skin-tone-option${t.hex === currentTone ? ' active' : ''}" data-hex="${t.hex}" title="Skin tone" aria-label="Skin tone ${t.key || 'default'}">${escapeHtml(t.emoji)}</button>`).join('')}
            </div>
        `;

        const grid = picker.querySelector('.wa-picker-grid');
        const searchInput = picker.querySelector('.wa-picker-search-input');
        const toneBtn = picker.querySelector('.wa-skin-tone-btn');
        const toneRow = picker.querySelector('.wa-skin-tone-row');
        const tabBtns = Array.from(picker.querySelectorAll('.wa-tab-btn'));

        function emojiItemHtml(rawEmoji) {
            return `<button type="button" class="wa-picker-item" data-emoji="${escapeHtml(rawEmoji)}" title="${escapeHtml(rawEmoji)}">${toAppleEmojiImg(rawEmoji)}</button>`;
        }

        function renderCategory(catKey) {
            if (!grid) return;
            searchQuery = '';
            let html = '';

            // Recently used section (only on the primary category view)
            const recents = getRecents();
            if (catKey === 'smileys' && recents.length > 0) {
                html += `<div class="wa-picker-section-label" style="grid-column:1/-1;">Recently Used</div>`;
                html += recents.map(emojiItemHtml).join('');
            }

            let items;
            if (catKey === 'recent') {
                items = recents.map(e => ({ e }));
            } else {
                items = (WA_EMOJI_DATA[catKey] && WA_EMOJI_DATA[catKey].emojis) || [];
            }

            if (catKey !== 'smileys' || recents.length === 0) {
                const label = (CATEGORY_ORDER.find(c => c.key === catKey) || {}).name || '';
                if (label) html += `<div class="wa-picker-section-label" style="grid-column:1/-1;">${escapeHtml(label)}</div>`;
            }

            html += items.map(it => {
                const disp = (it.s && currentTone) ? applySkinTone(it.e, currentTone) : it.e;
                return emojiItemHtml(disp);
            }).join('');

            if (!items.length && catKey === 'recent') {
                html = `<div class="wa-picker-empty">No recent emojis yet</div>`;
            }
            grid.innerHTML = html;
            grid.parentElement.scrollTop = 0;
        }

        function renderSearch(query) {
            if (!grid) return;
            const q = query.trim().toLowerCase();
            if (!q) { renderCategory(activeCat); return; }
            const results = allEmojis.filter(it => {
                if (it.n && it.n.toLowerCase().includes(q)) return true;
                if (it.k && it.k.some(k => k.toLowerCase().includes(q))) return true;
                return false;
            }).slice(0, 120);
            if (!results.length) {
                grid.innerHTML = `<div class="wa-picker-empty">No emoji found for “${escapeHtml(query)}”</div>`;
                return;
            }
            grid.innerHTML = results.map(it => {
                const disp = (it.s && currentTone) ? applySkinTone(it.e, currentTone) : it.e;
                return emojiItemHtml(disp);
            }).join('');
            grid.parentElement.scrollTop = 0;
        }

        function refreshToneUI() {
            const t = SKIN_TONES.find(x => x.hex === currentTone) || SKIN_TONES[0];
            if (toneBtn) toneBtn.textContent = t.emoji;
            picker.querySelectorAll('.wa-skin-tone-option').forEach(o => {
                o.classList.toggle('active', o.getAttribute('data-hex') === currentTone);
            });
        }

        // Tab switching
        tabBtns.forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                tabBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                activeCat = btn.getAttribute('data-cat');
                if (searchInput) searchInput.value = '';
                renderCategory(activeCat);
            });
        });

        // Search input
        if (searchInput) {
            searchInput.addEventListener('input', () => {
                searchQuery = searchInput.value;
                renderSearch(searchQuery);
            });
            searchInput.addEventListener('click', e => e.stopPropagation());
        }

        // Skin tone button toggles the tone row
        if (toneBtn) {
            toneBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                const open = toneRow.style.display === 'none';
                toneRow.style.display = open ? 'flex' : 'none';
            });
        }

        // Skin tone option select
        toneRow.addEventListener('click', (e) => {
            const opt = e.target.closest('.wa-skin-tone-option');
            if (!opt) return;
            e.stopPropagation();
            currentTone = opt.getAttribute('data-hex') || '';
            setSkinTone(currentTone);
            refreshToneUI();
            toneRow.style.display = 'none';
            if (searchQuery) renderSearch(searchQuery); else renderCategory(activeCat);
        });

        // Emoji select
        picker.addEventListener('click', (e) => {
            const emojiBtn = e.target.closest('.wa-picker-item');
            if (emojiBtn) {
                e.stopPropagation();
                const emoji = emojiBtn.getAttribute('data-emoji');
                pushRecent(emoji);
                if (typeof onSelect === 'function') onSelect(emoji, emojiBtn);
            }
        });

        refreshToneUI();
        renderCategory(activeCat);
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
                    if (pickerRef.parentElement) pickerRef.parentElement.removeChild(pickerRef);
                }
            }, 220);
        }
        activeGlobalPicker = null;
        activeGlobalTrigger = null;
        activeGlobalTargetInput = null;
    }

    function toggleWhatsAppEmojiPicker(triggerBtn, targetInput, options = {}) {
        if (!triggerBtn || !targetInput) return;

        if (activeGlobalTrigger === triggerBtn && activeGlobalPicker && activeGlobalPicker.classList.contains('is-open')) {
            closeGlobalEmojiPicker();
            return;
        }

        closeGlobalEmojiPicker();

        const picker = createWhatsAppEmojiPicker((emoji) => {
            insertEmojiAtCursor(targetInput, emoji);
            if (options.closeOnSelect) closeGlobalEmojiPicker();
        });

        activeGlobalPicker = picker;
        activeGlobalTrigger = triggerBtn;
        activeGlobalTargetInput = targetInput;

        const container = triggerBtn.closest('.msg-composer-wrap, .msg-footer, .msg-input-row, .msg-composer-form, .comment-form, .comment-input-group, .wt-chat-footer, .form-group, .form-input-box, .title-edit-form') || triggerBtn.parentElement || document.body;
        container.style.position = container.style.position && container.style.position !== 'static' ? container.style.position : 'relative';
        container.appendChild(picker);

        const placement = options.placement || 'top';
        if (placement === 'bottom') picker.classList.add('wa-picker-bottom');

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

        const textSelectors = '.comment-text, .wt-msg-text, .msg-text-content, .selected-name, .activity-summary';
        const commentTexts = container.querySelectorAll ? container.querySelectorAll(textSelectors) : [];
        commentTexts.forEach(el => {
            if (!el.querySelector('.wa-emoji') && !el.dataset.waParsed) {
                el.dataset.waParsed = 'true';
                el.innerHTML = parseWhatsAppEmoji(el.innerHTML);
            }
        });

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
        const commentForm = root.querySelector('#commentForm, .comment-form');
        if (commentForm) {
            const commentTextarea = commentForm.querySelector('#commentTextarea, textarea[name="text"]');
            const commentEmojiBtn = commentForm.querySelector('.comment-emoji-picker-toggle, .msg-emoji-toggle-btn');
            if (commentEmojiBtn && commentTextarea) attachWhatsAppEmojiPicker(commentEmojiBtn, commentTextarea);
        }

        const wtChatPanel = root.querySelector('#wtChatPanel, .wt-chat-drawer');
        if (wtChatPanel) {
            const wtChatInput = wtChatPanel.querySelector('#wtChatInput, .wt-chat-input');
            const wtEmojiBtn = wtChatPanel.querySelector('.wt-chat-emoji-btn, .msg-emoji-toggle-btn');
            if (wtEmojiBtn && wtChatInput) attachWhatsAppEmojiPicker(wtEmojiBtn, wtChatInput);
        }

        const titleEditForm = root.querySelector('#titleEditForm, .title-edit-form');
        if (titleEditForm) {
            const titleInput = titleEditForm.querySelector('#titleEditInput, .title-edit-input');
            const titleEmojiBtn = titleEditForm.querySelector('.title-emoji-toggle-btn, .msg-emoji-toggle-btn');
            if (titleEmojiBtn && titleInput) attachWhatsAppEmojiPicker(titleEmojiBtn, titleInput);
        }

        const uploadTitleGroup = root.querySelector('.upload-container, .upload-form, #uploadForm');
        if (uploadTitleGroup) {
            const titleInput = uploadTitleGroup.querySelector('#title');
            const titleEmojiBtn = uploadTitleGroup.querySelector('.upload-title-emoji-btn');
            if (titleEmojiBtn && titleInput) attachWhatsAppEmojiPicker(titleEmojiBtn, titleInput);

            const importTitleInput = uploadTitleGroup.querySelector('#importTitle');
            const importTitleEmojiBtn = uploadTitleGroup.querySelector('.import-title-emoji-btn');
            if (importTitleEmojiBtn && importTitleInput) attachWhatsAppEmojiPicker(importTitleEmojiBtn, importTitleInput);
        }

        const genericBtns = root.querySelectorAll ? root.querySelectorAll('[data-emoji-target]') : [];
        genericBtns.forEach(btn => {
            const targetSelector = btn.getAttribute('data-emoji-target');
            const targetEl = root.querySelector(targetSelector);
            if (targetEl) attachWhatsAppEmojiPicker(btn, targetEl);
        });

        const msgComposers = root.querySelectorAll ? root.querySelectorAll('.msg-composer-wrap, .msg-footer') : [];
        msgComposers.forEach(composer => {
            const textarea = composer.querySelector('.msg-textarea');
            const emojiBtn = composer.querySelector('.msg-emoji-toggle-btn');
            if (emojiBtn && textarea) attachWhatsAppEmojiPicker(emojiBtn, textarea);
        });

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

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => autoBindEmojiPickers(document));
    } else {
        autoBindEmojiPickers(document);
    }

    // Export API
    window.WA_EMOJI_CATEGORIES = WA_EMOJI_CATEGORIES;
    window.WA_EMOJI_DATA = WA_EMOJI_DATA;
    window.toAppleEmojiImg = toAppleEmojiImg;
    window.parseWhatsAppEmoji = parseWhatsAppEmoji;
    window.applyWhatsAppEmojis = applyWhatsAppEmojis;
    window.createWhatsAppEmojiPicker = createWhatsAppEmojiPicker;
    window.toggleWhatsAppEmojiPicker = toggleWhatsAppEmojiPicker;
    window.attachWhatsAppEmojiPicker = attachWhatsAppEmojiPicker;
    window.closeGlobalEmojiPicker = closeGlobalEmojiPicker;
    window.autoBindEmojiPickers = autoBindEmojiPickers;

})(window, document);
