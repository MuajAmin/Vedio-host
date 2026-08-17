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
const useSecureCookies = process.env.COOKIE_SECURE === 'true';
const requiredSecrets = ['SESSION_SECRET', 'MUAJ_PASSWORD', 'HAJERA_PASSWORD'];

if (isProduction) {
    for (const key of requiredSecrets) {
        if (!process.env[key]) {
            throw new Error(`${key} must be set in production`);
        }
    }
}

const { backfillMissingThumbnails } = require('./utils/thumbnail');

// Ensure uploads directories exist
const uploadsDir = path.join(__dirname, 'uploads', 'videos');
const thumbnailsDir = path.join(__dirname, 'uploads', 'thumbnails');
const voiceDir = path.join(__dirname, 'uploads', 'voice');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
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
    res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self' blob:; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'"
    );
    next();
});
app.use(express.urlencoded({ extended: false, limit: '32kb' }));
app.use(express.json({ limit: '32kb' }));
app.use(express.static(path.join(__dirname, 'public'), {
    etag: true,
    immutable: isProduction,
    maxAge: isProduction ? '7d' : 0
}));
// Health check — before session middleware to avoid creating sessions
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

// Session
app.use(session({
    store: new SQLiteSessionStore(),
    secret: process.env.SESSION_SECRET || 'dev_only_change_me',
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

// Ensure avatars directory exists
const avatarsDir = path.join(__dirname, 'uploads', 'avatars');
if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
}

// Serve thumbnails behind authentication (prevents unauthenticated access to private thumbnails)
app.get('/thumbnails/:file', isAuthenticated, (req, res) => {
    const filename = path.basename(req.params.file); // prevent path traversal
    const filePath = path.join(__dirname, 'uploads', 'thumbnails', filename);
    res.sendFile(filePath, {
        headers: {
            'Cache-Control': isProduction ? 'private, max-age=604800' : 'no-cache'
        }
    }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

// Serve user profile avatars behind authentication
app.get('/avatars/:file', isAuthenticated, (req, res) => {
    const filename = path.basename(req.params.file); // prevent path traversal
    const filePath = path.join(__dirname, 'uploads', 'avatars', filename);
    res.sendFile(filePath, {
        headers: {
            'Cache-Control': isProduction ? 'private, max-age=604800' : 'no-cache'
        }
    }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

// Serve voice audio notes behind authentication
app.get('/voice/:file', isAuthenticated, (req, res) => {
    const filename = path.basename(req.params.file); // prevent path traversal
    const filePath = path.join(__dirname, 'uploads', 'voice', filename);
    res.sendFile(filePath, {
        headers: {
            'Cache-Control': isProduction ? 'private, max-age=604800' : 'no-cache'
        }
    }, (err) => {
        if (err && !res.headersSent) res.status(404).end();
    });
});

app.use((req, res, next) => {
    if (req.path === '/upload' && req.method === 'POST') {
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
    // Watch Together chat/sync — CSRF handled via session auth
    if (req.path.startsWith('/watch-together/') && (req.method === 'POST' || req.method === 'GET')) {
        return next();
    }
    // Real-time presence pings & beacons — handled via session auth
    if (req.path.startsWith('/api/presence/') && (req.method === 'POST' || req.method === 'GET')) {
        return next();
    }
    // Direct Messaging API — handled via session auth
    if (req.path.startsWith('/api/messages') && (req.method === 'POST' || req.method === 'GET')) {
        return next();
    }
    return requireCsrf(req, res, next);
});

// Routes
const authRoutes = require('./routes/auth');
const videoRoutes = require('./routes/videos');
const commentRoutes = require('./routes/comments');
const importRoutes = require('./routes/import');
const adminRoutes = require('./routes/admin');
const profileRoutes = require('./routes/profile');
const watchTogetherRoutes = require('./routes/watchTogether');
const messagesRoutes = require('./routes/messages');

app.use('/', authRoutes);
app.use('/', videoRoutes);
app.use('/', commentRoutes);
app.use('/', importRoutes);
app.use('/', adminRoutes);
app.use('/', profileRoutes);
app.use('/', watchTogetherRoutes);
app.use('/', messagesRoutes);



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
