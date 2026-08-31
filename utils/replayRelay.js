// ============================================================
//  REPLAY RELAY — Server-side session replay manager
//  Coordinates rrweb recording between admin (viewer) and
//  target user (recorded), relaying DOM events via SSE.
// ============================================================

const { broadcastToUser } = require('./realtime');

/**
 * Active replay sessions.
 * Key: targetUser (the user being recorded)
 * Value: { adminUser, startedAt, lastEventAt, adminSseClients: Set<Response> }
 */
const activeReplaySessions = new Map();

// Idle timeout — auto-stop if no events for 60 seconds
const IDLE_TIMEOUT_MS = 60 * 1000;
let idleCheckInterval = null;

/**
 * Start the idle check timer (runs every 15s)
 */
function ensureIdleChecker() {
    if (idleCheckInterval) return;
    idleCheckInterval = setInterval(() => {
        const now = Date.now();
        for (const [targetUser, session] of activeReplaySessions.entries()) {
            if (now - session.lastEventAt > IDLE_TIMEOUT_MS) {
                console.log(`[replay] Auto-stopping idle session for ${targetUser} (no events for ${Math.round((now - session.lastEventAt) / 1000)}s)`);
                stopReplay(targetUser);
            }
        }
        // Stop timer if no active sessions
        if (activeReplaySessions.size === 0) {
            clearInterval(idleCheckInterval);
            idleCheckInterval = null;
        }
    }, 15000);
    idleCheckInterval.unref();
}

/**
 * Start recording a target user's session.
 * Sends SSE 'replay-start' to the target user's browser.
 * @param {string} targetUser - Username to record (e.g. 'hajera')
 * @param {string} adminUser - Admin username requesting the replay (e.g. 'muaj')
 * @returns {{ success: boolean, error?: string }}
 */
function startReplay(targetUser, adminUser) {
    if (!targetUser || !adminUser) {
        return { success: false, error: 'Missing target or admin user.' };
    }

    // Already being recorded
    if (activeReplaySessions.has(targetUser)) {
        const existing = activeReplaySessions.get(targetUser);
        if (existing.adminUser === adminUser) {
            return { success: true, message: 'Already recording.' };
        }
        return { success: false, error: `${targetUser} is already being recorded by ${existing.adminUser}.` };
    }

    const now = Date.now();
    activeReplaySessions.set(targetUser, {
        adminUser,
        startedAt: now,
        lastEventAt: now,
        adminSseClients: new Set()
    });

    // Tell the target user's browser to start rrweb recording
    broadcastToUser(targetUser, 'replay-start', {
        startedBy: adminUser,
        timestamp: now
    });

    ensureIdleChecker();
    console.log(`[replay] Started recording ${targetUser} (requested by ${adminUser})`);
    return { success: true };
}

/**
 * Stop recording a target user's session.
 * Sends SSE 'replay-stop' to the target user's browser and cleans up.
 * @param {string} targetUser - Username to stop recording
 * @returns {{ success: boolean, error?: string }}
 */
function stopReplay(targetUser) {
    if (!targetUser) {
        return { success: false, error: 'Missing target user.' };
    }

    const session = activeReplaySessions.get(targetUser);
    if (!session) {
        return { success: true, message: 'No active recording for this user.' };
    }

    // Tell the target user's browser to stop recording
    broadcastToUser(targetUser, 'replay-stop', {
        timestamp: Date.now()
    });

    // Close all admin SSE streams watching this user
    for (const client of session.adminSseClients) {
        try {
            client.write(`event: replay-ended\ndata: ${JSON.stringify({ targetUser, reason: 'stopped' })}\n\n`);
            if (typeof client.flush === 'function') client.flush();
            client.end();
        } catch {}
    }
    session.adminSseClients.clear();

    const durationSec = Math.round((Date.now() - session.startedAt) / 1000);
    activeReplaySessions.delete(targetUser);
    console.log(`[replay] Stopped recording ${targetUser} (duration: ${durationSec}s)`);
    return { success: true, durationSec };
}

/**
 * Check if a user is currently being recorded.
 * @param {string} username
 * @returns {boolean}
 */
function isBeingRecorded(username) {
    return activeReplaySessions.has(username);
}

/**
 * Get the session info for a recorded user.
 * @param {string} targetUser
 * @returns {object|null}
 */
function getReplaySession(targetUser) {
    return activeReplaySessions.get(targetUser) || null;
}

/**
 * Get all active replay sessions (for admin UI listing).
 * @returns {Array<{ targetUser, adminUser, startedAt, lastEventAt, viewerCount }>}
 */
function getActiveSessions() {
    const result = [];
    for (const [targetUser, session] of activeReplaySessions.entries()) {
        result.push({
            targetUser,
            adminUser: session.adminUser,
            startedAt: session.startedAt,
            lastEventAt: session.lastEventAt,
            viewerCount: session.adminSseClients.size
        });
    }
    return result;
}

/**
 * Register an admin SSE response for receiving replay events.
 * @param {string} targetUser - The user being replayed
 * @param {import('express').Response} res - Admin's SSE response object
 */
function addAdminReplayClient(targetUser, res) {
    const session = activeReplaySessions.get(targetUser);
    if (!session) return false;
    session.adminSseClients.add(res);

    const cleanup = () => {
        session.adminSseClients.delete(res);
        // If no admin is watching anymore, stop the replay
        if (session.adminSseClients.size === 0 && activeReplaySessions.has(targetUser)) {
            console.log(`[replay] All admin viewers disconnected for ${targetUser}, stopping replay`);
            stopReplay(targetUser);
        }
    };

    if (typeof res.on === 'function') {
        res.once('close', cleanup);
        res.once('error', cleanup);
        res.once('finish', cleanup);
    }
    return true;
}

/**
 * Forward rrweb events from the recorded user to all admin SSE viewers.
 * @param {string} targetUser - The user being recorded
 * @param {Array} events - Batch of rrweb events
 * @returns {{ success: boolean, forwarded: number }}
 */
function forwardReplayEvents(targetUser, events) {
    const session = activeReplaySessions.get(targetUser);
    if (!session) {
        return { success: false, forwarded: 0 };
    }

    // Update last event time
    session.lastEventAt = Date.now();

    if (session.adminSseClients.size === 0) {
        return { success: true, forwarded: 0 };
    }

    const payload = `event: replay-events\ndata: ${JSON.stringify({
        targetUser,
        events,
        serverTimestamp: Date.now()
    })}\n\n`;

    let forwarded = 0;
    const dead = [];

    for (const client of session.adminSseClients) {
        if (!client || client.destroyed || client.writableEnded || (client.writable === false)) {
            dead.push(client);
            continue;
        }
        try {
            client.write(payload);
            if (typeof client.flush === 'function') client.flush();
            forwarded++;
        } catch {
            dead.push(client);
        }
    }

    for (const d of dead) {
        session.adminSseClients.delete(d);
    }

    return { success: true, forwarded };
}

/**
 * Clean up all sessions (used during graceful shutdown).
 */
function cleanupAll() {
    for (const targetUser of activeReplaySessions.keys()) {
        stopReplay(targetUser);
    }
    if (idleCheckInterval) {
        clearInterval(idleCheckInterval);
        idleCheckInterval = null;
    }
}

module.exports = {
    startReplay,
    stopReplay,
    isBeingRecorded,
    getReplaySession,
    getActiveSessions,
    addAdminReplayClient,
    forwardReplayEvents,
    cleanupAll
};
