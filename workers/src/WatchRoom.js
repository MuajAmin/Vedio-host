// =============================================================================
//  Watch Together — WatchRoom Durable Object
//  Each room instance = one active Watch Together session.
//  Holds WebSocket connections, playback state, chat history.
//  Single-threaded actor model — no concurrency conflicts.
// =============================================================================

import { validateToken } from './auth.js';

// Room auto-cleanup timers
const ROOM_TTL_MS = 2 * 60 * 60 * 1000;       // 2 hours max room lifetime
const DISCONNECT_GRACE_MS = 90 * 1000;          // 90s grace period after all users disconnect
const REPLAY_BUFFER_SIZE = 50;                   // Max events kept for reconnection replay

export class WatchRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;

        // ─── Transient state (in-memory only, lost on eviction) ──────
        this.sockets = new Map();     // WebSocket → { user, role, connectedAt }
        this.videoState = {
            currentTime: 0,
            playing: false,
            playbackRate: 1,
            lastSyncAt: Date.now()
        };
        this.seq = 0;                 // Monotonic sequence number for reliable delivery
        this.replayBuffer = [];       // Last N broadcast messages for reconnection replay
        this.initialized = false;

        // ─── Persisted state (loaded from DO storage in initialize()) ─
        this.roomConfig = null;       // { roomId, videoId, videoTitle, host, guest, avatars, createdAt }
        this.chatHistory = [];        // Array of { id, user, avatar, text, timestamp }
        this.active = false;
    }

    /**
     * Load persisted state from DO storage on first access.
     * Called once per DO wake-up (after eviction or cold start).
     */
    async initialize() {
        if (this.initialized) return;

        const stored = await this.state.storage.get([
            'roomConfig', 'chatHistory', 'active', 'seq'
        ]);

        this.roomConfig = stored.get('roomConfig') || null;
        this.chatHistory = stored.get('chatHistory') || [];
        this.active = stored.get('active') ?? false;
        this.seq = stored.get('seq') || 0;

        // videoState starts empty — reconnecting host will send fresh state
        this.videoState = {
            currentTime: 0,
            playing: false,
            playbackRate: 1,
            lastSyncAt: Date.now()
        };

        this.initialized = true;
    }

    // =========================================================================
    //  HTTP Request Handler (entry point for all DO requests)
    // =========================================================================

    async fetch(request) {
        await this.initialize();

        const url = new URL(request.url);
        const path = url.pathname;

        // WebSocket upgrade
        if (request.headers.get('Upgrade') === 'websocket') {
            return this.handleWebSocketUpgrade(request, url);
        }

        // REST API routes
        if (path.endsWith('/create') && request.method === 'POST') {
            return this.handleCreate(request);
        }

        if (path.endsWith('/state') && request.method === 'GET') {
            return this.handleGetState();
        }

        if (path.endsWith('/leave') && request.method === 'POST') {
            return this.handleLeave(request);
        }

        return new Response('Not Found', { status: 404 });
    }

    // =========================================================================
    //  Room Creation
    // =========================================================================

    async handleCreate(request) {
        try {
            const body = await request.json();
            const { roomId, videoId, videoTitle, host, videoState, avatars } = body;

            if (!roomId || !videoId || !host) {
                return jsonResponse({ error: 'Missing required fields' }, 400);
            }

            // Initialize room config
            this.roomConfig = {
                roomId,
                videoId,
                videoTitle: videoTitle || 'Untitled Video',
                host,
                guest: null,
                avatars: avatars || {},
                createdAt: Date.now()
            };

            this.active = true;
            this.chatHistory = [];
            this.seq = 0;
            this.replayBuffer = [];

            if (videoState) {
                this.videoState = {
                    currentTime: Math.max(0, Number(videoState.currentTime) || 0),
                    playing: !!videoState.playing,
                    playbackRate: (Number(videoState.playbackRate) > 0 ? Number(videoState.playbackRate) : 1),
                    lastSyncAt: Date.now()
                };
            }

            // Persist room config
            await this.state.storage.put({
                roomConfig: this.roomConfig,
                chatHistory: this.chatHistory,
                active: true,
                seq: 0
            });

            // Set max room lifetime alarm (2 hours)
            await this.state.storage.setAlarm(Date.now() + ROOM_TTL_MS);

            return jsonResponse({
                status: 'created',
                roomId,
                videoId,
                videoTitle: this.roomConfig.videoTitle,
                host
            });
        } catch (err) {
            return jsonResponse({ error: 'Failed to create room', details: err.message }, 500);
        }
    }

    // =========================================================================
    //  Room State Query
    // =========================================================================

    handleGetState() {
        if (!this.roomConfig || !this.active) {
            return jsonResponse({ error: 'Room not found or inactive' }, 404);
        }

        return jsonResponse({
            roomId: this.roomConfig.roomId,
            videoId: this.roomConfig.videoId,
            videoTitle: this.roomConfig.videoTitle,
            host: this.roomConfig.host,
            guest: this.roomConfig.guest,
            videoState: this.videoState,
            active: this.active,
            memberCount: this.sockets.size,
            timestamp: Date.now()
        });
    }

    // =========================================================================
    //  Room Leave (via HTTP — for when WebSocket is already closed)
    // =========================================================================

    async handleLeave(request) {
        try {
            const body = await request.json();
            const { user } = body;

            if (!this.roomConfig || !user) {
                return jsonResponse({ status: 'ok' });
            }

            if (user === this.roomConfig.host) {
                // Host ending session
                await this.closeRoom('Host ended the session');
            } else {
                // Guest leaving
                this.roomConfig.guest = null;
                await this.state.storage.put('roomConfig', this.roomConfig);

                this.broadcast('user-left', { user });
            }

            return jsonResponse({ status: 'ok' });
        } catch (err) {
            return jsonResponse({ status: 'ok' });
        }
    }

    // =========================================================================
    //  WebSocket Handling
    // =========================================================================

    async handleWebSocketUpgrade(request, url) {
        if (!this.roomConfig || !this.active) {
            return new Response('Room not found or inactive', { status: 404 });
        }

        // Validate auth token from query string
        const token = url.searchParams.get('token');
        const authResult = await validateToken(token, this.env.WT_SHARED_SECRET);

        if (!authResult.valid) {
            return new Response(`Unauthorized: ${authResult.error}`, { status: 401 });
        }

        const { user, role } = authResult.payload;

        // Verify the token is for this room
        if (authResult.payload.roomId !== this.roomConfig.roomId) {
            return new Response('Token room mismatch', { status: 403 });
        }

        // Create WebSocket pair
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);

        // Accept the server side with hibernation tags
        this.state.acceptWebSocket(server, [user, role]);

        // Track connection
        this.sockets.set(server, {
            user,
            role,
            connectedAt: Date.now()
        });

        // Update guest if joining
        if (role === 'guest' && !this.roomConfig.guest) {
            this.roomConfig.guest = user;
            await this.state.storage.put('roomConfig', this.roomConfig);
        }

        // If reconnecting with a lastSeq, replay missed events
        const lastSeq = parseInt(url.searchParams.get('lastSeq') || '0', 10);
        if (lastSeq > 0 && this.replayBuffer.length > 0) {
            const missed = this.replayBuffer.filter(e => e.seq > lastSeq);
            for (const event of missed) {
                server.send(event.message);
            }
        }

        // Send full state snapshot
        server.send(JSON.stringify({
            type: 'connected',
            roomId: this.roomConfig.roomId,
            videoId: this.roomConfig.videoId,
            videoTitle: this.roomConfig.videoTitle,
            host: this.roomConfig.host,
            guest: this.roomConfig.guest,
            videoState: this.videoState,
            chatHistory: this.chatHistory.slice(-50),
            avatars: this.roomConfig.avatars || {},
            user,
            seq: this.seq
        }));

        // Notify others that user joined
        this.broadcast('user-joined', {
            user,
            memberCount: this.sockets.size,
            avatars: this.roomConfig.avatars || {}
        }, server);

        return new Response(null, { status: 101, webSocket: client });
    }

    /**
     * Hibernation API: Called when a WebSocket message is received.
     * This allows the DO to be evicted between messages (saves resources).
     */
    async webSocketMessage(ws, message) {
        await this.initialize();

        const conn = this.sockets.get(ws);
        if (!conn) {
            // Recover connection info from tags (after hibernation wake)
            const tags = this.state.getTags(ws);
            if (tags && tags.length >= 2) {
                const recovered = { user: tags[0], role: tags[1], connectedAt: Date.now() };
                this.sockets.set(ws, recovered);
                return this.processMessage(ws, recovered, message);
            }
            ws.close(4000, 'Unknown connection');
            return;
        }

        return this.processMessage(ws, conn, message);
    }

    /**
     * Process an incoming WebSocket message.
     */
    async processMessage(ws, conn, rawMessage) {
        let data;
        try {
            data = JSON.parse(rawMessage);
        } catch {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }

        const { type } = data;

        switch (type) {
            case 'sync':
                this.handleSync(ws, conn, data);
                break;

            case 'chat':
                await this.handleChat(ws, conn, data);
                break;

            case 'reaction':
                this.handleReaction(ws, conn, data);
                break;

            case 'ping':
                ws.send(JSON.stringify({ type: 'pong' }));
                break;

            case 'leave':
                this.handleExplicitLeave(ws, conn);
                break;

            default:
                ws.send(JSON.stringify({ type: 'error', message: `Unknown type: ${type}` }));
        }
    }

    /**
     * Hibernation API: Called when a WebSocket closes.
     */
    async webSocketClose(ws, code, reason) {
        await this.initialize();

        const conn = this.sockets.get(ws);
        this.sockets.delete(ws);

        if (conn) {
            this.broadcast('user-disconnected', {
                user: conn.user,
                memberCount: this.sockets.size
            });
        }

        // If no sockets remain, start grace period
        if (this.sockets.size === 0 && this.active) {
            await this.state.storage.setAlarm(Date.now() + DISCONNECT_GRACE_MS);
        }
    }

    /**
     * Hibernation API: Called on WebSocket errors.
     */
    async webSocketError(ws, error) {
        const conn = this.sockets.get(ws);
        this.sockets.delete(ws);

        if (conn) {
            this.broadcast('user-disconnected', {
                user: conn.user,
                memberCount: this.sockets.size
            });
        }

        if (this.sockets.size === 0 && this.active) {
            await this.state.storage.setAlarm(Date.now() + DISCONNECT_GRACE_MS);
        }
    }

    // =========================================================================
    //  Message Handlers
    // =========================================================================

    /**
     * Host-authoritative playback sync.
     * Only the host can broadcast sync events.
     */
    handleSync(ws, conn, data) {
        if (conn.role !== 'host') {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Only host can control playback'
            }));
            return;
        }

        this.videoState = {
            currentTime: Math.max(0, Number(data.currentTime) || 0),
            playing: !!data.playing,
            playbackRate: (Number(data.playbackRate) > 0 ? Number(data.playbackRate) : 1),
            lastSyncAt: Date.now()
        };

        this.broadcast('sync', {
            ...this.videoState,
            action: data.action || 'update',
            timestamp: Date.now()
        }, ws);
    }

    /**
     * Chat message handling — persisted to DO storage.
     */
    async handleChat(ws, conn, data) {
        const text = String(data.text || '').trim().slice(0, 500);
        if (!text) {
            ws.send(JSON.stringify({ type: 'error', message: 'Empty message' }));
            return;
        }

        // Generate a short random ID for the message
        const id = Array.from(crypto.getRandomValues(new Uint8Array(4)))
            .map(b => b.toString(16).padStart(2, '0')).join('');

        const avatar = (this.roomConfig.avatars || {})[conn.user] || null;

        const message = {
            id,
            user: conn.user,
            avatar,
            text,
            timestamp: Date.now()
        };

        this.chatHistory.push(message);

        // Keep only last 100 messages
        if (this.chatHistory.length > 100) {
            this.chatHistory = this.chatHistory.slice(-100);
        }

        // Persist chat history (human-rate writes — safe for DO storage)
        await this.state.storage.put('chatHistory', this.chatHistory);

        // Broadcast to all (including sender — sender can use it for confirmation)
        this.broadcast('chat', message);
    }

    /**
     * Live emoji reaction — transient, not persisted.
     */
    handleReaction(ws, conn, data) {
        const emoji = String(data.emoji || '💖').trim().slice(0, 10);

        this.broadcast('reaction', {
            user: conn.user,
            emoji,
            timestamp: Date.now()
        });
    }

    /**
     * Explicit leave via WebSocket message.
     */
    async handleExplicitLeave(ws, conn) {
        this.sockets.delete(ws);

        if (conn.role === 'host') {
            await this.closeRoom('Host ended the session');
        } else {
            this.roomConfig.guest = null;
            await this.state.storage.put('roomConfig', this.roomConfig);
            this.broadcast('user-left', { user: conn.user });
        }

        ws.close(1000, 'Left room');
    }

    // =========================================================================
    //  Broadcasting
    // =========================================================================

    /**
     * Broadcast a message to all connected WebSockets.
     * Increments the sequence number for reliable delivery.
     *
     * @param {string} type - Event type
     * @param {object} data - Event payload
     * @param {WebSocket} [excludeWs] - Optional WebSocket to exclude (sender)
     */
    broadcast(type, data, excludeWs = null) {
        this.seq++;
        const message = JSON.stringify({ type, ...data, seq: this.seq });

        // Store in replay buffer for reconnection
        this.replayBuffer.push({ seq: this.seq, message });
        if (this.replayBuffer.length > REPLAY_BUFFER_SIZE) {
            this.replayBuffer.shift();
        }

        const deadSockets = [];

        for (const [ws, conn] of this.sockets) {
            if (ws === excludeWs) continue;
            try {
                ws.send(message);
            } catch {
                deadSockets.push(ws);
            }
        }

        // Clean up dead sockets
        for (const ws of deadSockets) {
            this.sockets.delete(ws);
        }
    }

    // =========================================================================
    //  Room Cleanup
    // =========================================================================

    /**
     * Close the room and disconnect all users.
     */
    async closeRoom(reason) {
        this.active = false;

        this.broadcast('room-closed', { reason });

        // Close all WebSockets
        for (const [ws] of this.sockets) {
            try {
                ws.close(1000, reason);
            } catch {}
        }
        this.sockets.clear();

        // Clean up DO storage
        await this.state.storage.deleteAll();
    }

    /**
     * DO Alarm handler — fires for grace period expiry and max TTL.
     */
    async alarm() {
        await this.initialize();

        // If users have reconnected, don't clean up — just reset TTL alarm
        if (this.sockets.size > 0 && this.active) {
            // Room is still in use — set the max TTL alarm
            const elapsed = Date.now() - (this.roomConfig?.createdAt || Date.now());
            const remaining = ROOM_TTL_MS - elapsed;
            if (remaining > 0) {
                await this.state.storage.setAlarm(Date.now() + remaining);
            } else {
                // Max TTL exceeded
                await this.closeRoom('Session expired after 2 hours');
            }
            return;
        }

        // No active sockets and room is still "active" → grace period expired
        if (this.active) {
            await this.closeRoom('Session closed due to inactivity');
        }
    }
}

// ─── Utility ─────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}
