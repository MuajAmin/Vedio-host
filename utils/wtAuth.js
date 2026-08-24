// =============================================================================
//  Watch Together — VPS-Side Auth Token Generator
//  Generates HMAC-SHA256 tokens for Durable Object authentication.
//  Compatible with the Worker-side validation in workers/src/auth.js.
// =============================================================================

const crypto = require('crypto');

const WT_SHARED_SECRET = process.env.WT_SHARED_SECRET || '';
const TOKEN_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Check if Durable Objects mode is enabled.
 * @returns {boolean}
 */
function isDurableObjectsEnabled() {
    return process.env.USE_DURABLE_OBJECTS === 'true' && !!WT_SHARED_SECRET;
}

/**
 * Get the Worker base URL for Watch Together API calls.
 * Worker is deployed on the same subdomain (muaj.bro.bd) — DO requests
 * go to /wt/room/* on the same origin, routed by the edge Worker.
 * @returns {string}
 */
function getWorkerBaseUrl() {
    if (process.env.WT_WORKER_URL) return process.env.WT_WORKER_URL;
    if (process.env.CF_DOMAIN) return `https://${process.env.CF_DOMAIN}`;
    return 'https://muaj.bro.bd';
}

/**
 * Generate an HMAC-SHA256 auth token for Watch Together WebSocket connections.
 *
 * Token format: base64url(JSON(payload)) + '.' + base64url(HMAC-SHA256(payload))
 * Compatible with the Worker-side validateToken() in workers/src/auth.js.
 *
 * @param {object} params
 * @param {string} params.roomId - The room ID
 * @param {string} params.user - The username
 * @param {string} params.role - 'host' or 'guest'
 * @param {number} [ttlMs] - Token TTL in ms (default 5 min)
 * @returns {string} The signed token
 */
function generateWtToken({ roomId, user, role }, ttlMs = TOKEN_TTL_MS) {
    if (!WT_SHARED_SECRET) {
        throw new Error('WT_SHARED_SECRET is not configured');
    }

    const payload = {
        roomId,
        user,
        role,
        exp: Date.now() + ttlMs,
        iat: Date.now()
    };

    const payloadB64 = base64urlEncode(Buffer.from(JSON.stringify(payload), 'utf-8'));

    const hmac = crypto.createHmac('sha256', WT_SHARED_SECRET);
    hmac.update(payloadB64);
    const signatureB64 = base64urlEncode(hmac.digest());

    return `${payloadB64}.${signatureB64}`;
}

/**
 * Build the WebSocket URL for connecting to a Watch Together room DO.
 *
 * @param {string} roomId
 * @param {string} token
 * @param {number} [lastSeq=0] - Last seen sequence number (for reconnection replay)
 * @returns {string} The full WSS URL
 */
function buildWsUrl(roomId, token, lastSeq = 0) {
    const base = getWorkerBaseUrl().replace(/^http/, 'ws');
    const params = new URLSearchParams({ token });
    if (lastSeq > 0) {
        params.set('lastSeq', String(lastSeq));
    }
    return `${base}/wt/room/${roomId}/websocket?${params.toString()}`;
}

/**
 * Call the Worker to create a room in the Durable Object.
 *
 * @param {object} params
 * @param {string} params.roomId
 * @param {string} params.videoId
 * @param {string} params.videoTitle
 * @param {string} params.host
 * @param {object} [params.videoState]
 * @param {object} [params.avatars]
 * @returns {Promise<object>} The DO's response
 */
async function createRoomOnDO({ roomId, videoId, videoTitle, host, videoState, avatars }) {
    const baseUrl = getWorkerBaseUrl();
    const url = `${baseUrl}/wt/room/${roomId}/create`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId, videoId, videoTitle, host, videoState, avatars })
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`DO create failed (${response.status}): ${text}`);
    }

    return response.json();
}

/**
 * Call the Worker to leave/close a room in the Durable Object.
 *
 * @param {string} roomId
 * @param {string} user
 * @returns {Promise<object>}
 */
async function leaveRoomOnDO(roomId, user) {
    const baseUrl = getWorkerBaseUrl();
    const url = `${baseUrl}/wt/room/${roomId}/leave`;

    const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user })
    });

    return response.json();
}

/**
 * Query the current state of a room from the Durable Object.
 *
 * @param {string} roomId
 * @returns {Promise<object|null>}
 */
async function getRoomStateFromDO(roomId) {
    const baseUrl = getWorkerBaseUrl();
    const url = `${baseUrl}/wt/room/${roomId}/state`;

    const response = await fetch(url, { method: 'GET' });
    if (!response.ok) return null;
    return response.json();
}

// ─── Base64url helpers ───────────────────────────────────────────────────────

function base64urlEncode(buffer) {
    return buffer.toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

module.exports = {
    isDurableObjectsEnabled,
    getWorkerBaseUrl,
    generateWtToken,
    buildWsUrl,
    createRoomOnDO,
    leaveRoomOnDO,
    getRoomStateFromDO
};
