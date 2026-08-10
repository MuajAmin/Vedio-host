const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { isAuthenticated } = require('../middleware/auth');
const { requireCsrf } = require('../utils/security');
const db = require('../database');

const uploadsDir = path.join(__dirname, '..', 'uploads', 'videos');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

// Active import jobs (keyed by job ID)
const activeJobs = new Map();

// Validate URL — blocks internal/private IPs to prevent SSRF
function isValidUrl(str) {
    try {
        const url = new URL(str);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

        const hostname = url.hostname.toLowerCase();

        // Block localhost, IPv6 loopback, and private/link-local ranges
        const blockedPatterns = [
            /^localhost$/i,
            /^127\./,
            /^10\./,
            /^192\.168\./,
            /^172\.(1[6-9]|2\d|3[01])\./,
            /^169\.254\./,
            /^0\./,
            /^\[?::1\]?$/,
            /^\[?fe80:/i,
            /^\[?fc00:/i,
            /^\[?fd/i,
            /\.local$/i,
            /\.internal$/i
        ];

        for (const pattern of blockedPatterns) {
            if (pattern.test(hostname)) return false;
        }

        return true;
    } catch {
        return false;
    }
}

// POST /import-url — Start a video import from URL
router.post('/import-url', isAuthenticated, (req, res) => {
    // Manual CSRF check since we skip global CSRF for this route
    let csrfOk = false;
    requireCsrf(req, res, () => { csrfOk = true; });
    if (!csrfOk) return;

    // Only allow 1 concurrent import to save RAM on small VPS
    const activeDownloads = [...activeJobs.values()].filter(j => j.status === 'downloading' || j.status === 'starting');
    if (activeDownloads.length >= 1) {
        return res.status(429).json({ error: 'Another video is already being imported. Please wait for it to finish.' });
    }

    const url = String(req.body.url || '').trim();
    const customTitle = String(req.body.title || '').trim().slice(0, 180);
    const quality = String(req.body.quality || '480').trim();

    if (!url) {
        return res.status(400).json({ error: 'No URL provided.' });
    }

    if (!isValidUrl(url)) {
        return res.status(400).json({ error: 'Invalid URL. Must start with http:// or https://' });
    }

    const jobId = uuidv4();
    const outputFilename = jobId + '.mp4';
    const outputPath = path.join(uploadsDir, outputFilename);

    const job = {
        id: jobId,
        url,
        customTitle,
        quality,
        status: 'starting',
        progress: 0,
        speed: '',
        eta: '',
        title: customTitle || 'Fetching title...',
        error: null,
        videoId: null,
        listeners: new Set()
    };

    activeJobs.set(jobId, job);

    // Start yt-dlp download in background
    startDownload(job, outputPath, outputFilename);

    res.json({ jobId, message: 'Import started' });
});

// GET /import-progress/:jobId — SSE stream for progress
router.get('/import-progress/:jobId', isAuthenticated, (req, res) => {
    const job = activeJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    // Set up SSE
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    // Send current state immediately
    sendSSE(res, job);

    // Register listener for updates
    const listener = () => sendSSE(res, job);
    job.listeners.add(listener);

    // Cleanup on disconnect
    req.on('close', () => {
        job.listeners.delete(listener);
        // If no listeners and job is done, clean up
        if (job.listeners.size === 0 && (job.status === 'done' || job.status === 'error')) {
            setTimeout(() => activeJobs.delete(job.id), 30000);
        }
    });
});

function sendSSE(res, job) {
    try {
        const data = {
            status: job.status,
            progress: job.progress,
            speed: job.speed,
            eta: job.eta,
            title: job.title,
            error: job.error,
            videoId: job.videoId
        };
        res.write(`data: ${JSON.stringify(data)}\n\n`);
    } catch (err) {
        // Client disconnected
    }
}

function notifyListeners(job) {
    for (const listener of job.listeners) {
        listener();
    }
}

// ---- Auto-detect python/yt-dlp command for cross-platform support ----
let cachedPythonCmd = null;

function detectPythonCmd() {
    if (cachedPythonCmd) return Promise.resolve(cachedPythonCmd);

    return new Promise((resolve) => {
        // Try: python3 (Linux), python (Windows), yt-dlp binary directly
        const candidates = [
            { cmd: 'python3', args: ['-m', 'yt_dlp', '--version'], prefix: ['-m', 'yt_dlp'] },
            { cmd: 'python', args: ['-m', 'yt_dlp', '--version'], prefix: ['-m', 'yt_dlp'] },
            { cmd: 'yt-dlp', args: ['--version'], prefix: [] }
        ];

        let idx = 0;
        function tryNext() {
            if (idx >= candidates.length) {
                return resolve(null);
            }
            const c = candidates[idx++];
            const proc = spawn(c.cmd, c.args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            });
            let resolved = false;
            proc.on('close', (code) => {
                if (resolved) return;
                if (code === 0) {
                    resolved = true;
                    cachedPythonCmd = { cmd: c.cmd, prefix: c.prefix };
                    console.log(`[import] Using: ${c.cmd} ${c.prefix.join(' ')}`);
                    resolve(cachedPythonCmd);
                } else {
                    tryNext();
                }
            });
            proc.on('error', () => {
                if (!resolved) tryNext();
            });
        }
        tryNext();
    });
}

async function startDownload(job, outputPath, outputFilename) {
    const pythonCmd = await detectPythonCmd();

    if (!pythonCmd) {
        job.status = 'error';
        job.error = 'yt-dlp not found on server. Run: pip3 install yt-dlp';
        notifyListeners(job);
        return;
    }

    // Build format string based on quality selection
    let formatStr;
    switch (job.quality) {
        case 'best':
            formatStr = 'best[ext=mp4]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best';
            break;
        case '480':
            formatStr = 'best[height<=480][ext=mp4]/best[height<=480]/bestvideo[height<=480][ext=mp4]+bestaudio[ext=m4a]/best[height<=480]';
            break;
        case '360':
            formatStr = 'best[height<=360][ext=mp4]/best[height<=360]/bestvideo[height<=360][ext=mp4]+bestaudio[ext=m4a]/best[height<=360]';
            break;
        case '720':
        default:
            formatStr = 'best[height<=720][ext=mp4]/best[height<=720]/bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720]';
            break;
    }

    // yt-dlp arguments — optimized for low-resource VPS (1 core, 1GB RAM)
    const ytdlpArgs = [
        '--no-check-certificates',
        '--no-playlist',
        '--merge-output-format', 'mp4',
        '-f', formatStr,
        '--newline',
        '--progress',
        '--progress-template', '%(progress._percent_str)s|||%(progress._speed_str)s|||%(progress._eta_str)s',
        '-o', outputPath,
        '--print', 'before_dl:%(title)s',
        '--no-mtime',
        '--buffer-size', '1M',
        '--no-overwrites',
        job.url
    ];

    const args = [...pythonCmd.prefix, ...ytdlpArgs];

    job.status = 'downloading';
    notifyListeners(job);

    const proc = spawn(pythonCmd.cmd, args, {
        cwd: uploadsDir,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    let gotTitle = false;
    let stderrBuffer = '';

    proc.stdout.on('data', (data) => {
        const lines = data.toString().split('\n').filter(l => l.trim());

        for (const line of lines) {
            const trimmed = line.trim();

            // Check if it's a title line (first output from --print)
            if (!gotTitle && trimmed && !trimmed.includes('|||') && !trimmed.includes('%')) {
                gotTitle = true;
                if (!job.customTitle) {
                    job.title = trimmed.slice(0, 180);
                }
                notifyListeners(job);
                continue;
            }

            // Parse progress: "  45.2%|||2.5MiB/s|||00:23"
            if (trimmed.includes('|||')) {
                const parts = trimmed.split('|||');
                const percentStr = (parts[0] || '').replace(/[^0-9.]/g, '');
                const percent = parseFloat(percentStr);

                if (!isNaN(percent)) {
                    job.progress = Math.min(99, Math.round(percent));
                    job.speed = (parts[1] || '').trim().replace('Unknown', '');
                    job.eta = (parts[2] || '').trim().replace('Unknown', '');
                    job.status = 'downloading';
                    notifyListeners(job);
                }
            }
        }
    });

    proc.stderr.on('data', (data) => {
        if (stderrBuffer.length < 10000) {
            stderrBuffer += data.toString();
        }
    });

    proc.on('close', async (code) => {
        // Find the actual output file — yt-dlp may create file with different extension
        let finalPath = outputPath;
        let finalFilename = outputFilename;

        // Look for any file starting with the jobId
        try {
            const files = (await fs.promises.readdir(uploadsDir)).filter(f => f.startsWith(job.id));
            if (files.length > 0) {
                finalFilename = files[0];
                finalPath = path.join(uploadsDir, finalFilename);
            }
        } catch (err) { }

        let fileExists = false;
        let fileSize = 0;
        try {
            const stat = await fs.promises.stat(finalPath);
            fileExists = true;
            fileSize = stat.size;
        } catch (err) { }

        if (code === 0 && fileExists) {
            // Save to database
            const videoId = uuidv4();
            const title = job.customTitle || job.title || 'Imported Video';

            // Generate thumbnail
            let thumbnail = null;
            try {
                const { generateVideoThumbnail } = require('../utils/thumbnail');
                thumbnail = await generateVideoThumbnail(finalFilename, videoId);
            } catch (tErr) {
                console.warn('[import] Thumbnail extraction error:', tErr.message);
            }

            try {
                db.prepare(
                    'INSERT INTO videos (id, title, filename, original_name, size, thumbnail) VALUES (?, ?, ?, ?, ?, ?)'
                ).run(videoId, title, finalFilename, title + '.mp4', fileSize, thumbnail);

                job.status = 'done';
                job.progress = 100;
                job.videoId = videoId;
                job.title = title;
                notifyListeners(job);
            } catch (dbErr) {
                job.status = 'error';
                job.error = 'Downloaded but failed to save to library.';
                notifyListeners(job);
            }
        } else {
            // Failed
            let errorMsg = 'Download failed.';

            if (stderrBuffer.includes('Unsupported URL')) {
                errorMsg = 'This URL is not supported. Try a direct video link or a different site.';
            } else if (stderrBuffer.includes('HTTP Error 403') || stderrBuffer.includes('HTTP Error 401')) {
                errorMsg = 'Access denied. The site blocked the download.';
            } else if (stderrBuffer.includes('HTTP Error 404') || stderrBuffer.includes('not found')) {
                errorMsg = 'Video not found at this URL.';
            } else if (stderrBuffer.includes('network') || stderrBuffer.includes('connection')) {
                errorMsg = 'Network error. Check your internet connection.';
            } else if (stderrBuffer.includes('ERROR:')) {
                const errorMatch = stderrBuffer.match(/ERROR:\s*(.+?)(?:\n|$)/);
                if (errorMatch) {
                    errorMsg = errorMatch[1].trim().slice(0, 200);
                }
            }

            // Clean up partial files
            try {
                const partials = (await fs.promises.readdir(uploadsDir)).filter(f => f.startsWith(job.id));
                for (const f of partials) {
                    await fs.promises.unlink(path.join(uploadsDir, f)).catch(() => {});
                }
            } catch (err) { }

            job.status = 'error';
            job.error = errorMsg;
            notifyListeners(job);
        }

        // Clean up job after 5 minutes
        setTimeout(() => activeJobs.delete(job.id), 300000);
    });

    proc.on('error', (err) => {
        job.status = 'error';
        job.error = 'Could not start download process. Install: sudo apt install python3-pip && pip3 install yt-dlp';
        notifyListeners(job);
    });
}

module.exports = router;
