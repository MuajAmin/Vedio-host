const express = require('express');
const router = express.Router();
const { authenticate } = require('../middleware/auth');

const attempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 8;

// Clean up expired rate limit entries every hour
setInterval(() => {
    const now = Date.now();
    for (const [key, record] of attempts) {
        if (record.expiresAt <= now) attempts.delete(key);
    }
}, 60 * 60 * 1000).unref();

function getAttemptKey(req) {
    return req.ip || req.socket.remoteAddress || 'unknown';
}

function isLockedOut(req) {
    const key = getAttemptKey(req);
    const now = Date.now();
    const record = attempts.get(key);

    if (!record || record.expiresAt <= now) {
        attempts.delete(key);
        return false;
    }

    return record.count >= MAX_LOGIN_ATTEMPTS;
}

function recordFailedLogin(req) {
    const key = getAttemptKey(req);
    const now = Date.now();
    const record = attempts.get(key);

    if (!record || record.expiresAt <= now) {
        attempts.set(key, { count: 1, expiresAt: now + LOGIN_WINDOW_MS });
        return;
    }

    record.count += 1;
}

function clearFailedLogins(req) {
    attempts.delete(getAttemptKey(req));
}

// GET / — Login page
router.get('/', (req, res) => {
    if (req.session && req.session.user) {
        return res.redirect('/dashboard');
    }
    res.render('login', { error: null });
});

// POST /login — Verify password
router.post('/login', (req, res) => {
    const { password } = req.body;

    if (isLockedOut(req)) {
        return res.status(429).render('login', { error: 'Too many login attempts. Try again later.' });
    }

    if (!password) {
        return res.render('login', { error: 'Password দাও!' });
    }

    const user = authenticate(password);

    if (user) {
        clearFailedLogins(req);
        return req.session.regenerate((err) => {
            if (err) {
                return res.status(500).render('error', {
                    user: null,
                    message: 'Could not start session. Please try again.'
                });
            }

            req.session.user = user;
            return res.redirect('/dashboard');
        });
    }

    recordFailedLogin(req);
    res.render('login', { error: 'ভুল password! আবার চেষ্টা করো।' });
});

// POST /logout
router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
        res.redirect('/');
    });
});

module.exports = router;
