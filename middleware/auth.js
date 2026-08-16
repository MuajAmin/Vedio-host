const { timingSafeCompare } = require('../utils/security');
const db = require('../database');

function isAuthenticated(req, res, next) {
    const isAjaxOrApi = req.xhr || 
        (req.headers.accept && req.headers.accept.includes('application/json')) ||
        (req.path && (req.path.startsWith('/api/') || req.path.startsWith('/watch-together/') || req.path.startsWith('/messages/stream')));

    if (req.session && req.session.user) {
        // Check if the logged-in user has been blocked by admin
        if (db.isUserBlocked(req.session.user)) {
            return req.session.destroy(() => {
                if (isAjaxOrApi) {
                    return res.status(401).json({ error: 'Access blocked by admin', loggedOut: true });
                }
                return res.redirect('/');
            });
        }
        return next();
    }

    if (isAjaxOrApi) {
        return res.status(401).json({ error: 'Session terminated or unauthorized', loggedOut: true });
    }
    return res.redirect('/');
}

function isMuaj(req, res, next) {
    if (req.session && req.session.user === 'muaj') {
        return next();
    }
    return res.status(403).render('forbidden', {
        user: req.session ? req.session.user : null,
        message: 'শুধুমাত্র Muaj এই কাজ করতে পারবে!'
    });
}

function authenticate(password) {
    const muajPassword = process.env.MUAJ_PASSWORD || 'muaj123';
    const hajeraPassword = process.env.HAJERA_PASSWORD || 'hajera123';

    if (timingSafeCompare(password, muajPassword)) {
        return 'muaj';
    } else if (timingSafeCompare(password, hajeraPassword)) {
        // Deny login if hajera is blocked
        if (db.isUserBlocked('hajera')) {
            return null;
        }
        return 'hajera';
    }
    return null;
}

module.exports = { isAuthenticated, isMuaj, authenticate };
