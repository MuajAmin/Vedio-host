const { Database } = require('bun:sqlite');
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

// Ensure compatibility for db.pragma across Bun and Node
if (!db.pragma) {
    db.pragma = function (sql) {
        return db.exec('PRAGMA ' + sql);
    };
}

// Keep SQLite efficient for a small single-process server.
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('synchronous = NORMAL');
db.pragma('temp_store = MEMORY');
db.pragma('cache_size = -8192'); // 8MB page cache in RAM for instant query results
db.pragma('busy_timeout = 5000'); // Wait up to 5s for locks during concurrent writes
db.pragma('mmap_size = 268435456'); // 256MB OS memory-mapped I/O for zero-copy reads
db.pragma('wal_autocheckpoint = 1000');

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

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        recipient TEXT NOT NULL,
        text TEXT,
        video_id TEXT,
        voice_url TEXT,
        reply_to_id INTEGER,
        is_read INTEGER DEFAULT 0,
        read_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE SET NULL,
        FOREIGN KEY (reply_to_id) REFERENCES messages(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER NOT NULL,
        user TEXT NOT NULL,
        reaction TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (message_id, user),
        FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS call_logs (
        id TEXT PRIMARY KEY,
        caller TEXT NOT NULL,
        receiver TEXT NOT NULL,
        call_type TEXT NOT NULL DEFAULT 'audio',
        status TEXT NOT NULL DEFAULT 'missed',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        answered_at DATETIME,
        ended_at DATETIME,
        duration_seconds INTEGER DEFAULT 0,
        end_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS user_settings (
        username TEXT PRIMARY KEY,
        ui_mode TEXT DEFAULT 'standard',
        theme TEXT DEFAULT 'cinematic',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        keys_p256dh TEXT NOT NULL,
        keys_auth TEXT NOT NULL,
        user_agent TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_used_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Real (measured) VPS -> R2 transfer ledger.  The admin dashboard used to
    -- *estimate* offloaded bytes from watch time multiplied by a guessed
    -- bitrate; this table records what actually moved over the wire so the
    -- dashboard can report real numbers instead of a fabricated figure.
    CREATE TABLE IF NOT EXISTS r2_transfer_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        filename TEXT NOT NULL,
        direction TEXT NOT NULL DEFAULT 'vps_to_r2',
        bytes INTEGER NOT NULL DEFAULT 0,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        throughput_bps REAL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'success',
        error TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_videos_uploaded_at ON videos(uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_videos_uploaded_asc ON videos(uploaded_at ASC);
    CREATE INDEX IF NOT EXISTS idx_comments_video_created ON comments(video_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_watch_progress_user_updated ON watch_progress(user, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_activity_logs_user_time ON activity_logs(username, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_watch_ledger_user_date ON watch_time_ledger(user, watch_date);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient_unread ON messages(recipient, is_read);
    CREATE INDEX IF NOT EXISTS idx_messages_pair_created ON messages(sender, recipient, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_pair_id ON messages(sender, recipient, id DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_reactions_message_id ON message_reactions(message_id);
    CREATE INDEX IF NOT EXISTS idx_call_logs_users ON call_logs(caller, receiver, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_call_logs_created ON call_logs(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_push_subs_username ON push_subscriptions(username);
    CREATE INDEX IF NOT EXISTS idx_push_subs_endpoint ON push_subscriptions(endpoint);
    CREATE INDEX IF NOT EXISTS idx_r2_transfer_created ON r2_transfer_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_r2_transfer_status ON r2_transfer_log(status);
    CREATE INDEX IF NOT EXISTS idx_r2_transfer_filename ON r2_transfer_log(filename);
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
    ensureColumn('cdn_status', "cdn_status TEXT DEFAULT 'vps'");

    db.exec('CREATE INDEX IF NOT EXISTS idx_videos_uploaded_by ON videos(uploaded_by)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_videos_source_url ON videos(source_url)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_videos_cdn_status ON videos(cdn_status)');

    const progressInfo = db.prepare("PRAGMA table_info(watch_progress)").all();
    const hasDurationSeconds = progressInfo.some(col => col.name === 'duration_seconds');
    if (!hasDurationSeconds) {
        db.exec('ALTER TABLE watch_progress ADD COLUMN duration_seconds REAL DEFAULT 0');
        console.log('[db] Migrated watch_progress table: added duration_seconds column.');
    }

    const msgInfo = db.prepare("PRAGMA table_info(messages)").all();
    const hasReplyToId = msgInfo.some(col => col.name === 'reply_to_id');
    if (!hasReplyToId) {
        db.exec('ALTER TABLE messages ADD COLUMN reply_to_id INTEGER REFERENCES messages(id) ON DELETE SET NULL');
        console.log('[db] Migrated messages table: added reply_to_id column.');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_messages_reply_to ON messages(reply_to_id)');
} catch (err) {
    console.error('[db] Migration check error:', err.message);
}

function getUserAvatar(username) {
    if (!username) return null;
    try {
        const row = stmtGetUserAvatar.get(username);
        return row ? row.avatar : null;
    } catch {
        return null;
    }
}

function getAllUserAvatars() {
    try {
        const rows = stmtGetAllUserAvatars.all();
        const map = {};
        rows.forEach(r => { if (r.avatar) map[r.username] = r.avatar; });
        return map;
    } catch {
        return {};
    }
}

function setUserAvatar(username, avatarFilename) {
    stmtSetUserAvatar.run(username, avatarFilename);
}

function deleteUserAvatar(username) {
    stmtDeleteUserAvatar.run(username);
}

// --- In-memory cache for blocked users set ---
// isUserBlocked is called on EVERY authenticated HTTP request via middleware.
// Caching the blocked usernames in an in-memory Set converts uncompiled SQLite DB calls
// to instant O(1) in-memory checks (~0ms overhead).
let blockedUsersCache = null;

function resetBlockedUsersCache() {
    blockedUsersCache = null;
}

function getBlockedUsersSet() {
    if (!blockedUsersCache) {
        const rows = stmtGetBlockedUsersSet.all();
        blockedUsersCache = new Set(rows.map(r => r.username));
    }
    return blockedUsersCache;
}

function isUserBlocked(username) {
    if (!username) return false;
    try {
        const cache = getBlockedUsersSet();
        return cache.has(username);
    } catch {
        // Safe fallback if cache population throws (e.g. transient DB lock)
        try {
            const row = stmtIsUserBlocked.get(username);
            return !!row;
        } catch {
            return false;
        }
    }
}

function blockUser(username, reason = 'Blocked by admin') {
    if (!username) return;
    try {
        stmtBlockUser.run(username, reason);
        if (blockedUsersCache) {
            blockedUsersCache.add(username);
        }
        destroyUserSessions(username);
    } catch (err) {
        console.error('[db] Error blocking user:', err.message);
    }
}

function unblockUser(username) {
    if (!username) return;
    try {
        stmtUnblockUser.run(username);
        if (blockedUsersCache) {
            blockedUsersCache.delete(username);
        }
    } catch (err) {
        console.error('[db] Error unblocking user:', err.message);
    }
}

function getBlockedUsers() {
    try {
        return stmtGetBlockedUsers.all();
    } catch {
        return [];
    }
}

function pruneExpiredSessions() {
    try {
        db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(Date.now());
    } catch (err) {
        console.error('[db] Error pruning expired sessions:', err.message);
    }
}

function getAllActiveSessions(currentSid = null) {
    try {
        const rows = db.prepare('SELECT sid, sess, expires_at FROM sessions WHERE expires_at > ? ORDER BY expires_at DESC').all(Date.now());
        const hajeraPresence = getUserPresence('hajera');
        const muajPresence = getUserPresence('muaj');

        const list = [];
        for (const row of rows) {
            try {
                const data = JSON.parse(row.sess);
                if (data && data.user) {
                    const u = String(data.user).toLowerCase();
                    const isCurrent = currentSid ? (row.sid === currentSid) : false;
                    const fallbackPresence = u === 'hajera' ? hajeraPresence : muajPresence;

                    list.push({
                        sid: row.sid,
                        user: u,
                        device: data.device || (fallbackPresence && fallbackPresence.deviceInfo) || 'Web Browser',
                        ip: data.ip || (fallbackPresence && fallbackPresence.ipAddress) || '—',
                        loginTime: data.loginTime || null,
                        lastActive: data.lastActive || (fallbackPresence && fallbackPresence.lastSeen) || null,
                        expiresAt: row.expires_at,
                        isCurrent
                    });
                }
            } catch {}
        }
        return list;
    } catch (err) {
        console.error('[db] Error getting active sessions:', err.message);
        return [];
    }
}

function destroyUserSessions(username) {
    if (!username) return 0;
    try {
        const result = db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.user') = ?").run(username);
        const count = result.changes || 0;

        // Force user presence to offline
        updateUserPresence(username, { status: 'offline' });

        logActivity(username, 'logout', {
            details: `All active sessions (${count}) force-terminated by admin`
        });
        return count;
    } catch (err) {
        console.error('[db] Error destroying user sessions:', err.message);
        return 0;
    }
}

function destroyOtherUserSessions(username, currentSid) {
    if (!username) return 0;
    try {
        let result;
        if (currentSid) {
            result = db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.user') = ? AND sid != ?").run(username, currentSid);
        } else {
            result = db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.user') = ?").run(username);
        }
        const count = result.changes || 0;

        logActivity(username, 'logout', {
            details: `Other active sessions (${count}) force-terminated by admin`
        });
        return count;
    } catch (err) {
        console.error('[db] Error destroying other user sessions:', err.message);
        return 0;
    }
}

function destroySingleSession(sid) {
    if (!sid) return false;
    try {
        const row = db.prepare('SELECT sid, sess FROM sessions WHERE sid = ?').get(sid);
        if (!row) return false;

        let user = null;
        try {
            const parsed = JSON.parse(row.sess);
            user = parsed && parsed.user ? parsed.user : null;
        } catch {}

        db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);

        if (user) {
            const remaining = countUserSessions(user);
            if (remaining === 0) {
                updateUserPresence(user, { status: 'offline' });
            }
            logActivity(user, 'logout', {
                details: `Session (${sid.substring(0, 8)}...) terminated by admin`
            });
        }
        return true;
    } catch (err) {
        console.error('[db] Error destroying single session:', err.message);
        return false;
    }
}

function destroyAllSessions(keepCurrentSid = null) {
    try {
        let result;
        if (keepCurrentSid) {
            result = db.prepare('DELETE FROM sessions WHERE sid != ?').run(keepCurrentSid);
        } else {
            result = db.prepare('DELETE FROM sessions').run();
        }
        updateUserPresence('hajera', { status: 'offline' });
        return result.changes || 0;
    } catch (err) {
        console.error('[db] Error destroying all sessions:', err.message);
        return 0;
    }
}

function countUserSessions(username) {
    if (!username) return 0;
    try {
        const row = stmtCountUserSessions.get(username, Date.now());
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

// ============================================================
//  Precompiled Statements for High-Speed DB Execution
// ============================================================
const stmtGetUserAvatar = db.prepare('SELECT avatar FROM user_profiles WHERE username = ?');
const stmtGetAllUserAvatars = db.prepare('SELECT username, avatar FROM user_profiles');
const stmtSetUserAvatar = db.prepare(`
    INSERT INTO user_profiles (username, avatar, updated_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(username) DO UPDATE SET avatar = excluded.avatar, updated_at = CURRENT_TIMESTAMP
`);
const stmtDeleteUserAvatar = db.prepare('DELETE FROM user_profiles WHERE username = ?');
const stmtGetBlockedUsersSet = db.prepare('SELECT username FROM blocked_users');
const stmtIsUserBlocked = db.prepare('SELECT username FROM blocked_users WHERE username = ?');
const stmtBlockUser = db.prepare(`
    INSERT INTO blocked_users (username, reason, blocked_at)
    VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(username) DO UPDATE SET reason = excluded.reason, blocked_at = CURRENT_TIMESTAMP
`);
const stmtUnblockUser = db.prepare('DELETE FROM blocked_users WHERE username = ?');
const stmtGetBlockedUsers = db.prepare('SELECT username, reason, blocked_at FROM blocked_users');
const stmtCountUserSessions = db.prepare("SELECT COUNT(*) AS count FROM sessions WHERE json_extract(sess, '$.user') = ? AND expires_at > ?");
const stmtGetUserSettings = db.prepare('SELECT ui_mode, theme FROM user_settings WHERE username = ?');
const stmtSetUserSettingUiMode = db.prepare(`
    INSERT INTO user_settings (username, ui_mode, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET ui_mode = excluded.ui_mode, updated_at = excluded.updated_at
`);
const stmtSetUserSettingTheme = db.prepare(`
    INSERT INTO user_settings (username, theme, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(username) DO UPDATE SET theme = excluded.theme, updated_at = excluded.updated_at
`);
const stmtGetVideoBySourceUrl = db.prepare('SELECT id, title, filename, thumbnail, duration, size, source_url, uploaded_by, uploaded_at FROM videos WHERE source_url = ? LIMIT 1');
const stmtGetPushSubscriptions = db.prepare('SELECT * FROM push_subscriptions WHERE username = ?');
const stmtDeletePushSubscriptionsForUser = db.prepare('DELETE FROM push_subscriptions WHERE username = ?');
const stmtTouchPushSubscription = db.prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?');

const stmtPresenceUpsert = db.prepare(`
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
`);

const stmtPresenceGet = db.prepare('SELECT * FROM user_presence WHERE username = ?');
const stmtVideoMiniInfo = db.prepare('SELECT thumbnail, title FROM videos WHERE id = ?');
const stmtVideoTitleOnly = db.prepare('SELECT title FROM videos WHERE id = ?');

const stmtActivityRecentDebounce = db.prepare(`
    SELECT id, action, video_id, created_at
    FROM activity_logs
    WHERE username = ? AND action = ?
    ORDER BY created_at DESC LIMIT 1
`);

const stmtActivityUpdateDebounced = db.prepare(`
    UPDATE activity_logs
    SET position_seconds = ?, duration_seconds = ?, details = ?, created_at = ?
    WHERE id = ?
`);

const stmtActivityInsert = db.prepare(`
    INSERT INTO activity_logs (
        username, action, video_id, video_title, position_seconds, duration_seconds, details, device_info, ip_address, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtWatchLedgerUpsert = db.prepare(`
    INSERT INTO watch_time_ledger (user, video_id, seconds_watched, watch_date, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(user, video_id, watch_date) DO UPDATE SET
        seconds_watched = seconds_watched + excluded.seconds_watched,
        updated_at = CURRENT_TIMESTAMP
`);

const stmtWatchLedgerTotal = db.prepare(`
    SELECT SUM(seconds_watched) AS total FROM watch_time_ledger WHERE user = ?
`);

const stmtWatchLedgerToday = db.prepare(`
    SELECT SUM(seconds_watched) AS today FROM watch_time_ledger WHERE user = ? AND watch_date = ?
`);

const stmtWatchProgressTotalFallback = db.prepare(`
    SELECT SUM(position_seconds) AS total FROM watch_progress WHERE user = ?
`);

const stmtMessageReactionsForMsg = db.prepare(`
    SELECT reaction, user, created_at
    FROM message_reactions
    WHERE message_id = ?
    ORDER BY created_at ASC
`);

const stmtMessageReactionGet = db.prepare(`
    SELECT reaction FROM message_reactions
    WHERE message_id = ? AND user = ?
`);

const stmtMessageReactionDelete = db.prepare(`
    DELETE FROM message_reactions WHERE message_id = ? AND user = ?
`);

const stmtMessageReactionUpsert = db.prepare(`
    INSERT INTO message_reactions (message_id, user, reaction, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, user) DO UPDATE SET reaction = excluded.reaction, created_at = excluded.created_at
`);

const stmtMessageSave = db.prepare(`
    INSERT INTO messages (sender, recipient, text, video_id, voice_url, reply_to_id, is_read, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
`);

const stmtMessageGetById = db.prepare(`
    SELECT m.*,
           v.title AS video_title,
           v.thumbnail AS video_thumbnail,
           v.duration AS video_duration,
           v.size AS video_size,
           v.uploaded_by AS video_uploaded_by,
           p.avatar AS sender_avatar,
           rm.sender AS reply_sender,
           rm.text AS reply_text,
           rm.video_id AS reply_video_id,
           rm.voice_url AS reply_voice_url,
           rv.title AS reply_video_title,
           rv.thumbnail AS reply_video_thumbnail,
           rp.avatar AS reply_sender_avatar
    FROM messages m
    LEFT JOIN videos v ON v.id = m.video_id
    LEFT JOIN user_profiles p ON p.username = m.sender
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN videos rv ON rv.id = rm.video_id
    LEFT JOIN user_profiles rp ON rp.username = rm.sender
    WHERE m.id = ?
`);

const stmtMessagesMarkRead = db.prepare(`
    UPDATE messages
    SET is_read = 1, read_at = ?
    WHERE sender = ? AND recipient = ? AND is_read = 0
`);

const stmtMessagesUnreadCount = db.prepare(`
    SELECT COUNT(*) AS unread_count
    FROM messages
    WHERE recipient = ? AND is_read = 0
`);

const stmtMessageDelete = db.prepare('DELETE FROM messages WHERE id = ?');
const stmtMessageGetForDelete = db.prepare('SELECT id, sender, voice_url FROM messages WHERE id = ?');

const stmtMessageStats = db.prepare(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN video_id IS NOT NULL THEN 1 ELSE 0 END) AS videos_count,
           SUM(CASE WHEN voice_url IS NOT NULL THEN 1 ELSE 0 END) AS voice_count,
           SUM(CASE WHEN text LIKE '__CALL_EVENT__:%' THEN 1 ELSE 0 END) AS calls_count
    FROM messages
    WHERE ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
`);

const stmtInitialConversation = db.prepare(`
    SELECT m.*,
           v.title AS video_title,
           v.thumbnail AS video_thumbnail,
           v.duration AS video_duration,
           v.size AS video_size,
           v.uploaded_by AS video_uploaded_by,
           p.avatar AS sender_avatar,
           rm.sender AS reply_sender,
           rm.text AS reply_text,
           rm.video_id AS reply_video_id,
           rm.voice_url AS reply_voice_url,
           rv.title AS reply_video_title,
           rv.thumbnail AS reply_video_thumbnail,
           rp.avatar AS reply_sender_avatar
    FROM messages m
    LEFT JOIN videos v ON v.id = m.video_id
    LEFT JOIN user_profiles p ON p.username = m.sender
    LEFT JOIN messages rm ON rm.id = m.reply_to_id
    LEFT JOIN videos rv ON rv.id = rm.video_id
    LEFT JOIN user_profiles rp ON rp.username = rm.sender
    WHERE ((m.sender = ? AND m.recipient = ?) OR (m.sender = ? AND m.recipient = ?))
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT ?
`);

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
            const v = stmtVideoTitleOnly.get(data.videoId);
            if (v) videoTitle = v.title;
        }

        const currentTime = Number(data.currentTime || data.position || 0);
        const duration = Number(data.duration || 0);
        const page = data.page || data.currentPage || null;
        const deviceInfo = data.deviceInfo || null;
        const ipAddress = data.ipAddress || null;
        const sessionId = data.sessionId || null;
        const nowIso = new Date().toISOString();

        stmtPresenceUpsert.run(
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
    if (!s) return 0;
    const iso = (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) ? s.replace(' ', 'T') : (s.includes('T') ? s + 'Z' : s.replace(' ', 'T') + 'Z');
    const t = new Date(iso).getTime();
    return isNaN(t) ? new Date(str).getTime() || 0 : t;
}

function normalizeIsoDate(str) {
    if (!str) return null;
    const s = String(str).trim();
    if (!s) return null;
    if (s.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(s)) {
        return s.replace(' ', 'T');
    }
    return s.includes('T') ? s + 'Z' : s.replace(' ', 'T') + 'Z';
}

function getUserPresence(username) {
    if (!username) return null;
    try {
        const row = stmtPresenceGet.get(username);
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
            const v = stmtVideoMiniInfo.get(row.current_video_id);
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
        const recent = stmtActivityRecentDebounce.get(username, action);

        if (recent) {
            const diffSeconds = (Date.now() - parseSqliteDate(recent.created_at)) / 1000;
            if (diffSeconds < 10 && String(recent.video_id || '') === String(data.videoId || '')) {
                stmtActivityUpdateDebounced.run(
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
            const v = stmtVideoTitleOnly.get(data.videoId);
            if (v) videoTitle = v.title;
        }

        stmtActivityInsert.run(
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
            stmtWatchLedgerUpsert.run(user, videoId, safeDelta, today);
        }
    } catch (err) {
        console.error('[db] Error recording watch pulse:', err.message);
    }
}

function getUserWatchStats(username) {
    if (!username) return { totalSeconds: 0, todaySeconds: 0 };
    try {
        const totalRow = stmtWatchLedgerTotal.get(username);
        const today = getLocalDateString();
        const todayRow = stmtWatchLedgerToday.get(username, today);

        let totalSeconds = totalRow && totalRow.total ? Number(totalRow.total) : 0;
        const todaySeconds = todayRow && todayRow.today ? Number(todayRow.today) : 0;

        // If ledger is empty (new migration), fallback compute from watch_progress table
        if (totalSeconds === 0) {
            const wpRow = stmtWatchProgressTotalFallback.get(username);
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

function getReactionsForMessage(messageId) {
    if (!messageId) return [];
    try {
        const rows = stmtMessageReactionsForMsg.all(messageId);
        return rows;
    } catch {
        return [];
    }
}

function getReactionsForMessages(messageIds) {
    if (!messageIds || messageIds.length === 0) return {};
    try {
        const placeholders = messageIds.map(() => '?').join(',');
        const rows = db.prepare(`
            SELECT message_id, reaction, user, created_at
            FROM message_reactions
            WHERE message_id IN (${placeholders})
            ORDER BY created_at ASC
        `).all(...messageIds);

        const map = {};
        rows.forEach(r => {
            if (!map[r.message_id]) map[r.message_id] = [];
            map[r.message_id].push({ reaction: r.reaction, user: r.user });
        });
        return map;
    } catch {
        return {};
    }
}

function toggleMessageReaction(messageId, user, reaction) {
    if (!messageId || !user || !reaction) return null;
    try {
        const existing = stmtMessageReactionGet.get(messageId, user);

        let action = 'added';
        if (existing && existing.reaction === reaction) {
            stmtMessageReactionDelete.run(messageId, user);
            action = 'removed';
        } else {
            stmtMessageReactionUpsert.run(messageId, user, reaction, new Date().toISOString());
            action = 'added';
        }

        const currentReactions = getReactionsForMessage(messageId);
        return { action, messageId, user, reaction, reactions: currentReactions };
    } catch (err) {
        console.error('[db] Error toggling message reaction:', err.message);
        return null;
    }
}

function formatMessageRow(r, reactions = null) {
    if (!r) return null;
    const msgReactions = reactions !== null ? reactions : getReactionsForMessage(r.id);

    let replyTo = null;
    if (r.reply_to_id) {
        if (r.reply_sender) {
            replyTo = {
                id: r.reply_to_id,
                sender: r.reply_sender,
                text: r.reply_text || null,
                videoId: r.reply_video_id || null,
                videoTitle: r.reply_video_title || null,
                videoThumbnail: r.reply_video_thumbnail || null,
                voiceUrl: r.reply_voice_url || null,
                senderAvatar: r.reply_sender_avatar || null,
                isDeleted: false
            };
        } else {
            replyTo = {
                id: r.reply_to_id,
                sender: null,
                text: 'Original message deleted',
                videoId: null,
                videoTitle: null,
                videoThumbnail: null,
                voiceUrl: null,
                senderAvatar: null,
                isDeleted: true
            };
        }
    }

    return {
        id: r.id,
        sender: r.sender,
        recipient: r.recipient,
        text: r.text || null,
        videoId: r.video_id || null,
        voiceUrl: r.voice_url || null,
        replyToId: r.reply_to_id || null,
        replyTo,
        isRead: r.is_read === 1,
        readAt: r.read_at ? normalizeIsoDate(r.read_at) : null,
        createdAt: normalizeIsoDate(r.created_at),
        senderAvatar: r.sender_avatar || null,
        reactions: msgReactions || [],
        video: r.video_id ? {
            id: r.video_id,
            title: r.video_title || 'Video',
            thumbnail: r.video_thumbnail || null,
            duration: r.video_duration || null,
            size: r.video_size || 0,
            uploadedBy: r.video_uploaded_by || null
        } : null
    };
}

function saveMessage({ sender, recipient, text = null, videoId = null, voiceUrl = null, replyToId = null }) {
    if (!sender || !recipient) return null;
    try {
        let validReplyToId = null;
        if (replyToId) {
            const parsedId = parseInt(replyToId, 10);
            if (!isNaN(parsedId) && parsedId > 0) {
                // Ensure referenced message belongs to the conversation
                const refMsg = db.prepare(`
                    SELECT id FROM messages
                    WHERE id = ? AND ((sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?))
                `).get(parsedId, sender, recipient, recipient, sender);
                if (refMsg) {
                    validReplyToId = parsedId;
                }
            }
        }

        const nowIso = new Date().toISOString();
        const info = stmtMessageSave.run(sender, recipient, text ? String(text).trim() : null, videoId || null, voiceUrl || null, validReplyToId, nowIso);

        return getMessageById(info.lastInsertRowid);
    } catch (err) {
        console.error('[db] Error saving message:', err.message);
        return null;
    }
}

function getMessageById(id) {
    if (!id) return null;
    try {
        const row = stmtMessageGetById.get(id);
        return formatMessageRow(row);
    } catch (err) {
        console.error('[db] Error getting message by id:', err.message);
        return null;
    }
}

function getConversationMessages(user1, user2, limit = 80, beforeId = null, afterId = null) {
    if (!user1 || !user2) return [];
    try {
        if (!beforeId && !afterId) {
            const rows = stmtInitialConversation.all(user1, user2, user2, user1, Math.min(limit, 200));
            const msgIds = rows.map(r => r.id);
            const reactionsMap = getReactionsForMessages(msgIds);
            return rows.map(r => formatMessageRow(r, reactionsMap[r.id] || [])).reverse();
        }

        let query = `
            SELECT m.*,
                   v.title AS video_title,
                   v.thumbnail AS video_thumbnail,
                   v.duration AS video_duration,
                   v.size AS video_size,
                   v.uploaded_by AS video_uploaded_by,
                   p.avatar AS sender_avatar,
                   rm.sender AS reply_sender,
                   rm.text AS reply_text,
                   rm.video_id AS reply_video_id,
                   rm.voice_url AS reply_voice_url,
                   rv.title AS reply_video_title,
                   rv.thumbnail AS reply_video_thumbnail,
                   rp.avatar AS reply_sender_avatar
            FROM messages m
            LEFT JOIN videos v ON v.id = m.video_id
            LEFT JOIN user_profiles p ON p.username = m.sender
            LEFT JOIN messages rm ON rm.id = m.reply_to_id
            LEFT JOIN videos rv ON rv.id = rm.video_id
            LEFT JOIN user_profiles rp ON rp.username = rm.sender
            WHERE ((m.sender = ? AND m.recipient = ?) OR (m.sender = ? AND m.recipient = ?))
        `;
        const params = [user1, user2, user2, user1];

        if (afterId) {
            query += ` AND m.id > ? ORDER BY m.created_at ASC, m.id ASC LIMIT ?`;
            params.push(afterId, Math.min(limit, 200));
            const rows = db.prepare(query).all(...params);
            const msgIds = rows.map(r => r.id);
            const reactionsMap = getReactionsForMessages(msgIds);
            return rows.map(r => formatMessageRow(r, reactionsMap[r.id] || []));
        }

        if (beforeId) {
            query += ` AND m.id < ?`;
            params.push(beforeId);
        }

        query += ` ORDER BY m.created_at DESC, m.id DESC LIMIT ?`;
        params.push(Math.min(limit, 200));

        const rows = db.prepare(query).all(...params);
        const msgIds = rows.map(r => r.id);
        const reactionsMap = getReactionsForMessages(msgIds);

        return rows.map(r => formatMessageRow(r, reactionsMap[r.id] || [])).reverse();
    } catch (err) {
        console.error('[db] Error getting conversation messages:', err.message);
        return [];
    }
}

function markMessagesAsRead(sender, recipient) {
    if (!sender || !recipient) return 0;
    try {
        const nowIso = new Date().toISOString();
        const result = stmtMessagesMarkRead.run(nowIso, sender, recipient);
        return result.changes || 0;
    } catch (err) {
        console.error('[db] Error marking messages as read:', err.message);
        return 0;
    }
}

function getUnreadMessageCount(recipient) {
    if (!recipient) return 0;
    try {
        const row = stmtMessagesUnreadCount.get(recipient);
        return row ? row.unread_count : 0;
    } catch {
        return 0;
    }
}

function deleteMessage(messageId, requestingUser) {
    if (!messageId || !requestingUser) return false;
    try {
        const msg = stmtMessageGetForDelete.get(messageId);
        if (!msg) return false;

        if (msg.sender !== requestingUser && requestingUser !== 'muaj') {
            return false;
        }

        stmtMessageDelete.run(messageId);
        return true;
    } catch (err) {
        console.error('[db] Error deleting message:', err.message);
        return false;
    }
}

function getMessageStats(user1, user2) {
    try {
        const totalRow = stmtMessageStats.get(user1, user2, user2, user1);

        return {
            totalMessages: totalRow ? (totalRow.total || 0) : 0,
            sharedVideos: totalRow ? (totalRow.videos_count || 0) : 0,
            voiceMessages: totalRow ? (totalRow.voice_count || 0) : 0,
            totalCalls: totalRow ? (totalRow.calls_count || 0) : 0
        };
    } catch {
        return { totalMessages: 0, sharedVideos: 0, voiceMessages: 0, totalCalls: 0 };
    }
}

function createCallLog({ id, caller, receiver, callType = 'audio' }) {
    if (!id || !caller || !receiver) return null;
    try {
        const nowIso = new Date().toISOString();
        db.prepare(`
            INSERT INTO call_logs (id, caller, receiver, call_type, status, started_at, created_at)
            VALUES (?, ?, ?, ?, 'ringing', ?, ?)
        `).run(id, caller, receiver, callType, nowIso, nowIso);
        return getCallLog(id);
    } catch (err) {
        console.error('[db] Error creating call log:', err.message);
        return null;
    }
}

function updateCallLog(id, updates = {}) {
    if (!id) return null;
    try {
        const fields = [];
        const values = [];

        if (updates.status !== undefined) {
            fields.push('status = ?');
            values.push(updates.status);
        }
        if (updates.answeredAt !== undefined) {
            fields.push('answered_at = ?');
            values.push(updates.answeredAt);
        }
        if (updates.endedAt !== undefined) {
            fields.push('ended_at = ?');
            values.push(updates.endedAt);
        }
        if (updates.durationSeconds !== undefined) {
            fields.push('duration_seconds = ?');
            values.push(Number(updates.durationSeconds || 0));
        }
        if (updates.endReason !== undefined) {
            fields.push('end_reason = ?');
            values.push(updates.endReason);
        }

        if (fields.length === 0) return getCallLog(id);

        values.push(id);
        db.prepare(`UPDATE call_logs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
        return getCallLog(id);
    } catch (err) {
        console.error('[db] Error updating call log:', err.message);
        return null;
    }
}

function getCallLog(id) {
    if (!id) return null;
    try {
        const row = db.prepare('SELECT * FROM call_logs WHERE id = ?').get(id);
        if (!row) return null;
        return {
            id: row.id,
            caller: row.caller,
            receiver: row.receiver,
            callType: row.call_type,
            status: row.status,
            startedAt: normalizeIsoDate(row.started_at),
            answeredAt: normalizeIsoDate(row.answered_at),
            endedAt: normalizeIsoDate(row.ended_at),
            durationSeconds: row.duration_seconds || 0,
            endReason: row.end_reason,
            createdAt: normalizeIsoDate(row.created_at)
        };
    } catch (err) {
        console.error('[db] Error getting call log:', err.message);
        return null;
    }
}

function getRecentCallLogs(user1, user2, limit = 30) {
    try {
        const rows = db.prepare(`
            SELECT * FROM call_logs
            WHERE (caller = ? AND receiver = ?) OR (caller = ? AND receiver = ?)
            ORDER BY created_at DESC
            LIMIT ?
        `).all(user1, user2, user2, user1, limit);
        return rows.map(r => ({
            id: r.id,
            caller: r.caller,
            receiver: r.receiver,
            callType: r.call_type,
            status: r.status,
            startedAt: normalizeIsoDate(r.started_at),
            answeredAt: normalizeIsoDate(r.answered_at),
            endedAt: normalizeIsoDate(r.ended_at),
            durationSeconds: r.duration_seconds || 0,
            endReason: r.end_reason,
            createdAt: normalizeIsoDate(r.created_at)
        }));
    } catch (err) {
        console.error('[db] Error getting recent call logs:', err.message);
        return [];
    }
}

function getUserSettings(username) {
    if (!username) return { ui_mode: 'standard', theme: 'cinematic' };
    try {
        const row = stmtGetUserSettings.get(username);
        const defaultTheme = (username === 'hajera') ? 'sunset' : 'cinematic';
        if (!row) {
            return { ui_mode: 'standard', theme: defaultTheme };
        }
        return {
            ui_mode: row.ui_mode || 'standard',
            theme: row.theme || defaultTheme
        };
    } catch (err) {
        console.error('[db] Error getting user settings:', err.message);
        return { ui_mode: 'standard', theme: (username === 'hajera') ? 'sunset' : 'cinematic' };
    }
}

function setUserSetting(username, key, value) {
    if (!username || !key) return false;
    try {
        const now = new Date().toISOString();
        if (key === 'ui_mode') {
            const cleanVal = String(value);
            stmtSetUserSettingUiMode.run(username, cleanVal, now);
            return true;
        }
        if (key === 'theme') {
            const cleanVal = String(value);
            stmtSetUserSettingTheme.run(username, cleanVal, now);
            return true;
        }
        return false;
    } catch (err) {
        console.error('[db] Error saving user setting:', err.message);
        return false;
    }
}

db.getUserAvatar = getUserAvatar;
db.getAllUserAvatars = getAllUserAvatars;
db.setUserAvatar = setUserAvatar;
db.deleteUserAvatar = deleteUserAvatar;
db.getUserSettings = getUserSettings;
db.setUserSetting = setUserSetting;
db.isUserBlocked = isUserBlocked;
db.blockUser = blockUser;
db.unblockUser = unblockUser;
db.resetBlockedUsersCache = resetBlockedUsersCache;
db.getBlockedUsers = getBlockedUsers;
db.destroyUserSessions = destroyUserSessions;
db.destroyOtherUserSessions = destroyOtherUserSessions;
db.destroySingleSession = destroySingleSession;
db.destroyAllSessions = destroyAllSessions;
db.getAllActiveSessions = getAllActiveSessions;
db.pruneExpiredSessions = pruneExpiredSessions;
db.countUserSessions = countUserSessions;
db.updateUserPresence = updateUserPresence;
db.getUserPresence = getUserPresence;
db.logActivity = logActivity;
db.getRecentActivities = getRecentActivities;
db.recordWatchPulse = recordWatchPulse;
db.getUserWatchStats = getUserWatchStats;
db.clearOldActivityLogs = clearOldActivityLogs;
db.saveMessage = saveMessage;
db.getMessageById = getMessageById;
db.getConversationMessages = getConversationMessages;
db.markMessagesAsRead = markMessagesAsRead;
db.getUnreadMessageCount = getUnreadMessageCount;
db.deleteMessage = deleteMessage;
db.getMessageStats = getMessageStats;
db.toggleMessageReaction = toggleMessageReaction;
db.getReactionsForMessage = getReactionsForMessage;
db.createCallLog = createCallLog;
db.updateCallLog = updateCallLog;
db.getCallLog = getCallLog;
db.getRecentCallLogs = getRecentCallLogs;

function getVideoBySourceUrl(sourceUrl) {
    if (!sourceUrl) return null;
    try {
        return stmtGetVideoBySourceUrl.get(sourceUrl) || null;
    } catch {
        return null;
    }
}

db.getVideoBySourceUrl = getVideoBySourceUrl;

// ============================================================
//  PUSH SUBSCRIPTION HELPERS
// ============================================================

function savePushSubscription(username, subscription, userAgent = null) {
    if (!username || !subscription || !subscription.endpoint) return null;
    try {
        const keys = subscription.keys || {};
        const nowIso = new Date().toISOString();
        db.prepare(`
            INSERT INTO push_subscriptions (username, endpoint, keys_p256dh, keys_auth, user_agent, created_at, last_used_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(endpoint) DO UPDATE SET
                username = excluded.username,
                keys_p256dh = excluded.keys_p256dh,
                keys_auth = excluded.keys_auth,
                user_agent = COALESCE(excluded.user_agent, push_subscriptions.user_agent),
                last_used_at = excluded.last_used_at
        `).run(username, subscription.endpoint, keys.p256dh || '', keys.auth || '', userAgent, nowIso, nowIso);
        return true;
    } catch (err) {
        console.error('[db] Error saving push subscription:', err.message);
        return null;
    }
}

function getPushSubscriptions(username) {
    if (!username) return [];
    try {
        return stmtGetPushSubscriptions.all(username);
    } catch (err) {
        console.error('[db] Error getting push subscriptions:', err.message);
        return [];
    }
}

function deletePushSubscription(endpoint) {
    if (!endpoint) return false;
    try {
        db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
        return true;
    } catch (err) {
        console.error('[db] Error deleting push subscription:', err.message);
        return false;
    }
}

function deletePushSubscriptionsForUser(username) {
    if (!username) return 0;
    try {
        const result = stmtDeletePushSubscriptionsForUser.run(username);
        return result.changes || 0;
    } catch (err) {
        console.error('[db] Error deleting user push subscriptions:', err.message);
        return 0;
    }
}

function cleanupStalePushSubscriptions(maxAgeDays = 30) {
    try {
        const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
        const result = db.prepare('DELETE FROM push_subscriptions WHERE last_used_at < ?').run(cutoff);
        if (result.changes > 0) {
            console.log(`[db] Cleaned up ${result.changes} stale push subscriptions.`);
        }
        return result.changes || 0;
    } catch (err) {
        console.error('[db] Error cleaning up stale push subscriptions:', err.message);
        return 0;
    }
}

function touchPushSubscription(endpoint) {
    if (!endpoint) return;
    try {
        stmtTouchPushSubscription.run(new Date().toISOString(), endpoint);
    } catch {}
}

function pruneActivityLogs(maxKeep = 1500) {
    try {
        const result = db.prepare(`
            DELETE FROM activity_logs
            WHERE id NOT IN (
                SELECT id FROM activity_logs
                ORDER BY created_at DESC, id DESC
                LIMIT ?
            )
        `).run(maxKeep);
        if (result.changes > 0) {
            console.log(`[db] Pruned ${result.changes} old activity logs.`);
        }
        return result.changes || 0;
    } catch (err) {
        console.error('[db] Error pruning activity logs:', err.message);
        return 0;
    }
}

// Prune activity logs every 30 minutes (unref so it doesn't block shutdown)
setInterval(() => pruneActivityLogs(1500), 30 * 60 * 1000).unref();
pruneActivityLogs(1500);

// =============================================================================
//  R2 Transfer Ledger — real measured VPS -> R2 transfer accounting
// =============================================================================

const stmtR2TransferInsert = db.prepare(`
    INSERT INTO r2_transfer_log (filename, direction, bytes, duration_ms, throughput_bps, status, error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

// Totals cover every successful transfer into R2 (VPS-side multipart uploads and
// direct client -> Worker -> R2 uploads) so the dashboard reports the real total.
const stmtR2TransferStats = db.prepare(`
    SELECT
        COUNT(*)                AS transferCount,
        COALESCE(SUM(bytes), 0) AS totalBytes,
        COALESCE(SUM(duration_ms), 0) AS totalMs
    FROM r2_transfer_log
    WHERE status = 'success'
`);

// Speed is only meaningful for transfers the VPS actually performed and timed;
// direct client uploads are logged with duration_ms = 0 and must not skew it.
const stmtR2TransferSpeed = db.prepare(`
    SELECT
        COALESCE(AVG(throughput_bps), 0) AS avgBps,
        COALESCE(MAX(throughput_bps), 0) AS peakBps
    FROM r2_transfer_log
    WHERE status = 'success' AND direction = 'vps_to_r2' AND duration_ms > 0
`);

const stmtR2TransferFailures = db.prepare(`
    SELECT COUNT(*) AS failureCount FROM r2_transfer_log WHERE status != 'success'
`);

const stmtR2TransferRecent = db.prepare(`
    SELECT filename, bytes, duration_ms, throughput_bps, status, error, created_at
    FROM r2_transfer_log
    ORDER BY id DESC
    LIMIT ?
`);

/**
 * Record a completed (or failed) VPS -> R2 transfer with real measured bytes.
 * @param {{ filename: string, bytes?: number, durationMs?: number, status?: string, error?: string, direction?: string }} entry
 */
function recordR2Transfer(entry) {
    try {
        const bytes = Math.max(0, Math.round(Number(entry.bytes || 0)));
        const durationMs = Math.max(0, Math.round(Number(entry.durationMs || 0)));
        const throughput = durationMs > 0 ? (bytes / (durationMs / 1000)) : 0;
        stmtR2TransferInsert.run(
            String(entry.filename || ''),
            String(entry.direction || 'vps_to_r2'),
            bytes,
            durationMs,
            throughput,
            String(entry.status || 'success'),
            entry.error ? String(entry.error).slice(0, 500) : null
        );
    } catch (err) {
        console.warn('[db] Could not record R2 transfer:', err.message);
    }
}

/**
 * Aggregate real R2 transfer statistics for the admin dashboard.
 * @returns {{ transferCount: number, totalBytes: number, totalMs: number, avgBps: number, peakBps: number, failureCount: number }}
 */
function getR2TransferStats() {
    try {
        const row = stmtR2TransferStats.get() || {};
        const speed = stmtR2TransferSpeed.get() || {};
        const fail = stmtR2TransferFailures.get() || {};
        return {
            transferCount: Number(row.transferCount || 0),
            totalBytes: Number(row.totalBytes || 0),
            totalMs: Number(row.totalMs || 0),
            avgBps: Number(speed.avgBps || 0),
            peakBps: Number(speed.peakBps || 0),
            failureCount: Number(fail.failureCount || 0)
        };
    } catch {
        return { transferCount: 0, totalBytes: 0, totalMs: 0, avgBps: 0, peakBps: 0, failureCount: 0 };
    }
}

/**
 * Most recent transfer log rows (newest first) for the admin transfer table.
 * @param {number} [limit=10]
 */
function getRecentR2Transfers(limit = 10) {
    try {
        const n = Number.isInteger(limit) && limit > 0 && limit <= 100 ? limit : 10;
        return stmtR2TransferRecent.all(n);
    } catch {
        return [];
    }
}

/**
 * One-time seed: videos already confirmed on R2 before the transfer ledger
 * existed have no log rows, which would make the admin dashboard report 0 bytes
 * transferred on a library that is in fact fully synced. Backfill them once, with
 * duration_ms = 0 so they never distort the measured throughput averages.
 */
function seedR2TransferLedger() {
    try {
        const existing = db.prepare('SELECT COUNT(*) AS count FROM r2_transfer_log').get();
        if (Number(existing?.count || 0) > 0) return;

        const rows = db.prepare(
            "SELECT filename, size FROM videos WHERE cdn_status IN ('r2_ready', 'r2_only') AND filename IS NOT NULL"
        ).all();
        if (rows.length === 0) return;

        const insertMany = db.transaction((items) => {
            for (const item of items) {
                stmtR2TransferInsert.run(
                    item.filename,
                    'vps_to_r2',
                    Math.max(0, Number(item.size || 0)),
                    0,
                    0,
                    'success',
                    null
                );
            }
        });
        insertMany(rows);
        console.log(`[db] Seeded R2 transfer ledger with ${rows.length} pre-existing R2 video(s).`);
    } catch (err) {
        console.warn('[db] Could not seed R2 transfer ledger:', err.message);
    }
}

seedR2TransferLedger();

db.recordR2Transfer = recordR2Transfer;
db.getR2TransferStats = getR2TransferStats;
db.getRecentR2Transfers = getRecentR2Transfers;

db.savePushSubscription = savePushSubscription;
db.getPushSubscriptions = getPushSubscriptions;
db.deletePushSubscription = deletePushSubscription;
db.deletePushSubscriptionsForUser = deletePushSubscriptionsForUser;
db.cleanupStalePushSubscriptions = cleanupStalePushSubscriptions;
db.touchPushSubscription = touchPushSubscription;
db.pruneActivityLogs = pruneActivityLogs;

module.exports = db;

