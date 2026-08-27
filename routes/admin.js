const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { isMuaj } = require('../middleware/auth');
const db = require('../database');
const importRoutes = require('./import');
const r2 = require('../utils/r2');
const crypto = require('crypto');

/**
 * Generate a short-lived signed URL for admin worker endpoints.
 * @param {string} action - 'inventory' or 'delete-batch'
 * @returns {string|null}
 */
function getWorkerAdminSignedUrl(action) {
    const workerUrl = process.env.CF_WORKER_URL;
    const secret = process.env.SESSION_SECRET;
    if (!workerUrl || !secret) return null;
    const exp = Math.floor(Date.now() / 1000) + 300; // 5 minutes TTL
    const message = `${action}:${exp}`;
    const sig = crypto.createHmac('sha256', secret).update(message).digest('hex');
    return `${workerUrl.replace(/\/$/, '')}/api/r2-${action}?exp=${exp}&sig=${sig}`;
}

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
                if (stat.isFile()) results.push({ name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs });
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

function formatBytes(bytes) {
    return formatDataSize(bytes);
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
    const ramUsagePercent = Number(totalMemBytes > 0 ? ((usedMemBytes / totalMemBytes) * 100).toFixed(1) : 0);

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
        diskUsagePercent = Number(diskTotalBytes > 0 ? ((diskUsedBytes / diskTotalBytes) * 100).toFixed(1) : 0);
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
            runtimeName: typeof Bun !== 'undefined' ? 'Bun Runtime' : 'Node.js Runtime',
            runtimeVersion: typeof Bun !== 'undefined' ? ('v' + Bun.version) : process.version,
            nodeVersion: typeof Bun !== 'undefined' ? ('Bun v' + Bun.version) : process.version,
            isBun: typeof Bun !== 'undefined',
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
        'SELECT id, title, filename, thumbnail, size, duration, uploaded_by, uploaded_at, import_quality, cdn_status FROM videos ORDER BY uploaded_at DESC'
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

    const nowTime = Date.now();
    const orphanVideos = videoFiles.filter(file => {
        if (nowTime - file.mtimeMs < 15 * 60 * 1000) return false;
        if (dbVideoFiles.has(file.name)) return false;
        return !Array.from(activeImportIds).some(id => file.name.startsWith(id));
    });
    const orphanThumbnails = thumbnailFiles.filter(file => {
        if (nowTime - file.mtimeMs < 15 * 60 * 1000) return false;
        return !dbThumbnailFiles.has(file.name);
    });

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
            const threshold = dur <= 15 ? dur * 0.9 : dur - 15;
            return (dur > 0 && pos >= threshold);
        }).length,
        inProgressCount: watchedVideos.filter(a => {
            const pos = Number(a.position_seconds || 0);
            const dur = Number(a.duration_seconds || 0);
            const threshold = dur <= 15 ? dur * 0.9 : dur - 15;
            return pos >= 10 && (dur === 0 || pos < threshold);
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

    // Calculate Cloudflare R2 vs VPS Storage breakdown (Parallel & Cached)
    let r2VideoCount = 0;
    let r2TotalBytes = 0;
    const vpsDiskFileSet = new Set(videoFiles.map(f => f.name));

    await Promise.all(videos.map(async (v) => {
        v.onDisk = vpsDiskFileSet.has(v.filename);
        try {
            // Check DB cdn_status or in-memory confirmed set first before sending network HEAD request to R2
            const isDbConfirmed = v.cdn_status === 'r2_ready' || v.cdn_status === 'r2_only';
            v.onR2 = isDbConfirmed || r2.isConfirmedOnR2(v.filename) || await r2.existsOnR2(v.filename);
            if (v.onR2) r2.markConfirmedOnR2(v.filename);
        } catch {
            v.onR2 = false;
        }
        if (v.onR2) {
            r2VideoCount++;
            r2TotalBytes += (v.size || 0);
        }
    }));

    const r2Stats = {
        enabled: r2.isR2Enabled(),
        totalVideos: videos.length,
        r2Count: r2VideoCount,
        r2TotalBytes,
        r2Percent: videos.length > 0 ? Math.round((r2VideoCount / videos.length) * 100) : 0,
        vpsCount: videoFiles.length,
        vpsTotalBytes: sumBytes(videoFiles),
        unsyncedCount: Math.max(0, videos.length - r2VideoCount),
        unsyncedVideos: videos.filter(v => !v.onR2)
    };

    // Calculate Cloudflare Offload & Bandwidth Savings
    let totalWatchedSecondsAll = 0;
    try {
        const row = db.prepare('SELECT SUM(seconds_watched) AS total FROM watch_time_ledger').get();
        totalWatchedSecondsAll = Number(row?.total || 0);
    } catch {}

    let totalOffloadedBytes = 0;
    try {
        const rows = db.prepare(`
            SELECT w.seconds_watched, v.size, wp.duration_seconds
            FROM watch_time_ledger w
            JOIN videos v ON v.id = w.video_id
            LEFT JOIN watch_progress wp ON wp.video_id = w.video_id AND wp.user = w.user
        `).all();
        for (const r of rows) {
            const dur = Number(r.duration_seconds || 0);
            const size = Number(r.size || 0);
            const sec = Number(r.seconds_watched || 0);
            if (dur > 0 && size > 0) {
                totalOffloadedBytes += (sec * (size / dur));
            } else if (size > 0) {
                totalOffloadedBytes += (sec * (size / 600));
            }
        }
    } catch {}

    if (totalOffloadedBytes === 0 && totalWatchedSecondsAll > 0) {
        totalOffloadedBytes = totalWatchedSecondsAll * (80 * 1024 * 1024 / 600);
    }

    const cloudflareSavings = {
        enabled: r2.isR2Enabled(),
        workerUrl: process.env.CF_WORKER_URL || null,
        zoneConfigured: !!(process.env.CF_ZONE_ID && process.env.CF_API_TOKEN),
        zoneId: process.env.CF_ZONE_ID ? `${process.env.CF_ZONE_ID.slice(0, 6)}...` : null,
        totalOffloadedBytes: Math.round(totalOffloadedBytes),
        totalOffloadedFormatted: formatBytes(totalOffloadedBytes),
        totalWatchSeconds: totalWatchedSecondsAll,
        totalWatchFormatted: formatWatchTime(totalWatchedSecondsAll),
        vpsQuotaBytes: 1000 * 1024 * 1024 * 1024,
        vpsQuotaPreservedPercent: totalOffloadedBytes > 0
            ? ((totalOffloadedBytes / (1000 * 1024 * 1024 * 1024)) * 100).toFixed(2)
            : '0.00',
        edgeOffloadEfficiency: r2.isR2Enabled() ? 100 : 0
    };

    return {
        videos,
        r2Stats,
        cloudflareSavings,
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

// GET /admin/r2/live-status — Real-time R2 stats and active uploads for admin dashboard
router.get('/admin/r2/live-status', isMuaj, async (req, res) => {
    try {
        const stats = await collectAdminStats(req.sessionID);
        const activeUploads = typeof r2.getActiveUploadsList === 'function' ? r2.getActiveUploadsList() : [];
        res.json({
            success: true,
            r2Stats: stats.r2Stats,
            activeUploads,
            videos: stats.videos.map(v => ({
                id: v.id,
                filename: v.filename,
                title: v.title,
                size: v.size,
                onDisk: v.onDisk,
                onR2: v.onR2
            }))
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /admin/r2/sync-all — Background sync all unsynced videos to Cloudflare R2
router.post('/admin/r2/sync-all', isMuaj, (req, res) => {
    if (!r2.isR2Enabled()) {
        return res.status(400).json({ success: false, error: 'Cloudflare R2 credentials not configured.' });
    }
    r2.backfillMissingR2Uploads().catch(err => {
        console.error('[admin] R2 sync-all error:', err.message);
    });
    res.json({ success: true, message: 'Cloudflare R2 sync started in background!' });
});

// POST /admin/r2/sync-video/:id — Start background sync of specific video to Cloudflare R2
router.post('/admin/r2/sync-video/:id', isMuaj, (req, res) => {
    if (!r2.isR2Enabled()) {
        return res.status(400).json({ success: false, error: 'Cloudflare R2 credentials not configured.' });
    }
    const video = db.prepare('SELECT id, filename, title, size, cdn_status FROM videos WHERE id = ?').get(req.params.id);
    if (!video || !video.filename) {
        return res.status(404).json({ success: false, error: 'Video not found in database or filename missing.' });
    }

    const isAlreadyOnR2 = r2.isConfirmedOnR2(video.filename) || video.cdn_status === 'r2_ready' || video.cdn_status === 'r2_only';
    if (isAlreadyOnR2) {
        return res.json({
            success: true,
            alreadySynced: true,
            onR2: true,
            filename: video.filename,
            videoId: video.id,
            title: video.title,
            size: video.size,
            message: `"${video.title}" is already synced on Cloudflare R2.`
        });
    }

    const filePath = path.join(videosDir, video.filename);
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ success: false, error: 'Video file missing from VPS disk.' });
    }

    // Launch upload asynchronously in background with retry
    try {
        db.prepare("UPDATE videos SET cdn_status = 'r2_uploading' WHERE id = ?").run(video.id);
    } catch {}
    r2.uploadToR2WithRetry(filePath, video.filename).catch(err => {
        console.error('[admin] Single video R2 upload error:', video.filename, err.message);
    });

    res.json({
        success: true,
        filename: video.filename,
        videoId: video.id,
        title: video.title,
        size: video.size,
        message: `Sync started for "${video.title}"`
    });
});

// GET /admin/r2/edge-status — Edge Worker Connectivity & Remote Audit
router.get('/admin/r2/edge-status', isMuaj, async (req, res) => {
    const invUrl = r2.getWorkerInventoryUrl(300);
    if (!invUrl) {
        return res.json({
            workerConfigured: false,
            message: 'CF_WORKER_URL or SESSION_SECRET is not configured in .env'
        });
    }

    try {
        const response = await fetch(invUrl, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) {
            return res.json({
                workerConfigured: true,
                online: false,
                status: response.status,
                error: `Worker returned HTTP ${response.status}`
            });
        }
        const data = await response.json();
        return res.json({
            workerConfigured: true,
            online: true,
            edgeInventory: data
        });
    } catch (err) {
        return res.json({
            workerConfigured: true,
            online: false,
            error: err.message
        });
    }
});

// POST /admin/r2/scan-bucket — Live R2 bucket inventory and orphan detection
router.post('/admin/r2/scan-bucket', isMuaj, async (req, res) => {
    try {
        const dbVideos = db.prepare('SELECT id, filename, title, size FROM videos').all();
        const dbFilenameSet = new Set(dbVideos.map(v => v.filename).filter(Boolean));

        let r2Objects = [];
        let source = 'worker';
        let workerHandled = false;

        // 1. Try Worker inventory endpoint first
        const workerScanUrl = getWorkerAdminSignedUrl('inventory');
        if (workerScanUrl) {
            try {
                const response = await fetch(workerScanUrl, { method: 'GET', signal: AbortSignal.timeout(6000) });
                if (response.ok) {
                    const data = await response.json();
                    if (data && Array.isArray(data.files)) {
                        r2Objects = data.files;
                        workerHandled = true;
                    }
                }
            } catch (wErr) {
                console.warn('[admin] Worker inventory fetch failed, falling back to S3:', wErr.message);
            }
        }

        // 2. Fallback to S3 SDK if Worker is unavailable
        if (!workerHandled && r2.isR2Enabled()) {
            source = 's3-fallback';
            try {
                r2Objects = await r2.listAllR2Objects();
            } catch (s3Err) {
                console.error('[admin] S3 list failed:', s3Err.message);
            }
        }

        // 3. Match objects and detect true orphans
        let totalR2Bytes = 0;
        const orphans = [];
        const matched = [];

        for (const obj of r2Objects) {
            totalR2Bytes += (obj.size || 0);
            if (!dbFilenameSet.has(obj.key)) {
                orphans.push({
                    key: obj.key,
                    size: obj.size,
                    sizeFormatted: formatBytes(obj.size),
                    uploaded: obj.uploaded
                });
            } else {
                matched.push(obj.key);
            }
        }

        const matchedSet = new Set(matched);
        const missingOnR2 = dbVideos.filter(v => !matchedSet.has(v.filename));

        res.json({
            success: true,
            source,
            totalObjects: r2Objects.length,
            totalBytes: totalR2Bytes,
            totalBytesFormatted: formatBytes(totalR2Bytes),
            orphanCount: orphans.length,
            orphans,
            missingCount: missingOnR2.length,
            missingVideos: missingOnR2.map(v => ({ id: v.id, filename: v.filename, title: v.title, size: v.size }))
        });
    } catch (err) {
        console.error('[admin] R2 scan-bucket error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /admin/r2/clean-orphans — Batch delete orphan files from R2
router.post('/admin/r2/clean-orphans', isMuaj, async (req, res) => {
    try {
        const { keys } = req.body;
        if (!Array.isArray(keys) || keys.length === 0) {
            return res.status(400).json({ success: false, error: 'No orphan keys specified for cleanup.' });
        }

        const deletedKeys = [];
        const failedKeys = [];

        // 1. Try Worker delete-batch first
        const workerDeleteUrl = getWorkerAdminSignedUrl('delete-batch');
        let workerHandled = false;

        if (workerDeleteUrl) {
            try {
                const response = await fetch(workerDeleteUrl, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ keys }),
                    signal: AbortSignal.timeout(8000)
                });
                if (response.ok) {
                    const data = await response.json();
                    if (data && data.success && Array.isArray(data.deleted)) {
                        deletedKeys.push(...data.deleted);
                        workerHandled = true;
                    }
                }
            } catch (wErr) {
                console.warn('[admin] Worker batch delete failed, falling back to S3:', wErr.message);
            }
        }

        // 2. Fallback to S3 client
        if (!workerHandled) {
            for (const key of keys.slice(0, 100)) {
                try {
                    const success = await r2.deleteFromR2(key);
                    if (success) deletedKeys.push(key);
                    else failedKeys.push(key);
                } catch {
                    failedKeys.push(key);
                }
            }
        }

        for (const key of deletedKeys) {
            if (typeof r2.unmarkConfirmedOnR2 === 'function') {
                r2.unmarkConfirmedOnR2(key);
            }
        }

        res.json({
            success: true,
            deletedCount: deletedKeys.length,
            deletedKeys,
            failedKeys
        });
    } catch (err) {
        console.error('[admin] Clean orphans error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});

// POST /admin/cf/purge-cache — 1-Click Cloudflare Global Edge Cache Purge
router.post('/admin/cf/purge-cache', isMuaj, async (req, res) => {
    try {
        const zoneId = process.env.CF_ZONE_ID;
        const apiToken = process.env.CF_API_TOKEN;

        if (!zoneId || !apiToken) {
            return res.status(400).json({
                success: false,
                error: 'CF_ZONE_ID or CF_API_TOKEN is not configured in .env. Please add them to your VPS .env file.'
            });
        }

        const cfRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/purge_cache`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiToken}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ purge_everything: true }),
            signal: AbortSignal.timeout(10000)
        });

        const data = await cfRes.json();
        if (data && data.success) {
            return res.json({
                success: true,
                message: 'Cloudflare global edge cache purged successfully!'
            });
        } else {
            const errMsg = (data && data.errors && data.errors[0]?.message) || 'Cloudflare API rejected purge request.';
            return res.status(502).json({
                success: false,
                error: errMsg
            });
        }
    } catch (err) {
        console.error('[admin] CF purge error:', err);
        res.status(500).json({ success: false, error: err.message });
    }
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
    _liveStatusCache = null; _liveStatusCacheAt = 0;
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
    _liveStatusCache = null; _liveStatusCacheAt = 0;
    const targetSid = req.params.sid;
    const isSelf = (targetSid === req.sessionID);
    const destroyed = db.destroySingleSession(targetSid);

    if (req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'))) {
        const respond = () => res.json({ 
            success: destroyed, 
            isSelf, 
            remainingSessions: db.getAllActiveSessions(req.sessionID),
            muajSessionCount: db.countUserSessions('muaj'),
            hajeraSessionCount: db.countUserSessions('hajera')
        });
        if (isSelf) {
            return req.session.destroy(respond);
        }
        return respond();
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
    _liveStatusCache = null; _liveStatusCacheAt = 0;
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
    _liveStatusCache = null; _liveStatusCacheAt = 0;
    db.unblockUser('hajera');
    res.render('admin', {
        user: req.session.user,
        stats: await collectAdminStats(req.sessionID),
        cleanupResult: null,
        accessMessage: { type: 'success', text: 'Hajera-কে unblock করা হয়েছে। এখন login করতে পারবে।' }
    });
});

// GET /admin/hajera/live-status — Live polling endpoint for Admin Dashboard
// Cached for 1s to support real-time 1.4s~1.9s jittered admin polling with low SQLite overhead
let _liveStatusCache = null;
let _liveStatusCacheAt = 0;
const LIVE_STATUS_CACHE_TTL = 1000;

router.get('/admin/hajera/live-status', isMuaj, (req, res) => {
    const now = Date.now();
    if (_liveStatusCache && (now - _liveStatusCacheAt) < LIVE_STATUS_CACHE_TTL) {
        return res.json({
            ..._liveStatusCache,
            detailedSessions: db.getAllActiveSessions(req.sessionID)
        });
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

// GET /admin/api/presence-live — Real-time live presence from Edge Worker + VPS SQLite
router.get('/admin/api/presence-live', isMuaj, async (req, res) => {
    let edgePresence = null;
    const workerUrl = process.env.CF_WORKER_URL;
    const secret = process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET;

    if (workerUrl && secret) {
        try {
            const exp = Math.floor(Date.now() / 1000) + 60;
            const sig = crypto.createHmac('sha256', secret).update(`admin-presence:${exp}`).digest('hex');
            const url = `${workerUrl.replace(/\/$/, '')}/api/edge-presence-live?exp=${exp}&sig=${sig}`;
            const r = await fetch(url, { signal: AbortSignal.timeout(2500) });
            if (r.ok) {
                const json = await r.json();
                edgePresence = json.presence || null;
            }
        } catch {}
    }

    const sqliteHajera = db.getUserPresence('hajera');
    res.json({
        success: true,
        hajera: (edgePresence && edgePresence.hajera) || sqliteHajera,
        edgeActive: !!edgePresence,
        timestamp: Date.now()
    });
});

module.exports = router;
