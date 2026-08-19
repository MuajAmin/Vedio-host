// ============================================================
//  PUSH SUBSCRIPTION API ROUTES
//  Manages Web Push subscriptions for browser/Android notifications
// ============================================================

const express = require('express');
const { isAuthenticated } = require('../middleware/auth');
const db = require('../database');
const { getVapidPublicKey, isPushEnabled } = require('../utils/pushNotify');

const router = express.Router();

// GET /api/push/vapid-public-key — Return the VAPID public key for frontend
router.get('/api/push/vapid-public-key', isAuthenticated, (req, res) => {
    if (!isPushEnabled()) {
        return res.status(503).json({ error: 'Push notifications are not configured.' });
    }
    res.json({ publicKey: getVapidPublicKey() });
});

// POST /api/push/subscribe — Save a new push subscription
router.post('/api/push/subscribe', isAuthenticated, (req, res) => {
    if (!isPushEnabled()) {
        return res.status(503).json({ error: 'Push notifications are not configured.' });
    }

    const user = req.session.user;
    const subscription = req.body.subscription;

    if (!subscription || !subscription.endpoint || !subscription.keys) {
        return res.status(400).json({ error: 'Invalid push subscription.' });
    }

    if (!subscription.keys.p256dh || !subscription.keys.auth) {
        return res.status(400).json({ error: 'Missing push subscription keys.' });
    }

    const userAgent = req.headers['user-agent'] || null;
    const result = db.savePushSubscription(user, subscription, userAgent);

    if (result) {
        res.json({ success: true, message: 'Push subscription saved.' });
    } else {
        res.status(500).json({ error: 'Failed to save push subscription.' });
    }
});

// POST /api/push/unsubscribe — Remove a push subscription
router.post('/api/push/unsubscribe', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const endpoint = req.body.endpoint;

    if (endpoint) {
        // Remove specific subscription — verify it belongs to this user
        const subs = db.getPushSubscriptions(user);
        const owns = subs.some(s => s.endpoint === endpoint);
        if (owns) {
            db.deletePushSubscription(endpoint);
        }
    } else {
        // Remove all subscriptions for this user (e.g., on logout)
        db.deletePushSubscriptionsForUser(user);
    }

    res.json({ success: true, message: 'Push subscription removed.' });
});

module.exports = router;
