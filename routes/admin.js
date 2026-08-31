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
    // Must match the Worker's precedence (WORKER_HMAC_SECRET || SESSION_SECRET).
    // Using SESSION_SECRET unconditionally produced signatures the Worker rejected
    // with 401 whenever WORKER_HMAC_SECRET was set, silently degrading every
    // bucket scan to the much slower S3 ListObjectsV2 fallback.
    const secret = process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET;
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

// ─── Cached R2 bucket inventory ──────────────────────────────────────────────
// One bulk listing replaces the old per-video HEAD storm. Cached briefly so the
// 4s live-status poll cannot hammer R2 (or the Worker) once per video per poll.
let cachedR2Inventory = null;
let cachedR2InventoryTime = 0;
let inFlightR2Inventory = null;
const R2_INVENTORY_CACHE_TTL = 15 * 1000;

const EMPTY_INVENTORY = {
    available: false,
    source: 'unavailable',
    objects: [],
    map: new Map(),
    totalBytes: 0,
    ageMs: 0
};

/**
 * Fetch the full R2 object inventory, preferring the edge Worker (single request,
 * no S3 signing round trips) and falling back to the S3 ListObjectsV2 API.
 * Results are cached for R2_INVENTORY_CACHE_TTL and de-duplicated while in flight.
 *
 * @param {boolean} [forceRefresh=false]
 * @returns {Promise<{available: boolean, source: string, objects: Array, map: Map, totalBytes: number, ageMs: number}>}
 */
async function getR2InventoryWithCache(forceRefresh = false) {
    if (!r2.isR2Enabled()) {
        return { ...EMPTY_INVENTORY, source: 'disabled' };
    }

    const now = Date.now();
    if (!forceRefresh && cachedR2Inventory && (now - cachedR2InventoryTime < R2_INVENTORY_CACHE_TTL)) {
        return { ...cachedR2Inventory, ageMs: now - cachedR2InventoryTime };
    }

    // Collapse concurrent callers (dashboard render + live-status poll) onto one fetch.
    if (inFlightR2Inventory) return inFlightR2Inventory;

    inFlightR2Inventory = (async () => {
        let objects = null;
        let source = 'unavailable';

        // 1. Fast path — edge Worker inventory endpoint.
        const workerUrl = getWorkerAdminSignedUrl('inventory');
        if (workerUrl) {
            try {
                const response = await fetch(workerUrl, { method: 'GET', signal: AbortSignal.timeout(6000) });
                if (response.ok) {
                    const data = await response.json();
                    if (data && Array.isArray(data.files)) {
                        objects = data.files.map(f => ({ key: f.key, size: Number(f.size || 0), uploaded: f.uploaded }));
                        source = 'worker';
                    }
                } else {
                    console.warn(`[admin] Worker inventory returned HTTP ${response.status}; falling back to S3.`);
                }
            } catch (wErr) {
                console.warn('[admin] Worker inventory fetch failed, falling back to S3:', wErr.message);
            }
        }

        // 2. Fallback — S3 SDK bulk listing.
        if (!objects) {
            try {
                const listed = await r2.listAllR2Objects();
                objects = listed.map(o => ({ key: o.key, size: Number(o.size || 0), uploaded: o.uploaded }));
                source = 's3-fallback';
            } catch (s3Err) {
                console.error('[admin] R2 inventory unavailable (Worker and S3 both failed):', s3Err.message);
            }
        }

        if (!objects) {
            // Serve the last good inventory rather than reporting everything missing.
            if (cachedR2Inventory) {
                return { ...cachedR2Inventory, source: cachedR2Inventory.source + '-stale', ageMs: Date.now() - cachedR2InventoryTime };
            }
            return { ...EMPTY_INVENTORY };
        }

        const map = new Map();
        let totalBytes = 0;
        for (const obj of objects) {
            if (!obj.key) continue;
            map.set(obj.key, obj);
            totalBytes += obj.size;
        }

        // Keep the shared confirmed-on-R2 cache in sync with reality.
        try {
            if (typeof r2.bulkConfirmOnR2 === 'function') r2.bulkConfirmOnR2(map.keys());
        } catch {}

        cachedR2Inventory = { available: true, source, objects, map, totalBytes, ageMs: 0 };
        cachedR2InventoryTime = Date.now();
        return { ...cachedR2Inventory, ageMs: 0 };
    })().finally(() => {
        inFlightR2Inventory = null;
    });

    return inFlightR2Inventory;
}

/**
 * Invalidate the cached inventory so the next read reflects a mutation
 * (upload completed, object deleted) immediately instead of after the TTL.
 */
function invalidateR2Inventory() {
    cachedR2Inventory = null;
    cachedR2InventoryTime = 0;
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

    // Calculate Cloudflare R2 vs VPS Storage breakdown.
    //
    // This used to issue one HEAD request to R2 per video on every dashboard
    // render AND on every 4s live-status poll — with N videos that is N network
    // round trips per poll, which both made the admin page slow and reported
    // stale/incorrect values whenever a HEAD timed out (the catch turned any
    // transient error into "not on R2", under-reporting the R2 numbers).
    //
    // Instead, take one cached bulk inventory of the bucket. That gives the
    // authoritative object list *and* each object's real byte size on R2.
    const inventory = await getR2InventoryWithCache();
    const vpsDiskFileSet = new Set(videoFiles.map(f => f.name));

    let r2VideoCount = 0;
    let r2TotalBytes = 0;

    for (const v of videos) {
        v.onDisk = vpsDiskFileSet.has(v.filename);
        if (inventory.available) {
            // Authoritative: the object either is or is not in the bucket listing.
            const obj = inventory.map.get(v.filename);
            if (obj) {
                v.onR2 = true;
                // Report the real size stored on R2, not the local DB's size column.
                r2TotalBytes += Number(obj.size || 0);
            } else if (r2.isConfirmedOnR2(v.filename)) {
                // Uploaded and verified after this inventory snapshot was taken —
                // count it now instead of showing it as unsynced until the TTL expires.
                v.onR2 = true;
                r2TotalBytes += Number(v.size || 0);
            } else {
                v.onR2 = false;
            }
        } else {
            // Inventory unavailable (Worker + S3 both failed) — fall back to the
            // confirmed cache / cdn_status so the page still renders something
            // truthful rather than claiming everything is missing.
            v.onR2 = r2.isConfirmedOnR2(v.filename) || v.cdn_status === 'r2_ready' || v.cdn_status === 'r2_only';
            if (v.onR2) r2TotalBytes += Number(v.size || 0);
        }
        if (v.onR2) r2VideoCount++;
    }

    const r2Stats = {
        enabled: r2.isR2Enabled(),
        totalVideos: videos.length,
        r2Count: r2VideoCount,
        r2TotalBytes,
        r2Percent: videos.length > 0 ? Math.round((r2VideoCount / videos.length) * 100) : 0,
        vpsCount: videoFiles.length,
        vpsTotalBytes: sumBytes(videoFiles),
        unsyncedCount: Math.max(0, videos.length - r2VideoCount),
        unsyncedVideos: videos.filter(v => !v.onR2),
        // Surface where the numbers came from so the UI can be honest about
        // degraded/stale data instead of silently showing wrong values.
        inventorySource: inventory.source,
        inventoryAvailable: inventory.available,
        inventoryAgeSeconds: Math.round(inventory.ageMs / 1000),
        // Objects present in the bucket but not referenced by any DB row.
        orphanR2Count: inventory.available
            ? Math.max(0, inventory.objects.length - r2VideoCount)
            : 0,
        bucketObjectCount: inventory.available ? inventory.objects.length : null,
        bucketTotalBytes: inventory.available ? inventory.totalBytes : null
    };

    // Calculate Cloudflare Offload & Bandwidth Savings
    let totalWatchedSecondsAll = 0;
    try {
        const row = db.prepare('SELECT SUM(seconds_watched) AS total FROM watch_time_ledger').get();
        totalWatchedSecondsAll = Number(row?.total || 0);
    } catch {}

    // REAL measured VPS -> R2 transfer volume, taken from the r2_transfer_log
    // ledger written by utils/r2.js on every completed upload.
    //
    // Previously this figure was invented: it multiplied watch seconds by a
    // guessed per-second bitrate and, if that produced zero, fell back to
    // assuming every video was 80 MB per 10 minutes. That is why the admin page
    // never showed the actual R2 transfer value.
    const transferStats = (typeof db.getR2TransferStats === 'function')
        ? db.getR2TransferStats()
        : { transferCount: 0, totalBytes: 0, totalMs: 0, avgBps: 0, peakBps: 0, failureCount: 0 };

    const totalTransferredBytes = transferStats.totalBytes;

    // Bytes currently resident on R2 (authoritative, from the bucket inventory).
    const bytesOnR2 = r2Stats.r2TotalBytes;

    // Share of the library actually served from the edge instead of VPS disk.
    const edgeOffloadEfficiency = (r2.isR2Enabled() && r2Stats.totalVideos > 0)
        ? Math.round((r2Stats.r2Count / r2Stats.totalVideos) * 100)
        : 0;

    const cloudflareSavings = {
        enabled: r2.isR2Enabled(),
        workerUrl: process.env.CF_WORKER_URL || null,
        zoneConfigured: !!(process.env.CF_ZONE_ID && process.env.CF_API_TOKEN),
        zoneId: process.env.CF_ZONE_ID ? `${process.env.CF_ZONE_ID.slice(0, 6)}...` : null,

        // Measured VPS -> R2 transfer (real bytes pushed over the wire).
        totalTransferredBytes,
        totalTransferredFormatted: formatBytes(totalTransferredBytes),
        transferCount: transferStats.transferCount,
        transferFailureCount: transferStats.failureCount,
        avgTransferSpeed: transferStats.avgBps > 0 ? formatSpeed(transferStats.avgBps) : '—',
        peakTransferSpeed: transferStats.peakBps > 0 ? formatSpeed(transferStats.peakBps) : '—',

        // Bytes stored on R2 right now (this is the storage offloaded from VPS).
        totalOffloadedBytes: bytesOnR2,
        totalOffloadedFormatted: formatBytes(bytesOnR2),

        totalWatchSeconds: totalWatchedSecondsAll,
        totalWatchFormatted: formatWatchTime(totalWatchedSecondsAll),
        vpsQuotaBytes: 1000 * 1024 * 1024 * 1024,
        vpsQuotaPreservedPercent: bytesOnR2 > 0
            ? ((bytesOnR2 / (1000 * 1024 * 1024 * 1024)) * 100).toFixed(2)
            : '0.00',
        edgeOffloadEfficiency,
        recentTransfers: (typeof db.getRecentR2Transfers === 'function') ? db.getRecentR2Transfers(8) : []
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

// GET /admin/r2/live-status — Real-time R2 stats and active uploads for admin dashboard.
//
// This endpoint is polled every 4 seconds by the admin page. It used to call
// collectAdminStats(), which recomputes *everything* — all sessions, the full
// watch-history join, disk directory scans — and fired one HEAD request to R2
// per video. Now it computes only the R2 numbers it actually returns, using the
// shared cached bucket inventory.
router.get('/admin/r2/live-status', isMuaj, async (req, res) => {
    try {
        const videos = db.prepare('SELECT id, title, filename, size, cdn_status FROM videos').all();
        const [{ videoFiles }, inventory] = await Promise.all([
            getDiskFilesWithCache(),
            getR2InventoryWithCache()
        ]);

        const vpsDiskFileSet = new Set(videoFiles.map(f => f.name));
        let r2Count = 0;
        let r2TotalBytes = 0;

        const videoRows = videos.map((v) => {
            const onDisk = vpsDiskFileSet.has(v.filename);
            let onR2;
            if (inventory.available) {
                const obj = inventory.map.get(v.filename);
                if (obj) {
                    onR2 = true;
                    r2TotalBytes += Number(obj.size || 0);
                } else if (r2.isConfirmedOnR2(v.filename)) {
                    // Confirmed after the inventory snapshot — reflect it immediately.
                    onR2 = true;
                    r2TotalBytes += Number(v.size || 0);
                } else {
                    onR2 = false;
                }
            } else {
                onR2 = r2.isConfirmedOnR2(v.filename) || v.cdn_status === 'r2_ready' || v.cdn_status === 'r2_only';
                if (onR2) r2TotalBytes += Number(v.size || 0);
            }
            if (onR2) r2Count++;
            return { id: v.id, filename: v.filename, title: v.title, size: v.size, onDisk, onR2 };
        });

        const activeUploads = typeof r2.getActiveUploadsList === 'function' ? r2.getActiveUploadsList() : [];
        const transferStats = (typeof db.getR2TransferStats === 'function')
            ? db.getR2TransferStats()
            : { transferCount: 0, totalBytes: 0, avgBps: 0, peakBps: 0, failureCount: 0 };

        res.json({
            success: true,
            r2Stats: {
                enabled: r2.isR2Enabled(),
                totalVideos: videos.length,
                r2Count,
                r2TotalBytes,
                r2Percent: videos.length > 0 ? Math.round((r2Count / videos.length) * 100) : 0,
                vpsCount: videoFiles.length,
                vpsTotalBytes: sumBytes(videoFiles),
                unsyncedCount: Math.max(0, videos.length - r2Count),
                inventorySource: inventory.source,
                inventoryAvailable: inventory.available,
                inventoryAgeSeconds: Math.round(inventory.ageMs / 1000),
                bucketObjectCount: inventory.available ? inventory.objects.length : null,
                bucketTotalBytes: inventory.available ? inventory.totalBytes : null
            },
            transferStats: {
                totalBytes: transferStats.totalBytes,
                totalFormatted: formatBytes(transferStats.totalBytes),
                transferCount: transferStats.transferCount,
                failureCount: transferStats.failureCount,
                avgSpeed: transferStats.avgBps > 0 ? formatSpeed(transferStats.avgBps) : '—'
            },
            activeUploads,
            videos: videoRows
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

        // An explicit admin-triggered scan should see current state, so force a
        // refresh — but reuse the shared inventory helper (Worker fast path,
        // S3 fallback) instead of duplicating that logic here.
        const inventory = await getR2InventoryWithCache(true);
        const r2Objects = inventory.objects;
        const source = inventory.source;

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

        // Deleted objects must disappear from the dashboard immediately.
        if (deletedKeys.length > 0) invalidateR2Inventory();

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

// ─── Session Replay — rrweb Live DOM Recording & Playback ─────────────────────
const replayRelay = require('../utils/replayRelay');
const { getConnectedUsers } = require('../utils/realtime');

// GET /admin/replay/sessions — List online users available for replay
router.get('/admin/replay/sessions', isMuaj, (req, res) => {
    const connectedUsers = getConnectedUsers().filter(u => u !== 'muaj');
    const activeSessions = replayRelay.getActiveSessions();
    res.json({
        success: true,
        onlineUsers: connectedUsers,
        activeSessions,
        timestamp: Date.now()
    });
});

// POST /admin/replay/start — Start recording a target user's session
router.post('/admin/replay/start', isMuaj, (req, res) => {
    const targetUser = (req.body.targetUser || '').trim().toLowerCase();
    if (!targetUser) {
        return res.status(400).json({ success: false, error: 'Missing targetUser' });
    }
    const result = replayRelay.startReplay(targetUser, 'muaj');
    if (!result.success) {
        return res.status(400).json(result);
    }
    res.json({ success: true, targetUser, message: `Started recording ${targetUser}` });
});

// POST /admin/replay/stop — Stop recording a target user's session
router.post('/admin/replay/stop', isMuaj, (req, res) => {
    const targetUser = (req.body.targetUser || '').trim().toLowerCase();
    if (!targetUser) {
        return res.status(400).json({ success: false, error: 'Missing targetUser' });
    }
    const result = replayRelay.stopReplay(targetUser);
    res.json({ success: true, targetUser, ...result });
});

// GET /admin/replay/stream — Dedicated SSE stream for receiving replay events in admin browser
router.get('/admin/replay/stream', isMuaj, (req, res) => {
    const targetUser = (req.query.targetUser || '').trim().toLowerCase();
    if (!targetUser) {
        return res.status(400).json({ success: false, error: 'Missing targetUser query param' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    if (typeof res.flushHeaders === 'function') {
        res.flushHeaders();
    }

    // Send initial connected event
    res.write(`event: replay-connected\ndata: ${JSON.stringify({
        targetUser,
        timestamp: Date.now()
    })}\n\n`);

    const added = replayRelay.addAdminReplayClient(targetUser, res);
    if (!added) {
        res.write(`event: replay-error\ndata: ${JSON.stringify({
            error: 'No active replay session for this user'
        })}\n\n`);
        return res.end();
    }

    // Keepalive ping every 15 seconds
    const keepalive = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
            if (typeof res.flush === 'function') res.flush();
        } catch {
            clearInterval(keepalive);
        }
    }, 15000);

    res.on('close', () => clearInterval(keepalive));
});

// POST /api/replay/events — Receive batched rrweb events from recorded user, forward to admin
// Rate-limited: max 100 events per batch, simple time-gating for abuse prevention
const { isAuthenticated } = require('../middleware/auth');
const _replayEventTimestamps = new Map(); // username -> lastBatchTime

router.post('/api/replay/events', isAuthenticated, (req, res) => {
    const user = req.session.user;

    // Only forward if this user is actually being recorded
    if (!replayRelay.isBeingRecorded(user)) {
        return res.status(403).json({ success: false, error: 'Not being recorded' });
    }

    // Rate limit: max 2 batches/sec per user
    const now = Date.now();
    const lastBatch = _replayEventTimestamps.get(user) || 0;
    if (now - lastBatch < 200) { // 200ms = ~5 batches/sec max
        return res.status(429).json({ success: false, error: 'Too fast' });
    }
    _replayEventTimestamps.set(user, now);

    const events = req.body.events;
    if (!Array.isArray(events) || events.length === 0) {
        return res.status(400).json({ success: false, error: 'No events' });
    }

    // Cap at 100 events per batch
    const capped = events.slice(0, 100);
    const result = replayRelay.forwardReplayEvents(user, capped);
    res.json({ success: true, forwarded: result.forwarded, accepted: capped.length });
});

module.exports = router;
