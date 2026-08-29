const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { isAuthenticated } = require('../middleware/auth');
const db = require('../database');
const { broadcastToUser, broadcastToBoth } = require('../utils/realtime');
const { invalidateUnreadCache } = require('../utils/security');
const r2 = require('../utils/r2');

const router = express.Router();

// Active in-memory calls store
// callId -> { id, caller, receiver, callType, status, startedAt, answeredAt, ringTimeout, lastActivityAt }
const activeCalls = new Map();

// Deduplication store for recently concluded calls (TTL: 60s)
// callId -> { status, endedAt }
const recentlyEndedCalls = new Map();

const RING_TIMEOUT_MS = 45 * 1000; // 45 seconds ring timeout
const MAX_CALL_STALE_MS = 120 * 1000; // 2 minutes without handshake/activity
const ALLOWED_SIGNAL_TYPES = new Set(['offer', 'answer', 'ice-candidate', 'call-emoji', 'media-state', 'ice-restart']);

function callLog(action, details = {}) {
    const ts = new Date().toISOString();
    const meta = Object.entries(details)
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
    console.log(`[CALL] ${ts} | ${action} | ${meta}`);
}

function getPartner(currentUser) {
    return currentUser === 'muaj' ? 'hajera' : 'muaj';
}

function getActiveCallForUser(username) {
    if (!username) return null;
    for (const [id, call] of activeCalls) {
        if (call.caller === username || call.receiver === username) {
            return { id, ...call };
        }
    }
    return null;
}

// Background cleanup sweeper for abandoned or stuck calls (runs every 30s)
function sweepStaleCalls() {
    const now = Date.now();

    // 1. Clean recentlyEndedCalls older than 60s
    for (const [id, record] of recentlyEndedCalls) {
        if (now - record.endedAt > 60000) {
            recentlyEndedCalls.delete(id);
        }
    }

    // 2. Clean stuck activeCalls
    for (const [id, call] of activeCalls) {
        const isRingingStale = call.status === 'ringing' && (now - call.startedAt > RING_TIMEOUT_MS + 10000);
        const isConnectingStale = call.status === 'connecting' && (now - (call.answeredAt || call.startedAt) > 60000);
        // Only sweep connected calls if exceeded maximum continuous duration (6 hours)
        const isConnectedStale = call.status === 'connected' && (now - (call.answeredAt || call.startedAt) > 6 * 3600 * 1000);
        const isOrphanedUnconnected = call.status !== 'connected' && (now - (call.lastActivityAt || call.startedAt) > MAX_CALL_STALE_MS);

        if (isRingingStale || isConnectingStale || isConnectedStale || isOrphanedUnconnected) {
            callLog('STALE_SWEEP_CLEANUP', { callId: id, status: call.status, caller: call.caller, receiver: call.receiver });

            if (call.ringTimeout) {
                clearTimeout(call.ringTimeout);
                call.ringTimeout = null;
            }

            activeCalls.delete(id);
            recentlyEndedCalls.set(id, { status: 'failed', endedAt: now });

            db.updateCallLog(id, {
                status: call.status === 'ringing' ? 'missed' : (call.status === 'connected' ? 'completed' : 'failed'),
                endedAt: new Date().toISOString(),
                endReason: 'stale_timeout'
            });

            // Notify both peers
            broadcastToUser(call.caller, 'call-timeout', { callId: id, reason: 'Session timed out' });
            broadcastToUser(call.receiver, 'call-timeout', { callId: id, reason: 'Session timed out' });

            if (call.status === 'ringing') {
                createCallHistoryMessage(call.caller, call.receiver, call.callType, 'missed', 0);
            }
        }
    }
}
setInterval(sweepStaleCalls, 30000).unref();

function createCallHistoryMessage(caller, receiver, callType, status, durationSeconds = 0) {
    try {
        const payload = JSON.stringify({
            callType,       // 'audio' | 'video'
            status,         // 'completed' | 'missed' | 'rejected' | 'cancelled'
            durationSeconds // e.g. 125
        });
        const text = `__CALL_EVENT__:${payload}`;

        const saved = db.saveMessage({
            sender: caller,
            recipient: receiver,
            text
        });

        if (saved) {
            invalidateUnreadCache();
            const partnerUnread = db.getUnreadMessageCount(receiver);
            const senderUnread = db.getUnreadMessageCount(caller);
            const updatedStats = db.getMessageStats(caller, receiver);

            broadcastToUser(receiver, 'new-message', {
                message: saved,
                unreadCount: partnerUnread,
                stats: updatedStats
            });
            broadcastToUser(caller, 'new-message', {
                message: saved,
                unreadCount: senderUnread,
                stats: updatedStats
            });
        }
        return saved;
    } catch (err) {
        console.error('[calls] Error saving call history message:', err.message);
        return null;
    }
}

// Helper to safely parse req.body whether JSON object or raw string (beacon fallback)
function parseRequestBody(req) {
    if (!req.body) return {};
    if (typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body);
        } catch {
            return {};
        }
    }
    return {};
}

// ------------------------------------------------------------
//  GET /api/call/edge-token — Edge WebSocket Signaling Bridge
// ------------------------------------------------------------
router.get('/api/call/edge-token', isAuthenticated, (req, res) => {
    const user = req.session.user;
    // Direct VPS SSE / HTTP signaling is the reliable centralized architecture
    res.json({
        enabled: false,
        signalingUrl: null,
        user
    });
});

// ------------------------------------------------------------
//  GET /api/call/ice-servers — ICE (STUN + TURN) Configuration
// ------------------------------------------------------------
//  Why this exists:
//  STUN alone cannot traverse symmetric NAT / CGNAT, which is the norm on
//  mobile carrier networks. Without a TURN relay, a call between two mobile
//  devices on cellular data can fail to connect 100% of the time.
//  TURN credentials are short-lived and must never be embedded in client JS,
//  so they are minted server-side per request.
//
//  Supported providers (auto-detected, first match wins):
//   1. Cloudflare Realtime TURN  — CF_TURN_KEY_ID + CF_TURN_API_TOKEN
//   2. Static/self-hosted TURN   — TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL
//   3. None                      — STUN-only (previous behaviour, logged as a warning)
// ------------------------------------------------------------

// Baseline STUN servers. Trimmed to 2 distinct providers: RTCPeerConnection
// queries every STUN server in this list on every ICE gather, so a long list
// adds network chatter, battery drain and candidate-gathering latency on
// mobile without improving reachability.
const BASE_STUN_SERVERS = [
    { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }
];

// Cache minted TURN credentials until shortly before they expire so we don't
// hit the provider API on every single call setup (saves ~100-300ms per call).
let _turnCache = null; // { iceServers, expiresAt }
const TURN_TTL_SECONDS = 2 * 60 * 60; // request 2h lifetime
const TURN_CACHE_SAFETY_MS = 5 * 60 * 1000; // refresh 5 min early

function getStaticTurnServers() {
    const urls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
    const username = process.env.TURN_USERNAME;
    const credential = process.env.TURN_CREDENTIAL;
    if (!urls.length || !username || !credential) return null;
    return [{ urls, username, credential }];
}

async function getCloudflareTurnServers() {
    const keyId = process.env.CF_TURN_KEY_ID;
    const apiToken = process.env.CF_TURN_API_TOKEN;
    if (!keyId || !apiToken) return null;

    const endpoint = `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
        const resp = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
            signal: controller.signal
        });
        if (!resp.ok) {
            callLog('TURN_FETCH_FAILED', { provider: 'cloudflare', status: resp.status });
            return null;
        }
        const json = await resp.json();
        // Cloudflare returns { iceServers: { urls: [...], username, credential } }
        const ice = json && json.iceServers;
        if (!ice) return null;
        return Array.isArray(ice) ? ice : [ice];
    } catch (err) {
        callLog('TURN_FETCH_ERROR', { provider: 'cloudflare', error: err.name === 'AbortError' ? 'timeout' : err.message });
        return null;
    } finally {
        clearTimeout(timer);
    }
}

async function resolveTurnServers() {
    const now = Date.now();
    if (_turnCache && _turnCache.expiresAt > now) {
        return _turnCache.iceServers;
    }

    // Static TURN needs no minting and never expires — prefer it when present.
    const staticTurn = getStaticTurnServers();
    if (staticTurn) {
        _turnCache = { iceServers: staticTurn, expiresAt: now + 12 * 60 * 60 * 1000 };
        return staticTurn;
    }

    const cfTurn = await getCloudflareTurnServers();
    if (cfTurn) {
        _turnCache = {
            iceServers: cfTurn,
            expiresAt: now + (TURN_TTL_SECONDS * 1000) - TURN_CACHE_SAFETY_MS
        };
        return cfTurn;
    }

    return null;
}

let _warnedNoTurn = false;

router.get('/api/call/ice-servers', isAuthenticated, async (req, res) => {
    let turnServers = null;
    try {
        turnServers = await resolveTurnServers();
    } catch (err) {
        callLog('TURN_RESOLVE_ERROR', { error: err.message });
    }

    if (!turnServers && !_warnedNoTurn) {
        _warnedNoTurn = true;
        console.warn(
            '[calls] No TURN server configured. Calls will use STUN only and may fail ' +
            'on symmetric NAT / CGNAT (common on mobile data). Set CF_TURN_KEY_ID + ' +
            'CF_TURN_API_TOKEN, or TURN_URLS + TURN_USERNAME + TURN_CREDENTIAL.'
        );
    }

    const iceServers = turnServers
        ? [...BASE_STUN_SERVERS, ...turnServers]
        : [...BASE_STUN_SERVERS];

    // Never cache on a shared/CDN layer — payload contains per-user credentials.
    res.setHeader('Cache-Control', 'private, no-store');
    res.json({
        iceServers,
        turnAvailable: Boolean(turnServers),
        // Client keeps its own copy slightly shorter than the server cache.
        refreshAfterSeconds: turnServers ? Math.floor(TURN_TTL_SECONDS / 2) : 300
    });
});

// ------------------------------------------------------------
//  POST /api/call/initiate — Start a Call
// ------------------------------------------------------------
router.post('/api/call/initiate', isAuthenticated, (req, res) => {
    const caller = req.session.user;
    const receiver = getPartner(caller);
    const body = parseRequestBody(req);
    const callType = (body && body.callType === 'video') ? 'video' : 'audio';

    // Check if caller is already in an active call
    const existingForCaller = getActiveCallForUser(caller);
    if (existingForCaller) {
        if (Date.now() - (existingForCaller.startedAt || 0) > MAX_CALL_STALE_MS) {
            activeCalls.delete(existingForCaller.id);
        } else {
            callLog('INITIATE_REJECTED_CALLER_BUSY', { caller, existingCallId: existingForCaller.id });
            return res.status(409).json({ error: 'You already have an active call in progress.' });
        }
    }

    // Check if receiver is already in an active call
    const existingForReceiver = getActiveCallForUser(receiver);
    if (existingForReceiver) {
        if (Date.now() - (existingForReceiver.startedAt || 0) > MAX_CALL_STALE_MS) {
            activeCalls.delete(existingForReceiver.id);
        } else {
            callLog('INITIATE_REJECTED_RECEIVER_BUSY', { caller, receiver, existingCallId: existingForReceiver.id });
            return res.status(486).json({
                error: `${receiver === 'muaj' ? 'Muaj' : 'Hajera'} is currently busy in another call.`
            });
        }
    }

    const callId = uuidv4();
    const now = Date.now();

    // Create server-side ring timeout
    const ringTimeout = setTimeout(() => {
        const call = activeCalls.get(callId);
        if (call && call.status === 'ringing') {
            callLog('RING_TIMEOUT', { callId, caller: call.caller, receiver: call.receiver });
            activeCalls.delete(callId);
            recentlyEndedCalls.set(callId, { status: 'missed', endedAt: Date.now() });

            db.updateCallLog(callId, {
                status: 'missed',
                endedAt: new Date().toISOString(),
                endReason: 'timeout'
            });

            // Broadcast missed / timeout to both
            broadcastToUser(call.caller, 'call-timeout', { callId, reason: 'No answer' });
            broadcastToUser(call.receiver, 'call-timeout', { callId, reason: 'Missed call' });

            // Create call history message in chat
            createCallHistoryMessage(call.caller, call.receiver, call.callType, 'missed', 0);
        }
    }, RING_TIMEOUT_MS);

    const callObj = {
        id: callId,
        caller,
        receiver,
        callType,
        status: 'ringing',
        startedAt: now,
        lastActivityAt: now,
        ringTimeout
    };

    activeCalls.set(callId, callObj);

    // Save initial DB log
    db.createCallLog({
        id: callId,
        caller,
        receiver,
        callType
    });

    const callerAvatar = db.getUserAvatar(caller);

    callLog('CALL_INITIATED', { callId, caller, receiver, callType });

    // Broadcast incoming call to receiver
    broadcastToUser(receiver, 'incoming-call', {
        callId,
        caller,
        callerAvatar,
        callType,
        startedAt: now
    });

    res.json({
        success: true,
        callId,
        caller,
        receiver,
        callType,
        status: 'ringing'
    });
});

// ------------------------------------------------------------
//  POST /api/call/accept — Accept Incoming Call
// ------------------------------------------------------------
router.post('/api/call/accept', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const body = parseRequestBody(req);
    const callId = body && body.callId;

    if (!callId) {
        return res.status(400).json({ error: 'callId is required.' });
    }

    const call = activeCalls.get(callId);
    if (!call) {
        const recent = recentlyEndedCalls.get(callId);
        if (recent) {
            return res.status(410).json({ error: 'This call was already concluded or cancelled.' });
        }
        return res.status(404).json({ error: 'Call session not found or already ended.' });
    }

    if (call.receiver !== user) {
        return res.status(403).json({ error: 'Unauthorized to accept this call.' });
    }

    if (call.status !== 'ringing') {
        return res.status(409).json({ error: `Call is already in state "${call.status}".` });
    }

    if (call.ringTimeout) {
        clearTimeout(call.ringTimeout);
        call.ringTimeout = null;
    }

    const now = Date.now();
    call.status = 'connecting';
    call.answeredAt = now;
    call.lastActivityAt = now;

    db.updateCallLog(callId, {
        status: 'connecting',
        answeredAt: new Date().toISOString()
    });

    callLog('CALL_ACCEPTED', { callId, user, answeredAt: call.answeredAt });

    // Notify caller that receiver accepted
    broadcastToUser(call.caller, 'call-accepted', {
        callId,
        receiver: user,
        answeredAt: call.answeredAt
    });

    res.json({
        success: true,
        callId,
        status: 'connecting'
    });
});

// ------------------------------------------------------------
//  POST /api/call/reject — Reject Incoming Call
// ------------------------------------------------------------
router.post('/api/call/reject', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const body = parseRequestBody(req);
    const callId = body && body.callId;
    const reason = (body && body.reason) || 'declined';

    if (!callId) {
        return res.status(400).json({ error: 'callId is required.' });
    }

    const call = activeCalls.get(callId);
    if (call) {
        if (call.receiver !== user && call.caller !== user) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }

        if (call.ringTimeout) {
            clearTimeout(call.ringTimeout);
            call.ringTimeout = null;
        }

        activeCalls.delete(callId);
        recentlyEndedCalls.set(callId, { status: 'rejected', endedAt: Date.now() });

        db.updateCallLog(callId, {
            status: 'rejected',
            endedAt: new Date().toISOString(),
            endReason: reason
        });

        callLog('CALL_REJECTED', { callId, user, reason });

        const target = user === call.receiver ? call.caller : call.receiver;
        broadcastToUser(target, 'call-rejected', {
            callId,
            rejectedBy: user,
            reason
        });

        // Record in chat as rejected
        createCallHistoryMessage(call.caller, call.receiver, call.callType, 'rejected', 0);
    }

    res.json({ success: true });
});

// ------------------------------------------------------------
//  POST /api/call/cancel — Caller Cancels Before Answer
// ------------------------------------------------------------
router.post('/api/call/cancel', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const body = parseRequestBody(req);
    const callId = body && body.callId;

    if (!callId) {
        return res.status(400).json({ error: 'callId is required.' });
    }

    const call = activeCalls.get(callId);
    if (call) {
        if (call.caller !== user) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }

        if (call.ringTimeout) {
            clearTimeout(call.ringTimeout);
            call.ringTimeout = null;
        }

        activeCalls.delete(callId);
        recentlyEndedCalls.set(callId, { status: 'cancelled', endedAt: Date.now() });

        db.updateCallLog(callId, {
            status: 'missed',
            endedAt: new Date().toISOString(),
            endReason: 'caller_cancelled'
        });

        callLog('CALL_CANCELLED', { callId, user });

        broadcastToUser(call.receiver, 'call-cancelled', {
            callId,
            cancelledBy: user
        });

        createCallHistoryMessage(call.caller, call.receiver, call.callType, 'missed', 0);
    }

    res.json({ success: true });
});

// ------------------------------------------------------------
//  POST /api/call/end — End an Active Call (Idempotent)
// ------------------------------------------------------------
router.post('/api/call/end', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const body = parseRequestBody(req);
    const callId = body && body.callId;
    const durationSeconds = Math.max(0, parseInt(body && body.durationSeconds, 10) || 0);
    const reason = (body && body.reason) || 'ended';

    if (!callId) {
        return res.status(400).json({ error: 'callId is required.' });
    }

    // Check if already ended
    if (recentlyEndedCalls.has(callId)) {
        return res.json({ success: true, message: 'Call was already ended' });
    }

    const call = activeCalls.get(callId);
    if (call) {
        if (call.caller !== user && call.receiver !== user) {
            return res.status(403).json({ error: 'Unauthorized.' });
        }

        if (call.ringTimeout) {
            clearTimeout(call.ringTimeout);
            call.ringTimeout = null;
        }

        activeCalls.delete(callId);
        const status = durationSeconds > 0 ? 'completed' : 'missed';
        recentlyEndedCalls.set(callId, { status, endedAt: Date.now() });

        db.updateCallLog(callId, {
            status,
            endedAt: new Date().toISOString(),
            durationSeconds,
            endReason: reason
        });

        callLog('CALL_ENDED', { callId, user, status, durationSeconds, reason });

        const partner = user === call.caller ? call.receiver : call.caller;
        broadcastToUser(partner, 'call-ended', {
            callId,
            endedBy: user,
            durationSeconds,
            reason
        });

        // Record history event in chat
        createCallHistoryMessage(call.caller, call.receiver, call.callType, status, durationSeconds);
    } else {
        // Record in recentlyEndedCalls to prevent subsequent duplicate requests
        recentlyEndedCalls.set(callId, { status: durationSeconds > 0 ? 'completed' : 'ended', endedAt: Date.now() });

        db.updateCallLog(callId, {
            status: durationSeconds > 0 ? 'completed' : 'ended',
            endedAt: new Date().toISOString(),
            durationSeconds,
            endReason: reason
        });
    }

    res.json({ success: true });
});

// ------------------------------------------------------------
//  POST /api/call/signal — WebRTC Offer / Answer / ICE Candidates
// ------------------------------------------------------------
router.post('/api/call/signal', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const body = parseRequestBody(req);
    const { callId, type, data } = body || {};

    if (!callId || !type || !data) {
        return res.status(400).json({ error: 'callId, type, and data are required.' });
    }

    if (!ALLOWED_SIGNAL_TYPES.has(type)) {
        return res.status(400).json({ error: 'Invalid signal type.' });
    }

    const call = activeCalls.get(callId);
    if (!call) {
        return res.status(404).json({ error: 'Call session not found or already ended.' });
    }

    if (call.caller !== user && call.receiver !== user) {
        return res.status(403).json({ error: 'Unauthorized.' });
    }

    // Refresh active timestamp
    call.lastActivityAt = Date.now();
    if (type === 'offer' || type === 'answer') {
        call.status = 'connected';
    }

    const partner = user === call.caller ? call.receiver : call.caller;

    // Relay the WebRTC signaling message directly to partner via SSE
    broadcastToUser(partner, 'call-signal', {
        callId,
        from: user,
        type, // 'offer' | 'answer' | 'ice-candidate' | 'call-emoji' | 'media-state' | 'ice-restart'
        data
    });

    res.json({ success: true });
});

// ------------------------------------------------------------
//  GET /api/call/active — Check Active Call State
// ------------------------------------------------------------
router.get('/api/call/active', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const active = getActiveCallForUser(user);

    if (!active) {
        return res.json({ active: false });
    }

    res.json({
        active: true,
        call: {
            id: active.id,
            caller: active.caller,
            receiver: active.receiver,
            callType: active.callType,
            status: active.status,
            startedAt: active.startedAt,
            answeredAt: active.answeredAt || null
        }
    });
});

module.exports = router;

