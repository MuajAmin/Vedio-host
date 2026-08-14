const session = require('express-session');
const db = require('../database');

const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

class SQLiteSessionStore extends session.Store {
    constructor(options = {}) {
        super();
        this.ttlMs = options.ttlMs || DEFAULT_TTL_MS;

        this.statements = {
            get: db.prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?'),
            set: db.prepare(`
                INSERT INTO sessions (sid, sess, expires_at)
                VALUES (?, ?, ?)
                ON CONFLICT(sid) DO UPDATE SET
                    sess = excluded.sess,
                    expires_at = excluded.expires_at
            `),
            touch: db.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
            destroy: db.prepare('DELETE FROM sessions WHERE sid = ?'),
            prune: db.prepare('DELETE FROM sessions WHERE expires_at <= ?')
        };

        this.cleanupTimer = setInterval(() => {
            this.pruneExpired();
        }, 15 * 60 * 1000); // Check every 15 mins
        this.cleanupTimer.unref();

        // Prune immediately on startup
        setTimeout(() => this.pruneExpired(), 1000).unref();
    }

    get(sid, callback) {
        try {
            const row = this.statements.get.get(sid);
            if (!row) return callback(null, null);

            if (row.expires_at <= Date.now()) {
                this.statements.destroy.run(sid);
                return callback(null, null);
            }

            return callback(null, JSON.parse(row.sess));
        } catch (err) {
            return callback(err);
        }
    }

    set(sid, sess, callback = () => {}) {
        try {
            this.statements.set.run(sid, JSON.stringify(sess), this.getExpiresAt(sess));
            return callback(null);
        } catch (err) {
            return callback(err);
        }
    }

    touch(sid, sess, callback = () => {}) {
        try {
            this.statements.touch.run(this.getExpiresAt(sess), sid);
            return callback(null);
        } catch (err) {
            return callback(err);
        }
    }

    destroy(sid, callback = () => {}) {
        try {
            this.statements.destroy.run(sid);
            return callback(null);
        } catch (err) {
            return callback(err);
        }
    }

    pruneExpired() {
        try {
            this.statements.prune.run(Date.now());
            // Also clean up any unauthenticated sessions older than 1 hour
            db.prepare("DELETE FROM sessions WHERE sess NOT LIKE '%\"user\":%' AND expires_at <= ?").run(Date.now() + 30 * 60 * 1000);
        } catch (err) {
            console.error('[sessionStore] Prune error:', err.message);
        }
    }

    getExpiresAt(sess) {
        // Unauthenticated / bot sessions only get 30 minutes TTL
        if (!sess || !sess.user) {
            return Date.now() + (30 * 60 * 1000);
        }
        const expires = sess && sess.cookie && sess.cookie.expires;
        const expiresAt = expires ? new Date(expires).getTime() : Date.now() + this.ttlMs;
        return Number.isFinite(expiresAt) ? expiresAt : Date.now() + this.ttlMs;
    }
}

module.exports = SQLiteSessionStore;
