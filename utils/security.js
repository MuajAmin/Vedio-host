const crypto = require('crypto');
const ejs = require('ejs');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

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

function attachLocals(req, res, next) {
    const user = req.session ? req.session.user : null;
    const avatars = getCachedAvatars();

    res.locals.user = user;
    res.locals.csrfToken = req.session ? getCsrfToken(req) : '';
    res.locals.escapeHtml = escapeHtml;
    res.locals.userAvatars = avatars;
    res.locals.userAvatar = user ? (avatars[user] || null) : null;
    res.locals.renderAvatar = (uname, cls) => renderAvatar(uname, cls, avatars);
    next();
}

function requireCsrf(req, res, next) {
    if (SAFE_METHODS.has(req.method)) {
        return next();
    }

    const expected = req.session && req.session.csrfToken;
    const submitted = (req.body && req.body._csrf)
        || (req.query && req.query._csrf)
        || req.get('x-csrf-token');

    if (!expected || !submitted || !timingSafeCompare(submitted, expected)) {
        return res.status(403).render('forbidden', {
            user: req.session ? req.session.user : null,
            message: 'Invalid request token. Please refresh the page and try again.'
        });
    }

    return next();
}

module.exports = {
    attachLocals,
    escapeHtml,
    getCsrfToken,
    invalidateAvatarCache,
    renderAvatar,
    requireCsrf,
    timingSafeCompare
};
