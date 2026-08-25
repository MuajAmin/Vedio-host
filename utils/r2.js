const { S3Client, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const { NodeHttpHandler } = require('@smithy/node-http-handler');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Transform } = require('stream');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'videohost';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';
const CF_WORKER_URL = process.env.CF_WORKER_URL || '';

let r2Enabled = false;
let s3Client = null;

// Persistent HTTPS agent — reuses TCP connections across multipart PUT requests.
// Without this, each 5MB part opens a new TLS handshake → TCP slow-start kills throughput.
const r2Agent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 30000,
    maxSockets: 8,
});

if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
        requestHandler: new NodeHttpHandler({
            httpsAgent: r2Agent,
            connectionTimeout: 10000,
            socketTimeout: 120000,
        }),
        maxAttempts: 5,
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

// In-flight upload deduplication map (filename -> Promise)
const inFlightUploads = new Map();

// Active upload controllers map (filename -> { upload, aborted: boolean })
const activeUploadControllers = new Map();

// Confirmed R2 objects cache
const _r2ConfirmedCache = new Set();

/**
 * Check if a file is already in the in-memory confirmed R2 cache.
 * @param {string} filename
 * @returns {boolean}
 */
function isConfirmedOnR2(filename) {
    if (!filename) return false;
    return _r2ConfirmedCache.has(filename);
}

/**
 * Mark a filename as confirmed to exist on R2.
 * @param {string} filename
 */
function markConfirmedOnR2(filename) {
    if (filename) _r2ConfirmedCache.add(filename);
}

/**
 * Remove a filename from the confirmed R2 cache.
 * @param {string} filename
 */
function unmarkConfirmedOnR2(filename) {
    if (filename) _r2ConfirmedCache.delete(filename);
}

/**
 * Bulk add filenames to the confirmed R2 cache.
 * @param {string[]|Iterable<string>} filenames
 */
function bulkConfirmOnR2(filenames) {
    if (!filenames) return;
    for (const f of filenames) {
        if (f) _r2ConfirmedCache.add(f);
    }
}

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
 * Includes concurrency deduplication, pre-upload faststart optimization, and cancellation support.
 * @param {string} filePath - Absolute path to the video file on disk
 * @param {string} filename - The filename to use as the R2 object key
 * @returns {Promise<boolean>} true if upload succeeded
 */
function uploadToR2(filePath, filename) {
    if (!r2Enabled) return Promise.resolve(false);
    if (!filePath || !filename) return Promise.resolve(false);

    // Concurrency Deduplication: If this exact file is already uploading, share the same Promise
    if (inFlightUploads.has(filename)) {
        console.log(`[R2] ⚡ Deduplicating upload: ${filename} is already in-flight.`);
        return inFlightUploads.get(filename);
    }

    const controller = { upload: null, aborted: false };
    activeUploadControllers.set(filename, controller);

    const uploadPromise = (async () => {
        try {
            // Verify file exists on disk
            if (!fs.existsSync(filePath)) {
                console.warn(`[R2] Upload skipped: file not found on disk: ${filePath}`);
                return false;
            }

            if (controller.aborted) return false;

            // Pre-upload Faststart Optimization: Ensure moov atom is at file start for instant CDN playback
            const ext = path.extname(filename).toLowerCase();
            if (ext === '.mp4' || ext === '.m4v') {
                try {
                    const { isFaststartOptimized, optimizeFaststart } = require('./faststart');
                    const isOpt = await isFaststartOptimized(filePath);
                    if (controller.aborted) return false;
                    if (!isOpt) {
                        console.log(`[R2] 🚀 Faststart optimizing ${filename} prior to R2 upload...`);
                        await optimizeFaststart(filePath);
                        if (controller.aborted) return false;
                    }
                } catch (fsErr) {
                    console.warn(`[R2] Faststart check before upload skipped:`, fsErr.message);
                }
            }

            if (controller.aborted) return false;

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
                    if (progressEntry.loaded >= stat.size) {
                        progressEntry.percent = 99;
                        progressEntry.eta = 'Finalizing with R2...';
                        progressEntry.speed = 'Saving...';
                    } else {
                        progressEntry.percent = Math.min(99, Math.round((progressEntry.loaded / progressEntry.total) * 100));
                    }

                    // Throttle SSE updates to every 200ms for continuous smooth progress bar animation
                    if (now - lastNotifyTime >= 200) {
                        const timeDiff = (now - lastNotifyTime) / 1000;
                        const bytesDiff = progressEntry.loaded - lastBytesStreamed;
                        const bps = timeDiff > 0 ? Math.max(0, bytesDiff / timeDiff) : 0;
                        if (progressEntry.loaded < stat.size) {
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
                partSize: 16 * 1024 * 1024, // 16MB chunks — optimal for high-latency long-haul uploads
                queueSize: 3,               // 3 concurrent parts — fills the bandwidth-delay product on APAC links
                leavePartsOnError: false,
            });

            controller.upload = parallelUpload;

            if (controller.aborted) {
                try { parallelUpload.abort(); } catch {}
                return false;
            }

            await parallelUpload.done();

            if (controller.aborted) {
                console.warn(`[R2] Upload was aborted mid-flight for deleted video: ${filename}`);
                // Clean up any uploaded object in case it completed right as abort was called
                try {
                    await s3Client.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: filename }));
                } catch {}
                _r2ConfirmedCache.delete(filename);
                return false;
            }

            // Verify upload integrity: HEAD the object to confirm size and accessibility.
            // R2 has an eventual consistency window — wait until the object is actually readable.
            let verified = false;
            for (let attempt = 0; attempt < 5; attempt++) {
                try {
                    const head = await s3Client.send(new HeadObjectCommand({ Bucket: R2_BUCKET, Key: filename }));
                    if (Number(head.ContentLength) === stat.size) {
                        verified = true;
                        break;
                    }
                    console.warn(`[R2] Verification attempt ${attempt + 1}/5: size mismatch for ${filename} (expected ${stat.size}, got ${head.ContentLength})`);
                } catch (headErr) {
                    console.warn(`[R2] Verification attempt ${attempt + 1}/5: HEAD failed for ${filename}: ${headErr.message}`);
                }
                await new Promise(r => setTimeout(r, 1000 * (attempt + 1))); // 1s, 2s, 3s, 4s, 5s
            }

            if (!verified) {
                console.error(`[R2] ✗ Upload verification failed for ${filename} — object not accessible or size mismatch`);
                if (progressEntry) {
                    progressEntry.status = 'error';
                    progressEntry.error = 'R2 verification failed after upload';
                    notify();
                }
                // Update DB status to failed so backfill can retry
                try {
                    const dbModule = require('../database');
                    dbModule.prepare("UPDATE videos SET cdn_status = 'upload_failed' WHERE filename = ?").run(filename);
                } catch {}
                setTimeout(() => activeUploads.delete(filename), 5 * 60 * 1000).unref();
                return false;
            }

            const elapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
            console.log(`[R2] ✓ Upload verified: ${filename} (${sizeMB} MB) in ${elapsed}s`);
            _r2ConfirmedCache.add(filename);

            // Update DB: mark video as R2-ready (authoritative source of truth for fallback)
            try {
                const dbModule = require('../database');
                dbModule.prepare("UPDATE videos SET cdn_status = 'r2_ready' WHERE filename = ?").run(filename);
            } catch (dbErr) {
                console.warn('[R2] Could not update cdn_status in DB:', dbErr.message);
            }

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
            const c = activeUploadControllers.get(filename);
            if ((c && c.aborted) || (controller && controller.aborted)) {
                console.log(`[R2] Upload aborted cleanly for: ${filename}`);
                return false;
            }
            let progressEntry = activeUploads.get(filename);
            if (progressEntry) {
                progressEntry.status = 'error';
                progressEntry.error = err.message || 'R2 upload failed';
                if (progressEntry.listeners) {
                    for (const cb of progressEntry.listeners) {
                        try { cb(progressEntry); } catch {}
                    }
                }
            }
            setTimeout(() => activeUploads.delete(filename), 5 * 60 * 1000).unref();
            throw err;
        } finally {
            inFlightUploads.delete(filename);
            activeUploadControllers.delete(filename);
        }
    })();

    inFlightUploads.set(filename, uploadPromise);
    return uploadPromise;
}

/**
 * Delete a video file from R2.
 * Aborts any in-flight upload controller immediately to prevent zombie orphan objects.
 * @param {string} filename - The filename (R2 object key) to delete
 * @returns {Promise<boolean>} true if deletion succeeded
 */
async function deleteFromR2(filename) {
    if (!r2Enabled || !filename) return false;

    console.log(`[R2] ⬇ Delete start: ${filename}`);

    // Abort any in-flight upload for this filename immediately
    const activeController = activeUploadControllers.get(filename);
    if (activeController) {
        console.log(`[R2] 🛑 Aborting in-flight upload for deleted file: ${filename}`);
        activeController.aborted = true;
        if (activeController.upload && typeof activeController.upload.abort === 'function') {
            try {
                activeController.upload.abort();
            } catch (abortErr) {
                console.warn(`[R2] Error aborting upload:`, abortErr.message);
            }
        }
        activeUploadControllers.delete(filename);
        inFlightUploads.delete(filename);
        activeUploads.delete(filename);
    }

    _r2ConfirmedCache.delete(filename);

    const command = new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: filename,
    });

    try {
        await s3Client.send(command);
        console.log(`[R2] ✓ Delete done: ${filename}`);
        return true;
    } catch (delErr) {
        console.error(`[R2] Delete failed for ${filename}:`, delErr.message);
        return false;
    }
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

async function getObjectMetadata(filename) {
    if (!r2Enabled || !s3Client || !filename) return null;

    try {
        const command = new HeadObjectCommand({
            Bucket: R2_BUCKET,
            Key: filename,
        });
        const head = await s3Client.send(command);
        _r2ConfirmedCache.add(filename);
        return {
            size: Number(head.ContentLength || 0),
            contentType: head.ContentType || '',
            etag: head.ETag || '',
            lastModified: head.LastModified || null
        };
    } catch {
        return null;
    }
}

/**
 * List all objects currently in the R2 bucket with full pagination.
 * @returns {Promise<Array<{ key: string, size: number, uploaded: Date, etag: string }>>}
 */
async function listAllR2Objects() {
    if (!r2Enabled || !s3Client) return [];
    const { ListObjectsV2Command } = require('@aws-sdk/client-s3');
    const objects = [];
    let continuationToken = undefined;

    do {
        const res = await s3Client.send(new ListObjectsV2Command({
            Bucket: R2_BUCKET,
            MaxKeys: 1000,
            ContinuationToken: continuationToken
        }));

        if (res.Contents && Array.isArray(res.Contents)) {
            for (const item of res.Contents) {
                if (item.Key) {
                    objects.push({
                        key: item.Key,
                        size: item.Size || 0,
                        uploaded: item.LastModified || new Date(),
                        etag: item.ETag || ''
                    });
                    _r2ConfirmedCache.add(item.Key);
                }
            }
        }

        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (continuationToken);

    return objects;
}

/**
 * Automatically scan database and upload any videos that are missing from Cloudflare R2.
 * Uses cdn_status column for targeted queries instead of checking every video.
 * Runs 2 uploads concurrently to speed up backfill without overwhelming 1GB VPS.
 * Run in background on server startup or on-demand.
 */
async function backfillMissingR2Uploads() {
    if (!r2Enabled) return;
    try {
        const db = require('../database');
        const videosDir = path.join(__dirname, '..', 'uploads', 'videos');

        // Seed in-memory cache from DB for videos already confirmed on R2
        const confirmedRows = db.prepare("SELECT filename FROM videos WHERE cdn_status IN ('r2_ready', 'r2_only')").all();
        for (const row of confirmedRows) {
            if (row.filename) _r2ConfirmedCache.add(row.filename);
        }
        console.log(`[R2-Sync] Seeded in-memory cache with ${confirmedRows.length} confirmed R2 video(s) from DB.`);

        // Also bulk-list R2 bucket to catch any files confirmed on R2 but not yet marked in DB
        try {
            await listAllR2Objects();
            console.log(`[R2-Sync] Bucket inventory scanned. ${_r2ConfirmedCache.size} objects confirmed in R2.`);
        } catch (listErr) {
            console.warn('[R2-Sync] Bulk list failed, will check individually:', listErr.message);
        }

        // Find videos that need R2 upload: cdn_status is not yet confirmed ('r2_ready' / 'r2_only')
        const rows = db.prepare(
            "SELECT id, title, filename FROM videos WHERE cdn_status NOT IN ('r2_ready', 'r2_only') OR cdn_status IS NULL"
        ).all();
        if (rows.length === 0) {
            console.log(`[R2-Sync] All videos are synchronized with Cloudflare R2.`);
            return;
        }

        // Check which of these actually need uploading (might already be on R2 but DB not updated)
        const needsUpload = [];
        for (const row of rows) {
            if (!row.filename) continue;
            const exists = isConfirmedOnR2(row.filename) || await existsOnR2(row.filename);
            if (exists) {
                // Already on R2, just update DB status
                try {
                    db.prepare("UPDATE videos SET cdn_status = 'r2_ready' WHERE id = ?").run(row.id);
                } catch {}
            } else {
                const localPath = path.join(videosDir, row.filename);
                if (fs.existsSync(localPath)) {
                    needsUpload.push(row);
                }
            }
        }

        if (needsUpload.length === 0) {
            console.log(`[R2-Sync] All ${rows.length} video(s) are synchronized with Cloudflare R2.`);
            return;
        }

        console.log(`[R2-Sync] 🔄 Backfilling ${needsUpload.length} missing video(s) to Cloudflare R2...`);

        // Run 2 concurrent uploads to speed up backfill
        const CONCURRENCY = 2;
        let synced = 0;
        for (let i = 0; i < needsUpload.length; i += CONCURRENCY) {
            const batch = needsUpload.slice(i, i + CONCURRENCY);
            const results = await Promise.allSettled(
                batch.map(async (row) => {
                    const localPath = path.join(videosDir, row.filename);
                    console.log(`[R2-Sync] 🔄 Backfilling: ${row.filename} (${row.title})`);
                    try {
                        db.prepare("UPDATE videos SET cdn_status = 'r2_uploading' WHERE id = ?").run(row.id);
                    } catch {}
                    return uploadToR2(localPath, row.filename);
                })
            );
            for (const r of results) {
                if (r.status === 'fulfilled' && r.value) synced++;
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

function generateWorkerSignature(key, expiry) {
    const secret = process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET;
    if (!secret) {
        throw new Error('WORKER_HMAC_SECRET (or SESSION_SECRET) is required for Worker signed URLs.');
    }
    return crypto
        .createHmac('sha256', secret)
        .update(`${key}:${expiry}`)
        .digest('hex');
}

function getWorkerUploadUrl(filename, expiresInSeconds = 3600) {
    if (!CF_WORKER_URL || !filename || !(process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET)) return null;
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = generateWorkerSignature(filename, exp);
    return `${CF_WORKER_URL.replace(/\/$/, '')}/upload/${encodeURIComponent(filename)}?sig=${sig}&exp=${exp}`;
}

function getWorkerInventoryUrl(expiresInSeconds = 600) {
    if (!CF_WORKER_URL || !(process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET)) return null;
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = generateWorkerSignature('inventory', exp);
    return `${CF_WORKER_URL.replace(/\/$/, '')}/api/r2-inventory?sig=${sig}&exp=${exp}`;
}

function getWorkerCallSignalingUrl(user, expiresInSeconds = 7200) {
    if (!CF_WORKER_URL || !user || !(process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET)) return null;
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;
    const sig = generateWorkerSignature(`call:${user}`, exp);
    const wsBase = CF_WORKER_URL.replace(/^http/, 'ws').replace(/\/$/, '');
    return `${wsBase}/call-signaling?user=${encodeURIComponent(user)}&sig=${sig}&exp=${exp}`;
}

function generateWorkerImageSignature({ filename, width = 480, height = 0, quality = 80, format = 'webp', exp }) {
    const secret = process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET;
    if (!secret) {
        throw new Error('WORKER_HMAC_SECRET (or SESSION_SECRET) is required for Worker signed URLs.');
    }
    const normW = (Number.isInteger(Number(width)) && Number(width) >= 16 && Number(width) <= 1920) ? Number(width) : 480;
    const normH = (Number.isInteger(Number(height)) && Number(height) >= 0 && Number(height) <= 1920) ? Number(height) : 0;
    const normQ = (Number.isInteger(Number(quality)) && Number(quality) >= 10 && Number(quality) <= 100) ? Number(quality) : 80;
    const allowedFormats = new Set(['webp', 'avif', 'jpeg', 'png', 'auto']);
    const normF = allowedFormats.has(String(format).toLowerCase()) ? String(format).toLowerCase() : 'webp';

    const message = `${filename}:${normW}:${normH}:${normQ}:${normF}:${exp}`;
    return crypto
        .createHmac('sha256', secret)
        .update(message)
        .digest('hex');
}

function getWorkerOptimizedImageUrl(filename, options = {}, expiresInSeconds = 86400) {
    if (!CF_WORKER_URL || !filename || !(process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET)) return null;
    const width = options.width !== undefined ? Number(options.width) : 480;
    const height = options.height !== undefined ? Number(options.height) : 0;
    const quality = options.quality !== undefined ? Number(options.quality) : 80;
    const format = options.format || 'webp';
    const exp = Math.floor(Date.now() / 1000) + expiresInSeconds;

    const sig = generateWorkerImageSignature({ filename, width, height, quality, format, exp });
    const base = CF_WORKER_URL.replace(/\/$/, '');
    let query = `w=${width}&q=${quality}&format=${format}`;
    if (height > 0) query += `&h=${height}`;
    query += `&exp=${exp}&sig=${sig}`;
    return `${base}/img-opt/${encodeURIComponent(filename)}?${query}`;
}

/**
 * Upload to R2 with automatic retry and exponential backoff.
 * Wraps uploadToR2 with up to 3 retries on failure.
 * @param {string} filePath - Absolute path to the video file on disk
 * @param {string} filename - The filename to use as the R2 object key
 * @param {number} [maxAttempts=3] - Max retry attempts
 * @returns {Promise<boolean>} true if upload ultimately succeeded
 */
async function uploadToR2WithRetry(filePath, filename, maxAttempts = 3) {
    const delays = [5000, 30000, 120000]; // 5s, 30s, 2min between retries
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            const ok = await uploadToR2(filePath, filename);
            if (ok) return true;
            console.warn(`[R2-Retry] Upload returned false for ${filename} (attempt ${attempt}/${maxAttempts})`);
        } catch (err) {
            console.error(`[R2-Retry] Attempt ${attempt}/${maxAttempts} failed for ${filename}: ${err.message}`);
        }
        if (attempt < maxAttempts) {
            const delay = delays[attempt - 1] || 120000;
            console.log(`[R2-Retry] Retrying ${filename} in ${delay / 1000}s...`);
            await new Promise(r => setTimeout(r, delay));
            // Re-check if file still exists before retrying (might have been deleted)
            if (!fs.existsSync(filePath)) {
                console.warn(`[R2-Retry] File no longer exists, abandoning: ${filePath}`);
                return false;
            }
        }
    }
    console.error(`[R2-Retry] Permanently failed after ${maxAttempts} attempts: ${filename}`);
    // Mark as failed in DB so admin can see it
    try {
        const dbModule = require('../database');
        dbModule.prepare("UPDATE videos SET cdn_status = 'upload_failed' WHERE filename = ?").run(filename);
    } catch {}
    return false;
}

/**
 * Delete local VPS copy of a video after confirming it is safely stored on R2.
 * Only deletes if R2 object exists and size matches local file.
 * @param {string} filePath - Absolute path to the local video file
 * @param {string} filename - R2 object key
 * @returns {Promise<boolean>}
 */
async function cleanupLocalAfterR2Migration(filePath, filename) {
    try {
        const [localStat, r2Meta] = await Promise.all([
            fs.promises.stat(filePath),
            getObjectMetadata(filename)
        ]);
        if (!r2Meta || r2Meta.size !== localStat.size) {
            console.warn(`[R2-Cleanup] Size mismatch for ${filename} — keeping local copy`);
            return false;
        }
        await fs.promises.unlink(filePath);
        console.log(`[R2-Cleanup] ✓ Deleted local copy: ${filename} (${(localStat.size / 1024 / 1024).toFixed(1)} MB freed)`);
        try {
            const dbModule = require('../database');
            dbModule.prepare("UPDATE videos SET cdn_status = 'r2_only' WHERE filename = ?").run(filename);
        } catch {}
        return true;
    } catch (err) {
        console.warn(`[R2-Cleanup] Failed to clean up ${filename}:`, err.message);
        return false;
    }
}

module.exports = {
    isR2Enabled,
    getPublicUrl,
    getMimeType,
    uploadToR2,
    uploadToR2WithRetry,
    deleteFromR2,
    existsOnR2,
    getObjectMetadata,
    isConfirmedOnR2,
    markConfirmedOnR2,
    unmarkConfirmedOnR2,
    bulkConfirmOnR2,
    listAllR2Objects,
    getUploadProgress,
    registerProgressListener,
    getActiveUploadsList,
    backfillMissingR2Uploads,
    cleanupLocalAfterR2Migration,
    generateWorkerSignature,
    generateWorkerImageSignature,
    getWorkerUploadUrl,
    getWorkerInventoryUrl,
    getWorkerCallSignalingUrl,
    getWorkerOptimizedImageUrl
};
