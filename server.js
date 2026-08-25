require('dotenv').config();
const express = require('express');
const session = require('express-session');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const { attachLocals, requireCsrf, renderAvatar } = require('./utils/security');
const { isAuthenticated } = require('./middleware/auth');
const SQLiteSessionStore = require('./utils/sessionStore');
const db = require('./database');

const app = express();
app.locals.renderAvatar = renderAvatar;
const PORT = process.env.PORT || 3000;
const isProduction = process.env.NODE_ENV === 'production';
const useSecureCookies = isProduction || process.env.COOKIE_SECURE === 'true';
const requiredSecrets = ['SESSION_SECRET', 'MUAJ_PASSWORD', 'HAJERA_PASSWORD'];

if (isProduction) {
    for (const key of requiredSecrets) {
        if (!process.env[key]) {
            throw new Error(`${key} must be set in production`);
        }
    }
}

const { backfillMissingThumbnails } = require('./utils/thumbnail');
const { backfillFaststart } = require('./utils/faststart');
const r2 = require('./utils/r2');

// Ensure uploads directories exist
const uploadsDir = path.join(__dirname, 'uploads', 'videos');
const thumbnailsDir = path.join(__dirname, 'uploads', 'thumbnails');
const avatarsDir = path.join(__dirname, 'uploads', 'avatars');
const voiceDir = path.join(__dirname, 'uploads', 'voice');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
}
if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
}
if (!fs.existsSync(voiceDir)) {
    fs.mkdirSync(voiceDir, { recursive: true });
}

// View engine
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.set('view cache', isProduction);
app.disable('x-powered-by');
app.set('trust proxy', 1);

// Middleware

// Gzip compression — reduces CSS/JS/HTML by ~70% on the wire
app.use(compression({
    level: 6,
    threshold: 1024,
    filter: (req, res) => {
        // SSE progress events are tiny streaming writes; gzip can buffer them until the job ends.
        if (req.path.startsWith('/import-progress/')) return false;
        if (req.path.startsWith('/api/r2-progress/')) return false;
        // Watch Together SSE stream — don't buffer
        if (req.path.startsWith('/watch-together/stream/')) return false;
        // Direct Messages SSE stream — don't buffer
        if (req.path.startsWith('/messages/stream')) return false;
        // Don't compress video streams — they're already binary and chunked
        if (req.path.startsWith('/stream/')) return false;
        return compression.filter(req, res);
    }
}));

app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (isProduction) {
        res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    const cfWorkerHost = process.env.CF_WORKER_URL ? new URL(process.env.CF_WORKER_URL).host : '';
    const mediaSrc = cfWorkerHost
        ? `media-src 'self' blob: https://${cfWorkerHost} https://*.r2.dev`
        : "media-src 'self' blob: https://*.r2.dev";
    const imgSrc = cfWorkerHost
        ? `img-src 'self' data: blob: https://${cfWorkerHost} https://*.r2.dev https://cdn.jsdelivr.net https://unpkg.com`
        : "img-src 'self' data: blob: https://*.r2.dev https://cdn.jsdelivr.net https://unpkg.com";
    res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://unpkg.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; style-src-attr 'unsafe-inline'; font-src 'self' https://fonts.gstatic.com data:; ${mediaSrc}; ${imgSrc}; connect-src 'self' wss: https: blob: data:; object-src 'none'; base-uri 'self'; form-action 'self'`
    );

    // 103 Early Hints Link header for HTML navigation requests
    if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api/') && !req.path.startsWith('/stream/')) {
        const earlyHints = [
            '</css/style.css?v=13.9>; rel=preload; as=style',
            '</css/minimal.css?v=13.9>; rel=preload; as=style',
            '</js/theme-init.js?v=13.9>; rel=preload; as=script',
            '</js/twemoji.min.js?v=13.9>; rel=preload; as=script',
            '</js/whatsapp-emojis.js?v=13.9>; rel=preload; as=script',
            '</js/app.js?v=13.9>; rel=preload; as=script',
            '<https://fonts.googleapis.com>; rel=preconnect',
            '<https://fonts.gstatic.com>; rel=preconnect; crossorigin',
            '<https://cdn.jsdelivr.net>; rel=preconnect'
        ];
        if (req.path.startsWith('/messages') || req.path.startsWith('/call')) {
            earlyHints.push(
                '</css/messages.css?v=13.9>; rel=preload; as=style',
                '</css/calling.css?v=13.9>; rel=preload; as=style',
                '</js/messages.js?v=13.9>; rel=preload; as=script',
                '</js/calling.js?v=13.9>; rel=preload; as=script'
            );
        }
        res.setHeader('Link', earlyHints.join(', '));
    }

    next();
});
app.use(express.urlencoded({ extended: false, limit: '64kb' }));
app.use(express.json({ limit: '2mb' }));
app.use(express.text({ limit: '2mb', type: 'text/plain' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    immutable: false,
    maxAge: isProduction ? '7d' : 0,
    setHeaders: (res) => {
        if (isProduction) {
            res.setHeader('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
        }
    }
}));
// Health check — before session middleware to avoid creating sessions
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// --- Lightweight session validation for high-frequency media routes ---
// Video streaming, thumbnails, avatars, and voice notes send many concurrent requests per page load.
// Each request through full express-session middleware triggers:
//   store.get() → JSON.parse() → store.touch() → JSON.stringify() → DB write
// This fast-path validates the session cookie directly via an in-memory cached single DB read,
// skipping session deserialization, touch, and write-back.
const cookie = require('cookie');
const signature = require('cookie-signature');
const sessionSecret = process.env.SESSION_SECRET || (() => {
    const ephemeral = require('crypto').randomBytes(32).toString('hex');
    console.warn('[security] SESSION_SECRET not set — using ephemeral random secret (sessions will not persist across restarts)');
    return ephemeral;
})();
const streamSessionStmt = db.prepare('SELECT sess, expires_at FROM sessions WHERE sid = ?');

// In-memory cache for media auth bursts (10s TTL) to prevent 30-50 simultaneous DB queries on page load
const mediaAuthCache = new Map();
const MEDIA_AUTH_CACHE_TTL_MS = 10000;

function fastMediaAuth(req, res, next) {
    try {
        const cookies = cookie.parse(req.headers.cookie || '');
        const raw = cookies['videohost.sid'];
        if (!raw) return res.status(401).end('Unauthorized');

        // express-session prepends 's:' to signed cookies
        const sid = raw.startsWith('s:')
            ? signature.unsign(raw.slice(2), sessionSecret)
            : raw;

        if (!sid || sid === false) return res.status(401).end('Unauthorized');

        const now = Date.now();
        const cached = mediaAuthCache.get(sid);
        if (cached && cached.expiresAt > now) {
            req.session = { user: cached.user };
            return next();
        }

        const row = streamSessionStmt.get(sid);
        if (!row || row.expires_at <= now) {
            mediaAuthCache.delete(sid);
            return res.status(401).end('Unauthorized');
        }

        const sess = JSON.parse(row.sess);
        if (!sess || !sess.user) {
            mediaAuthCache.delete(sid);
            return res.status(401).end('Unauthorized');
        }

        // Cache valid session in memory for 10 seconds to handle bursts
        mediaAuthCache.set(sid, { user: sess.user, expiresAt: Math.min(row.expires_at, now + MEDIA_AUTH_CACHE_TTL_MS) });
        if (mediaAuthCache.size > 200) {
            for (const [k, v] of mediaAuthCache.entries()) {
                if (v.expiresAt <= now) mediaAuthCache.delete(k);
            }
        }

        // Attach minimal session info for downstream handlers
        req.session = { user: sess.user };
        next();
    } catch {
        return res.status(401).end('Unauthorized');
    }
}

// Media MIME types
const mediaMimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.webm': 'audio/webm',
    '.m4a': 'audio/mp4'
};

function serveMediaFile(dir, internalPrefix, cacheControlHeader) {
    return (req, res) => {
        const filename = path.basename(req.params.file);
        const filePath = path.join(dir, filename);

        if (!fs.existsSync(filePath)) {
            return res.status(404).end();
        }

        const ext = path.extname(filename).toLowerCase();
        const contentType = mediaMimeTypes[ext] || 'application/octet-stream';

        if (isProduction) {
            // Production: Nginx serves directly via X-Accel-Redirect (zero-copy kernel sendfile)
            res.setHeader('X-Accel-Redirect', `${internalPrefix}${filename}`);
            res.setHeader('Content-Type', contentType);
            res.setHeader('Cache-Control', cacheControlHeader);
            res.setHeader('X-Content-Type-Options', 'nosniff');
            return res.end();
        }

        // Development fallback: Node.js streams file directly
        res.sendFile(filePath, {
            headers: {
                'Cache-Control': isProduction ? cacheControlHeader : 'no-cache',
                'X-Content-Type-Options': 'nosniff'
            }
        }, (err) => {
            if (err && !res.headersSent) res.status(404).end();
        });
    };
}

// Register stream routes BEFORE the full session middleware
const videoRoutes = require('./routes/videos');
app.head('/stream/:videoKey', fastMediaAuth, (req, res, next) => {
    req.params = { videoKey: req.params.videoKey };
    videoRoutes.handle(req, res, next);
});
app.get('/stream/:videoKey', fastMediaAuth, (req, res, next) => {
    req.params = { videoKey: req.params.videoKey };
    videoRoutes.handle(req, res, next);
});

// Fast media serving routes (Thumbnails, Avatars, Voice) BEFORE full session middleware
// Note: Thumbnails and Avatars are public hashed image assets (cached on Edge & Service Worker)
app.get('/thumbnails/:file', serveMediaFile(thumbnailsDir, '/internal-thumbnails/', 'public, max-age=604800, stale-while-revalidate=86400'));
app.get('/avatars/:file', serveMediaFile(avatarsDir, '/internal-avatars/', 'public, max-age=604800, stale-while-revalidate=86400'));
app.get('/voice/:file', fastMediaAuth, serveMediaFile(voiceDir, '/internal-voice/', 'private, max-age=604800'));

// Session
app.use(session({
    store: new SQLiteSessionStore(),
    secret: sessionSecret,
    name: 'videohost.sid',
    resave: false,
    saveUninitialized: false,
    rolling: false,
    unset: 'destroy',
    cookie: {
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true,
        sameSite: 'lax',
        secure: useSecureCookies
    }
}));
app.use(attachLocals);

// --- Cloudflare CDN: Prevent caching of EJS HTML responses ---
// All pages are session-dependent — caching would leak user data between users.
// Static assets already have their own Cache-Control from express.static / Nginx.
app.use((req, res, next) => {
    const originalRender = res.render;
    res.render = function (...args) {
        res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        return originalRender.apply(this, args);
    };
    next();
});

// --- Diagnostic: Log slow requests (>200ms) ---
// Helps verify the intermittent loading fix is working.
// Safe to keep in production — only fires on genuinely slow routes.
app.use((req, res, next) => {
    const start = Date.now();
    const originalEnd = res.end;
    res.end = function (...args) {
        const duration = Date.now() - start;
        if (duration > 200) {
            console.warn(`[SLOW] ${req.method} ${req.path} — ${duration}ms`);
        }
        return originalEnd.apply(this, args);
    };
    next();
});

// --- Diagnostic: Event loop lag monitor ---
// Detects when synchronous operations block the event loop.
let _lastLagCheck = Date.now();
setInterval(() => {
    const now = Date.now();
    const lag = now - _lastLagCheck - 2000;
    if (lag > 50) {
        console.warn(`[EVENT-LOOP-LAG] ${lag}ms`);
    }
    _lastLagCheck = now;
}, 2000).unref();

app.use((req, res, next) => {
    // File upload routes — CSRF validated inline after multer parses multipart body
    if (req.path === '/upload' && req.method === 'POST') {
        return next();
    }
    if (req.path.startsWith('/api/upload/') && req.method === 'POST') {
        return next();
    }
    if (req.path === '/import-url' && req.method === 'POST') {
        return next();
    }
    if (req.path.startsWith('/thumbnail/') && req.method === 'POST') {
        return next();
    }
    if (req.path === '/profile/avatar' && req.method === 'POST') {
        return next();
    }
    return requireCsrf(req, res, next);
});

// Routes
const authRoutes = require('./routes/auth');
const commentRoutes = require('./routes/comments');
const importRoutes = require('./routes/import');
const adminRoutes = require('./routes/admin');
const profileRoutes = require('./routes/profile');
const watchTogetherRoutes = require('./routes/watchTogether');
const messagesRoutes = require('./routes/messages');
const callRoutes = require('./routes/calls');
const pushRoutes = require('./routes/push');

app.use('/', authRoutes);
app.use('/', videoRoutes);
app.use('/', commentRoutes);
app.use('/', importRoutes);
app.use('/', adminRoutes);
app.use('/', profileRoutes);
app.use('/', watchTogetherRoutes);
app.use('/', messagesRoutes);
app.use('/', callRoutes);
app.use('/', pushRoutes);



// Error handling
app.use((req, res) => {
    res.status(404).render('error', {
        user: req.session ? req.session.user : null,
        message: 'Page not found.'
    });
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).render('error', {
        user: req.session ? req.session.user : null,
        message: 'Server error.'
    });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`VideoHost listening on http://localhost:${PORT}`);
    // Run thumbnail backfill in background for existing videos
    backfillMissingThumbnails();
    // Optimize existing videos for instant playback (moov atom at file start)
    // Runs after a short delay to avoid competing with thumbnail backfill
    setTimeout(() => backfillFaststart(), 5000);
    // Automatically sync any videos in database that are missing from Cloudflare R2
    if (typeof r2.backfillMissingR2Uploads === 'function') {
        setTimeout(() => r2.backfillMissingR2Uploads(), 8000);
    }
    // Clean up any orphaned import temp files from past server restarts
    if (typeof importRoutes.cleanupOrphanedImportFiles === 'function') {
        importRoutes.cleanupOrphanedImportFiles();
    }
    // Periodic cleanup of stale push subscriptions (every 24 hours)
    setInterval(() => {
        try {
            db.cleanupStalePushSubscriptions(30);
        } catch (err) {
            console.error('[push] Cleanup error:', err.message);
        }
    }, 24 * 60 * 60 * 1000).unref();
});

// Increase timeouts for large file uploads on slow connections
// Default is 2 minutes which kills uploads on mobile networks
server.timeout = 10 * 60 * 1000;         // 10 min request timeout
server.keepAliveTimeout = 65 * 1000;      // 65s keep-alive (slightly above typical proxy 60s)
server.headersTimeout = 70 * 1000;        // 70s headers timeout

// Graceful shutdown — close DB cleanly to prevent WAL corruption
function gracefulShutdown(signal) {
    console.log(`\n[${signal}] Shutting down gracefully...`);
    server.close(() => {
        try {
            db.pragma('wal_checkpoint(TRUNCATE)');
            db.close();
            console.log('Database closed cleanly.');
        } catch (err) {
            console.error('Error closing database:', err.message);
        }
        process.exit(0);
    });
    // Force exit after 10 seconds if connections hang
    setTimeout(() => {
        console.error('Forced shutdown after timeout.');
        process.exit(1);
    }, 10000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
