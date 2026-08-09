const crypto = require('crypto');
const ejs = require('ejs');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function escapeHtml(value) {
    return ejs.escapeXML(value == null ? '' : String(value));
}

function timingSafeCompare(a, b) {
    const aBuffer = Buffer.from(String(a || ''));
    const bBuffer = Buffer.from(String(b || ''));

    if (aBuffer.length !== bBuffer.length) {
        return false;
    }

    return crypto.timingSafeEqual(aBuffer, bBuffer);
}

function getCsrfToken(req) {
    if (!req.session.csrfToken) {
        req.session.csrfToken = crypto.randomBytes(32).toString('hex');
    }

    return req.session.csrfToken;
}

function attachLocals(req, res, next) {
    res.locals.user = req.session ? req.session.user : null;
    res.locals.csrfToken = req.session ? getCsrfToken(req) : '';
    res.locals.escapeHtml = escapeHtml;
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
    requireCsrf,
    timingSafeCompare
};
