const express = require('express');
const crypto = require('crypto');
const { isAuthenticated } = require('../middleware/auth');
const db = require('../database');
const { broadcastToUser, broadcastToBoth } = require('../utils/realtime');
const wt = require('../utils/wtAuth');
const { getCachedAvatars } = require('../utils/security');

const router = express.Router();
const USE_DO = wt.isDurableObjectsEnabled();
if (USE_DO) {
    console.log('[WT] Durable Objects mode ENABLED — rooms will run at Cloudflare edge');
} else {
    console.log('[WT] Durable Objects mode DISABLED — rooms will run in-memory on VPS');
}

// ============================================================
//  IN-MEMORY ROOM STORE
// ============================================================
const rooms = new Map();
const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours auto-cleanup
const DISCONNECT_GRACE_MS = 90 * 1000; // 90 seconds grace period for reloads/reconnects

function generateRoomId() {
    return crypto.randomBytes(6).toString('hex');
}

function cleanupStaleRooms() {
    const now = Date.now();
    for (const [id, room] of rooms) {
        if (now - room.lastActivity > ROOM_TTL_MS) {
            if (room.graceTimer) clearTimeout(room.graceTimer);
            for (const client of room.sseClients) {
                try { client.end(); } catch {}
            }
            rooms.delete(id);
            broadcastToBoth('muaj', 'hajera', 'watch-together-ended', {
                roomId: id,
                reason: 'Session expired after 2 hours'
            });
        }
    }
}

// Prune stale rooms every 10 minutes
setInterval(cleanupStaleRooms, 10 * 60 * 1000).unref();

function broadcastToRoom(room, event, data, excludeRes = null) {
    if (!room || !room.sseClients) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const deadClients = [];
    for (const client of room.sseClients) {
        if (client !== excludeRes) {
            try {
                client.write(payload);
                if (typeof client.flush === 'function') client.flush();
            } catch {
                deadClients.push(client);
            }
        }
    }
    for (const dead of deadClients) {
        room.sseClients.delete(dead);
    }
}

function getRoomByHost(username) {
    for (const [id, room] of rooms) {
        if (room.host === username) return { id, room };
    }
    return null;
}

// Fast in-memory cache lookup for user avatars to eliminate redundant SQLite queries
// on high-frequency Watch Together actions (join, chat, status polls, SSE stream setup).
function getUserAvatars() {
    try {
        return getCachedAvatars();
    } catch {
        return {};
    }
}

function getActiveRoomForUser(user) {
    const avatars = getUserAvatars();
    for (const [id, room] of rooms) {
        if (!room.active) continue;

        if (room.host === user) {
            return {
                roomId: id,
                videoId: room.videoId,
                videoTitle: room.videoTitle,
                host: room.host,
                guest: room.guest,
                role: 'host',
                videoState: room.videoState,
                memberCount: room.sseClients.size,
                avatars,
                createdAt: room.createdAt
            };
        }

        if (room.guest === user || (!room.guest && user !== room.host)) {
            return {
                roomId: id,
                videoId: room.videoId,
                videoTitle: room.videoTitle,
                host: room.host,
                guest: room.guest,
                role: room.guest === user ? 'guest' : 'invited',
                videoState: room.videoState,
                memberCount: room.sseClients.size,
                avatars,
                createdAt: room.createdAt
            };
        }
    }
    return null;
}

// ============================================================
//  API ROUTES
// ============================================================

// GET /watch-together/active — Check if there's an active room (for invite banner)
router.get('/watch-together/active', isAuthenticated, async (req, res) => {
    // DO mode: query the DO for active room state
    // Note: In DO mode, the VPS doesn't track rooms, so we use a lightweight
    // in-memory tracker that's populated on create/join. The DO is the source of truth.
    if (USE_DO && _doActiveRooms.size > 0) {
        const user = req.session.user;
        const avatars = getUserAvatars();
        for (const [roomId, info] of _doActiveRooms) {
            if (info.host === user || info.guest === user) {
                try {
                    const doState = await wt.getRoomStateFromDO(roomId);
                    if (doState && doState.active) {
                        return res.json({
                            roomId,
                            videoId: doState.videoId,
                            videoTitle: doState.videoTitle,
                            host: doState.host,
                            guest: doState.guest,
                            role: doState.host === user ? 'host' : (doState.guest === user ? 'guest' : 'invited'),
                            videoState: doState.videoState,
                            memberCount: doState.memberCount,
                            avatars,
                            createdAt: info.createdAt,
                            useDO: true,
                            wsUrl: wt.buildWsUrl(roomId, wt.generateWtToken({
                                roomId, user, role: doState.host === user ? 'host' : 'guest'
                            }))
                        });
                    } else {
                        // Room expired on DO side — clean up tracker
                        _doActiveRooms.delete(roomId);
                    }
                } catch {
                    _doActiveRooms.delete(roomId);
                }
            }
        }
        return res.json(null);
    }

    const user = req.session.user;
    const active = getActiveRoomForUser(user);
    res.json(active);
});

// POST /watch-together/create — Host creates a room
router.post('/watch-together/create', isAuthenticated, async (req, res) => {
    const { videoId, videoTitle, currentTime, playing, playbackRate } = req.body;
    const hostUser = req.session.user;
    const inviteeUser = hostUser === 'muaj' ? 'hajera' : 'muaj';

    if (!videoId) {
        return res.status(400).json({ error: 'videoId required' });
    }

    // Verify video exists in database
    let videoRow = null;
    try {
        videoRow = db.prepare('SELECT id, title FROM videos WHERE id = ?').get(videoId);
    } catch (e) {
        console.error('[WT] DB query error:', e);
    }

    if (!videoRow) {
        return res.status(404).json({ error: 'Video not found' });
    }

    const resolvedTitle = (videoTitle || videoRow.title || 'Untitled Video').trim();
    const roomId = generateRoomId();
    const videoState = {
        currentTime: typeof currentTime === 'number' ? Math.max(0, currentTime) : 0,
        playing: typeof playing === 'boolean' ? playing : false,
        playbackRate: typeof playbackRate === 'number' && playbackRate > 0 ? playbackRate : 1
    };
    const avatars = getUserAvatars();

    // ─── Durable Objects path ────────────────────────────────────────
    if (USE_DO) {
        try {
            // Clean up any existing DO room by this host
            for (const [oldId, info] of _doActiveRooms) {
                if (info.host === hostUser) {
                    wt.leaveRoomOnDO(oldId, hostUser).catch(() => {});
                    _doActiveRooms.delete(oldId);
                    broadcastToUser(inviteeUser, 'watch-together-ended', {
                        roomId: oldId,
                        reason: 'Host started a new session'
                    });
                }
            }

            // Create room on Durable Object
            await wt.createRoomOnDO({
                roomId, videoId, videoTitle: resolvedTitle,
                host: hostUser, videoState, avatars
            });

            // Track locally for /active endpoint
            _doActiveRooms.set(roomId, {
                host: hostUser, guest: null, createdAt: Date.now()
            });

            // Generate auth token for host WebSocket
            const token = wt.generateWtToken({ roomId, user: hostUser, role: 'host' });
            const wsUrl = wt.buildWsUrl(roomId, token);

            // Broadcast invite to partner via VPS SSE (stays on VPS)
            broadcastToUser(inviteeUser, 'watch-together-invite', {
                roomId, videoId, videoTitle: resolvedTitle,
                host: hostUser, createdAt: Date.now(), videoState,
                useDO: true
            });

            return res.json({
                roomId, videoId, videoTitle: resolvedTitle,
                host: hostUser, videoState,
                useDO: true, wsUrl, token
            });
        } catch (err) {
            console.error('[WT-DO] Create failed, falling back to VPS:', err.message);
            // Fall through to VPS implementation
        }
    }

    // ─── VPS in-memory path (original) ───────────────────────────────
    // Close any existing room by this host
    const existing = getRoomByHost(hostUser);
    if (existing) {
        if (existing.room.graceTimer) clearTimeout(existing.room.graceTimer);
        broadcastToRoom(existing.room, 'room-closed', { reason: 'Host started a new session' });
        for (const client of existing.room.sseClients) {
            try { client.end(); } catch {}
        }
        rooms.delete(existing.id);
        broadcastToUser(inviteeUser, 'watch-together-ended', {
            roomId: existing.id,
            reason: 'Host started a new session'
        });
    }

    const room = {
        videoId,
        videoTitle: resolvedTitle,
        host: hostUser,
        guest: null,
        active: true,
        videoState,
        chatHistory: [],
        sseClients: new Set(),
        createdAt: Date.now(),
        lastActivity: Date.now(),
        graceTimer: null
    };

    rooms.set(roomId, room);

    // Broadcast instant real-time notification to the partner user across all routes
    broadcastToUser(inviteeUser, 'watch-together-invite', {
        roomId,
        videoId,
        videoTitle: resolvedTitle,
        host: hostUser,
        createdAt: room.createdAt,
        videoState: room.videoState
    });

    res.json({
        roomId,
        videoId,
        videoTitle: resolvedTitle,
        host: hostUser,
        videoState: room.videoState
    });
});

// POST /watch-together/join/:roomId — Guest joins a room
router.post('/watch-together/join/:roomId', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    const avatars = getUserAvatars();
    const roomId = req.params.roomId;

    // ─── Durable Objects path ────────────────────────────────────────
    if (USE_DO && _doActiveRooms.has(roomId)) {
        try {
            const doState = await wt.getRoomStateFromDO(roomId);
            if (!doState || !doState.active) {
                _doActiveRooms.delete(roomId);
                return res.status(404).json({ error: 'Room not found or inactive' });
            }

            const role = doState.host === user ? 'host' : 'guest';
            const token = wt.generateWtToken({ roomId, user, role });
            const wsUrl = wt.buildWsUrl(roomId, token);

            // Track guest locally
            const info = _doActiveRooms.get(roomId);
            if (info) info.guest = user;

            return res.json({
                status: role === 'host' ? 'already-host' : 'joined',
                videoId: doState.videoId,
                videoTitle: doState.videoTitle,
                host: doState.host,
                videoState: doState.videoState,
                chatHistory: [],  // Chat is delivered via WebSocket on connect
                avatars,
                useDO: true, wsUrl, token
            });
        } catch (err) {
            console.error('[WT-DO] Join failed:', err.message);
            _doActiveRooms.delete(roomId);
            return res.status(404).json({ error: 'Room not found or inactive' });
        }
    }

    // ─── VPS in-memory path (original) ───────────────────────────────
    const room = rooms.get(roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found or inactive' });
    }

    // Cancel any disconnect grace timer
    if (room.graceTimer) {
        clearTimeout(room.graceTimer);
        room.graceTimer = null;
    }

    if (user === room.host) {
        return res.json({
            status: 'already-host',
            videoId: room.videoId,
            videoTitle: room.videoTitle,
            host: room.host,
            videoState: room.videoState,
            chatHistory: room.chatHistory.slice(-50),
            avatars
        });
    }

    room.guest = user;
    room.lastActivity = Date.now();

    // Notify host via room SSE
    broadcastToRoom(room, 'user-joined', {
        user,
        memberCount: room.sseClients.size,
        avatars
    });

    // Notify global stream of status update
    broadcastToBoth('muaj', 'hajera', 'watch-together-status', {
        roomId: req.params.roomId,
        active: true,
        guest: user,
        memberCount: room.sseClients.size
    });

    res.json({
        status: 'joined',
        videoId: room.videoId,
        videoTitle: room.videoTitle,
        host: room.host,
        videoState: room.videoState,
        chatHistory: room.chatHistory.slice(-50),
        avatars
    });
});

// POST /watch-together/leave/:roomId — Leave or stop the room
router.post('/watch-together/leave/:roomId', isAuthenticated, async (req, res) => {
    const user = req.session.user;
    const roomId = req.params.roomId;

    // ─── Durable Objects path ────────────────────────────────────────
    if (USE_DO && _doActiveRooms.has(roomId)) {
        try {
            await wt.leaveRoomOnDO(roomId, user);
        } catch (err) {
            console.error('[WT-DO] Leave failed:', err.message);
        }
        _doActiveRooms.delete(roomId);

        // Notify global SSE so invite banners are cleared
        broadcastToBoth('muaj', 'hajera', 'watch-together-ended', {
            roomId,
            reason: user === (_doActiveRooms.get(roomId)?.host) ? 'Host ended the session' : 'Guest left'
        });

        return res.json({ status: 'ok' });
    }

    // ─── VPS in-memory path (original) ───────────────────────────────
    const room = rooms.get(roomId);
    if (!room) return res.json({ status: 'ok' });

    if (user === room.host) {
        // Host explicitly ending the session
        room.active = false;
        if (room.graceTimer) {
            clearTimeout(room.graceTimer);
            room.graceTimer = null;
        }

        broadcastToRoom(room, 'room-closed', { reason: 'Host ended the session' });
        for (const client of room.sseClients) {
            try { client.end(); } catch {}
        }
        rooms.delete(roomId);

        // Notify global SSE so floating invite/status is cleared for both users
        broadcastToBoth('muaj', 'hajera', 'watch-together-ended', {
            roomId,
            reason: 'Host ended the session'
        });
    } else {
        // Guest leaving
        room.guest = null;
        room.lastActivity = Date.now();
        broadcastToRoom(room, 'user-left', { user });

        broadcastToBoth('muaj', 'hajera', 'watch-together-status', {
            roomId,
            active: true,
            guest: null,
            memberCount: room.sseClients.size
        });
    }

    res.json({ status: 'ok' });
});

// POST /watch-together/sync/:roomId — Host sends video state sync
router.post('/watch-together/sync/:roomId', isAuthenticated, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const user = req.session.user;
    if (user !== room.host) {
        return res.status(403).json({ error: 'Only host can broadcast playback sync' });
    }

    const { currentTime, playing, playbackRate, action } = req.body;

    room.videoState = {
        currentTime: typeof currentTime === 'number' ? Math.max(0, currentTime) : (Number(currentTime) || 0),
        playing: !!playing,
        playbackRate: typeof playbackRate === 'number' && playbackRate > 0 ? playbackRate : (Number(playbackRate) || 1)
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
        guest: room.guest,
        timestamp: Date.now()
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

// GET /watch-together/stream/:roomId — SSE stream for real-time room events
router.get('/watch-together/stream/:roomId', isAuthenticated, (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (!room || !room.active) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const user = req.session.user;
    const avatars = getUserAvatars();

    // Cancel any disconnect grace timer since a client has connected
    if (room.graceTimer) {
        clearTimeout(room.graceTimer);
        room.graceTimer = null;
    }

    // SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

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
        user
    })}\n\n`);

    room.sseClients.add(res);

    // Keepalive every 15 seconds
    const keepalive = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
            if (typeof res.flush === 'function') res.flush();
        } catch {
            clearInterval(keepalive);
            room.sseClients.delete(res);
        }
    }, 15000);

    req.on('close', () => {
        clearInterval(keepalive);
        room.sseClients.delete(res);

        // Notify others in the room
        broadcastToRoom(room, 'user-disconnected', {
            user,
            memberCount: room.sseClients.size
        });

        // If no clients are connected and room is active, start grace period
        if (room.sseClients.size === 0 && room.active && !room.graceTimer) {
            room.graceTimer = setTimeout(() => {
                const currentRoom = rooms.get(req.params.roomId);
                if (currentRoom && currentRoom.sseClients.size === 0) {
                    currentRoom.active = false;
                    rooms.delete(req.params.roomId);
                    broadcastToBoth('muaj', 'hajera', 'watch-together-ended', {
                        roomId: req.params.roomId,
                        reason: 'Session closed due to inactivity'
                    });
                }
            }, DISCONNECT_GRACE_MS);
        }
    });
});

// POST /watch-together/refresh-token/:roomId — Get a fresh auth token for WebSocket reconnection
router.post('/watch-together/refresh-token/:roomId', isAuthenticated, (req, res) => {
    if (!USE_DO) {
        return res.status(404).json({ error: 'Durable Objects not enabled' });
    }

    const user = req.session.user;
    const roomId = req.params.roomId;
    const info = _doActiveRooms.get(roomId);

    if (!info) {
        return res.status(404).json({ error: 'Room not found' });
    }

    const role = info.host === user ? 'host' : 'guest';
    const token = wt.generateWtToken({ roomId, user, role });
    const wsUrl = wt.buildWsUrl(roomId, token);

    res.json({ token, wsUrl });
});

// ============================================================
//  DO ACTIVE ROOM TRACKER (lightweight VPS-side index)
//  Maps roomId → { host, guest, createdAt }
//  Populated on create/join, cleaned up on leave/expiry.
//  NOT the source of truth — the DO storage is.
// ============================================================
const _doActiveRooms = new Map();

// Clean up stale DO room trackers every 10 minutes
setInterval(() => {
    const now = Date.now();
    for (const [id, info] of _doActiveRooms) {
        // Remove trackers older than 2.5 hours (room TTL is 2 hours + buffer)
        if (now - info.createdAt > 2.5 * 60 * 60 * 1000) {
            _doActiveRooms.delete(id);
        }
    }
}, 10 * 60 * 1000).unref();

module.exports = router;
module.exports.getActiveRoomForUser = getActiveRoomForUser;
