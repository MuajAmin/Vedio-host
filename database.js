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

    CREATE INDEX IF NOT EXISTS idx_videos_uploaded_at ON videos(uploaded_at DESC);
    CREATE INDEX IF NOT EXISTS idx_comments_video_created ON comments(video_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
`);

// Migration: Ensure thumbnail and duration columns exist in older databases
try {
    const tableInfo = db.prepare("PRAGMA table_info(videos)").all();
    const hasThumbnail = tableInfo.some(col => col.name === 'thumbnail');
    if (!hasThumbnail) {
        db.exec('ALTER TABLE videos ADD COLUMN thumbnail TEXT');
        console.log('[db] Migrated videos table: added thumbnail column.');
    }
    const hasDuration = tableInfo.some(col => col.name === 'duration');
    if (!hasDuration) {
        db.exec('ALTER TABLE videos ADD COLUMN duration TEXT');
        console.log('[db] Migrated videos table: added duration column.');
    }
} catch (err) {
    console.error('[db] Migration check error:', err.message);
}

module.exports = db;
