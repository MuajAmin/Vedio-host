// ============================================================
//  WEB PUSH NOTIFICATION SENDER
//  Sends native browser/Android push notifications via Web Push API
//  Uses VAPID credentials from environment variables
// ============================================================

const webPush = require('web-push');
const db = require('../database');

// Configure VAPID credentials
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:admin@videohost.app';

let pushEnabled = false;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    try {
        webPush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
        pushEnabled = true;
        console.log('[push] Web Push configured successfully.');
    } catch (err) {
        console.error('[push] Failed to configure VAPID:', err.message);
    }
} else {
    console.warn('[push] VAPID keys not configured — push notifications disabled.');
}

// Deduplicate: track recently sent messageIds to prevent duplicate pushes
// from SSE reconnection, retries, or multiple backend workers
const recentlySent = new Map(); // messageId -> timestamp
const DEDUP_WINDOW_MS = 30 * 1000; // 30 seconds

// Clean up dedup map periodically
setInterval(() => {
    const cutoff = Date.now() - DEDUP_WINDOW_MS;
    for (const [id, ts] of recentlySent) {
        if (ts < cutoff) recentlySent.delete(id);
    }
}, 60 * 1000).unref();

/**
 * Build notification payload based on message type
 * @param {object} message - The saved message object
 * @returns {object} - Notification payload
 */
function buildNotificationPayload(message) {
    if (!message) return null;

    const senderName = message.sender === 'muaj' ? 'Muaj' : 'Hajera';
    let body = 'You have a new message';
    let type = 'text';

    if (message.text) {
        if (message.text.startsWith('__CALL_EVENT__:')) {
            // Call event — skip push notification for these
            return null;
        }
        // Truncate for privacy — don't send full message in push payload
        body = message.text.length > 100 ? message.text.slice(0, 100) + '…' : message.text;
        type = 'text';
    }

    if (message.voiceUrl) {
        body = `${senderName} sent you a voice note`;
        type = 'voice';
    }

    if (message.videoId || message.video) {
        const videoTitle = message.video ? message.video.title : 'a video';
        body = `${senderName} sent you a video`;
        type = 'video';
    }

    if (message.replyToId) {
        if (type === 'text') {
            body = message.text.length > 80 ? message.text.slice(0, 80) + '…' : message.text;
        }
        type = 'reply';
    }

    return {
        title: senderName,
        body,
        type,
        messageId: message.id,
        sender: message.sender,
        url: '/messages',
        icon: '/css/icon-192.png',
        badge: '/css/icon-192.png',
        timestamp: message.createdAt || new Date().toISOString(),
        tag: `msg-${message.sender}` // Group notifications by sender
    };
}

/**
 * Send push notification to all subscriptions of a user
 * @param {string} username - Recipient username
 * @param {object} message - The saved message object from db.saveMessage()
 */
async function sendPushToUser(username, message) {
    if (!pushEnabled || !username || !message) return;

    // Deduplicate by messageId
    if (message.id && recentlySent.has(message.id)) {
        return;
    }
    if (message.id) {
        recentlySent.set(message.id, Date.now());
    }

    const payload = buildNotificationPayload(message);
    if (!payload) return; // Skip (e.g., call events)

    const subscriptions = db.getPushSubscriptions(username);
    if (!subscriptions || subscriptions.length === 0) return;

    const payloadStr = JSON.stringify(payload);
    const pushOptions = {
        TTL: 60 * 60, // 1 hour TTL
        urgency: 'high',
        topic: payload.tag // Replace previous notification with same tag
    };

    const sendPromises = subscriptions.map(async (sub) => {
        const pushSub = {
            endpoint: sub.endpoint,
            keys: {
                p256dh: sub.keys_p256dh,
                auth: sub.keys_auth
            }
        };

        try {
            await webPush.sendNotification(pushSub, payloadStr, pushOptions);
            // Touch subscription to update last_used_at
            db.touchPushSubscription(sub.endpoint);
        } catch (err) {
            const statusCode = err.statusCode || 0;
            // 404 or 410 = subscription expired/invalid — remove it
            if (statusCode === 404 || statusCode === 410) {
                console.log(`[push] Removing expired subscription for ${username}: ${statusCode}`);
                db.deletePushSubscription(sub.endpoint);
            } else if (statusCode === 429) {
                console.warn(`[push] Rate limited for ${username}`);
            } else {
                console.error(`[push] Error sending to ${username}:`, err.message || err);
            }
        }
    });

    // Fire and forget — don't block the caller
    Promise.allSettled(sendPromises).catch(() => {});
}

/**
 * Get the VAPID public key for frontend subscription
 * @returns {string}
 */
function getVapidPublicKey() {
    return VAPID_PUBLIC_KEY;
}

/**
 * Check if push notifications are configured and enabled
 * @returns {boolean}
 */
function isPushEnabled() {
    return pushEnabled;
}

module.exports = {
    sendPushToUser,
    getVapidPublicKey,
    isPushEnabled
};
