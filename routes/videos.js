const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { isAuthenticated, isMuaj } = require('../middleware/auth');
const { requireCsrf, validateCsrf } = require('../utils/security');
const db = require('../database');
const { parseUserAgent, getClientIp } = require('../utils/device');
const r2 = require('../utils/r2');
const crypto = require('crypto');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads', 'videos');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
const thumbnailsDir = path.join(__dirname, '..', 'uploads', 'thumbnails');
if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
}

// Multer config
const maxSize = (parseInt(process.env.MAX_FILE_SIZE_MB) || 500) * 1024 * 1024;
const allowedExtensions = new Set(['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v']);
const allowedMimeTypes = new Set([
    'video/mp4',
    'video/x-matroska',
    'video/quicktime',
    'video/x-msvideo',
    'video/x-flv',
    'video/x-ms-wmv',
    'video/x-m4v',
    'video/webm'
]);
const MAX_TITLE_LENGTH = 180;

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueName = uuidv4() + path.extname(file.originalname).toLowerCase();
        cb(null, uniqueName);
    }
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const mimeType = String(file.mimetype || '').toLowerCase();

    if (allowedExtensions.has(ext) && (allowedMimeTypes.has(mimeType) || mimeType.startsWith('video/'))) {
        cb(null, true);
    } else {
        cb(new Error('Only video files can be uploaded. Allowed: mp4, mkv, avi, mov, webm, flv, wmv, m4v.'));
    }
};

const upload = multer({
    storage,
    limits: { fileSize: maxSize },
    fileFilter
});

const thumbnailUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            cb(null, thumbnailsDir);
        },
        filename: (req, file, cb) => {
            const ext = path.extname(file.originalname).toLowerCase();
            cb(null, `${req.params.id}-${Date.now()}${ext}`);
        }
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase();
        const mimeType = String(file.mimetype || '').toLowerCase();
        const allowedImageExt = new Set(['.jpg', '.jpeg', '.png', '.webp']);
        const allowedImageMime = new Set(['image/jpeg', 'image/png', 'image/webp']);

        if (allowedImageExt.has(ext) && allowedImageMime.has(mimeType)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPG, PNG, or WebP thumbnails are allowed.'));
        }
    }
});
const STREAM_HIGH_WATER_MARK = 256 * 1024;

// Mutex set to deduplicate concurrent delete requests for the same video
const activeDeletes = new Set();

// Lightweight LRU cache for video filename lookups.
// Prevents a DB query on every single 206 range request during playback.
// Max 200 entries (~20KB memory) — more than enough for a private video host.
const VIDEO_CACHE_MAX = 200;
const videoFilenameCache = new Map();

function getCachedVideoFilename(videoKey) {
    if (videoFilenameCache.has(videoKey)) {
        const value = videoFilenameCache.get(videoKey);
        // Move to end (most-recently-used)
        videoFilenameCache.delete(videoKey);
        videoFilenameCache.set(videoKey, value);
        return value;
    }
    return null;
}

function setCachedVideoFilename(videoKey, filename) {
    if (videoFilenameCache.size >= VIDEO_CACHE_MAX) {
        // Evict oldest entry (first in Map iteration order)
        const oldest = videoFilenameCache.keys().next().value;
        videoFilenameCache.delete(oldest);
    }
    videoFilenameCache.set(videoKey, filename);
}

function invalidateVideoCache(videoKey) {
    videoFilenameCache.delete(videoKey);
    // Also remove by filename if cached under a different key
    for (const [key, val] of videoFilenameCache) {
        if (val === videoKey) videoFilenameCache.delete(key);
    }
}

const { generateVideoThumbnail, getVideoDuration } = require('../utils/thumbnail');

// Precompiled SQL statement for instant dashboard gallery loading
const stmtDashboardVideos = db.prepare(`
    SELECT
        v.id,
        v.title,
        v.size,
        v.duration,
        v.thumbnail,
        v.uploaded_by,
        v.uploaded_at,
        wp.position_seconds,
        wp.duration_seconds,
        wp.updated_at AS progress_updated_at
    FROM videos v
    LEFT JOIN watch_progress wp
        ON wp.video_id = v.id AND wp.user = ?
    ORDER BY v.uploaded_at DESC
`);

// GET /dashboard — Video gallery (Ultra-fast precompiled query)
router.get('/dashboard', isAuthenticated, (req, res) => {
    const videos = stmtDashboardVideos.all(req.session.user);

    const continueVideos = videos
        .filter((video) => {
            const position = Number(video.position_seconds || 0);
            const duration = Number(video.duration_seconds || 0);
            return position >= 10 && (!duration || position < duration - 15);
        })
        .sort((a, b) => new Date(b.progress_updated_at || 0) - new Date(a.progress_updated_at || 0))
        .slice(0, 6);

    // Track last visit for "NEW" badge — read before updating
    const lastVisit = req.session.lastDashboardVisit || null;
    req.session.lastDashboardVisit = new Date().toISOString();

    res.render('dashboard', {
        user: req.session.user,
        videos,
        continueVideos,
        lastVisit
    });
});

// GET /upload — Upload form (any authenticated user)
router.get('/upload', isAuthenticated, (req, res) => {
    res.render('upload', { user: req.session.user, error: null });
});

// POST /upload — Handle video upload (any authenticated user)
router.post('/upload', isAuthenticated, (req, res) => {
    upload.single('video')(req, res, async (err) => {
        const isXHR = req.xhr || 
            (req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest' ||
            (req.headers.accept && req.headers.accept.includes('application/json'));

        const fail = (status, error) => {
            if (req.file) {
                fs.promises.unlink(path.join(uploadsDir, req.file.filename)).catch(() => {});
            }
            if (isXHR) {
                return res.status(status).json({ success: false, error });
            }
            return res.status(status).render('upload', { user: req.session.user, error });
        };

        if (err) {
            let errorMsg = 'Upload failed.';
            if (err instanceof multer.MulterError) {
                if (err.code === 'LIMIT_FILE_SIZE') {
                    errorMsg = `File is too large. Maximum ${process.env.MAX_FILE_SIZE_MB || 500}MB allowed.`;
                }
            } else if (err.message) {
                errorMsg = err.message;
            }
            return fail(400, errorMsg);
        }

        if (!validateCsrf(req)) {
            if (req.file) {
                fs.promises.unlink(path.join(uploadsDir, req.file.filename)).catch(() => {});
            }
            if (isXHR) {
                return res.status(403).json({ success: false, error: 'Invalid CSRF token.' });
            }
            return;
        }

        if (!req.file) {
            return fail(400, 'No file selected.');
        }

        const id = uuidv4();
        const title = String(req.body.title || req.file.originalname).trim().slice(0, MAX_TITLE_LENGTH);
        const uploader = req.session.user || 'muaj';

        // Generate video thumbnail (lightweight single-frame FFmpeg extraction)
        let thumbnail = null;
        let duration = null;
        try {
            [thumbnail, duration] = await Promise.all([
                generateVideoThumbnail(req.file.filename, id),
                getVideoDuration(req.file.filename)
            ]);
        } catch (thumbErr) {
            console.warn('[upload] Metadata extraction error:', thumbErr.message);
        }

        try {
            db.prepare(
                'INSERT INTO videos (id, title, filename, original_name, size, thumbnail, duration, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
            ).run(id, title || req.file.originalname, req.file.filename, req.file.originalname, req.file.size, thumbnail, duration, uploader);
            console.log(`[upload] DB saved: id=${id} file=${req.file.filename} size=${(req.file.size / 1024 / 1024).toFixed(1)}MB by=${uploader}`);
        } catch (dbError) {
            console.error(`[upload] DB save failed for ${req.file.filename}:`, dbError.message);
            return fail(500, 'Could not save video metadata.');
        }

        // Upload to R2 CDN in background (non-blocking — user sees dashboard immediately or monitors progress)
        if (r2.isR2Enabled()) {
            const videoPath = path.join(uploadsDir, req.file.filename);
            console.log(`[upload] R2 background upload starting: ${req.file.filename}`);
            // Set DB status to uploading
            try {
                db.prepare("UPDATE videos SET cdn_status = 'r2_uploading' WHERE filename = ?").run(req.file.filename);
            } catch {}
            // Use retry wrapper: 3 attempts with exponential backoff (5s, 30s, 2min)
            r2.uploadToR2WithRetry(videoPath, req.file.filename)
                .catch(err => console.error(`[upload] R2 upload permanently failed for ${req.file.filename}:`, err.message));
        }

        if (isXHR) {
            return res.json({
                success: true,
                id,
                filename: req.file.filename,
                title: title || req.file.originalname,
                size: req.file.size,
                r2Enabled: r2.isR2Enabled()
            });
        }

        res.redirect('/dashboard');
    });
});

// POST /api/upload/init — Initialize direct-to-R2 upload ticket
router.post('/api/upload/init', isAuthenticated, (req, res) => {
    if (!validateCsrf(req)) {
        return res.status(403).json({ success: false, error: 'Invalid CSRF token.' });
    }

    const rawFilename = String(req.body.filename || req.body.originalName || '').trim();
    const rawTitle = String(req.body.title || '').trim().slice(0, MAX_TITLE_LENGTH);
    const fileSize = parseInt(req.body.size, 10) || 0;
    const ext = path.extname(rawFilename).toLowerCase();

    if (!ext || !allowedExtensions.has(ext)) {
        return res.status(400).json({
            success: false,
            error: 'Only video files are allowed (.mp4, .mkv, .avi, .mov, .webm, .flv, .wmv, .m4v).'
        });
    }

    if (fileSize > maxSize) {
        return res.status(400).json({
            success: false,
            error: `File exceeds maximum allowed size of ${process.env.MAX_FILE_SIZE_MB || 500}MB.`
        });
    }

    const id = uuidv4();
    const videoFilename = `${id}${ext}`;
    const contentType = r2.getMimeType(videoFilename);

    // Direct-to-R2 Worker upload URL
    const uploadUrl = r2.getWorkerUploadUrl(videoFilename, 3600);

    if (r2.isR2Enabled() && uploadUrl) {
        return res.json({
            success: true,
            directUpload: true,
            id,
            filename: videoFilename,
            originalName: rawFilename || videoFilename,
            title: rawTitle || rawFilename,
            uploadUrl,
            method: 'PUT',
            headers: {
                'Content-Type': contentType
            }
        });
    }

    // If R2/Worker direct upload is not available, indicate fallback to standard multipart POST /upload
    return res.json({
        success: true,
        directUpload: false,
        message: 'Direct R2 upload not configured. Falling back to server upload.'
    });
});

// POST /api/upload/finalize — Finalize direct-to-R2 upload metadata and client-extracted thumbnail
router.post('/api/upload/finalize', isAuthenticated, async (req, res) => {
    if (!validateCsrf(req)) {
        return res.status(403).json({ success: false, error: 'Invalid CSRF token.' });
    }

    const id = String(req.body.id || '').trim();
    const filename = String(req.body.filename || '').trim();
    const originalName = String(req.body.originalName || req.body.title || '').trim().slice(0, 255);
    const title = String(req.body.title || originalName || 'Untitled Video').trim().slice(0, MAX_TITLE_LENGTH);
    const size = parseInt(req.body.size, 10) || 0;
    const duration = req.body.duration ? String(req.body.duration).trim().slice(0, 20) : null;
    const thumbnailBase64 = req.body.thumbnailBase64 || null;
    const uploader = req.session.user || 'muaj';

    if (!id || !/^[a-f0-9-]{36}$/i.test(id)) {
        return res.status(400).json({ success: false, error: 'Invalid video ID.' });
    }

    if (!filename || !allowedExtensions.has(path.extname(filename).toLowerCase())) {
        return res.status(400).json({ success: false, error: 'Invalid video filename.' });
    }

    const expectedFilename = `${id}${path.extname(filename).toLowerCase()}`;
    if (filename !== expectedFilename) {
        return res.status(400).json({ success: false, error: 'Video filename does not match upload ticket.' });
    }

    if (!Number.isFinite(size) || size <= 0 || size > maxSize) {
        return res.status(400).json({ success: false, error: 'Invalid video size.' });
    }

    const objectMeta = await r2.getObjectMetadata(filename);
    if (!objectMeta) {
        return res.status(400).json({ success: false, error: 'Uploaded video was not found on Cloudflare R2.' });
    }

    if (objectMeta.size !== size) {
        return res.status(400).json({ success: false, error: 'Uploaded video size does not match finalized metadata.' });
    }

    const objectContentType = String(objectMeta.contentType || '').toLowerCase();
    if (objectContentType && !allowedMimeTypes.has(objectContentType) && !objectContentType.startsWith('video/')) {
        return res.status(400).json({ success: false, error: 'Uploaded object is not a supported video type.' });
    }

    let thumbnail = null;
    if (thumbnailBase64 && typeof thumbnailBase64 === 'string' && thumbnailBase64.startsWith('data:image/')) {
        try {
            const matches = thumbnailBase64.match(/^data:image\/([a-zA-Z0-9]+);base64,(.+)$/);
            if (matches) {
                const imgExt = matches[1].toLowerCase() === 'png' ? '.png' : '.jpg';
                const base64Data = matches[2];
                const buffer = Buffer.from(base64Data, 'base64');

                // Limit thumbnail buffer to 2MB to protect disk/RAM
                if (buffer.length <= 2 * 1024 * 1024) {
                    const thumbFilename = `${id}${imgExt}`;
                    const thumbPath = path.join(thumbnailsDir, thumbFilename);
                    await fs.promises.writeFile(thumbPath, buffer);
                    thumbnail = thumbFilename;
                }
            }
        } catch (thumbErr) {
            console.warn('[upload/finalize] Failed to save client thumbnail:', thumbErr.message);
        }
    }

    try {
        db.prepare(
            'INSERT INTO videos (id, title, filename, original_name, size, thumbnail, duration, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
        ).run(id, title, filename, originalName, size, thumbnail, duration, uploader);

        console.log(`[upload/finalize] Video saved directly to R2: id=${id} file=${filename} size=${(size / 1024 / 1024).toFixed(1)}MB by=${uploader}`);

        // Mark as confirmed in memory caches so playback stream redirects instantly without HEAD check
        r2.markConfirmedOnR2(filename);

        // Direct-to-R2 uploads bypass VPS disk — mark as R2-ready immediately
        try {
            db.prepare("UPDATE videos SET cdn_status = 'r2_ready' WHERE id = ?").run(id);
        } catch {}

        return res.json({
            success: true,
            id,
            filename,
            title,
            redirectUrl: '/dashboard'
        });
    } catch (dbErr) {
        console.error(`[upload/finalize] DB save failed for ${filename}:`, dbErr.message);
        return res.status(500).json({ success: false, error: 'Could not save video metadata.' });
    }
});

// GET /api/r2-progress/:filename — Real-time Server to Cloudflare R2 upload progress (SSE)
router.get('/api/r2-progress/:filename', isAuthenticated, (req, res) => {
    const filename = path.basename(req.params.filename || '');

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const send = (data) => {
        try {
            res.write(`data: ${JSON.stringify(data)}\n\n`);
            if (typeof res.flush === 'function') res.flush();
        } catch {}
    };

    const current = r2.getUploadProgress(filename);
    if (!current) {
        r2.existsOnR2(filename).then((exists) => {
            if (exists) {
                send({ filename, percent: 100, loaded: 0, total: 0, speed: '', eta: '', status: 'done' });
                setTimeout(() => { try { res.end(); } catch {} }, 500);
            } else {
                send({ filename, percent: 0, loaded: 0, total: 0, speed: '', eta: '', status: 'starting' });
            }
        }).catch(() => {
            send({ filename, percent: 0, loaded: 0, total: 0, speed: '', eta: '', status: 'starting' });
        });
    } else {
        send({
            filename: current.filename,
            percent: current.percent,
            loaded: current.loaded,
            total: current.total,
            speed: current.speed,
            eta: current.eta,
            status: current.status,
            error: current.error
        });
        if (current.status === 'done' || current.status === 'error') {
            setTimeout(() => { try { res.end(); } catch {} }, 500);
            return;
        }
    }

    const unregister = r2.registerProgressListener(filename, (entry) => {
        send({
            filename: entry.filename,
            percent: entry.percent,
            loaded: entry.loaded,
            total: entry.total,
            speed: entry.speed,
            eta: entry.eta,
            status: entry.status,
            error: entry.error
        });

        if (entry.status === 'done' || entry.status === 'error') {
            setTimeout(() => {
                try { res.end(); } catch {}
            }, 800);
        }
    });

    const keepalive = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
            if (typeof res.flush === 'function') res.flush();
        } catch {
            clearInterval(keepalive);
        }
    }, 15000);
    keepalive.unref();

    const cleanup = () => {
        clearInterval(keepalive);
        unregister();
    };

    req.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
});

// Compiled prepared statements for high-speed watch page rendering
const stmtWatchVideo = db.prepare('SELECT * FROM videos WHERE id = ?');
const stmtWatchComments = db.prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY created_at DESC');
const stmtWatchProgress = db.prepare('SELECT position_seconds, duration_seconds, updated_at FROM watch_progress WHERE video_id = ? AND user = ?');
const stmtWatchPrevVideo = db.prepare('SELECT id FROM videos WHERE uploaded_at > ? ORDER BY uploaded_at ASC LIMIT 1');
const stmtWatchNextVideo = db.prepare('SELECT id FROM videos WHERE uploaded_at < ? ORDER BY uploaded_at DESC LIMIT 1');
const stmtWatchSuggested = db.prepare(`
    SELECT
        v.id,
        v.title,
        v.size,
        v.duration,
        v.thumbnail,
        v.uploaded_by,
        v.uploaded_at,
        wp.position_seconds,
        wp.duration_seconds
    FROM videos v
    LEFT JOIN watch_progress wp
        ON wp.video_id = v.id AND wp.user = ?
    WHERE v.id != ?
    ORDER BY v.uploaded_at DESC
    LIMIT 30
`);
const stmtWatchMarkSeen = db.prepare(`
    INSERT INTO watch_progress (video_id, user, position_seconds, duration_seconds, updated_at)
    VALUES (?, ?, 1, 0, CURRENT_TIMESTAMP)
    ON CONFLICT(video_id, user) DO NOTHING
`);

// GET /watch/:id — Video player page (Ultra-fast cached execution)
router.get('/watch/:id', isAuthenticated, async (req, res) => {
    const video = stmtWatchVideo.get(req.params.id);

    if (!video) {
        return res.status(404).render('error', {
            user: req.session.user,
            message: 'Video not found.'
        });
    }

    let isOnR2 = false;
    let directStreamUrl = null;
    if (r2.isR2Enabled() && video.filename) {
        const isDbReady = video.cdn_status === 'r2_ready' || video.cdn_status === 'r2_only' || r2.isConfirmedOnR2(video.filename);
        if (isDbReady) {
            isOnR2 = true;
        } else {
            try {
                isOnR2 = await r2.existsOnR2(video.filename);
            } catch {
                isOnR2 = false;
            }
        }
        if (isOnR2) {
            directStreamUrl = getWorkerStreamUrl(video.filename) || r2.getPublicUrl(video.filename) || null;
        }
    }

    const comments = stmtWatchComments.all(req.params.id);
    const progress = stmtWatchProgress.get(req.params.id, req.session.user) || null;

    // Prev / Next video navigation
    const prevVideo = stmtWatchPrevVideo.get(video.uploaded_at) || null;
    const nextVideo = stmtWatchNextVideo.get(video.uploaded_at) || null;

    // Suggested videos (all other videos ordered by newest, with watch progress)
    const suggestedVideos = stmtWatchSuggested.all(req.session.user, req.params.id);
    const edgeTrackerUrl = getWorkerTrackerUrl(req.session.user);

    res.render('watch', {
        user: req.session.user,
        video,
        isOnR2,
        directStreamUrl,
        edgeTrackerUrl,
        comments,
        progress,
        suggestedVideos,
        thumbnail: String(req.query.thumbnail || '').slice(0, 120),
        prevVideoId: prevVideo ? prevVideo.id : null,
        nextVideoId: nextVideo ? nextVideo.id : null
    });

    // Mark video as seen asynchronously without blocking response
    queueMicrotask(() => {
        try {
            stmtWatchMarkSeen.run(req.params.id, req.session.user);
        } catch (e) {
            // ignore
        }
    });
});

// POST /rename/:id — Rename video title (any authenticated user)
router.post('/rename/:id', isAuthenticated, (req, res) => {
    const newTitle = String(req.body.title || '').trim().slice(0, 180);
    if (!newTitle) {
        return res.status(400).json({ error: 'Title cannot be empty.' });
    }
    const result = db.prepare('UPDATE videos SET title = ? WHERE id = ?').run(newTitle, req.params.id);
    if (result.changes === 0) {
        return res.status(404).json({ error: 'Video not found.' });
    }
    res.json({ success: true, title: newTitle });
});

// POST /delete/:id — Delete video (any authenticated user)
router.post('/delete/:id', isAuthenticated, requireCsrf, async (req, res) => {
    const videoId = String(req.params.id || '').trim();
    if (!videoId) {
        return res.status(400).json({ error: 'Invalid video ID.' });
    }

    // Deduplicate concurrent deletion requests for the same video ID
    if (activeDeletes.has(videoId)) {
        console.log(`[delete] Deduplicated concurrent delete request for video: ${videoId}`);
        const isAjax = req.xhr || 
            (req.headers.accept && req.headers.accept.includes('application/json')) ||
            (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));
        if (isAjax) return res.json({ success: true, message: 'Video deletion in progress.' });
        return res.redirect('/dashboard');
    }

    activeDeletes.add(videoId);

    try {
        const video = db.prepare('SELECT * FROM videos WHERE id = ? OR filename = ?').get(videoId, videoId);

        if (video) {
            console.log(`[delete] Start: video=${video.id} file=${video.filename} by=${req.session.user}`);

            // Invalidate stream cache
            invalidateVideoCache(video.id);
            invalidateVideoCache(video.filename);
            // Clear R2 confirmed cache so stale 302 redirects don't hit a deleted object
            r2.unmarkConfirmedOnR2(video.filename);

            // 1. Delete from R2 CDN first (also aborts any in-flight upload controller immediately)
            if (r2.isR2Enabled()) {
                try {
                    await r2.deleteFromR2(video.filename);
                    console.log(`[delete] R2 delete success: ${video.filename}`);
                } catch (err) {
                    console.error(`[delete] R2 delete failed for ${video.filename}:`, err.message);
                }
            }

            // 1b. Purge Cloudflare edge cache (Worker / CDN cached responses)
            if (process.env.CF_ZONE_ID && process.env.CF_API_TOKEN) {
                const cfDomain = process.env.CF_DOMAIN || 'muaj.bro.bd';
                const purgeUrls = [`https://${cfDomain}/stream/${video.filename}`];
                if (video.thumbnail) {
                    purgeUrls.push(`https://${cfDomain}/thumbnails/${video.thumbnail}`);
                }
                fetch(`https://api.cloudflare.com/client/v4/zones/${process.env.CF_ZONE_ID}/purge_cache`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${process.env.CF_API_TOKEN}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({ files: purgeUrls })
                })
                    .then(() => console.log(`[delete] CF cache purge sent for ${video.filename}`))
                    .catch(err => console.warn(`[delete] CF cache purge failed: ${err.message}`));
            }

            // 2. Delete video file from disk
            const filePath = getSafeVideoPath(video.filename);
            if (filePath && fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath).catch(() => {});
                console.log(`[delete] Local file removed: ${video.filename}`);
            }

            // 3. Delete thumbnail file if exists
            if (video.thumbnail) {
                const thumbPath = getSafeThumbnailPath(video.thumbnail);
                if (thumbPath && fs.existsSync(thumbPath)) {
                    await fs.promises.unlink(thumbPath).catch(() => {});
                }
            }

            // 4. Delete from database last (foreign keys handle comments & watch_progress)
            db.prepare('DELETE FROM videos WHERE id = ?').run(video.id);
            console.log(`[delete] DB record removed: ${video.id} (${video.title})`);
            console.log(`[delete] Complete: ${video.id}`);
        }

        const isAjax = req.xhr || 
            (req.headers.accept && req.headers.accept.includes('application/json')) ||
            (req.headers['content-type'] && req.headers['content-type'].includes('application/json'));

        if (isAjax) {
            return res.json({ success: true, message: 'Video deleted successfully.' });
        }

        res.redirect('/dashboard');
    } catch (err) {
        console.error('[delete] Error:', err.message);
        const isAjax = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));
        if (isAjax) {
            return res.status(500).json({ error: 'Could not delete video.' });
        }
        res.redirect('/dashboard');
    } finally {
        activeDeletes.delete(videoId);
    }
});

// POST /api/presence/ping - Client heartbeat ping (every 10s or on user interaction)
router.post('/api/presence/ping', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const { page, videoId, videoTitle, isPlaying, currentTime, duration, isIdle, action, deltaSeconds } = req.body;
    const deviceInfo = parseUserAgent(req.headers['user-agent']);
    const ipAddress = getClientIp(req);

    const playing = (isPlaying === true || isPlaying === 1 || isPlaying === 'true' || isPlaying === '1');
    const idle = (isIdle === true || isIdle === 1 || isIdle === 'true' || isIdle === '1');
    const pos = Number(currentTime) || 0;
    const dur = Number(duration) || 0;

    if (req.session) {
        req.session.lastActive = new Date().toISOString();
        if (!req.session.device) req.session.device = deviceInfo;
        if (!req.session.ip) req.session.ip = ipAddress;
    }

    db.updateUserPresence(user, {
        page: page || '/dashboard',
        videoId: videoId || null,
        videoTitle: videoTitle || null,
        isPlaying: playing,
        currentTime: pos,
        duration: dur,
        isIdle: idle,
        deviceInfo,
        ipAddress,
        sessionId: req.sessionID
    });

    if (videoId && playing) {
        const delta = Math.min(Number(deltaSeconds) || 10, 30);
        db.recordWatchPulse(user, videoId, pos, dur, true, delta);
    }

    if (action) {
        let details = null;
        if (action === 'watch_start') {
            details = `Started watching "${videoTitle || 'video'}"`;
        } else if (action === 'watch_pause') {
            const percent = (dur > 0) ? ` (${Math.round((pos / dur) * 100)}%)` : '';
            details = `Paused at ${Math.floor(pos / 60)}:${String(Math.floor(pos % 60)).padStart(2, '0')}${percent}`;
        } else if (action === 'watch_resume') {
            details = `Resumed watching "${videoTitle || 'video'}"`;
        } else if (action === 'watch_complete') {
            details = `Finished watching "${videoTitle || 'video'}" (100%)`;
        } else if (action === 'went_idle') {
            details = 'Screen inactive / tab in background';
        } else if (action === 'came_online') {
            details = 'Active on screen';
        }

        db.logActivity(user, action, {
            videoId: videoId || null,
            videoTitle: videoTitle || null,
            position: pos,
            duration: dur,
            details,
            deviceInfo,
            ipAddress
        });
    }

    res.json({ success: true });
});

// POST /api/presence/leave - Client leaving beacon (pagehide / beforeunload)
router.post('/api/presence/leave', isAuthenticated, (req, res) => {
    const user = req.session ? req.session.user : null;
    if (user) {
        const deviceInfo = parseUserAgent(req.headers['user-agent']);
        const ipAddress = getClientIp(req);
        db.updateUserPresence(user, { status: 'offline' });
        db.logActivity(user, 'went_offline', {
            details: 'Left the website / closed tab',
            deviceInfo,
            ipAddress
        });
    }
    res.json({ success: true });
});

// POST /watch-progress/:id - Save or update playback position for current user
router.post('/watch-progress/:id', isAuthenticated, (req, res) => {
    const position = Number(req.body.position);
    const duration = Number(req.body.duration);
    const ended = req.body.ended === true || req.body.ended === 'true';

    if (!Number.isFinite(position) || position < 0) {
        return res.status(400).json({ error: 'Invalid position.' });
    }

    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const nearEnd = safeDuration > 0 && position >= safeDuration - 10;
    const user = req.session.user;
    const video = db.prepare('SELECT title FROM videos WHERE id = ?').get(req.params.id);
    const videoTitle = video ? video.title : null;
    const deviceInfo = parseUserAgent(req.headers['user-agent']);
    const ipAddress = getClientIp(req);

    if (ended || nearEnd) {
        // Video finished — keep progress record with safeDuration so it does NOT appear in "Continue Watching" but also never reverts to "NEW"
        db.prepare(
            `INSERT INTO watch_progress (video_id, user, position_seconds, duration_seconds, updated_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(video_id, user) DO UPDATE SET
                position_seconds = excluded.position_seconds,
                duration_seconds = excluded.duration_seconds,
                updated_at = CURRENT_TIMESTAMP`
        ).run(req.params.id, user, Math.floor(safeDuration || position), Math.floor(safeDuration));

        db.recordWatchPulse(user, req.params.id, safeDuration || position, safeDuration, true, 5);
        db.logActivity(user, 'watch_complete', {
            videoId: req.params.id,
            videoTitle,
            position: safeDuration || position,
            duration: safeDuration,
            details: `Completed 100% of "${videoTitle || 'video'}"`,
            deviceInfo,
            ipAddress
        });

        return res.json({ success: true, completed: true });
    }

    // For very short watches (< 5s), save position as 1 so the video is marked "seen"
    const savePosition = position < 5 ? 1 : Math.floor(position);

    db.prepare(
        `INSERT INTO watch_progress (video_id, user, position_seconds, duration_seconds, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(video_id, user) DO UPDATE SET
            position_seconds = excluded.position_seconds,
            duration_seconds = excluded.duration_seconds,
            updated_at = CURRENT_TIMESTAMP`
    ).run(req.params.id, user, savePosition, Math.floor(safeDuration));

    // Note: recordWatchPulse is only called on watch_complete (above) to reduce DB writes.
    // Normal progress saves only update watch_progress, not the watch_time_ledger.

    res.json({ success: true });
});

// POST /api/internal-presence-sync — Authenticated relay from Cloudflare Edge Worker
router.post('/api/internal-presence-sync', (req, res) => {
    const secret = process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET;
    const { exp, sig } = req.query;
    if (!secret || !exp || !sig) {
        return res.status(401).json({ error: 'Unauthorized — missing credentials' });
    }

    const expiryTs = parseInt(exp, 10);
    if (!Number.isFinite(expiryTs) || Date.now() > expiryTs * 1000) {
        return res.status(401).json({ error: 'Unauthorized — expired token' });
    }

    const expectedSig = crypto.createHmac('sha256', secret).update(`sync:${exp}`).digest('hex');
    if (sig.toLowerCase() !== expectedSig.toLowerCase()) {
        return res.status(401).json({ error: 'Unauthorized — invalid signature' });
    }

    const { user, videoId, position, duration, playing, ended, videoTitle } = req.body || {};
    if (!user || !videoId || (user !== 'muaj' && user !== 'hajera')) {
        return res.status(400).json({ error: 'Invalid payload' });
    }

    const posNum = Number(position) || 0;
    const durNum = Number(duration) || 0;
    const nearEnd = durNum > 0 && posNum >= durNum - 10;
    const isCompleted = ended === true || nearEnd;

    const v = videoTitle ? { title: videoTitle } : db.prepare('SELECT title FROM videos WHERE id = ?').get(videoId);
    const title = v ? v.title : (videoTitle || null);
    const deviceInfo = parseUserAgent(req.headers['user-agent'] || 'Cloudflare-Edge-Worker');
    const ipAddress = getClientIp(req);

    try {
        if (isCompleted) {
            db.prepare(
                `INSERT INTO watch_progress (video_id, user, position_seconds, duration_seconds, updated_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(video_id, user) DO UPDATE SET
                    position_seconds = excluded.position_seconds,
                    duration_seconds = excluded.duration_seconds,
                    updated_at = CURRENT_TIMESTAMP`
            ).run(videoId, user, Math.floor(durNum || posNum), Math.floor(durNum));

            db.recordWatchPulse(user, videoId, durNum || posNum, durNum, true, 5);
            db.logActivity(user, 'watch_complete', {
                videoId,
                videoTitle: title,
                position: durNum || posNum,
                duration: durNum,
                details: `Completed 100% of "${title || 'video'}"`,
                deviceInfo,
                ipAddress
            });
        } else {
            const savePos = posNum < 5 ? 1 : Math.floor(posNum);
            db.prepare(
                `INSERT INTO watch_progress (video_id, user, position_seconds, duration_seconds, updated_at)
                 VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                 ON CONFLICT(video_id, user) DO UPDATE SET
                    position_seconds = excluded.position_seconds,
                    duration_seconds = excluded.duration_seconds,
                    updated_at = CURRENT_TIMESTAMP`
            ).run(videoId, user, savePos, Math.floor(durNum));

            if (playing && posNum >= 5) {
                db.recordWatchPulse(user, videoId, savePos, Math.floor(durNum), false, 4);
            }
        }

        // Update live presence in SQLite
        db.updateUserPresence(user, {
            status: playing ? 'watching' : 'online',
            isPlaying: !!playing,
            videoId,
            videoTitle: title,
            currentTime: Math.floor(posNum),
            duration: Math.floor(durNum),
            page: `/watch/${videoId}`,
            deviceInfo,
            ipAddress
        });

        res.json({ success: true, updated: true });
    } catch (err) {
        console.error('[InternalSync] Error updating presence/progress:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// POST /thumbnail/:id - Upload a custom thumbnail for a video (Admin / Muaj only)
router.post('/thumbnail/:id', isMuaj, (req, res) => {
    thumbnailUpload.single('thumbnail')(req, res, (err) => {
        const video = db.prepare('SELECT id, thumbnail FROM videos WHERE id = ?').get(req.params.id);
        const watchUrl = `/watch/${encodeURIComponent(req.params.id)}`;

        const fail = (message) => {
            if (req.file) {
                fs.promises.unlink(path.join(thumbnailsDir, req.file.filename)).catch(() => {});
            }
            return res.redirect(`${watchUrl}?thumbnail=${encodeURIComponent(message)}`);
        };

        if (!video) {
            return fail('Video not found.');
        }

        if (err) {
            return fail(err.message || 'Thumbnail upload failed.');
        }

        if (!validateCsrf(req)) {
            if (req.file) {
                fs.promises.unlink(path.join(thumbnailsDir, req.file.filename)).catch(() => {});
            }
            return;
        }

        if (!req.file) {
            return fail('No thumbnail selected.');
        }

        if (video.thumbnail && video.thumbnail !== req.file.filename) {
            const oldPath = getSafeThumbnailPath(video.thumbnail);
            if (oldPath) {
                fs.promises.unlink(oldPath).catch(() => {});
            }
        }

        db.prepare('UPDATE videos SET thumbnail = ? WHERE id = ?').run(req.file.filename, req.params.id);
        return res.redirect(`${watchUrl}?thumbnail=updated`);
    });
});

// POST /thumbnail/:id/regenerate - Rebuild thumbnail from source URL or video file (Admin / Muaj only)
router.post('/thumbnail/:id/regenerate', isMuaj, async (req, res) => {
    if (!validateCsrf(req)) return;

    const video = db.prepare('SELECT id, filename, thumbnail, source_url FROM videos WHERE id = ?').get(req.params.id);
    const watchUrl = `/watch/${encodeURIComponent(req.params.id)}`;

    if (!video) {
        return res.status(404).render('error', {
            user: req.session.user,
            message: 'Video not found.'
        });
    }

    try {
        let thumbFilename = null;

        // 1. If video has a source URL, try to fetch official source thumbnail first
        if (video.source_url) {
            thumbFilename = await new Promise((resolve) => {
                const tempId = `refetch-${video.id}-${Date.now()}`;
                const outputPath = path.join(uploadsDir, `${tempId}.mp4`);
                const proc = spawn(process.platform === 'win32' ? 'python' : 'python3', [
                    '-m', 'yt_dlp',
                    '--no-check-certificates',
                    '--no-playlist',
                    '--skip-download',
                    '--write-thumbnail',
                    '-o', outputPath,
                    '--',
                    video.source_url
                ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

                let settled = false;
                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        try { proc.kill('SIGTERM'); } catch {}
                        resolve(null);
                    }
                }, 20000);

                proc.on('close', async () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    try {
                        const files = await fs.promises.readdir(uploadsDir);
                        const thumbCandidate = files.find(f => 
                            f.startsWith(tempId) && 
                            ['.jpg', '.jpeg', '.webp', '.png'].includes(path.extname(f).toLowerCase())
                        );
                        if (thumbCandidate) {
                            const ext = path.extname(thumbCandidate).toLowerCase();
                            const targetFilename = `${video.id}${ext}`;
                            const targetPath = path.join(thumbnailsDir, targetFilename);
                            const srcPath = path.join(uploadsDir, thumbCandidate);
                            await fs.promises.rename(srcPath, targetPath);
                            return resolve(targetFilename);
                        }
                    } catch {}
                    resolve(null);
                });

                proc.on('error', () => {
                    if (settled) return;
                    settled = true;
                    clearTimeout(timer);
                    resolve(null);
                });
            });
        }

        // 2. If no source thumbnail was retrieved, fallback to FFmpeg extraction
        if (!thumbFilename) {
            thumbFilename = await generateVideoThumbnail(video.filename, video.id);
        }

        if (!thumbFilename) {
            return res.redirect(`${watchUrl}?thumbnail=${encodeURIComponent('Could not generate thumbnail.')}`);
        }

        if (video.thumbnail && video.thumbnail !== thumbFilename) {
            const oldPath = getSafeThumbnailPath(video.thumbnail);
            if (oldPath) {
                fs.promises.unlink(oldPath).catch(() => {});
            }
        }

        db.prepare('UPDATE videos SET thumbnail = ? WHERE id = ?').run(thumbFilename, video.id);
        return res.redirect(`${watchUrl}?thumbnail=updated`);
    } catch (err) {
        return res.redirect(`${watchUrl}?thumbnail=${encodeURIComponent('Could not generate thumbnail.')}`);
    }
});

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

function formatContentDisposition(filename, type = 'attachment') {
    const ext = path.extname(filename).toLowerCase();
    const base = path.basename(filename, ext);

    const asciiBase = base.replace(/["\\\r\n\x00-\x1F\x7F-\uFFFF]/g, '_').trim() || 'video';
    const asciiFilename = `${asciiBase}${ext}`;

    const utf8Filename = encodeURIComponent(path.basename(filename))
        .replace(/['()]/g, escape)
        .replace(/\*/g, '%2A');

    return `${type}; filename="${asciiFilename}"; filename*=UTF-8''${utf8Filename}`;
}

function getSafeVideoPath(filename) {
    const baseDir = path.resolve(uploadsDir);
    const resolved = path.resolve(baseDir, filename);
    const relative = path.relative(baseDir, resolved);

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }

    return resolved;
}

function getSafeThumbnailPath(filename) {
    const baseDir = path.resolve(thumbnailsDir);
    const resolved = path.resolve(baseDir, path.basename(filename || ''));
    const relative = path.relative(baseDir, resolved);

    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }

    return resolved;
}

function parseRange(rangeHeader, fileSize) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
    if (!match) {
        return null;
    }

    let start;
    let end;

    if (match[1] === '' && match[2] === '') {
        return null;
    }

    if (match[1] === '') {
        const suffixLength = Number.parseInt(match[2], 10);
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
            return null;
        }
        start = Math.max(fileSize - suffixLength, 0);
        end = fileSize - 1;
    } else {
        start = Number.parseInt(match[1], 10);
        end = match[2] ? Number.parseInt(match[2], 10) : fileSize - 1;
    }

    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
        return null;
    }

    return { start, end: Math.min(end, fileSize - 1) };
}

function streamFile(req, res, filePath, filename, stat) {
    const fileSize = stat.size;
    const range = req.headers.range;
    const mimeType = getMimeType(filename);
    const etag = `"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;

    // ETag-based caching — avoid re-sending data the browser already has
    if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
    }

    const baseHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Type': mimeType,
        'Content-Disposition': formatContentDisposition(filename, 'inline'),
        'Cache-Control': 'private, max-age=86400, no-transform',
        'Last-Modified': stat.mtime.toUTCString(),
        'ETag': etag,
        'Connection': 'keep-alive',
        'X-Content-Type-Options': 'nosniff'
    };

    if (range) {
        const parsed = parseRange(range, fileSize);
        if (!parsed) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
        }

        // Let the browser decide chunk size via its Range header —
        // highWaterMark (256KB) controls actual memory usage per read
        const chunkSize = parsed.end - parsed.start + 1;

        res.writeHead(206, {
            ...baseHeaders,
            'Content-Range': `bytes ${parsed.start}-${parsed.end}/${fileSize}`,
            'Content-Length': chunkSize
        });

        if (req.method === 'HEAD') {
            return res.end();
        }

        return pipeFile(res, filePath, {
            start: parsed.start,
            end: parsed.end,
            highWaterMark: STREAM_HIGH_WATER_MARK
        });
    }

    res.writeHead(200, {
        ...baseHeaders,
        'Content-Length': fileSize
    });

    if (req.method === 'HEAD') {
        return res.end();
    }

    return pipeFile(res, filePath, { highWaterMark: STREAM_HIGH_WATER_MARK });
}

function pipeFile(res, filePath, options) {
    const stream = fs.createReadStream(filePath, options);

    stream.on('error', (err) => {
        if (!res.headersSent) {
            res.status(500).end('Stream error');
            return;
        }
        res.destroy(err);
    });

    // Clean up stream if client disconnects mid-download
    res.on('close', () => {
        if (!stream.destroyed) {
            stream.destroy();
        }
    });

    return stream.pipe(res);
}

const isProduction = process.env.NODE_ENV === 'production';

// ─── Worker CDN: Signed URL for cross-origin R2 video proxy ─────────────
// When CF_WORKER_URL is set, video streams redirect to the Cloudflare Worker
// instead of the R2 public URL. The Worker validates the signed token and
// proxies the video from R2 with proper Range/206 support.
const CF_WORKER_URL = process.env.CF_WORKER_URL; // e.g. https://videohost-edge.muajamin2021.workers.dev

/**
 * Generates a signed Worker CDN URL for a video file.
 * Token = HMAC-SHA256(filename + ":" + expiry, SESSION_SECRET)
 * @param {string} filename - The video filename (R2 object key)
 * @returns {string|null} Signed Worker URL or null if not configured
 */
function getWorkerStreamUrl(filename) {
    if (!CF_WORKER_URL || !(process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET)) return null;
    const exp = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    const message = `${filename}:${exp}`;
    const secret = process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET;
    const sig = crypto.createHmac('sha256', secret)
        .update(message)
        .digest('hex');
    return `${CF_WORKER_URL}/stream/${encodeURIComponent(filename)}?exp=${exp}&sig=${sig}`;
}

/**
 * Generates a signed Edge Worker URL for live watch progress and presence telemetry.
 * Token = HMAC-SHA256("tracker:" + user + ":" + expiry, SESSION_SECRET)
 * @param {string} user - The username
 * @returns {string|null} Signed Edge Tracker URL or null if not configured
 */
function getWorkerTrackerUrl(user) {
    if (!CF_WORKER_URL || !user || !(process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET)) return null;
    const exp = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    const message = `tracker:${user}:${exp}`;
    const secret = process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET;
    const sig = crypto.createHmac('sha256', secret)
        .update(message)
        .digest('hex');
    return `${CF_WORKER_URL.replace(/\/$/, '')}/api/edge-watch-progress?user=${encodeURIComponent(user)}&exp=${exp}&sig=${sig}`;
}


async function handleStream(req, res) {
    const videoKey = req.params.videoKey;

    // Try LRU cache first (avoids DB query on every 206 range request)
    let filename = getCachedVideoFilename(videoKey);
    let cdnStatus = null;
    if (filename) {
        // LRU cache stores "filename|cdn_status" — split to extract both
        const pipeIdx = filename.indexOf('|');
        if (pipeIdx !== -1) {
            cdnStatus = filename.slice(pipeIdx + 1);
            filename = filename.slice(0, pipeIdx);
        }
    }
    if (!filename) {
        const video = db.prepare('SELECT filename, cdn_status FROM videos WHERE id = ? OR filename = ?').get(videoKey, videoKey);
        if (!video) {
            return res.status(404).send('File not found');
        }
        filename = video.filename;
        cdnStatus = video.cdn_status || 'vps';
        // Cache both filename and cdn_status to avoid DB query on subsequent 206 range requests
        setCachedVideoFilename(videoKey, `${filename}|${cdnStatus}`);
    }

    // R2 CDN: Redirect to Cloudflare edge — zero VPS bandwidth usage.
    // Uses DB cdn_status as the authoritative source of truth for R2 readiness.
    // Only redirects when cdn_status is 'r2_ready' or 'r2_only' (verified uploaded).
    // The in-memory isConfirmedOnR2 cache is a secondary fast-path for the same decision.
    if (r2.isR2Enabled()) {
        const shouldUseR2 = cdnStatus === 'r2_ready' || cdnStatus === 'r2_only' || r2.isConfirmedOnR2(filename);
        if (shouldUseR2) {
            const workerUrl = getWorkerStreamUrl(filename);
            const cdnUrl = workerUrl || r2.getPublicUrl(filename);
            if (cdnUrl) {
                res.setHeader('Cache-Control', 'private, no-cache');
                return res.redirect(302, cdnUrl);
            }
        }
        // cdn_status is 'vps', 'r2_uploading', 'upload_failed', or null → serve from VPS
    }

    // Fallback: serve from VPS disk (when R2 is not configured or URL unavailable)
    const filePath = getSafeVideoPath(filename);
    if (!filePath) {
        return res.status(404).send('File not found');
    }

    let stat;
    try {
        stat = await fs.promises.stat(filePath);
    } catch (err) {
        // File missing from disk — remove from cache
        invalidateVideoCache(videoKey);
        return res.status(404).send('File not found');
    }

    const mimeType = getMimeType(filename);
    const etag = `"${stat.size.toString(16)}-${stat.mtime.getTime().toString(16)}"`;

    // ETag-based caching — avoid re-sending data the browser already has
    if (req.headers['if-none-match'] === etag) {
        return res.status(304).end();
    }

    // Production: Nginx serves video directly via X-Accel-Redirect (zero Node.js overhead)
    // Nginx handles Range/206 responses, Content-Length, and Accept-Ranges itself
    // from the internal location block — we only pass through metadata headers.
    if (isProduction) {
        res.setHeader('X-Accel-Redirect', `/internal-videos/${filename}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Content-Disposition', formatContentDisposition(filename, 'inline'));
        res.setHeader('Cache-Control', 'private, max-age=86400, no-transform');
        res.setHeader('Last-Modified', stat.mtime.toUTCString());
        res.setHeader('ETag', etag);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        // NOTE: Do NOT set Content-Length here — Nginx computes it from the
        // actual byte range served (206) or the full file (200). Setting it
        // to stat.size would be incorrect for range responses.
        return res.end();
    }

    // Dev: Node.js streams the file directly
    return streamFile(req, res, filePath, filename, stat);
}

// Stream video
router.head('/stream/:videoKey', isAuthenticated, handleStream);
router.get('/stream/:videoKey', isAuthenticated, handleStream);

// Download video — serves file as attachment for browser download
router.get('/download/:id', isAuthenticated, async (req, res) => {
    const video = db.prepare('SELECT id, filename, original_name, title FROM videos WHERE id = ?').get(req.params.id);

    if (!video) {
        return res.status(404).send('File not found');
    }

    const filePath = getSafeVideoPath(video.filename);
    if (!filePath) {
        return res.status(404).send('File not found');
    }

    let stat;
    try {
        stat = await fs.promises.stat(filePath);
    } catch (err) {
        return res.status(404).send('File not found');
    }

    const ext = path.extname(video.filename).toLowerCase() || '.mp4';
    let rawName = video.original_name || video.title || 'video';
    if (!path.extname(rawName)) {
        rawName += ext;
    }

    // Production: Nginx serves file directly via X-Accel-Redirect
    if (isProduction) {
        res.setHeader('X-Accel-Redirect', `/internal-videos/${video.filename}`);
        res.setHeader('Content-Type', getMimeType(video.filename));
        res.setHeader('Content-Disposition', formatContentDisposition(rawName, 'attachment'));
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        return res.end();
    }

    // Dev: Node.js streams the file
    res.writeHead(200, {
        'Content-Type': getMimeType(video.filename),
        'Content-Disposition': formatContentDisposition(rawName, 'attachment'),
        'Content-Length': stat.size,
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff'
    });

    if (req.method === 'HEAD') {
        return res.end();
    }

    return pipeFile(res, filePath, { highWaterMark: STREAM_HIGH_WATER_MARK });
});

module.exports = router;
