const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { isAuthenticated, isMuaj } = require('../middleware/auth');
const { requireCsrf } = require('../utils/security');
const db = require('../database');

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
    'video/webm',
    'application/octet-stream'
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

const { generateVideoThumbnail, getVideoDuration } = require('../utils/thumbnail');

// GET /dashboard — Video gallery
router.get('/dashboard', isAuthenticated, (req, res) => {
    const videos = db.prepare(
        `SELECT
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
        ORDER BY v.uploaded_at DESC`
    ).all(req.session.user);

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
        const isXHR = req.xhr || (req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';

        const fail = (status, error) => {
            if (req.file) {
                fs.promises.unlink(path.join(uploadsDir, req.file.filename)).catch(() => {});
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

        let csrfOk = false;
        requireCsrf(req, res, () => {
            csrfOk = true;
        });
        if (!csrfOk) {
            if (req.file) {
                fs.promises.unlink(path.join(uploadsDir, req.file.filename)).catch(() => {});
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
        } catch (dbError) {
            return fail(500, 'Could not save video metadata.');
        }

        res.redirect('/dashboard');
    });
});

// GET /watch/:id — Video player page
router.get('/watch/:id', isAuthenticated, (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);

    if (!video) {
        return res.status(404).render('error', {
            user: req.session.user,
            message: 'Video not found.'
        });
    }

    const comments = db.prepare(
        'SELECT * FROM comments WHERE video_id = ? ORDER BY created_at DESC'
    ).all(req.params.id);

    const progress = db.prepare(
        'SELECT position_seconds, duration_seconds, updated_at FROM watch_progress WHERE video_id = ? AND user = ?'
    ).get(req.params.id, req.session.user) || null;

    // Next/Previous video navigation (ordered by uploaded_at DESC)
    const prevVideo = db.prepare(
        'SELECT id FROM videos WHERE uploaded_at > ? ORDER BY uploaded_at ASC LIMIT 1'
    ).get(video.uploaded_at);
    const nextVideo = db.prepare(
        'SELECT id FROM videos WHERE uploaded_at < ? ORDER BY uploaded_at DESC LIMIT 1'
    ).get(video.uploaded_at);

    res.render('watch', {
        user: req.session.user,
        video,
        comments,
        progress,
        thumbnail: String(req.query.thumbnail || '').slice(0, 120),
        prevVideoId: prevVideo ? prevVideo.id : null,
        nextVideoId: nextVideo ? nextVideo.id : null
    });
});

// POST /rename/:id — Rename video title (any authenticated user)
router.post('/rename/:id', isAuthenticated, (req, res) => {
    const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found.' });
    }

    const newTitle = String(req.body.title || '').trim().slice(0, MAX_TITLE_LENGTH);
    if (!newTitle) {
        return res.status(400).json({ error: 'Title cannot be empty.' });
    }

    db.prepare('UPDATE videos SET title = ? WHERE id = ?').run(newTitle, req.params.id);
    res.json({ success: true, title: newTitle });
});

// POST /delete/:id — Delete video (any authenticated user)
router.post('/delete/:id', isAuthenticated, (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);

    if (video) {
        // Delete video file
        const filePath = getSafeVideoPath(video.filename);
        if (filePath && fs.existsSync(filePath)) {
            fs.promises.unlink(filePath).catch(() => {});
        }
        // Delete thumbnail file if exists
        if (video.thumbnail) {
            const thumbPath = getSafeThumbnailPath(video.thumbnail);
            if (thumbPath) {
                fs.promises.unlink(thumbPath).catch(() => {});
            }
        }
        db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    }

res.redirect('/dashboard');
});

// POST /watch-progress/:id - Save per-user playback position
router.post('/watch-progress/:id', isAuthenticated, (req, res) => {
    const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(req.params.id);
    if (!video) {
        return res.status(404).json({ error: 'Video not found.' });
    }

    const position = Number(req.body.position);
    const duration = Number(req.body.duration);
    const ended = req.body.ended === true || req.body.ended === 'true';

    if (!Number.isFinite(position) || position < 0) {
        return res.status(400).json({ error: 'Invalid position.' });
    }

    const safeDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const nearEnd = safeDuration > 0 && position >= safeDuration - 10;

    if (ended || position < 5 || nearEnd) {
        db.prepare('DELETE FROM watch_progress WHERE video_id = ? AND user = ?').run(req.params.id, req.session.user);
        return res.json({ success: true, cleared: true });
    }

    db.prepare(
        `INSERT INTO watch_progress (video_id, user, position_seconds, duration_seconds, updated_at)
         VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(video_id, user) DO UPDATE SET
            position_seconds = excluded.position_seconds,
            duration_seconds = excluded.duration_seconds,
            updated_at = CURRENT_TIMESTAMP`
    ).run(req.params.id, req.session.user, Math.floor(position), Math.floor(safeDuration));

    res.json({ success: true });
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

        let csrfOk = false;
        requireCsrf(req, res, () => {
            csrfOk = true;
        });
        if (!csrfOk) {
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
    let csrfOk = false;
    requireCsrf(req, res, () => {
        csrfOk = true;
    });
    if (!csrfOk) return;

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
                const proc = spawn('python3', [
                    '-m', 'yt_dlp',
                    '--no-check-certificates',
                    '--no-playlist',
                    '--skip-download',
                    '--write-thumbnail',
                    '-o', outputPath,
                    video.source_url
                ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

                let settled = false;
                const timer = setTimeout(() => {
                    if (!settled) {
                        settled = true;
                        proc.kill();
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

        // Cap chunk size to 10MB — only 2 viewers so memory is fine;
        // highWaterMark (256KB) controls actual RAM usage, not chunk size
        const MAX_CHUNK = 10 * 1024 * 1024;
        const requestedEnd = parsed.end;
        const cappedEnd = Math.min(parsed.start + MAX_CHUNK - 1, requestedEnd);
        const chunkSize = cappedEnd - parsed.start + 1;

        res.writeHead(206, {
            ...baseHeaders,
            'Content-Range': `bytes ${parsed.start}-${cappedEnd}/${fileSize}`,
            'Content-Length': chunkSize
        });

        if (req.method === 'HEAD') {
            return res.end();
        }

        return pipeFile(res, filePath, {
            start: parsed.start,
            end: cappedEnd,
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

async function handleStream(req, res) {
    const video = db.prepare('SELECT filename FROM videos WHERE id = ? OR filename = ?').get(req.params.videoKey, req.params.videoKey);

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

    return streamFile(req, res, filePath, video.filename, stat);
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
