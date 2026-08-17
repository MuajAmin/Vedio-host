const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isMuaj } = require('../middleware/auth');
const db = require('../database');
const importRoutes = require('./import');

const router = express.Router();
const videosDir = path.join(__dirname, '..', 'uploads', 'videos');
const thumbnailsDir = path.join(__dirname, '..', 'uploads', 'thumbnails');

async function listFiles(dir) {
    try {
        const entries = await fs.promises.readdir(dir);
        const results = [];
        for (const name of entries) {
            const fullPath = path.join(dir, name);
            try {
                const stat = await fs.promises.stat(fullPath);
                if (stat.isFile()) results.push({ name, fullPath, size: stat.size });
            } catch {}
        }
        return results;
    } catch {
        return [];
    }
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

function formatDuration(totalSeconds) {
    const s = Math.floor(Number(totalSeconds) || 0);
    if (s < 60) return `${s}s`;
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m`;
}

function getCpuSample() {
    const cpus = os.cpus() || [];
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
        for (const type in cpu.times) {
            totalTick += cpu.times[type];
        }
        totalIdle += cpu.times.idle;
    }
    return { idle: totalIdle, total: totalTick, cpus };
}

let prevCpuSample = getCpuSample();

function getLiveCpuPercent() {
    const current = getCpuSample();
    const idleDiff = current.idle - prevCpuSample.idle;
    const totalDiff = current.total - prevCpuSample.total;
    prevCpuSample = current;
    if (totalDiff <= 0) return 0;
    const usage = 100 - Math.round((idleDiff / totalDiff) * 100);
    return Math.max(0, Math.min(100, usage));
}

function formatDataSize(bytes) {
    const b = Number(bytes || 0);
    if (b >= 1024 ** 4) return (b / (1024 ** 4)).toFixed(2) + ' TB';
    if (b >= 1024 ** 3) return (b / (1024 ** 3)).toFixed(2) + ' GB';
    if (b >= 1024 ** 2) return (b / (1024 ** 2)).toFixed(1) + ' MB';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
    return `${b} B`;
}

function formatSpeed(bytesPerSec) {
    const b = Number(bytesPerSec || 0);
    if (b >= 1024 * 1024) return (b / (1024 * 1024)).toFixed(1) + ' MB/s';
    if (b >= 1024) return (b / 1024).toFixed(1) + ' KB/s';
    return `${Math.round(b)} B/s`;
}

function getNetworkTraffic() {
    try {
        if (fs.existsSync('/proc/net/dev')) {
            const data = fs.readFileSync('/proc/net/dev', 'utf8');
            const lines = data.trim().split('\n');
            let totalRx = 0;
            let totalTx = 0;
            for (let i = 2; i < lines.length; i++) {
                const line = lines[i].trim();
                if (!line) continue;
                const parts = line.split(':');
                const iface = parts[0].trim();
                if (iface === 'lo') continue;
                const metrics = parts[1].trim().split(/\s+/);
                const rx = parseInt(metrics[0], 10) || 0;
                const tx = parseInt(metrics[8], 10) || 0;
                totalRx += rx;
                totalTx += tx;
            }
            return { rxBytes: totalRx, txBytes: totalTx, totalBytes: totalRx + totalTx };
        }
    } catch {}

    try {
        const cp = require('child_process');
        const out = cp.execSync('netstat -e', { timeout: 800, stdio: ['pipe', 'pipe', 'ignore'] }).toString();
        const match = out.match(/Bytes\s+(\d+)\s+(\d+)/i);
        if (match) {
            const rx = parseInt(match[1], 10) || 0;
            const tx = parseInt(match[2], 10) || 0;
            return { rxBytes: rx, txBytes: tx, totalBytes: rx + tx };
        }
    } catch {}

    return { rxBytes: 0, txBytes: 0, totalBytes: 0 };
}

let prevNetSample = { ...getNetworkTraffic(), time: Date.now() };

function getNetworkMetrics() {
    const current = getNetworkTraffic();
    const now = Date.now();
    const timeDiffSec = Math.max(0.5, (now - prevNetSample.time) / 1000);

    const rxSpeedBps = Math.max(0, (current.rxBytes - prevNetSample.rxBytes) / timeDiffSec);
    const txSpeedBps = Math.max(0, (current.txBytes - prevNetSample.txBytes) / timeDiffSec);

    prevNetSample = { ...current, time: now };

    const monthlyQuotaBytes = 1000 * (1024 ** 3); // 1000 GB (1 TB) Alibaba Cloud Free Tier Monthly Quota
    const usedPercent = Number(((current.totalBytes / monthlyQuotaBytes) * 100).toFixed(2));

    return {
        rxBytes: current.rxBytes,
        txBytes: current.txBytes,
        totalBytes: current.totalBytes,
        rxFormatted: formatDataSize(current.rxBytes),
        txFormatted: formatDataSize(current.txBytes),
        totalFormatted: formatDataSize(current.totalBytes),
        rxSpeedFormatted: formatSpeed(rxSpeedBps),
        txSpeedFormatted: formatSpeed(txSpeedBps),
        monthlyQuotaFormatted: '1,000 GB (1 TB)',
        usagePercent: Math.min(100, usedPercent)
    };
}

function collectSystemMetrics() {
    const cpus = os.cpus() || [];
    const cpuCount = cpus.length;
    const rawModel = cpus[0] ? cpus[0].model.replace(/\s+/g, ' ').trim() : 'Generic CPU';
    const cpuSpeedMhz = cpus[0] ? cpus[0].speed : 0;
    const cpuUsagePercent = getLiveCpuPercent();
    const loadAvg = os.loadavg().map(v => Number(v.toFixed(2)));

    // RAM
    const totalMemBytes = os.totalmem();
    const freeMemBytes = os.freemem();
    const usedMemBytes = totalMemBytes - freeMemBytes;
    const ramUsagePercent = Number(((usedMemBytes / totalMemBytes) * 100).toFixed(1));

    // Disk
    let diskTotalBytes = 0;
    let diskFreeBytes = 0;
    let diskUsedBytes = 0;
    let diskUsagePercent = 0;

    try {
        const disk = fs.statfsSync(__dirname);
        diskTotalBytes = disk.bsize * disk.blocks;
        diskFreeBytes = disk.bsize * disk.bavail;
        diskUsedBytes = diskTotalBytes - diskFreeBytes;
        diskUsagePercent = Number(((diskUsedBytes / diskTotalBytes) * 100).toFixed(1));
    } catch {}

    // Process Memory
    const procMem = process.memoryUsage();

    // Network Telemetry
    const network = getNetworkMetrics();

    return {
        os: {
            platform: os.platform(),
            type: os.type(),
            release: os.release(),
            arch: os.arch(),
            hostname: os.hostname(),
            uptimeSec: os.uptime(),
            uptimeFormatted: formatDuration(os.uptime())
        },
        cpu: {
            count: cpuCount,
            model: rawModel,
            speedMhz: cpuSpeedMhz,
            usagePercent: cpuUsagePercent,
            loadAvg
        },
        ram: {
            totalBytes: totalMemBytes,
            freeBytes: freeMemBytes,
            usedBytes: usedMemBytes,
            usagePercent: ramUsagePercent,
            totalFormatted: (totalMemBytes / (1024 ** 3)).toFixed(2) + ' GB',
            freeFormatted: (freeMemBytes / (1024 ** 3)).toFixed(2) + ' GB',
            usedFormatted: (usedMemBytes / (1024 ** 3)).toFixed(2) + ' GB'
        },
        disk: {
            totalBytes: diskTotalBytes,
            freeBytes: diskFreeBytes,
            usedBytes: diskUsedBytes,
            usagePercent: diskUsagePercent,
            totalFormatted: (diskTotalBytes / (1024 ** 3)).toFixed(1) + ' GB',
            freeFormatted: (diskFreeBytes / (1024 ** 3)).toFixed(1) + ' GB',
            usedFormatted: (diskUsedBytes / (1024 ** 3)).toFixed(1) + ' GB'
        },
        network,
        process: {
            uptimeSec: process.uptime(),
            uptimeFormatted: formatDuration(process.uptime()),
            nodeVersion: process.version,
            rssMb: (procMem.rss / (1024 * 1024)).toFixed(1),
            heapUsedMb: (procMem.heapUsed / (1024 * 1024)).toFixed(1),
            heapTotalMb: (procMem.heapTotal / (1024 * 1024)).toFixed(1)
        },
        timestamp: Date.now()
    };
}

let cachedDiskStats = null;
let cachedDiskStatsTime = 0;
const DISK_STATS_CACHE_TTL = 30 * 1000; // 30 seconds cache for disk scans

async function getDiskFilesWithCache() {
    const now = Date.now();
    if (cachedDiskStats && (now - cachedDiskStatsTime < DISK_STATS_CACHE_TTL)) {
        return cachedDiskStats;
    }
    const videoFiles = await listFiles(videosDir);
    const thumbnailFiles = await listFiles(thumbnailsDir);
    cachedDiskStats = { videoFiles, thumbnailFiles };
    cachedDiskStatsTime = now;
    return cachedDiskStats;
}

async function collectAdminStats(currentSid = null) {
    const videos = db.prepare(
        'SELECT id, title, filename, thumbnail, size, duration, uploaded_by, uploaded_at, import_quality FROM videos ORDER BY uploaded_at DESC'
    ).all();
    const commentsCount = db.prepare('SELECT COUNT(*) AS count FROM comments').get().count;
    const progressCount = db.prepare('SELECT COUNT(*) AS count FROM watch_progress').get().count;
    
    const muajSessionCount = db.countUserSessions('muaj');
    const hajeraSessionCount = db.countUserSessions('hajera');
    const sessionCount = muajSessionCount + hajeraSessionCount;
    const detailedSessions = db.getAllActiveSessions(currentSid);

    const importJobs = getImportJobs().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const { videoFiles, thumbnailFiles } = await getDiskFilesWithCache();
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
        muajSessionCount,
        hajeraSessionCount,
        detailedSessions,
        importJobs,
        hajeraStats,
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
        thumbnailBytes: sumBytes(thumbnailFiles),
        systemMetrics: collectSystemMetrics()
    };
}

router.get('/admin', isMuaj, async (req, res) => {
    res.render('admin', {
        user: req.session.user,
        stats: await collectAdminStats(req.sessionID),
        cleanupResult: null,
        accessMessage: null
    });
});

router.post('/admin/cleanup', isMuaj, async (req, res) => {
    const stats = await collectAdminStats(req.sessionID);
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

    cachedDiskStats = null; // Invalidate cache after cleanup
    cachedDiskStatsTime = 0;

    res.render('admin', {
        user: req.session.user,
        stats: await collectAdminStats(req.sessionID),
        cleanupResult: { deleted, bytesFreed },
        accessMessage: null
    });
});

// Force logout all Hajera sessions
router.post('/admin/hajera/logout-sessions', isMuaj, async (req, res) => {
    const destroyed = db.destroyUserSessions('hajera');
    res.render('admin', {
        user: req.session.user,
        stats: await collectAdminStats(req.sessionID),
        cleanupResult: null,
        accessMessage: { type: 'success', text: `Hajera-র ${destroyed}টা session logout করা হয়েছে।` }
    });
});

// Force logout other Muaj sessions (keeps current device session)
router.post('/admin/muaj/logout-other-sessions', isMuaj, async (req, res) => {
    const destroyed = db.destroyOtherUserSessions('muaj', req.sessionID);
    res.render('admin', {
        user: req.session.user,
        stats: await collectAdminStats(req.sessionID),
        cleanupResult: null,
        accessMessage: { type: 'success', text: `Muaj-এর অন্যান্য ${destroyed}টা session logout করা হয়েছে। বর্তমান ডিভাইসটি সক্রিয় রয়েছে।` }
    });
});

// Force logout all Muaj sessions (including current)
router.post('/admin/muaj/logout-all-sessions', isMuaj, (req, res) => {
    db.destroyUserSessions('muaj');
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// Terminate a single specific session
router.post('/admin/sessions/destroy/:sid', isMuaj, async (req, res) => {
    const targetSid = req.params.sid;
    const isSelf = (targetSid === req.sessionID);
    const destroyed = db.destroySingleSession(targetSid);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        return res.json({ 
            success: destroyed, 
            isSelf, 
            remainingSessions: db.getAllActiveSessions(req.sessionID),
            muajSessionCount: db.countUserSessions('muaj'),
            hajeraSessionCount: db.countUserSessions('hajera')
        });
    }

    if (isSelf) {
        return req.session.destroy(() => {
            res.redirect('/');
        });
    }

    res.render('admin', {
        user: req.session.user,
        stats: await collectAdminStats(req.sessionID),
        cleanupResult: null,
        accessMessage: { type: 'success', text: `Session (${targetSid.substring(0, 8)}...) সফলভাবে বন্ধ করা হয়েছে।` }
    });
});

// Block Hajera's access
router.post('/admin/hajera/block', isMuaj, async (req, res) => {
    const reason = (req.body.reason || '').trim() || 'Admin দ্বারা block করা হয়েছে';
    db.blockUser('hajera', reason);
    res.render('admin', {
        user: req.session.user,
        stats: await collectAdminStats(req.sessionID),
        cleanupResult: null,
        accessMessage: { type: 'warning', text: `Hajera-কে block করা হয়েছে। কারণ: ${reason}` }
    });
});

// Unblock Hajera's access
router.post('/admin/hajera/unblock', isMuaj, async (req, res) => {
    db.unblockUser('hajera');
    res.render('admin', {
        user: req.session.user,
        stats: await collectAdminStats(req.sessionID),
        cleanupResult: null,
        accessMessage: { type: 'success', text: 'Hajera-কে unblock করা হয়েছে। এখন login করতে পারবে।' }
    });
});

// GET /admin/hajera/live-status — Live polling endpoint for Admin Dashboard
// Cached for 2s to prevent 13+ DB queries per poll cycle
let _liveStatusCache = null;
let _liveStatusCacheAt = 0;
const LIVE_STATUS_CACHE_TTL = 2000;

router.get('/admin/hajera/live-status', isMuaj, (req, res) => {
    const now = Date.now();
    if (_liveStatusCache && (now - _liveStatusCacheAt) < LIVE_STATUS_CACHE_TTL) {
        return res.json(_liveStatusCache);
    }

    const presence = db.getUserPresence('hajera');
    const muajPresence = db.getUserPresence('muaj');
    const rawWatchStats = db.getUserWatchStats('hajera');
    const activityTimeline = db.getRecentActivities('hajera', 30);
    const hajeraSessionCount = db.countUserSessions('hajera');
    const muajSessionCount = db.countUserSessions('muaj');
    const totalSessionCount = hajeraSessionCount + muajSessionCount;
    const detailedSessions = db.getAllActiveSessions(req.sessionID);
    const isBlocked = db.isUserBlocked('hajera');

    _liveStatusCache = {
        presence,
        muajPresence,
        watchStats: {
            totalSeconds: rawWatchStats.totalSeconds,
            todaySeconds: rawWatchStats.todaySeconds,
            totalFormatted: formatWatchTime(rawWatchStats.totalSeconds),
            todayFormatted: formatWatchTime(rawWatchStats.todaySeconds)
        },
        activityTimeline,
        sessionCount: hajeraSessionCount,
        hajeraSessionCount,
        muajSessionCount,
        totalSessionCount,
        detailedSessions,
        isBlocked,
        timestamp: now
    };
    _liveStatusCacheAt = now;
    res.json(_liveStatusCache);
});

// GET /admin/system/live-metrics — Real-time VPS & Server Health metrics
// Cached for 2s — metrics don't change faster than that on 1 vCPU
let _sysMetricsCache = null;
let _sysMetricsCacheAt = 0;
const SYS_METRICS_CACHE_TTL = 2000;

router.get('/admin/system/live-metrics', isMuaj, (req, res) => {
    const now = Date.now();
    if (_sysMetricsCache && (now - _sysMetricsCacheAt) < SYS_METRICS_CACHE_TTL) {
        return res.json(_sysMetricsCache);
    }
    _sysMetricsCache = collectSystemMetrics();
    _sysMetricsCacheAt = now;
    res.json(_sysMetricsCache);
});

// POST /admin/hajera/clear-logs — Clear older activity logs
router.post('/admin/hajera/clear-logs', isMuaj, (req, res) => {
    db.clearOldActivityLogs('hajera');
    res.json({ success: true });
});

module.exports = router;
