const express = require('express');
const crypto = require('crypto');
const { isAuthenticated, isMuaj } = require('../middleware/auth');
const db = require('../database');

const router = express.Router();

// ============================================================
//  IN-MEMORY ROOM STORE
// ============================================================
const rooms = new Map();
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours auto-cleanup

function generateRoomId() {
    return crypto.randomBytes(6).toString('hex');
}

function cleanupStaleRooms() {
    const now = Date.now();
    for (const [id, room] of rooms) {
        if (now - room.lastActivity > ROOM_TTL_MS) {
            // Close all SSE clients
            for (const client of room.sseClients) {
                try { client.end(); } catch {}
            }
            rooms.delete(id);
        }
    }
}

// Prune stale rooms every 10 minutes
setInterval(cleanupStaleRooms, 10 * 60 * 1000).unref();

function broadcastToRoom(room, event, data, excludeRes = null) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of room.sseClients) {
        if (client !== excludeRes) {
            try { client.write(payload); } catch {}
        }
    }
}

function getRoomByHost(username) {
    for (const [id, room] of rooms) {
        if (room.host === username) return { id, room };
    }
    return null;
}

function getUserAvatars() {
    try {
        return (typeof db.getAllUserAvatars === 'function') ? db.getAllUserAvatars() : {};
    } catch {
        return {};
    }
}

function getActiveRoomForVideo(videoId) {
    for (const [id, room] of rooms) {
        if (room.videoId === videoId && room.active) return { id, room };
    }
    return null;
}

// ============================================================
//  API ROUTES
// ============================================================

// GET /watch-together/active — Check if there's an active room (for invite banner)
router.get('/watch-together/active', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const avatars = getUserAvatars();

    for (const [id, room] of rooms) {
        if (!room.active) continue;

        // If user is the host, return their room
        if (room.host === user) {
            return res.json({
                roomId: id,
                videoId: room.videoId,
                videoTitle: room.videoTitle,
                host: room.host,
                guest: room.guest,
                role: 'host',
                videoState: room.videoState,
                memberCount: room.sseClients.size,
                avatars
            });
        }

        // If user is the guest or room is open for them
        if (room.guest === user || (!room.guest && user !== room.host)) {
            return res.json({
                roomId: id,
                videoId: room.videoId,
                videoTitle: room.videoTitle,
                host: room.host,
                guest: room.guest,
                role: room.guest === user ? 'guest' : 'invited',
                videoState: room.videoState,
                memberCount: room.sseClients.size,
                avatars
            });
        }
    }

    res.json(null);
});

// POST /watch-together/create — Host creates a room
router.post('/watch-together/create', isMuaj, (req, res) => {
    const { videoId, videoTitle } = req.body;

    if (!videoId) {
        return res.status(400).json({ error: 'videoId required' });
    }

    // Resolve title from DB if not passed
    let resolvedTitle = (videoTitle || '').trim();
    if (!resolvedTitle) {
        try {
            const row = db.prepare('SELECT title FROM videos WHERE id = ?').get(videoId);
            if (row && row.title) resolvedTitle = row.title;
        } catch {}
    }
    if (!resolvedTitle) resolvedTitle = 'Untitled Video';

    // Close any existing room by this host
    const existing = getRoomByHost('muaj');
    if (existing) {
        broadcastToRoom(existing.room, 'room-closed', { reason: 'Host started a new session' });
        for (const client of existing.room.sseClients) {
            try { client.end(); } catch {}
        }
        rooms.delete(existing.id);
    }

    const roomId = generateRoomId();
    const room = {
        videoId,
        videoTitle: resolvedTitle,
        host: 'muaj',
        guest: null,
        active: true,
        videoState: {
            currentTime: 0,
            playing: false,
            playbackRate: 1
        },
        chatHistory: [],
        sseClients: new Set(),
        createdAt: Date.now(),
        lastActivity: Date.now()
    };

    rooms.set(roomId, room);

    res.json({ roomId, videoId, videoTitle: resolvedTitle });
});

// POST /watch-together/join/:roomId — Guest joins a room
router.post('/watch-together/join/:roomId', isAuthenticated, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found or inactive' });
    }

    const user = req.session.user;
    const avatars = getUserAvatars();

    if (user === room.host) {
        return res.json({ status: 'already-host', videoState: room.videoState, avatars });
    }

    room.guest = user;
    room.lastActivity = Date.now();

    // Notify host
    broadcastToRoom(room, 'user-joined', {
        user,
        memberCount: room.sseClients.size,
        avatars
    });

    res.json({
        status: 'joined',
        videoId: room.videoId,
        videoTitle: room.videoTitle,
        videoState: room.videoState,
        chatHistory: room.chatHistory.slice(-50),
        avatars
    });
});

// POST /watch-together/leave/:roomId — Leave the room
router.post('/watch-together/leave/:roomId', isAuthenticated, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room) return res.json({ status: 'ok' });

    const user = req.session.user;

    if (user === room.host) {
        // Host leaving = close room
        room.active = false;
        broadcastToRoom(room, 'room-closed', { reason: 'Host left the session' });
        for (const client of room.sseClients) {
            try { client.end(); } catch {}
        }
        rooms.delete(req.params.roomId);
    } else {
        room.guest = null;
        broadcastToRoom(room, 'user-left', { user });
    }

    res.json({ status: 'ok' });
});

// POST /watch-together/sync/:roomId — Host sends video state sync
router.post('/watch-together/sync/:roomId', isMuaj, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const { currentTime, playing, playbackRate, action } = req.body;

    room.videoState = {
        currentTime: Number(currentTime) || 0,
        playing: !!playing,
        playbackRate: Number(playbackRate) || 1
    };
    room.lastActivity = Date.now();

    broadcastToRoom(room, 'sync', {
        ...room.videoState,
        action: action || 'update',
        timestamp: Date.now()
    });

    res.json({ status: 'ok' });
});

// GET /watch-together/sync-state/:roomId — Guest requests latest sync state
router.get('/watch-together/sync-state/:roomId', isAuthenticated, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found' });
    }

    res.json({
        videoState: room.videoState,
        active: room.active,
        host: room.host,
        guest: room.guest
    });
});

// POST /watch-together/reaction/:roomId — Send an instant live emoji reaction
router.post('/watch-together/reaction/:roomId', isAuthenticated, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const user = req.session.user;
    const emoji = String(req.body.emoji || '💖').trim().slice(0, 10);

    room.lastActivity = Date.now();

    broadcastToRoom(room, 'reaction', {
        user,
        emoji,
        timestamp: Date.now()
    });

    res.json({ status: 'ok' });
});

// POST /watch-together/chat/:roomId — Send a chat message
router.post('/watch-together/chat/:roomId', isAuthenticated, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const user = req.session.user;
    const avatars = getUserAvatars();
    const text = String(req.body.text || '').trim().slice(0, 500);

    if (!text) {
        return res.status(400).json({ error: 'Empty message' });
    }

    const message = {
        id: crypto.randomBytes(4).toString('hex'),
        user,
        avatar: avatars[user] || null,
        text,
        timestamp: Date.now()
    };

    room.chatHistory.push(message);
    room.lastActivity = Date.now();

    // Keep only last 100 messages
    if (room.chatHistory.length > 100) {
        room.chatHistory = room.chatHistory.slice(-100);
    }

    broadcastToRoom(room, 'chat', message);

    res.json({ status: 'ok', message });
});

// GET /watch-together/stream/:roomId — SSE stream for real-time events
router.get('/watch-together/stream/:roomId', isAuthenticated, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const avatars = getUserAvatars();

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    // Send initial state
    res.write(`event: connected\ndata: ${JSON.stringify({
        roomId: req.params.roomId,
        videoId: room.videoId,
        videoTitle: room.videoTitle,
        host: room.host,
        guest: room.guest,
        videoState: room.videoState,
        chatHistory: room.chatHistory.slice(-50),
        avatars,
        user: req.session.user
    })}\n\n`);

    room.sseClients.add(res);

    // Keepalive every 15 seconds
    const keepalive = setInterval(() => {
        try { res.write(': keepalive\n\n'); } catch {}
    }, 15000);

    req.on('close', () => {
        clearInterval(keepalive);
        room.sseClients.delete(res);

        // Notify others
        broadcastToRoom(room, 'user-disconnected', {
            user: req.session.user,
            memberCount: room.sseClients.size
        });
    });
});

module.exports = router;
