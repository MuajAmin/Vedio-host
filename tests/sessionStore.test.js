const { describe, test, expect, afterAll, afterEach } = require('bun:test');
const db = require('../database');
const SQLiteSessionStore = require('../utils/sessionStore');

describe('SQLiteSessionStore expiry cleanup', () => {
    const sessionId = 'test-unauthenticated-session-cleanup';
    const store = new SQLiteSessionStore();

    afterAll(() => {
        clearInterval(store.cleanupTimer);
    });

    afterEach(() => {
        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sessionId);
    });

    test('does not remove an unexpired unauthenticated session', () => {
        const expiresAt = Date.now() + 29 * 60 * 1000;
        db.prepare('INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)')
            .run(sessionId, JSON.stringify({ csrfToken: 'test-token' }), expiresAt);

        store.pruneExpired();

        const row = db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(sessionId);
        expect(row).not.toBeNull();
    });

    test('removes an expired unauthenticated session', () => {
        db.prepare('INSERT INTO sessions (sid, sess, expires_at) VALUES (?, ?, ?)')
            .run(sessionId, JSON.stringify({ csrfToken: 'test-token' }), Date.now() - 1);

        store.pruneExpired();

        const row = db.prepare('SELECT sid FROM sessions WHERE sid = ?').get(sessionId);
        expect(row == null).toBe(true);
    });
});
