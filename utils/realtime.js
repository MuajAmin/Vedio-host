// ============================================================
//  REAL-TIME SSE EVENT BROADCASTER
//  Central manager for active SSE streams across all routes
// ============================================================

const sseClients = new Map(); // username -> Set of Express response objects

/**
 * Register an active SSE response stream for a user
 * @param {string} username
 * @param {import('express').Response} res
 */
function addSseClient(username, res) {
    if (!username || !res) return;
    if (!sseClients.has(username)) {
        sseClients.set(username, new Set());
    }
    const clientSet = sseClients.get(username);
    clientSet.add(res);

    // Auto-clean on socket close or error
    const cleanup = () => {
        removeSseClient(username, res);
    };
    if (typeof res.on === 'function') {
        res.once('close', cleanup);
        res.once('error', cleanup);
        res.once('finish', cleanup);
    }
}

/**
 * Unregister an SSE response stream
 * @param {string} username
 * @param {import('express').Response} res
 */
function removeSseClient(username, res) {
    if (!username || !res || !sseClients.has(username)) return;
    const clientSet = sseClients.get(username);
    clientSet.delete(res);
    if (clientSet.size === 0) {
        sseClients.delete(username);
    }
}

/**
 * Broadcast an SSE event to all active connections of a specific user
 * @param {string} username
 * @param {string} event
 * @param {object} data
 */
function broadcastToUser(username, event, data) {
    if (!username || !sseClients.has(username)) return;
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    const clients = sseClients.get(username);
    const toRemove = [];

    for (const client of clients) {
        if (!client || client.destroyed || client.writableEnded || (client.writable === false)) {
            toRemove.push(client);
            continue;
        }
        try {
            client.write(payload);
            if (typeof client.flush === 'function') client.flush();
        } catch {
            toRemove.push(client);
        }
    }

    for (const dead of toRemove) {
        clients.delete(dead);
    }
    if (clients.size === 0) {
        sseClients.delete(username);
    }
}

/**
 * Broadcast an SSE event to both users (or all connections of user1 and user2)
 * @param {string} user1
 * @param {string} user2
 * @param {string} event
 * @param {object} data
 */
function broadcastToBoth(user1, user2, event, data) {
    if (user1) broadcastToUser(user1, event, data);
    if (user2 && user2 !== user1) broadcastToUser(user2, event, data);
}

/**
 * Broadcast an SSE event to all currently connected users
 * @param {string} event
 * @param {object} data
 */
function broadcastToAll(event, data) {
    for (const username of sseClients.keys()) {
        broadcastToUser(username, event, data);
    }
}

/**
 * Get list of usernames that currently have active SSE connections
 * @returns {string[]}
 */
function getConnectedUsers() {
    return Array.from(sseClients.keys());
}

/**
 * Check if a specific user has at least one active SSE connection
 * @param {string} username
 * @returns {boolean}
 */
function isUserConnected(username) {
    return sseClients.has(username) && sseClients.get(username).size > 0;
}

module.exports = {
    addSseClient,
    removeSseClient,
    broadcastToUser,
    broadcastToBoth,
    broadcastToAll,
    getConnectedUsers,
    isUserConnected
};
