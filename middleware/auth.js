require('dotenv').config();
const { timingSafeCompare } = require('../utils/security');

function isAuthenticated(req, res, next) {
    if (req.session && req.session.user) {
        return next();
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
        return 'hajera';
    }
    return null;
}

module.exports = { isAuthenticated, isMuaj, authenticate };
