const express = require('express');
const path = require('path');
const fs = require('fs');
const { isMuaj } = require('../middleware/auth');
const db = require('../database');
const importRoutes = require('./import');

const router = express.Router();
const videosDir = path.join(__dirname, '..', 'uploads', 'videos');
const thumbnailsDir = path.join(__dirname, '..', 'uploads', 'thumbnails');

function listFiles(dir) {
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
        .map((name) => {
            const fullPath = path.join(dir, name);
            try {
                const stat = fs.statSync(fullPath);
                return stat.isFile() ? { name, fullPath, size: stat.size } : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function sumBytes(files) {
    return files.reduce((total, file) => total + file.size, 0);
}

function getImportJobs() {
    if (typeof importRoutes.getImportJobs !== 'function') return [];
    return importRoutes.getImportJobs();
}

function formatWatchTime(totalSec) {
    const s = Number(totalSec || 0);
    if (!s || s <= 0) return '0m';
    const hrs = Math.floor(s / 3600);
    const mins = Math.floor((s % 3600) / 60);
    if (hrs > 0 && mins > 0) return `${hrs}h ${mins}m`;
    if (hrs > 0) return `${hrs}h`;
    return `${Math.max(1, mins)}m`;
}

function collectAdminStats() {
    const videos = db.prepare(
        'SELECT id, title, filename, thumbnail, size, duration, uploaded_by, uploaded_at, import_quality FROM videos ORDER BY uploaded_at DESC'
    ).all();
    const commentsCount = db.prepare('SELECT COUNT(*) AS count FROM comments').get().count;
    const progressCount = db.prepare('SELECT COUNT(*) AS count FROM watch_progress').get().count;
    const sessionCount = db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ? AND sess LIKE \'%"user":%\''
    ).get(Date.now()).count;
    const importJobs = getImportJobs().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const videoFiles = listFiles(videosDir);
    const thumbnailFiles = listFiles(thumbnailsDir);
    const dbVideoFiles = new Set(videos.map(video => video.filename).filter(Boolean));
    const dbThumbnailFiles = new Set(videos.map(video => video.thumbnail).filter(Boolean));
    const activeImportIds = new Set(importJobs
        .filter(job => ['queued', 'starting', 'downloading'].includes(job.status))
        .map(job => job.id));

    const orphanVideos = videoFiles.filter(file => {
        if (dbVideoFiles.has(file.name)) return false;
        return !Array.from(activeImportIds).some(id => file.name.startsWith(id));
    });
    const orphanThumbnails = thumbnailFiles.filter(file => !dbThumbnailFiles.has(file.name));

    // Fetch Hajera's watch status for all videos in the library
    const hajeraVideos = db.prepare(
        `SELECT
            v.id AS video_id,
            v.title,
            v.thumbnail,
            v.duration AS formatted_duration,
            v.size,
            v.uploaded_by,
            v.uploaded_at,
            wp.position_seconds,
            wp.duration_seconds,
            wp.updated_at AS hajera_watched_at
        FROM videos v
        LEFT JOIN watch_progress wp
            ON wp.video_id = v.id AND wp.user = 'hajera'
        ORDER BY
            CASE WHEN wp.updated_at IS NOT NULL THEN 0 ELSE 1 END,
            wp.updated_at DESC,
            v.uploaded_at DESC`
    ).all();

    const watchedVideos = hajeraVideos.filter(v => v.hajera_watched_at !== null);
    const unwatchedVideos = hajeraVideos.filter(v => v.hajera_watched_at === null);

    const presence = db.getUserPresence('hajera');
    const rawWatchStats = db.getUserWatchStats('hajera');
    const activityTimeline = db.getRecentActivities('hajera', 35);

    const hajeraStats = {
        totalLibrary: hajeraVideos.length,
        totalWatched: watchedVideos.length,
        unwatchedCount: unwatchedVideos.length,
        completedCount: watchedVideos.filter(a => {
            const pos = Number(a.position_seconds || 0);
            const dur = Number(a.duration_seconds || 0);
            return (dur > 0 && pos >= dur - 15);
        }).length,
        inProgressCount: watchedVideos.filter(a => {
            const pos = Number(a.position_seconds || 0);
            const dur = Number(a.duration_seconds || 0);
            return pos >= 10 && (dur === 0 || pos < dur - 15);
        }).length,
        openedCount: watchedVideos.filter(a => {
            const pos = Number(a.position_seconds || 0);
            return pos < 10;
        }).length,
        allVideos: hajeraVideos,
        recentActivity: hajeraVideos,
        presence,
        watchStats: {
            totalSeconds: rawWatchStats.totalSeconds,
            todaySeconds: rawWatchStats.todaySeconds,
            totalFormatted: formatWatchTime(rawWatchStats.totalSeconds),
            todayFormatted: formatWatchTime(rawWatchStats.todaySeconds)
        },
        activityTimeline
    };

    return {
        videos,
        commentsCount,
        progressCount,
        sessionCount,
        importJobs,
        hajeraStats,
        hajeraSessionCount: db.countUserSessions('hajera'),
        hajeraBlocked: db.isUserBlocked('hajera'),
        hajeraBlockReason: (() => {
            try {
                const row = db.prepare('SELECT reason FROM blocked_users WHERE username = ?').get('hajera');
                return row ? row.reason : null;
            } catch { return null; }
        })(),
        videoFiles,
        thumbnailFiles,
        orphanVideos,
        orphanThumbnails,
        storageBytes: sumBytes(videoFiles) + sumBytes(thumbnailFiles),
        videoBytes: sumBytes(videoFiles),
        thumbnailBytes: sumBytes(thumbnailFiles)
    };
}

router.get('/admin', isMuaj, (req, res) => {
    res.render('admin', {
        user: req.session.user,
        stats: collectAdminStats(),
        cleanupResult: null,
        accessMessage: null
    });
});

router.post('/admin/cleanup', isMuaj, async (req, res) => {
    const stats = collectAdminStats();
    const targets = [...stats.orphanVideos, ...stats.orphanThumbnails];
    let deleted = 0;
    let bytesFreed = 0;

    for (const file of targets) {
        try {
            await fs.promises.unlink(file.fullPath);
            deleted += 1;
            bytesFreed += file.size;
        } catch {}
    }

    res.render('admin', {
        user: req.session.user,
        stats: collectAdminStats(),
        cleanupResult: { deleted, bytesFreed },
        accessMessage: null
    });
});

// Force logout all Hajera sessions
router.post('/admin/hajera/logout-sessions', isMuaj, (req, res) => {
    const destroyed = db.destroyUserSessions('hajera');
    res.render('admin', {
        user: req.session.user,
        stats: collectAdminStats(),
        cleanupResult: null,
        accessMessage: { type: 'success', text: `Hajera-র ${destroyed}টা session logout করা হয়েছে।` }
    });
});

// Block Hajera's access
router.post('/admin/hajera/block', isMuaj, (req, res) => {
    const reason = (req.body.reason || '').trim() || 'Admin দ্বারা block করা হয়েছে';
    db.blockUser('hajera', reason);
    res.render('admin', {
        user: req.session.user,
        stats: collectAdminStats(),
        cleanupResult: null,
        accessMessage: { type: 'warning', text: `Hajera-কে block করা হয়েছে। কারণ: ${reason}` }
    });
});

// Unblock Hajera's access
router.post('/admin/hajera/unblock', isMuaj, (req, res) => {
    db.unblockUser('hajera');
    res.render('admin', {
        user: req.session.user,
        stats: collectAdminStats(),
        cleanupResult: null,
        accessMessage: { type: 'success', text: 'Hajera-কে unblock করা হয়েছে। এখন login করতে পারবে।' }
    });
});

// GET /admin/hajera/live-status — Live polling endpoint for Admin Dashboard
router.get('/admin/hajera/live-status', isMuaj, (req, res) => {
    const presence = db.getUserPresence('hajera');
    const rawWatchStats = db.getUserWatchStats('hajera');
    const activityTimeline = db.getRecentActivities('hajera', 30);
    const sessionCount = db.countUserSessions('hajera');
    const isBlocked = db.isUserBlocked('hajera');

    res.json({
        presence,
        watchStats: {
            totalSeconds: rawWatchStats.totalSeconds,
            todaySeconds: rawWatchStats.todaySeconds,
            totalFormatted: formatWatchTime(rawWatchStats.totalSeconds),
            todayFormatted: formatWatchTime(rawWatchStats.todaySeconds)
        },
        activityTimeline,
        sessionCount,
        isBlocked,
        timestamp: Date.now()
    });
});

// POST /admin/hajera/clear-logs — Clear older activity logs
router.post('/admin/hajera/clear-logs', isMuaj, (req, res) => {
    db.clearOldActivityLogs('hajera');
    res.json({ success: true });
});

module.exports = router;
