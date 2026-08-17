const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { isAuthenticated } = require('../middleware/auth');
const db = require('../database');
const { broadcastToUser, broadcastToBoth } = require('../utils/realtime');
const { invalidateUnreadCache } = require('../utils/security');

const router = express.Router();

// Active in-memory calls store
// callId -> { id, caller, receiver, callType, status, startedAt, answeredAt, ringTimeout }
const activeCalls = new Map();

const RING_TIMEOUT_MS = 45 * 1000; // 45 seconds ring timeout

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

// ------------------------------------------------------------
//  POST /api/call/initiate — Start a Call
// ------------------------------------------------------------
router.post('/api/call/initiate', isAuthenticated, (req, res) => {
    const caller = req.session.user;
    const receiver = getPartner(caller);
    const callType = (req.body && req.body.callType === 'video') ? 'video' : 'audio';

    // Check if caller or receiver is in an active call
    const existingForCaller = getActiveCallForUser(caller);
    if (existingForCaller) {
        // If older than 90s, purge stale active call
        if (Date.now() - (existingForCaller.startedAt || 0) > 90000) {
            activeCalls.delete(existingForCaller.id);
        } else {
            return res.status(409).json({ error: 'You are already in a call session.' });
        }
    }

    const existingForReceiver = getActiveCallForUser(receiver);
    if (existingForReceiver) {
        if (Date.now() - (existingForReceiver.startedAt || 0) > 90000) {
            activeCalls.delete(existingForReceiver.id);
        } else {
            return res.status(486).json({ error: `${receiver === 'muaj' ? 'Muaj' : 'Hajera'} is busy in another call.` });
        }
    }

    const callId = uuidv4();
    const now = Date.now();

    // Create ring timeout
    const ringTimeout = setTimeout(() => {
        const call = activeCalls.get(callId);
        if (call && call.status === 'ringing') {
            activeCalls.delete(callId);
            db.updateCallLog(callId, {
                status: 'missed',
                endedAt: new Date().toISOString(),
                endReason: 'timeout'
            });

            // Broadcast missed / timeout to both
            broadcastToUser(call.caller, 'call-timeout', { callId, reason: 'No answer' });
            broadcastToUser(call.receiver, 'call-timeout', { callId, reason: 'Missed call' });

            // Create call history message
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
    const callId = req.body && req.body.callId;

    if (!callId) {
        return res.status(400).json({ error: 'callId is required.' });
    }

    const call = activeCalls.get(callId);
    if (!call) {
        return res.status(404).json({ error: 'Call session not found or already ended.' });
    }

    if (call.receiver !== user) {
        return res.status(403).json({ error: 'Unauthorized to accept this call.' });
    }

    if (call.ringTimeout) {
        clearTimeout(call.ringTimeout);
        call.ringTimeout = null;
    }

    call.status = 'connecting';
    call.answeredAt = Date.now();

    db.updateCallLog(callId, {
        status: 'connecting',
        answeredAt: new Date().toISOString()
    });

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
    const callId = req.body && req.body.callId;
    const reason = (req.body && req.body.reason) || 'declined';

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

        db.updateCallLog(callId, {
            status: 'rejected',
            endedAt: new Date().toISOString(),
            endReason: reason
        });

        const target = user === call.receiver ? call.caller : call.receiver;
        broadcastToUser(target, 'call-rejected', {
            callId,
            rejectedBy: user,
            reason
        });

        // Record in chat as rejected / declined
        createCallHistoryMessage(call.caller, call.receiver, call.callType, 'rejected', 0);
    }

    res.json({ success: true });
});

// ------------------------------------------------------------
//  POST /api/call/cancel — Caller Cancels Before Answer
// ------------------------------------------------------------
router.post('/api/call/cancel', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const callId = req.body && req.body.callId;

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

        db.updateCallLog(callId, {
            status: 'missed',
            endedAt: new Date().toISOString(),
            endReason: 'caller_cancelled'
        });

        broadcastToUser(call.receiver, 'call-cancelled', {
            callId,
            cancelledBy: user
        });

        createCallHistoryMessage(call.caller, call.receiver, call.callType, 'missed', 0);
    }

    res.json({ success: true });
});

// ------------------------------------------------------------
//  POST /api/call/end — End an Active Call
// ------------------------------------------------------------
router.post('/api/call/end', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const callId = req.body && req.body.callId;
    const durationSeconds = Math.max(0, parseInt(req.body && req.body.durationSeconds, 10) || 0);
    const reason = (req.body && req.body.reason) || 'ended';

    if (!callId) {
        return res.status(400).json({ error: 'callId is required.' });
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

        db.updateCallLog(callId, {
            status,
            endedAt: new Date().toISOString(),
            durationSeconds,
            endReason: reason
        });

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
        // If not in active memory, ensure DB log is updated if exists
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
    const { callId, type, data } = req.body || {};

    if (!callId || !type || !data) {
        return res.status(400).json({ error: 'callId, type, and data are required.' });
    }

    const call = activeCalls.get(callId);
    if (!call) {
        return res.status(404).json({ error: 'Call session not found.' });
    }

    if (call.caller !== user && call.receiver !== user) {
        return res.status(403).json({ error: 'Unauthorized.' });
    }

    const partner = user === call.caller ? call.receiver : call.caller;

    // Relay the WebRTC signaling message directly to the partner via SSE
    broadcastToUser(partner, 'call-signal', {
        callId,
        from: user,
        type, // 'offer' | 'answer' | 'ice-candidate'
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
