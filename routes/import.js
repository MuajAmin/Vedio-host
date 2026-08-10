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

// Validate URL
function isValidUrl(str) {
    try {
        const url = new URL(str);
        return url.protocol === 'http:' || url.protocol === 'https:';
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

function startDownload(job, outputPath, outputFilename) {
    // yt-dlp arguments — optimized for low-resource VPS (1 core, 1GB RAM)
    // Prefer single pre-merged format to avoid RAM-heavy ffmpeg merge
    const args = [
        '-m', 'yt_dlp',
        '--no-check-certificates',
        '--no-playlist',
        '--merge-output-format', 'mp4',
        '-f', 'best[ext=mp4]/best[ext=webm]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best',
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

    job.status = 'downloading';
    notifyListeners(job);

    const proc = spawn('python', args, {
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
        stderrBuffer += data.toString();
    });

    proc.on('close', (code) => {
        if (code === 0 && fs.existsSync(outputPath)) {
            // Success — find the actual output file (yt-dlp may add different extension)
            let finalPath = outputPath;
            let finalFilename = outputFilename;

            // Check if yt-dlp created a file with different name pattern
            // Sometimes it merges and keeps the .mp4
            if (!fs.existsSync(outputPath)) {
                // Look for any file starting with the jobId
                const files = fs.readdirSync(uploadsDir).filter(f => f.startsWith(job.id));
                if (files.length > 0) {
                    finalFilename = files[0];
                    finalPath = path.join(uploadsDir, finalFilename);
                }
            }

            let fileSize = 0;
            try {
                const stat = fs.statSync(finalPath);
                fileSize = stat.size;
            } catch (err) {}

            // Save to database
            const videoId = uuidv4();
            const title = job.customTitle || job.title || 'Imported Video';

            try {
                db.prepare(
                    'INSERT INTO videos (id, title, filename, original_name, size) VALUES (?, ?, ?, ?, ?)'
                ).run(videoId, title, finalFilename, title + '.mp4', fileSize);

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
                // Extract the specific error message
                const errorMatch = stderrBuffer.match(/ERROR:\s*(.+?)(?:\n|$)/);
                if (errorMatch) {
                    errorMsg = errorMatch[1].trim().slice(0, 200);
                }
            }

            // Clean up partial file
            try {
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                // Also clean any partial files
                const partials = fs.readdirSync(uploadsDir).filter(f => f.startsWith(job.id));
                for (const f of partials) {
                    fs.unlinkSync(path.join(uploadsDir, f));
                }
            } catch (err) {}

            job.status = 'error';
            job.error = errorMsg;
            notifyListeners(job);
        }

        // Clean up job after 5 minutes
        setTimeout(() => activeJobs.delete(job.id), 300000);
    });

    proc.on('error', (err) => {
        job.status = 'error';
        job.error = 'Could not start yt-dlp. Make sure Python and yt-dlp are installed.';
        notifyListeners(job);
    });
}

module.exports = router;
