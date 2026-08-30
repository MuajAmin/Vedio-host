const crypto = require('crypto');
const ejs = require('ejs');
const cookie = require('cookie');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const VALID_THEMES = new Set(['cinematic', 'cyberpunk', 'emerald', 'sunset']);
const VALID_MODES = new Set(['standard', 'minimal']);
const VALID_SCHEMES = new Set(['dark', 'light']);

// --- Avatar in-memory cache -------------------------------------------
// getAllUserAvatars() was being called on every HTTP request (including
// video streams, thumbnails, etc). With only 2 users this is fine
// functionally, but unnecessary SQLite I/O on a 1GB VPS. Cache it.
let _avatarCache = null;
let _avatarCacheAt = 0;
const AVATAR_CACHE_TTL = 30 * 1000; // 30 seconds

function getCachedAvatars() {
    const now = Date.now();
    if (_avatarCache && (now - _avatarCacheAt) < AVATAR_CACHE_TTL) {
        return _avatarCache;
    }
    let db;
    try { db = require('../database'); } catch { return {}; }
    const avatars = db && typeof db.getAllUserAvatars === 'function'
        ? db.getAllUserAvatars()
        : {};
    _avatarCache = avatars;
    _avatarCacheAt = now;
    return avatars;
}

function invalidateAvatarCache() {
    _avatarCache = null;
    _avatarCacheAt = 0;
}
// -----------------------------------------------------------------------

function escapeHtml(value) {
    return ejs.escapeXML(value == null ? '' : String(value));
}

function timingSafeCompare(a, b) {
    const aHash = crypto.createHash('sha256').update(String(a || '')).digest();
    const bHash = crypto.createHash('sha256').update(String(b || '')).digest();
    return crypto.timingSafeEqual(aHash, bHash);
}

function getCsrfToken(req) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }

    return req.session.csrfToken;
}

function renderAvatar(username, extraClass = '', userAvatars = {}) {
    const avatar = userAvatars[username];
    const cleanClass = escapeHtml(extraClass);
    const cleanUser = escapeHtml(username || '');
    if (avatar) {
        return `<img src="/avatars/${escapeHtml(avatar)}" alt="${cleanUser}" class="avatar-img ${cleanClass}" loading="lazy" />`;
    }
    const letter = (username === 'muaj') ? 'M' : 'H';
    const roleClass = (username === 'muaj') ? 'avatar-admin' : 'avatar-viewer';
    return `<div class="avatar-letter ${roleClass} ${cleanClass}">${letter}</div>`;
}

// --- Unread count in-memory cache ---
// attachLocals runs on every HTTP request; getUnreadMessageCount is a
// synchronous SQLite query. Cache it for 5 seconds to avoid redundant
// DB I/O. The SSE stream already pushes real-time badge updates.
let _unreadCache = {};
let _unreadCacheTimes = {};
const UNREAD_CACHE_TTL = 5 * 1000;

function invalidateUnreadCache(username) {
    if (username) {
        delete _unreadCache[username];
        delete _unreadCacheTimes[username];
    } else {
        _unreadCache = {};
        _unreadCacheTimes = {};
    }
}

let _settingsCache = {};
let _settingsCacheTimes = {};
const SETTINGS_CACHE_TTL = 10 * 1000;

function invalidateSettingsCache(username) {
    if (username) {
        delete _settingsCache[username];
        delete _settingsCacheTimes[username];
    } else {
        _settingsCache = {};
        _settingsCacheTimes = {};
    }
}

function attachLocals(req, res, next) {
    const user = req.session ? req.session.user : null;
    const avatars = getCachedAvatars();
    let unreadCount = 0;

    // Check request cookies as seamless fallback
    let cookieTheme = null;
    let cookieUiMode = null;
    let cookieScheme = null;
    try {
        if (req.headers.cookie) {
            const parsedCookies = cookie.parse(req.headers.cookie);
            if (parsedCookies.videohosk_theme && VALID_THEMES.has(parsedCookies.videohosk_theme)) {
                cookieTheme = parsedCookies.videohosk_theme;
            }
            if (parsedCookies.videohosk_uimode && VALID_MODES.has(parsedCookies.videohosk_uimode)) {
                cookieUiMode = parsedCookies.videohosk_uimode;
            }
            if (parsedCookies.videohosk_scheme && VALID_SCHEMES.has(parsedCookies.videohosk_scheme)) {
                cookieScheme = parsedCookies.videohosk_scheme;
            }
        }
    } catch {}

    const defaultTheme = (user === 'hajera') ? 'sunset' : (cookieTheme || 'cinematic');
    const defaultMode = cookieUiMode || 'standard';

    let userSettings = { ui_mode: defaultMode, theme: defaultTheme };
    if (user) {
        try {
            const now = Date.now();
            const cachedTime = _unreadCacheTimes[user] || 0;
            if (_unreadCache[user] !== undefined && (now - cachedTime) < UNREAD_CACHE_TTL) {
                unreadCount = _unreadCache[user];
            } else {
                const db = require('../database');
                if (db && typeof db.getUnreadMessageCount === 'function') {
                    unreadCount = db.getUnreadMessageCount(user);
                    _unreadCache[user] = unreadCount;
                    _unreadCacheTimes[user] = now;
                }
            }

            const cachedSettingsTime = _settingsCacheTimes[user] || 0;
            if (_settingsCache[user] !== undefined && (now - cachedSettingsTime) < SETTINGS_CACHE_TTL) {
                userSettings = _settingsCache[user];
            } else {
                const db = require('../database');
                if (db && typeof db.getUserSettings === 'function') {
                    userSettings = db.getUserSettings(user);
                    _settingsCache[user] = userSettings;
                    _settingsCacheTimes[user] = now;
                }
            }
        } catch {}
    }

    res.locals.user = user;
    res.locals.uiMode = userSettings.ui_mode || defaultMode;
    res.locals.userTheme = userSettings.theme || defaultTheme;
    res.locals.userScheme = cookieScheme || 'dark';
    res.locals.unreadCount = unreadCount;
    res.locals.csrfToken = req.session ? getCsrfToken(req) : '';
    res.locals.escapeHtml = escapeHtml;
    res.locals.userAvatars = avatars;
    res.locals.userAvatar = user ? (avatars[user] || null) : null;
    res.locals.renderAvatar = (uname, cls) => renderAvatar(uname, cls, avatars);
    next();
}

function validateCsrf(req) {
    if (SAFE_METHODS.has(req.method)) {
        return true;
    }

    const expected = req.session && req.session.csrfToken;
    const submitted = (req.body && req.body._csrf)
        || (req.query && req.query._csrf)
        || (typeof req.get === 'function' ? req.get('x-csrf-token') : null);

    if (!expected || !submitted) {
        return false;
    }

    return timingSafeCompare(submitted, expected);
}

function handleCsrfError(req, res) {
    const isJsonReq = Boolean(
        req.xhr ||
        (req.headers['content-type'] && req.headers['content-type'].includes('application/json')) ||
        (req.headers['accept'] && req.headers['accept'].includes('application/json'))
    );

    if (isJsonReq) {
        return res.status(403).json({
            error: 'Invalid security token. Please refresh the page and try again.'
        });
    }

    return res.status(403).render('forbidden', {
        user: req.session ? req.session.user : null,
        message: 'Invalid request token. Please refresh the page and try again.'
    });
}

function requireCsrf(req, res, next) {
    if (validateCsrf(req)) {
        return next();
    }
    return handleCsrfError(req, res);
}

module.exports = {
    attachLocals,
    escapeHtml,
    getCachedAvatars,
    getCsrfToken,
    handleCsrfError,
    invalidateAvatarCache,
    invalidateUnreadCache,
    invalidateSettingsCache,
    renderAvatar,
    requireCsrf,
    validateCsrf,
    timingSafeCompare
};
