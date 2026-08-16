const Database = require('better-sqlite3');
const path = require('path');

const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

const oldDbPath = path.join(dataDir, 'videohosk.db');
const dbPath = path.join(dataDir, 'videohost.db');

// Migrate existing videohosk database files if needed
if (fs.existsSync(oldDbPath) && !fs.existsSync(dbPath)) {
    fs.renameSync(oldDbPath, dbPath);
    if (fs.existsSync(oldDbPath + '-wal')) fs.renameSync(oldDbPath + '-wal', dbPath + '-wal');
    if (fs.existsSync(oldDbPath + '-shm')) fs.renameSync(oldDbPath + '-shm', dbPath + '-shm');
}

const db = new Database(dbPath);

// Keep SQLite efficient for a small single-process server.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -4096'); // 4MB — optimized for 1GB RAM VPS

// Create tables
db.exec(`
    CREATE TABLE IF NOT EXISTS videos (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        filename TEXT NOT NULL,
        original_name TEXT,
        size INTEGER DEFAULT 0,
        duration TEXT,
        thumbnail TEXT,
        source_url TEXT,
        import_quality TEXT,
        uploaded_by TEXT DEFAULT 'muaj',
        uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        video_id TEXT NOT NULL,
        user TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY,
        sess TEXT NOT NULL,
        expires_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS watch_progress (
        video_id TEXT NOT NULL,
        user TEXT NOT NULL,
        position_seconds REAL NOT NULL DEFAULT 0,
        duration_seconds REAL DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (video_id, user),
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS user_profiles (
        username TEXT PRIMARY KEY,
        avatar TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS blocked_users (
        username TEXT PRIMARY KEY,
        reason TEXT,
        blocked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_presence (
        username TEXT PRIMARY KEY,
        status TEXT DEFAULT 'offline',
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        current_page TEXT,
        current_video_id TEXT,
        video_title TEXT,
        is_playing INTEGER DEFAULT 0,
        current_time REAL DEFAULT 0,
        duration REAL DEFAULT 0,
        device_info TEXT,
        ip_address TEXT,
        session_id TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        action TEXT NOT NULL,
        video_id TEXT,
        video_title TEXT,
        position_seconds REAL DEFAULT 0,
        duration_seconds REAL DEFAULT 0,
        details TEXT,
        device_info TEXT,
        ip_address TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS watch_time_ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user TEXT NOT NULL,
        video_id TEXT NOT NULL,
        seconds_watched REAL DEFAULT 0,
        watch_date TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user, video_id, watch_date)
    );

    CREATE INDEX IF NOT EXISTS idx_videos_uploaded_at ON videos(uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_video_created ON comments(video_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_watch_progress_user_updated ON watch_progress(user, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_user_time ON activity_logs(username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_watch_ledger_user_date ON watch_time_ledger(user, watch_date);
`);

// Migrations for older SQLite files.
try {
    const tableInfo = db.prepare("PRAGMA table_info(videos)").all();

    const ensureColumn = (name, definition) => {
        const exists = tableInfo.some(col => col.name === name);
        if (!exists) {
            db.exec(`ALTER TABLE videos ADD COLUMN ${definition}`);
            console.log(`[db] Migrated videos table: added ${name} column.`);
        }
    };

    ensureColumn('original_name', 'original_name TEXT');
    ensureColumn('size', 'size INTEGER DEFAULT 0');
    ensureColumn('duration', 'duration TEXT');
    ensureColumn('thumbnail', 'thumbnail TEXT');
    ensureColumn('source_url', 'source_url TEXT');
    ensureColumn('import_quality', 'import_quality TEXT');
    ensureColumn('uploaded_by', "uploaded_by TEXT DEFAULT 'muaj'");

    db.exec('CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by ON videos(uploaded_by)');

    const progressInfo = db.prepare("PRAGMA table_info(watch_progress)").all();
    const hasDurationSeconds = progressInfo.some(col => col.name === 'duration_seconds');
    if (!hasDurationSeconds) {
        db.exec('ALTER TABLE watch_progress ADD COLUMN duration_seconds REAL DEFAULT 0');
        console.log('[db] Migrated watch_progress table: added duration_seconds column.');
    }
} catch (err) {
    console.error('[db] Migration check error:', err.message);
}

function getUserAvatar(username) {
    if (!username) return null;
    try {
        const row = db.prepare('SELECT avatar FROM user_profiles WHERE username = ?').get(username);
        return row ? row.avatar : null;
    } catch {
        return null;
    }
}

function getAllUserAvatars() {
    try {
        const rows = db.prepare('SELECT username, avatar FROM user_profiles').all();
        const map = {};
        rows.forEach(r => { if (r.avatar) map[r.username] = r.avatar; });
        return map;
    } catch {
        return {};
    }
}

function setUserAvatar(username, avatarFilename) {
    db.prepare(`
        INSERT INTO user_profiles (username, avatar, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(username) DO UPDATE SET avatar = excluded.avatar, updated_at = CURRENT_TIMESTAMP
    `).run(username, avatarFilename);
}

function deleteUserAvatar(username) {
    db.prepare('DELETE FROM user_profiles WHERE username = ?').run(username);
}

function isUserBlocked(username) {
    if (!username) return false;
    try {
        const row = db.prepare('SELECT username FROM blocked_users WHERE username = ?').get(username);
        return !!row;
    } catch {
        return false;
    }
}

function blockUser(username, reason = 'Blocked by admin') {
    if (!username) return;
    try {
        db.prepare(`
            INSERT INTO blocked_users (username, reason, blocked_at)
            VALUES (?, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(username) DO UPDATE SET reason = excluded.reason, blocked_at = CURRENT_TIMESTAMP
        `).run(username, reason);
        destroyUserSessions(username);
    } catch (err) {
        console.error('[db] Error blocking user:', err.message);
    }
}

function unblockUser(username) {
    if (!username) return;
    try {
        db.prepare('DELETE FROM blocked_users WHERE username = ?').run(username);
    } catch (err) {
        console.error('[db] Error unblocking user:', err.message);
    }
}

function getBlockedUsers() {
    try {
        return db.prepare('SELECT username, reason, blocked_at FROM blocked_users').all();
    } catch {
        return [];
    }
}

function destroyUserSessions(username) {
    if (!username) return 0;
    try {
        const pattern = `%"user":"${username}"%`;
        const result = db.prepare('DELETE FROM sessions WHERE sess LIKE ?').run(pattern);
        return result.changes || 0;
    } catch (err) {
        console.error('[db] Error destroying user sessions:', err.message);
        return 0;
    }
}

function countUserSessions(username) {
    if (!username) return 0;
    try {
        const pattern = `%"user":"${username}"%`;
        const row = db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE sess LIKE ? AND expires_at > ?').get(pattern, Date.now());
        return row ? row.count : 0;
    } catch {
        return 0;
    }
}

function getLocalDateString(d = new Date()) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function updateUserPresence(username, data = {}) {
    if (!username) return;
    try {
        let status = data.status || 'online';
        const isPlaying = (data.isPlaying === true || data.isPlaying === 1 || data.isPlaying === '1') ? 1 : 0;
        const isIdle = (data.isIdle === true || data.isIdle === 1 || data.isIdle === '1');

        if (status === 'offline') {
            // mark offline
        } else if (isPlaying) {
            status = 'watching';
        } else if (isIdle) {
            status = 'idle';
        } else {
            status = 'online';
        }

        let videoTitle = data.videoTitle || null;
        if (data.videoId && !videoTitle) {
            const v = db.prepare('SELECT title FROM videos WHERE id = ?').get(data.videoId);
            if (v) videoTitle = v.title;
        }

        const currentTime = Number(data.currentTime || data.position || 0);
        const duration = Number(data.duration || 0);
        const page = data.page || data.currentPage || null;
        const deviceInfo = data.deviceInfo || null;
        const ipAddress = data.ipAddress || null;
        const sessionId = data.sessionId || null;
        const nowIso = new Date().toISOString();

        db.prepare(`
            INSERT INTO user_presence (
                username, status, last_seen, current_page, current_video_id,
                video_title, is_playing, current_time, duration, device_info, ip_address, session_id, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(username) DO UPDATE SET
                status = excluded.status,
                last_seen = excluded.last_seen,
                current_page = COALESCE(excluded.current_page, user_presence.current_page),
                current_video_id = excluded.current_video_id,
                video_title = COALESCE(excluded.video_title, user_presence.video_title),
                is_playing = excluded.is_playing,
                current_time = excluded.current_time,
                duration = excluded.duration,
                device_info = COALESCE(excluded.device_info, user_presence.device_info),
                ip_address = COALESCE(excluded.ip_address, user_presence.ip_address),
                session_id = COALESCE(excluded.session_id, user_presence.session_id),
                updated_at = excluded.updated_at
        `).run(
            username, status, nowIso, page, data.videoId || null, videoTitle,
            isPlaying, currentTime, duration, deviceInfo, ipAddress, sessionId, nowIso
        );
    } catch (err) {
        console.error('[db] Error updating user presence:', err.message);
    }
}

function parseSqliteDate(str) {
    if (!str) return 0;
    if (typeof str === 'number') return str;
    const s = String(str).trim();
    const iso = s.includes('T') ? (s.endsWith('Z') ? s : s + 'Z') : s.replace(' ', 'T') + 'Z';
    const t = new Date(iso).getTime();
    return isNaN(t) ? new Date(str).getTime() : t;
}

function normalizeIsoDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    if (s.includes('T') && s.endsWith('Z')) return s;
    return s.includes('T') ? s + 'Z' : s.replace(' ', 'T') + 'Z';
}

function getUserPresence(username) {
    if (!username) return null;
    try {
        const row = db.prepare('SELECT * FROM user_presence WHERE username = ?').get(username);
        if (!row) {
            return {
                username,
                status: 'offline',
                isOnline: false,
                isWatching: false,
                isIdle: false,
                lastSeen: null,
                lastSeenSecondsAgo: null,
                currentPage: null,
                currentVideoId: null,
                videoTitle: null,
                thumbnail: null,
                isPlaying: false,
                currentTime: 0,
                duration: 0,
                deviceInfo: null,
                ipAddress: null
            };
        }

        const now = Date.now();
        const lastSeenTime = parseSqliteDate(row.last_seen || row.updated_at);
        const secondsAgo = Math.max(0, Math.floor((now - lastSeenTime) / 1000));

        let computedStatus = row.status || 'offline';
        // Auto offline if heartbeat timed out (> 45s)
        if (secondsAgo > 45) {
            computedStatus = 'offline';
        } else if (computedStatus === 'watching' && !row.is_playing) {
            computedStatus = 'online';
        }

        const isOnline = computedStatus !== 'offline';
        const isWatching = computedStatus === 'watching' && row.is_playing === 1;
        const isIdle = computedStatus === 'idle';

        // If watching, fetch thumbnail if available
        let thumbnail = null;
        if (row.current_video_id) {
            const v = db.prepare('SELECT thumbnail, title FROM videos WHERE id = ?').get(row.current_video_id);
            if (v) {
                thumbnail = v.thumbnail;
                if (!row.video_title) row.video_title = v.title;
            }
        }

        return {
            username: row.username,
            status: computedStatus,
            isOnline,
            isWatching,
            isIdle,
            lastSeen: normalizeIsoDate(row.last_seen || row.updated_at),
            lastSeenSecondsAgo: secondsAgo,
            currentPage: row.current_page,
            currentVideoId: row.current_video_id,
            videoTitle: row.video_title,
            thumbnail,
            isPlaying: row.is_playing === 1,
            currentTime: Number(row.current_time || 0),
            duration: Number(row.duration || 0),
            deviceInfo: row.device_info,
            ipAddress: row.ip_address,
            updatedAt: normalizeIsoDate(row.updated_at)
        };
    } catch (err) {
        console.error('[db] Error getting user presence:', err.message);
        return null;
    }
}

function logActivity(username, action, data = {}) {
    if (!username || !action) return;
    try {
        const nowIso = new Date().toISOString();

        // Anti-spam debounce: check if identical action on same video happened in last 10s
        const recent = db.prepare(`
            SELECT id, action, video_id, created_at
            FROM activity_logs
            WHERE username = ? AND action = ?
            ORDER BY created_at DESC LIMIT 1
        `).get(username, action);

        if (recent) {
            const diffSeconds = (Date.now() - parseSqliteDate(recent.created_at)) / 1000;
            if (diffSeconds < 10 && String(recent.video_id || '') === String(data.videoId || '')) {
                db.prepare(`
                    UPDATE activity_logs
                    SET position_seconds = ?, duration_seconds = ?, details = ?, created_at = ?
                    WHERE id = ?
                `).run(
                    Number(data.position || data.position_seconds || 0),
                    Number(data.duration || data.duration_seconds || 0),
                    data.details || null,
                    nowIso,
                    recent.id
                );
                return;
            }
        }

        let videoTitle = data.videoTitle || null;
        if (data.videoId && !videoTitle) {
            const v = db.prepare('SELECT title FROM videos WHERE id = ?').get(data.videoId);
            if (v) videoTitle = v.title;
        }

        db.prepare(`
            INSERT INTO activity_logs (
                username, action, video_id, video_title, position_seconds, duration_seconds, details, device_info, ip_address, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            username,
            action,
            data.videoId || null,
            videoTitle,
            Number(data.position || data.position_seconds || 0),
            Number(data.duration || data.duration_seconds || 0),
            data.details || null,
            data.deviceInfo || null,
            data.ipAddress || null,
            nowIso
        );
    } catch (err) {
        console.error('[db] Error logging activity:', err.message);
    }
}

function getRecentActivities(username, limit = 25) {
    try {
        const rows = db.prepare(`
            SELECT a.*, v.thumbnail AS video_thumbnail
            FROM activity_logs a
            LEFT JOIN videos v ON v.id = a.video_id
            WHERE a.username = ?
            ORDER BY a.created_at DESC
            LIMIT ?
        `).all(username, limit);
        return rows.map(r => ({
            ...r,
            created_at: normalizeIsoDate(r.created_at)
        }));
    } catch (err) {
        console.error('[db] Error getting recent activities:', err.message);
        return [];
    }
}

function recordWatchPulse(user, videoId, position, duration, isPlaying, deltaSeconds = 5) {
    if (!user || !videoId) return;
    try {
        const safeDelta = (isPlaying && deltaSeconds > 0) ? Math.min(deltaSeconds, 30) : 0;
        if (safeDelta > 0) {
            const today = getLocalDateString();
            db.prepare(`
                INSERT INTO watch_time_ledger (user, video_id, seconds_watched, watch_date, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(user, video_id, watch_date) DO UPDATE SET
                    seconds_watched = seconds_watched + excluded.seconds_watched,
                    updated_at = CURRENT_TIMESTAMP
            `).run(user, videoId, safeDelta, today);
        }
    } catch (err) {
        console.error('[db] Error recording watch pulse:', err.message);
    }
}

function getUserWatchStats(username) {
    if (!username) return { totalSeconds: 0, todaySeconds: 0 };
    try {
        const totalRow = db.prepare(`
            SELECT SUM(seconds_watched) AS total FROM watch_time_ledger WHERE user = ?
        `).get(username);

        const today = getLocalDateString();
        const todayRow = db.prepare(`
            SELECT SUM(seconds_watched) AS today FROM watch_time_ledger WHERE user = ? AND watch_date = ?
        `).get(username, today);

        let totalSeconds = totalRow && totalRow.total ? Number(totalRow.total) : 0;
        const todaySeconds = todayRow && todayRow.today ? Number(todayRow.today) : 0;

        // If ledger is empty (new migration), fallback compute from watch_progress table
        if (totalSeconds === 0) {
            const wpRow = db.prepare(`
                SELECT SUM(position_seconds) AS total FROM watch_progress WHERE user = ?
            `).get(username);
            if (wpRow && wpRow.total) totalSeconds = Number(wpRow.total);
        }

        return {
            totalSeconds: Math.round(totalSeconds),
            todaySeconds: Math.round(todaySeconds)
        };
    } catch (err) {
        console.error('[db] Error getting user watch stats:', err.message);
        return { totalSeconds: 0, todaySeconds: 0 };
    }
}

function clearOldActivityLogs(username) {
    if (!username) return;
    try {
        db.prepare(`
            DELETE FROM activity_logs
            WHERE username = ? AND id NOT IN (
                SELECT id FROM activity_logs WHERE username = ? ORDER BY created_at DESC LIMIT 500
            )
        `).run(username, username);
    } catch (err) {
        console.error('[db] Error clearing old activity logs:', err.message);
    }
}

db.getUserAvatar = getUserAvatar;
db.getAllUserAvatars = getAllUserAvatars;
db.setUserAvatar = setUserAvatar;
db.deleteUserAvatar = deleteUserAvatar;
db.isUserBlocked = isUserBlocked;
db.blockUser = blockUser;
db.unblockUser = unblockUser;
db.getBlockedUsers = getBlockedUsers;
db.destroyUserSessions = destroyUserSessions;
db.countUserSessions = countUserSessions;
db.updateUserPresence = updateUserPresence;
db.getUserPresence = getUserPresence;
db.logActivity = logActivity;
db.getRecentActivities = getRecentActivities;
db.recordWatchPulse = recordWatchPulse;
db.getUserWatchStats = getUserWatchStats;
db.clearOldActivityLogs = clearOldActivityLogs;

module.exports = db;

