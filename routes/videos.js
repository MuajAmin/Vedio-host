const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { isAuthenticated, isMuaj } = require('../middleware/auth');
const { requireCsrf } = require('../utils/security');
const db = require('../database');

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, '..', 'uploads', 'videos');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
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
const STREAM_HIGH_WATER_MARK = 512 * 1024;

// GET /dashboard — Video gallery
router.get('/dashboard', isAuthenticated, (req, res) => {
    const videos = db.prepare(
        'SELECT id, title, size, uploaded_at FROM videos ORDER BY uploaded_at DESC'
    ).all();
    res.render('dashboard', {
        user: req.session.user,
        videos
    });
});

// GET /upload — Upload form (Muaj only)
router.get('/upload', isAuthenticated, isMuaj, (req, res) => {
    res.render('upload', { user: req.session.user, error: null });
});

// POST /upload — Handle video upload (Muaj only)
router.post('/upload', isAuthenticated, isMuaj, (req, res) => {
    upload.single('video')(req, res, (err) => {
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

        try {
            db.prepare(
                'INSERT INTO videos (id, title, filename, original_name, size) VALUES (?, ?, ?, ?, ?)'
            ).run(id, title || req.file.originalname, req.file.filename, req.file.originalname, req.file.size);
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

    res.render('watch', {
        user: req.session.user,
        video,
        comments
    });
});

// POST /delete/:id — Delete video (Muaj only)
router.post('/delete/:id', isAuthenticated, isMuaj, (req, res) => {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);

    if (video) {
        const filePath = getSafeVideoPath(video.filename);
        if (filePath && fs.existsSync(filePath)) {
            fs.promises.unlink(filePath).catch(() => {});
        }
        db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    }

    res.redirect('/dashboard');
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

function safeHeaderFilename(filename) {
    return path.basename(filename).replace(/["\\\r\n]/g, '_');
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
    const baseHeaders = {
        'Accept-Ranges': 'bytes',
        'Content-Type': mimeType,
        'Content-Disposition': `inline; filename="${safeHeaderFilename(filename)}"`,
        'Cache-Control': 'private, max-age=86400, no-transform',
        'Last-Modified': stat.mtime.toUTCString(),
        'X-Content-Type-Options': 'nosniff'
    };

    if (range) {
        const parsed = parseRange(range, fileSize);
        if (!parsed) {
            res.setHeader('Content-Range', `bytes */${fileSize}`);
            return res.status(416).end();
        }

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

    return stream.pipe(res);
}

function handleStream(req, res) {
    const video = db.prepare('SELECT filename FROM videos WHERE id = ? OR filename = ?').get(req.params.videoKey, req.params.videoKey);

    if (!video) {
        return res.status(404).send('File not found');
    }

    const filePath = getSafeVideoPath(video.filename);

    if (!filePath || !fs.existsSync(filePath)) {
        return res.status(404).send('File not found');
    }

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch (err) {
        return res.status(404).send('File not found');
    }

    return streamFile(req, res, filePath, video.filename, stat);
}

// Stream video
router.head('/stream/:videoKey', isAuthenticated, handleStream);
router.get('/stream/:videoKey', isAuthenticated, handleStream);

module.exports = router;
