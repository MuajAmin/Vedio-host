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

    CREATE INDEX IF NOT EXISTS idx_videos_uploaded_at ON videos(uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_video_created ON comments(video_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_watch_progress_user_updated ON watch_progress(user, updated_at DESC);
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

    const progressInfo = db.prepare("PRAGMA table_info(watch_progress)").all();
    const hasDurationSeconds = progressInfo.some(col => col.name === 'duration_seconds');
    if (!hasDurationSeconds) {
        db.exec('ALTER TABLE watch_progress ADD COLUMN duration_seconds REAL DEFAULT 0');
        console.log('[db] Migrated watch_progress table: added duration_seconds column.');
    }
} catch (err) {
    console.error('[db] Migration check error:', err.message);
}

module.exports = db;
