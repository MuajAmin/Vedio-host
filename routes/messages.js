const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { isAuthenticated } = require('../middleware/auth');
const { requireCsrf, invalidateUnreadCache } = require('../utils/security');
const db = require('../database');
const { parseUserAgent, getClientIp } = require('../utils/device');

const router = express.Router();

// Ensure voice uploads directory exists
const voiceDir = path.join(__dirname, '..', 'uploads', 'voice');
if (!fs.existsSync(voiceDir)) {
    fs.mkdirSync(voiceDir, { recursive: true });
}

// Multer storage for voice audio notes
const voiceStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, voiceDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.webm';
        const sender = req.session ? req.session.user : 'user';
        cb(null, `voice-${sender}-${Date.now()}${ext}`);
    }
});

const voiceUpload = multer({
    storage: voiceStorage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
    fileFilter: (req, file, cb) => {
        const allowedExt = new Set(['.webm', '.ogg', '.mp3', '.wav', '.m4a', '.aac', '.mp4']);
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowedExt.has(ext) || (file.mimetype && file.mimetype.startsWith('audio/'))) {
            return cb(null, true);
        }
        cb(new Error('Only audio recordings are allowed.'));
    }
});

// ============================================================
//  SSE REAL-TIME CLIENT STORE
// ============================================================
const sseClients = new Map(); // username -> Set of res objects

function addSseClient(username, res) {
    if (!sseClients.has(username)) {
        sseClients.set(username, new Set());
    }
    sseClients.get(username).add(res);
}

function removeSseClient(username, res) {
    if (sseClients.has(username)) {
        const clientSet = sseClients.get(username);
        clientSet.delete(res);
        if (clientSet.size === 0) {
            sseClients.delete(username);
        }
    }
}

function broadcastToUser(username, event, data) {
    if (!sseClients.has(username)) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients.get(username)) {
        try {
            client.write(payload);
            if (typeof client.flush === 'function') client.flush();
        } catch {
            // client disconnected
        }
    }
}

function broadcastToBoth(user1, user2, event, data) {
    broadcastToUser(user1, event, data);
    if (user1 !== user2) {
        broadcastToUser(user2, event, data);
    }
}

function getPartner(currentUser) {
    return currentUser === 'muaj' ? 'hajera' : 'muaj';
}

// ============================================================
//  ROUTES
// ============================================================

// GET /messages — Dedicated Full-Screen Chat View
router.get('/messages', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const partner = getPartner(user);
    const partnerPresence = db.getUserPresence(partner);
    const stats = db.getMessageStats(user, partner);
    const initialMessages = db.getConversationMessages(user, partner, 60);

    // Auto mark partner's messages as read when opening page
    const readCount = db.markMessagesAsRead(partner, user);
    if (readCount > 0) {
        invalidateUnreadCache();
        broadcastToUser(partner, 'messages-read', {
            readBy: user,
            readAt: new Date().toISOString(),
            count: readCount
        });
    }

    const currentUnread = db.getUnreadMessageCount(user);
    invalidateUnreadCache(user);
    broadcastToUser(user, 'unread-count', {
        unreadCount: currentUnread
    });
    res.locals.unreadCount = currentUnread;

    // Get list of recent videos for quick "Attach Video" modal/drawer
    const videos = db.prepare(`
        SELECT id, title, thumbnail, duration, uploaded_by, uploaded_at
        FROM videos
        ORDER BY uploaded_at DESC
        LIMIT 30
    `).all();

    res.render('messages', {
        user,
        partner,
        partnerPresence,
        stats,
        initialMessages,
        videos,
        unreadCount: currentUnread,
        pageTitle: 'Messages — ' + (partner === 'muaj' ? 'Muaj' : 'Hajera')
    });
});

// GET /messages/stream — Server-Sent Events (SSE) Stream
router.get('/messages/stream', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const partner = getPartner(user);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    // Send initial connected state
    res.write(`event: connected\ndata: ${JSON.stringify({
        user,
        partner,
        unreadCount: db.getUnreadMessageCount(user),
        partnerPresence: db.getUserPresence(partner)
    })}\n\n`);

    addSseClient(user, res);

    // Keepalive ping every 15 seconds
    const keepalive = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
            if (typeof res.flush === 'function') res.flush();
        } catch {
            clearInterval(keepalive);
        }
    }, 15000);

    req.on('close', () => {
        clearInterval(keepalive);
        removeSseClient(user, res);
    });
});

// GET /api/messages — Fetch conversation history (pagination)
router.get('/api/messages', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const partner = getPartner(user);
    const limit = parseInt(req.query.limit, 10) || 50;
    const beforeId = req.query.beforeId ? parseInt(req.query.beforeId, 10) : null;

    const messages = db.getConversationMessages(user, partner, limit, beforeId);
    res.json({ success: true, messages });
});

// POST /api/messages — Send text message or attached video
router.post('/api/messages', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const partner = getPartner(user);
    const text = req.body.text ? String(req.body.text).trim().slice(0, 4000) : null;
    const videoId = req.body.videoId ? String(req.body.videoId).trim() : null;

    if (!text && !videoId) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
    }

    // Verify video exists if videoId passed
    if (videoId) {
        const v = db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId);
        if (!v) return res.status(404).json({ error: 'Video not found.' });
    }

    const saved = db.saveMessage({
        sender: user,
        recipient: partner,
        text,
        videoId
    });

    if (!saved) {
        return res.status(500).json({ error: 'Failed to send message.' });
    }

    // Invalidate in-memory unread cache
    invalidateUnreadCache();

    // Broadcast new message per user with accurate unread counts
    const partnerUnread = db.getUnreadMessageCount(partner);
    const senderUnread = db.getUnreadMessageCount(user);

    broadcastToUser(partner, 'new-message', {
        message: saved,
        unreadCount: partnerUnread
    });
    broadcastToUser(user, 'new-message', {
        message: saved,
        unreadCount: senderUnread
    });

    // Log activity
    const deviceInfo = parseUserAgent(req.headers['user-agent']);
    const ipAddress = getClientIp(req);
    db.logActivity(user, 'message_sent', {
        details: videoId ? `Shared video: ${saved.video ? saved.video.title : 'video'}` : (text.length > 50 ? text.slice(0, 50) + '...' : text),
        deviceInfo,
        ipAddress
    });

    res.json({ success: true, message: saved });
});

// POST /api/messages/voice — Upload and send voice audio note
router.post('/api/messages/voice', isAuthenticated, (req, res) => {
    voiceUpload.single('audio')(req, res, (err) => {
        if (err) {
            return res.status(400).json({ error: err.message || 'Voice recording upload failed.' });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No audio recorded.' });
        }

        const user = req.session.user;
        const partner = getPartner(user);
        const voiceUrl = `/voice/${req.file.filename}`;
        const text = req.body.caption ? String(req.body.caption).trim().slice(0, 500) : null;

        const saved = db.saveMessage({
            sender: user,
            recipient: partner,
            text,
            voiceUrl
        });

        if (!saved) {
            fs.promises.unlink(req.file.path).catch(() => {});
            return res.status(500).json({ error: 'Failed to save voice message.' });
        }

        // Invalidate in-memory unread cache
        invalidateUnreadCache();

        const partnerUnread = db.getUnreadMessageCount(partner);
        const senderUnread = db.getUnreadMessageCount(user);

        broadcastToUser(partner, 'new-message', {
            message: saved,
            unreadCount: partnerUnread
        });
        broadcastToUser(user, 'new-message', {
            message: saved,
            unreadCount: senderUnread
        });

        res.json({ success: true, message: saved });
    });
});

// POST /api/messages/read — Mark conversation messages as read
router.post('/api/messages/read', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const partner = getPartner(user);

    const changes = db.markMessagesAsRead(partner, user);
    if (changes > 0) {
        invalidateUnreadCache();
        broadcastToUser(partner, 'messages-read', {
            readBy: user,
            readAt: new Date().toISOString(),
            count: changes
        });
    }

    const remainingUnread = db.getUnreadMessageCount(user);
    invalidateUnreadCache(user);

    // Always ensure reader's active tabs receive accurate remaining unread count
    broadcastToUser(user, 'unread-count', {
        unreadCount: remainingUnread
    });

    res.json({ success: true, readCount: changes, unreadCount: remainingUnread });
});

// POST /api/messages/react — Toggle emoji reaction on message
router.post('/api/messages/react', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const partner = getPartner(user);
    const messageId = parseInt(req.body.messageId, 10);
    const reaction = req.body.reaction ? String(req.body.reaction).trim() : '';

    if (!messageId || !reaction) {
        return res.status(400).json({ error: 'Message ID and reaction are required.' });
    }

    const result = db.toggleMessageReaction(messageId, user, reaction);
    if (!result) {
        return res.status(500).json({ error: 'Failed to update reaction.' });
    }

    broadcastToBoth(user, partner, 'message-reaction', {
        messageId,
        user,
        reaction,
        action: result.action,
        reactions: result.reactions
    });

    res.json({ success: true, ...result });
});

// POST /api/messages/typing — Broadcast typing indicator
router.post('/api/messages/typing', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const partner = getPartner(user);
    const isTyping = !!req.body.isTyping;

    broadcastToUser(partner, 'user-typing', {
        user,
        isTyping
    });

    res.json({ success: true });
});

// POST /api/messages/delete/:id — Delete message
router.post('/api/messages/delete/:id', isAuthenticated, (req, res) => {
    const messageId = parseInt(req.params.id, 10);
    const user = req.session.user;
    const partner = getPartner(user);

    const msg = db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId);
    if (!msg) {
        return res.status(404).json({ error: 'Message not found.' });
    }

    const wasUnread = msg.is_read === 0;

    const deleted = db.deleteMessage(messageId, user);
    if (!deleted) {
        return res.status(403).json({ error: 'Not allowed to delete this message.' });
    }

    if (wasUnread) {
        invalidateUnreadCache();
        const partnerRemaining = db.getUnreadMessageCount(partner);
        const senderRemaining = db.getUnreadMessageCount(user);
        broadcastToUser(partner, 'unread-count', { unreadCount: partnerRemaining });
        broadcastToUser(user, 'unread-count', { unreadCount: senderRemaining });
    }

    // Delete voice file if it was a voice message
    if (msg.voice_url && msg.voice_url.startsWith('/voice/')) {
        const voiceFileName = path.basename(msg.voice_url);
        const voiceFilePath = path.join(voiceDir, voiceFileName);
        if (fs.existsSync(voiceFilePath)) {
            fs.promises.unlink(voiceFilePath).catch(() => {});
        }
    }

    broadcastToBoth(user, partner, 'message-deleted', {
        messageId
    });

    res.json({ success: true, messageId });
});

// GET /api/messages/unread-count — Unread message count badge
router.get('/api/messages/unread-count', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const unreadCount = db.getUnreadMessageCount(user);
    res.json({ unreadCount });
});

module.exports = router;
