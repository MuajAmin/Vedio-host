const { S3Client, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const fs = require('fs');
const path = require('path');
const { Transform } = require('stream');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'videohost';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

let r2Enabled = false;
let s3Client = null;

if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });
    r2Enabled = true;
    console.log('[R2] Cloudflare R2 CDN configured successfully.');
} else {
    console.warn('[R2] R2 credentials not configured — videos will stream from VPS only.');
}

/**
 * Check if R2 is configured and ready to use.
 */
function isR2Enabled() {
    return r2Enabled;
}

/**
 * Get the public CDN URL for a video file.
 * @param {string} filename - The video filename (UUID-based)
 * @returns {string|null} Full public URL or null if R2 is not configured
 */
function getPublicUrl(filename) {
    if (!R2_PUBLIC_URL || !filename) return null;
    return `${R2_PUBLIC_URL.replace(/\/$/, '')}/${encodeURIComponent(filename)}`;
}

/**
 * Get the MIME type for a video file based on its extension.
 */
function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.flv': 'video/x-flv',
        '.wmv': 'video/x-ms-wmv',
        '.m4v': 'video/mp4'
    };
    return mimeMap[ext] || 'video/mp4';
}

// In-memory active uploads progress tracker (filename -> { loaded, total, percent, speed, eta, status, error, listeners: Set })
const activeUploads = new Map();

/**
 * Get current upload progress for a file.
 * @param {string} filename
 * @returns {object|null}
 */
function getUploadProgress(filename) {
    if (!filename) return null;
    const entry = activeUploads.get(filename);
    if (!entry) return null;
    return {
        filename: entry.filename,
        loaded: entry.loaded,
        total: entry.total,
        percent: entry.percent,
        speed: entry.speed,
        eta: entry.eta,
        status: entry.status,
        error: entry.error
    };
}

/**
 * Register a real-time progress listener for an ongoing R2 upload.
 * @param {string} filename
 * @param {function} callback
 * @returns {function} unregister function
 */
function registerProgressListener(filename, callback) {
    let entry = activeUploads.get(filename);
    if (!entry) {
        entry = {
            filename,
            loaded: 0,
            total: 0,
            percent: 0,
            speed: '',
            eta: '',
            status: 'queued',
            error: null,
            listeners: new Set(),
            startedAt: Date.now(),
            lastUpdate: Date.now()
        };
        activeUploads.set(filename, entry);
    }
    entry.listeners.add(callback);
    return () => {
        if (entry.listeners) {
            entry.listeners.delete(callback);
        }
    };
}

/**
 * Upload a video file to R2.
 * Streams the file to avoid loading it entirely into memory (safe for 1GB VPS).
 * @param {string} filePath - Absolute path to the video file on disk
 * @param {string} filename - The filename to use as the R2 object key
 * @returns {Promise<boolean>} true if upload succeeded
 */
async function uploadToR2(filePath, filename) {
    if (!r2Enabled) return false;

    const stat = await fs.promises.stat(filePath);
    const contentType = getMimeType(filename);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    const uploadStart = Date.now();
    console.log(`[R2] ⬆ Upload start: ${filename} (${sizeMB} MB)`);

    let progressEntry = activeUploads.get(filename);
    if (!progressEntry) {
        progressEntry = {
            filename,
            loaded: 0,
            total: stat.size,
            percent: 0,
            speed: '',
            eta: '',
            status: 'uploading',
            error: null,
            listeners: new Set(),
            startedAt: uploadStart,
            lastUpdate: uploadStart
        };
        activeUploads.set(filename, progressEntry);
    } else {
        progressEntry.total = stat.size;
        progressEntry.status = 'uploading';
        progressEntry.startedAt = uploadStart;
    }

    const notify = () => {
        if (!progressEntry || !progressEntry.listeners) return;
        for (const cb of progressEntry.listeners) {
            try { cb(progressEntry); } catch {}
        }
    };

    notify();

    let bytesStreamed = 0;
    let lastNotifyTime = uploadStart;
    let lastBytesStreamed = 0;

    const progressStream = new Transform({
        transform(chunk, encoding, callback) {
            bytesStreamed += chunk.length;
            const now = Date.now();
            progressEntry.loaded = Math.min(stat.size, bytesStreamed);
            progressEntry.total = stat.size;
            progressEntry.percent = Math.min(99, Math.round((progressEntry.loaded / progressEntry.total) * 100));

            // Throttle SSE updates to every 200ms for continuous smooth progress bar animation
            if (now - lastNotifyTime >= 200) {
                const timeDiff = (now - lastNotifyTime) / 1000;
                const bytesDiff = progressEntry.loaded - lastBytesStreamed;
                const bps = timeDiff > 0 ? Math.max(0, bytesDiff / timeDiff) : 0;
                if (bps >= 1024 * 1024) {
                    progressEntry.speed = (bps / (1024 * 1024)).toFixed(1) + ' MB/s';
                } else if (bps >= 1024) {
                    progressEntry.speed = (bps / 1024).toFixed(0) + ' KB/s';
                }
                const remainingBytes = progressEntry.total - progressEntry.loaded;
                if (bps > 0 && remainingBytes > 0) {
                    const etaSec = Math.ceil(remainingBytes / bps);
                    if (etaSec < 60) progressEntry.eta = `~${etaSec}s left`;
                    else progressEntry.eta = `~${Math.floor(etaSec / 60)}m ${etaSec % 60}s left`;
                }
                lastNotifyTime = now;
                lastBytesStreamed = progressEntry.loaded;
                notify();
            }
            callback(null, chunk);
        }
    });

    const fileStream = fs.createReadStream(filePath);
    const uploadBody = fileStream.pipe(progressStream);

    const parallelUpload = new Upload({
        client: s3Client,
        params: {
            Bucket: R2_BUCKET,
            Key: filename,
            Body: uploadBody,
            ContentType: contentType,
            CacheControl: 'public, max-age=2592000, immutable', // 30 days — videos are UUID-named & never change
        },
        partSize: 10 * 1024 * 1024, // 10MB chunks
        queueSize: 4, // 4 concurrent chunks (~40MB in-flight, optimal balance)
        leavePartsOnError: false,
    });

    try {
        await parallelUpload.done();
        const elapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
        console.log(`[R2] ✓ Upload done: ${filename} (${sizeMB} MB) in ${elapsed}s`);
        _r2ConfirmedCache.add(filename);
        progressEntry.percent = 100;
        progressEntry.loaded = stat.size;
        progressEntry.status = 'done';
        progressEntry.speed = '';
        progressEntry.eta = '';
        notify();
        // Remove active tracker after 5 minutes to avoid memory leak
        setTimeout(() => activeUploads.delete(filename), 5 * 60 * 1000).unref();
        return true;
    } catch (err) {
        progressEntry.status = 'error';
        progressEntry.error = err.message || 'R2 upload failed';
        notify();
        setTimeout(() => activeUploads.delete(filename), 5 * 60 * 1000).unref();
        throw err;
    }
}

const _r2ConfirmedCache = new Set();

/**
 * Delete a video file from R2.
 * @param {string} filename - The filename (R2 object key) to delete
 * @returns {Promise<boolean>} true if deletion succeeded
 */
async function deleteFromR2(filename) {
    if (!r2Enabled || !filename) return false;

    console.log(`[R2] ⬇ Delete start: ${filename}`);
    const command = new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: filename,
    });

    await s3Client.send(command);
    _r2ConfirmedCache.delete(filename);
    console.log(`[R2] ✓ Delete done: ${filename}`);
    return true;
}

/**
 * Check if a file exists on R2.
 * @param {string} filename - The filename (R2 object key) to check
 * @returns {Promise<boolean>} true if the object exists
 */
async function existsOnR2(filename) {
    if (!r2Enabled || !filename) return false;
    if (_r2ConfirmedCache.has(filename)) return true;

    try {
        const command = new HeadObjectCommand({
            Bucket: R2_BUCKET,
            Key: filename,
        });
        await s3Client.send(command);
        _r2ConfirmedCache.add(filename);
        return true;
    } catch {
        return false;
    }
}

/**
 * Automatically scan database and upload any videos that are missing from Cloudflare R2.
 * Run in background on server startup or on-demand.
 */
async function backfillMissingR2Uploads() {
    if (!r2Enabled) return;
    try {
        const db = require('../database');
        const videosDir = path.join(__dirname, '..', 'uploads', 'videos');
        const rows = db.prepare('SELECT id, title, filename FROM videos').all();
        let synced = 0;

        for (const row of rows) {
            if (!row.filename) continue;
            try {
                const exists = await existsOnR2(row.filename);
                if (!exists) {
                    const localPath = path.join(videosDir, row.filename);
                    if (fs.existsSync(localPath)) {
                        console.log(`[R2-Sync] 🔄 Backfilling missing video to Cloudflare R2: ${row.filename} (${row.title})`);
                        await uploadToR2(localPath, row.filename);
                        synced++;
                    }
                }
            } catch (err) {
                console.warn(`[R2-Sync] Failed to backfill ${row.filename}:`, err.message);
            }
        }

        if (synced > 0) {
            console.log(`[R2-Sync] ✓ Successfully synced ${synced} missing video(s) to Cloudflare R2.`);
        }
    } catch (err) {
        console.warn('[R2-Sync] Error during background R2 sync:', err.message);
    }
}

function getActiveUploadsList() {
    const list = [];
    for (const [filename, entry] of activeUploads.entries()) {
        list.push({
            filename: entry.filename,
            percent: entry.percent || 0,
            loaded: entry.loaded || 0,
            total: entry.total || 0,
            speed: entry.speed || '',
            eta: entry.eta || '',
            status: entry.status || 'idle',
            error: entry.error || null
        });
    }
    return list;
}

module.exports = {
    isR2Enabled,
    getPublicUrl,
    uploadToR2,
    deleteFromR2,
    existsOnR2,
    getUploadProgress,
    registerProgressListener,
    getActiveUploadsList,
    backfillMissingR2Uploads
};
