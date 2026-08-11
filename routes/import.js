const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const os = require('os');
const dns = require('dns').promises;
const net = require('net');
const { v4: uuidv4 } = require('uuid');
const { spawn } = require('child_process');
const { isAuthenticated } = require('../middleware/auth');
const { requireCsrf } = require('../utils/security');
const db = require('../database');

const denoBinPaths = [
    path.join(os.homedir(), '.deno', 'bin'),
    '/usr/local/bin',
    '/usr/bin'
];
const extendedPath = [...denoBinPaths, process.env.PATH || process.env.Path || ''].join(path.delimiter);

const uploadsDir = path.join(__dirname, '..', 'uploads', 'videos');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const MAX_QUEUE_SIZE = 20;
const COMPLETED_JOB_TTL_MS = 5 * 60 * 1000;
const LEGACY_QUALITIES = new Set(['best', '720', '480', '360']);

const activeJobs = new Map();
const pendingQueue = [];
let currentJob = null;
let cachedPythonCmd = null;

function normalizeHostname(hostname) {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .replace(/\.$/, '');
}

function isPrivateAddress(address) {
    const host = normalizeHostname(address);
    const ipv4Match = host.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    const ip = ipv4Match ? ipv4Match[1] : host;
    const version = net.isIP(ip);

    if (version === 4) {
        const parts = ip.split('.').map(Number);
        if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) {
            return true;
        }

        const first = parts[0];
        const second = parts[1];
        return (
            first === 0 ||
            first === 10 ||
            first === 127 ||
            (first === 100 && second >= 64 && second <= 127) ||
            (first === 169 && second === 254) ||
            (first === 172 && second >= 16 && second <= 31) ||
            (first === 192 && second === 168) ||
            (first === 192 && second === 0) ||
            (first === 198 && (second === 18 || second === 19)) ||
            first >= 224
        );
    }

    if (version === 6) {
        return (
            host === '::' ||
            host === '::1' ||
            host.startsWith('fe80:') ||
            host.startsWith('fc') ||
            host.startsWith('fd')
        );
    }

    return false;
}

async function isValidImportUrl(value) {
    try {
        const url = new URL(String(value || '').trim());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

        const hostname = normalizeHostname(url.hostname);
        if (!hostname) return false;

        if (
            hostname === 'localhost' ||
            hostname.endsWith('.localhost') ||
            hostname.endsWith('.local') ||
            hostname.endsWith('.internal')
        ) {
            return false;
        }

        if (net.isIP(hostname)) {
            return !isPrivateAddress(hostname);
        }

        const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        if (!addresses.length) return false;

        return addresses.every(record => !isPrivateAddress(record.address));
    } catch {
        return false;
    }
}

function sanitizeQuality(value) {
    const quality = String(value || '720').trim();
    return LEGACY_QUALITIES.has(quality) ? quality : '720';
}

function sanitizeFormatId(value) {
    const formatId = String(value || '').trim();
    if (!formatId || formatId === 'best') return '';
    if (formatId.length > 180) return '';
    if (/[\r\n\t]/.test(formatId)) return '';
    if (formatId.startsWith('-')) return '';
    if (!/^[A-Za-z0-9._:+,/\[\]<>=!?-]+$/.test(formatId)) return '';
    return formatId;
}

function getQueuePosition(job) {
    if (!job || job.status !== 'queued') return 0;
    const index = pendingQueue.findIndex(item => item.id === job.id);
    return index >= 0 ? index + 1 : 0;
}

function serializeJob(job) {
    return {
        id: job.id,
        url: job.url,
        status: job.status,
        progress: job.progress,
        speed: job.speed,
        eta: job.eta,
        title: job.title,
        error: job.error,
        videoId: job.videoId,
        quality: job.quality,
        qualityLabel: job.qualityLabel,
        queuePosition: getQueuePosition(job),
        createdAt: job.createdAt,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt
    };
}

function sendSSE(res, job) {
    try {
        res.write(`data: ${JSON.stringify(serializeJob(job))}\n\n`);
        if (typeof res.flush === 'function') res.flush();
    } catch {
        // Client disconnected.
    }
}

function notifyListeners(job) {
    for (const listener of job.listeners) {
        listener();
    }
}

function notifyQueue() {
    for (const job of pendingQueue) {
        notifyListeners(job);
    }
}

function scheduleJobCleanup(job) {
    setTimeout(() => {
        if (job.listeners.size === 0 && ['done', 'error', 'canceled'].includes(job.status)) {
            activeJobs.delete(job.id);
        }
    }, COMPLETED_JOB_TTL_MS).unref();
}

function enqueueJob(job) {
    activeJobs.set(job.id, job);
    pendingQueue.push(job);
    notifyQueue();
    processQueue();
}

function finishCurrentJob(job) {
    if (currentJob && currentJob.id === job.id) {
        currentJob = null;
    }
    job.finishedAt = new Date().toISOString();
    notifyListeners(job);
    notifyQueue();
    scheduleJobCleanup(job);
    processQueue();
}

function processQueue() {
    if (currentJob || pendingQueue.length === 0) return;

    const job = pendingQueue.shift();
    if (!job || job.status !== 'queued') {
        processQueue();
        return;
    }

    currentJob = job;
    job.status = 'starting';
    job.queuePosition = 0;
    job.startedAt = new Date().toISOString();
    notifyListeners(job);
    notifyQueue();

    startDownload(job).catch((err) => {
        job.status = 'error';
        job.error = err.message || 'Download failed.';
        finishCurrentJob(job);
    });
}

async function detectPythonCmd() {
    if (cachedPythonCmd) return cachedPythonCmd;

    return new Promise((resolve) => {
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

            const candidate = candidates[idx++];
            const proc = spawn(candidate.cmd, candidate.args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true
            });

            let settled = false;
            proc.on('close', (code) => {
                if (settled) return;
                settled = true;
                if (code === 0) {
                    cachedPythonCmd = { cmd: candidate.cmd, prefix: candidate.prefix };
                    console.log(`[import] Using: ${candidate.cmd} ${candidate.prefix.join(' ')}`);
                    return resolve(cachedPythonCmd);
                }
                return tryNext();
            });

            proc.on('error', () => {
                if (settled) return;
                settled = true;
                tryNext();
            });
        }

        tryNext();
    });
}

const cookiesDir = path.join(__dirname, '..', 'data');

/**
 * Find the best matching cookies file for a given URL.
 * Looks for files like: www.youtube.com_cookies.txt, www.pornhub.com_cookies.txt
 * in the data/ directory and matches against the URL's hostname.
 */
const domainAliases = {
    'youtu.be': 'www.youtube.com',
    'm.youtube.com': 'www.youtube.com',
    'music.youtube.com': 'www.youtube.com',
    'm.pornhub.com': 'www.pornhub.com',
};

function findCookiesFileForUrl(url) {
    try {
        let hostname = new URL(String(url || '')).hostname.toLowerCase();
        hostname = domainAliases[hostname] || hostname;
        if (!fs.existsSync(cookiesDir)) return null;

        const files = fs.readdirSync(cookiesDir).filter(f => f.endsWith('_cookies.txt'));
        for (const file of files) {
            // Extract domain from filename: "www.youtube.com_cookies.txt" → "www.youtube.com"
            const fileDomain = file.replace('_cookies.txt', '').toLowerCase();
            if (hostname === fileDomain || hostname.endsWith('.' + fileDomain) || fileDomain.endsWith('.' + hostname)) {
                const fullPath = path.join(cookiesDir, file);
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 50) {
                    return fullPath;
                }
            }
        }
    } catch {}
    return null;
}

function getYtdlpBaseArgs(url) {
    const args = [
        '--no-check-certificates',
        '--no-playlist',
        '--socket-timeout', '20'
    ];

    // Auto-select cookies file based on URL domain (e.g. youtube → youtube cookies, pornhub → pornhub cookies)
    const matchedCookies = url ? findCookiesFileForUrl(url) : null;
    const fallbackFile = (process.env.YTDLP_COOKIES_FILE || '').trim();
    const cookiesBrowser = (process.env.YTDLP_COOKIES_BROWSER || '').trim().toLowerCase();

    if (matchedCookies) {
        args.push('--cookies', matchedCookies);
    } else if (fallbackFile && fs.existsSync(fallbackFile)) {
        args.push('--cookies', fallbackFile);
    } else if (cookiesBrowser) {
        args.push('--cookies-from-browser', cookiesBrowser);
    }

    return args;
}

function buildDownloadArgs(job, outputPath) {
    const args = [
        ...getYtdlpBaseArgs(job.url),
        '--merge-output-format', 'mp4',
        '--newline',
        '--progress',
        '--progress-template', '%(progress._percent_str)s|||%(progress._speed_str)s|||%(progress._eta_str)s',
        '-o', outputPath,
        '--print', 'before_dl:%(title)s',
        '--no-mtime',
        '--no-overwrites',
        // Speed optimizations
        '--buffer-size', '4M',
        '--concurrent-fragments', '4',
        '--throttled-rate', '100K',
        '--retries', '3',
        '--fragment-retries', '3'
    ];

    const formatId = sanitizeFormatId(job.formatId);
    if (formatId) {
        args.push('-f', formatId);
    } else {
        // bv*+ba/b/best: try separate streams first, fall back to combined, then any best
        // No --format-sort-force so sites with limited formats (xHamster etc.) still work
        const formatSort = job.quality === 'best'
            ? 'res,fps,size,br'
            : `res:${job.quality},fps,size,br`;
        args.push('-f', 'bv*+ba/b/best', '-S', formatSort);
    }

    args.push(job.url);
    return args;
}

async function cleanupJobFiles(jobId) {
    try {
        const files = (await fs.promises.readdir(uploadsDir)).filter(file => file.startsWith(jobId));
        await Promise.all(files.map(file => fs.promises.unlink(path.join(uploadsDir, file)).catch(() => {})));
    } catch {
        // Nothing to clean.
    }
}

async function findDownloadedFile(jobId, fallbackPath, fallbackFilename) {
    let candidates = [];
    try {
        const files = (await fs.promises.readdir(uploadsDir)).filter(file => file.startsWith(jobId));
        for (const file of files) {
            const filePath = path.join(uploadsDir, file);
            try {
                const stat = await fs.promises.stat(filePath);
                if (stat.isFile()) {
                    candidates.push({ file, filePath, size: stat.size, part: file.endsWith('.part') });
                }
            } catch {}
        }
    } catch {}

    candidates = candidates
        .filter(item => item.size > 0)
        .sort((a, b) => Number(a.part) - Number(b.part) || b.size - a.size);

    if (candidates.length > 0) {
        return {
            finalFilename: candidates[0].file,
            finalPath: candidates[0].filePath,
            fileSize: candidates[0].size
        };
    }

    const stat = await fs.promises.stat(fallbackPath);
    return {
        finalFilename: fallbackFilename,
        finalPath: fallbackPath,
        fileSize: stat.size
    };
}

function parseProgressLine(job, line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (!job.gotTitle && !trimmed.includes('|||') && !trimmed.includes('%')) {
        job.gotTitle = true;
        if (!job.customTitle) {
            job.title = trimmed.slice(0, 180);
        }
        notifyListeners(job);
        return;
    }

    if (!trimmed.includes('|||')) return;

    const parts = trimmed.split('|||');
    const percentStr = (parts[0] || '').replace(/[^0-9.]/g, '');
    const percent = parseFloat(percentStr);

    if (!Number.isNaN(percent)) {
        job.gotStdoutProgress = true;
        job.progress = Math.min(99, Math.round(percent));
        job.speed = (parts[1] || '').trim().replace('Unknown', '');
        job.eta = (parts[2] || '').trim().replace('Unknown', '');
        job.status = 'downloading';
        notifyListeners(job);
    }
}

function buildErrorMessage(stderrBuffer) {
    if (stderrBuffer.includes('Unsupported URL')) {
        return 'This URL is not supported. Try a direct video link or a different site.';
    }
    if (stderrBuffer.includes('HTTP Error 403') || stderrBuffer.includes('HTTP Error 401')) {
        return 'Access denied. The site blocked the download.';
    }
    if (stderrBuffer.includes('HTTP Error 410')) {
        return 'This video has been permanently removed (HTTP 410 Gone). It is no longer available on the site.';
    }
    if (stderrBuffer.includes('HTTP Error 404') || stderrBuffer.includes('not found')) {
        return 'Video not found at this URL.';
    }
    if (stderrBuffer.toLowerCase().includes('network') || stderrBuffer.toLowerCase().includes('connection')) {
        return 'Network error. Check your internet connection.';
    }

    const errorMatch = stderrBuffer.match(/ERROR:\s*(.+?)(?:\n|$)/);
    if (errorMatch) {
        return errorMatch[1].trim().slice(0, 200);
    }

    return 'Download failed.';
}

async function startDownload(job) {
    const pythonCmd = await detectPythonCmd();
    if (job.canceled) {
        job.status = 'canceled';
        job.error = 'Import canceled.';
        finishCurrentJob(job);
        return;
    }

    if (!pythonCmd) {
        job.status = 'error';
        job.error = 'yt-dlp not found on server. Run: pip3 install yt-dlp';
        finishCurrentJob(job);
        return;
    }

    const outputFilename = `${job.id}.mp4`;
    const outputPath = path.join(uploadsDir, outputFilename);
    const ytdlpArgs = buildDownloadArgs(job, outputPath);
    const args = [...pythonCmd.prefix, ...ytdlpArgs];

    console.log('[import] Spawning:', pythonCmd.cmd, args.join(' '));

    job.status = 'downloading';
    job.progress = Math.max(job.progress, 1);
    notifyListeners(job);

    return new Promise((resolve) => {
        let settled = false;
        let stderrBuffer = '';
        let stdoutBuffer = '';

        const finish = () => {
            if (settled) return;
            settled = true;
            finishCurrentJob(job);
            resolve();
        };

        const proc = spawn(pythonCmd.cmd, args, {
            cwd: uploadsDir,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PATH: extendedPath, Path: extendedPath }
        });

        job.proc = proc;
        console.log('[import] Process spawned, pid:', proc.pid);

        const fileSizeMonitor = setInterval(async () => {
            if (job.gotStdoutProgress || job.canceled) return;
            try {
                const files = (await fs.promises.readdir(uploadsDir)).filter(file => file.startsWith(job.id));
                let totalSize = 0;
                for (const file of files) {
                    try {
                        const stat = await fs.promises.stat(path.join(uploadsDir, file));
                        totalSize += stat.size;
                    } catch {}
                }

                if (totalSize > 0) {
                    const mb = (totalSize / (1024 * 1024)).toFixed(1);
                    job.speed = `${mb} MB downloaded`;
                    job.status = 'downloading';
                    job.progress = Math.min(90, Math.max(5, Math.floor(totalSize / (1024 * 1024))));
                    notifyListeners(job);
                }
            } catch {}
        }, 500);

        proc.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            const lines = stdoutBuffer.split(/\r?\n/);
            stdoutBuffer = lines.pop() || '';
            for (const line of lines) {
                parseProgressLine(job, line);
            }
        });

        proc.stdout.on('end', () => {
            if (stdoutBuffer.trim()) {
                parseProgressLine(job, stdoutBuffer);
            }
            stdoutBuffer = '';
        });

        proc.stderr.on('data', (data) => {
            const chunk = data.toString();
            console.log('[import] STDERR:', chunk.trim().slice(0, 200));
            if (stderrBuffer.length < 10000) {
                stderrBuffer += chunk;
            }
        });

        proc.on('close', async (code) => {
            clearInterval(fileSizeMonitor);
            job.proc = null;

            if (job.canceled) {
                await cleanupJobFiles(job.id);
                job.status = 'canceled';
                job.error = 'Import canceled.';
                job.progress = 0;
                notifyListeners(job);
                return finish();
            }

            job.progress = 99;
            job.speed = '';
            job.eta = '';
            job.status = 'downloading';
            notifyListeners(job);

            let downloaded;
            try {
                downloaded = await findDownloadedFile(job.id, outputPath, outputFilename);
                console.log('[import] File found:', downloaded.finalFilename, downloaded.fileSize);
            } catch {
                downloaded = null;
            }

            if (code === 0 && downloaded) {
                const videoId = uuidv4();
                const title = job.customTitle || job.title || 'Imported Video';

                let thumbnail = null;
                let duration = null;
                try {
                    const { generateVideoThumbnail, getVideoDuration } = require('../utils/thumbnail');
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Thumbnail timeout')), 30000));
                    [thumbnail, duration] = await Promise.race([
                        Promise.all([
                            generateVideoThumbnail(downloaded.finalFilename, videoId),
                            getVideoDuration(downloaded.finalFilename)
                        ]),
                        timeoutPromise
                    ]);
                } catch (err) {
                    console.warn('[import] Metadata extraction error:', err.message);
                }

                try {
                    const ext = path.extname(downloaded.finalFilename).toLowerCase() || '.mp4';
                    db.prepare(
                        `INSERT INTO videos
                            (id, title, filename, original_name, size, thumbnail, duration, source_url, import_quality)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(
                        videoId,
                        title,
                        downloaded.finalFilename,
                        `${title}${ext}`,
                        downloaded.fileSize,
                        thumbnail,
                        duration,
                        job.url,
                        job.qualityLabel || job.quality
                    );

                    job.status = 'done';
                    job.progress = 100;
                    job.videoId = videoId;
                    job.title = title;
                    console.log('[import] SUCCESS - saved as', videoId);
                    notifyListeners(job);
                    return finish();
                } catch (dbErr) {
                    console.log('[import] DB error:', dbErr.message);
                    job.status = 'error';
                    job.error = 'Downloaded but failed to save to library.';
                    notifyListeners(job);
                    return finish();
                }
            }

            await cleanupJobFiles(job.id);
            job.status = 'error';
            job.error = buildErrorMessage(stderrBuffer);
            console.log('[import] FAILED:', job.error);
            notifyListeners(job);
            return finish();
        });

        proc.on('error', () => {
            clearInterval(fileSizeMonitor);
            job.proc = null;
            job.status = 'error';
            job.error = 'Could not start download process. Install: sudo apt install python3-pip && pip3 install yt-dlp';
            notifyListeners(job);
            finish();
        });
    });
}

function parseUrlsFromBody(body) {
    const rawUrls = Array.isArray(body.urls)
        ? body.urls
        : String(body.url || '')
            .split(/\r?\n/)
            .map(item => item.trim())
            .filter(Boolean);

    return [...new Set(rawUrls.map(url => String(url || '').trim()).filter(Boolean))].slice(0, 10);
}

router.post('/import-url', isAuthenticated, async (req, res) => {
    let csrfOk = false;
    requireCsrf(req, res, () => {
        csrfOk = true;
    });
    if (!csrfOk) return;

    if (activeJobs.size >= MAX_QUEUE_SIZE) {
        return res.status(429).json({ error: 'Import queue is full. Wait for a few jobs to finish.' });
    }

    const urls = parseUrlsFromBody(req.body);
    const customTitle = String(req.body.title || '').trim().slice(0, 180);
    const quality = sanitizeQuality(req.body.quality);
    const formatId = sanitizeFormatId(req.body.formatId);
    const qualityLabel = String(req.body.qualityLabel || quality).trim().slice(0, 80);

    if (urls.length === 0) {
        return res.status(400).json({ error: 'No URL provided.' });
    }

    const jobs = [];
    for (const url of urls) {
        const valid = await isValidImportUrl(url);
        if (!valid) {
            return res.status(400).json({ error: `Invalid URL: ${url}` });
        }

        const job = {
            id: uuidv4(),
            url,
            customTitle: urls.length === 1 ? customTitle : '',
            quality,
            formatId: urls.length === 1 ? formatId : '',
            qualityLabel: urls.length === 1 ? qualityLabel : quality,
            status: 'queued',
            progress: 0,
            speed: '',
            eta: '',
            title: customTitle || 'Queued import',
            error: null,
            videoId: null,
            listeners: new Set(),
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            proc: null,
            canceled: false,
            gotTitle: false,
            gotStdoutProgress: false
        };

        enqueueJob(job);
        jobs.push(serializeJob(job));
    }

    res.json({
        jobId: jobs[0].id,
        jobs,
        message: jobs.length > 1 ? `${jobs.length} imports queued` : 'Import queued'
    });
});

router.post('/import-formats', isAuthenticated, async (req, res) => {
    const url = String(req.body.url || '').trim();
    if (!url) {
        return res.status(400).json({ error: 'No URL provided.' });
    }

    const valid = await isValidImportUrl(url);
    if (!valid) {
        return res.status(400).json({ error: 'Invalid URL. Must be a public http:// or https:// video URL.' });
    }

    try {
        const info = await fetchVideoInfo(url);
        res.json({
            title: info.title || '',
            duration: info.duration || null,
            formats: buildFormatOptions(info)
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Could not analyze this URL.' });
    }
});

router.get('/import-jobs', isAuthenticated, (req, res) => {
    const jobs = Array.from(activeJobs.values())
        .map(serializeJob)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    res.json({ jobs });
});

router.post('/import-cancel/:jobId', isAuthenticated, (req, res) => {
    const job = activeJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    if (job.status === 'queued') {
        const index = pendingQueue.findIndex(item => item.id === job.id);
        if (index >= 0) pendingQueue.splice(index, 1);
        job.canceled = true;
        job.status = 'canceled';
        job.error = 'Import canceled.';
        notifyListeners(job);
        notifyQueue();
        scheduleJobCleanup(job);
        return res.json({ success: true });
    }

    if ((job.status === 'starting' || job.status === 'downloading') && job.proc) {
        job.canceled = true;
        job.proc.kill('SIGTERM');
        return res.json({ success: true });
    }

    return res.status(400).json({ error: 'This import cannot be canceled now.' });
});

router.post('/import-retry/:jobId', isAuthenticated, async (req, res) => {
    const oldJob = activeJobs.get(req.params.jobId);
    if (!oldJob) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    if (activeJobs.size >= MAX_QUEUE_SIZE) {
        return res.status(429).json({ error: 'Import queue is full. Wait for a few jobs to finish.' });
    }

    const valid = await isValidImportUrl(oldJob.url);
    if (!valid) {
        return res.status(400).json({ error: 'Original URL is no longer valid.' });
    }

    const job = {
        id: uuidv4(),
        url: oldJob.url,
        customTitle: oldJob.customTitle || '',
        quality: oldJob.quality,
        formatId: oldJob.formatId,
        qualityLabel: oldJob.qualityLabel,
        status: 'queued',
        progress: 0,
        speed: '',
        eta: '',
        title: oldJob.customTitle || oldJob.title || 'Queued import',
        error: null,
        videoId: null,
        listeners: new Set(),
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        proc: null,
        canceled: false,
        gotTitle: false,
        gotStdoutProgress: false
    };

    enqueueJob(job);
    res.json({ jobId: job.id, job: serializeJob(job) });
});

router.get('/import-progress/:jobId', isAuthenticated, (req, res) => {
    const job = activeJobs.get(req.params.jobId);
    if (!job) {
        return res.status(404).json({ error: 'Job not found' });
    }

    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });

    const keepalive = setInterval(() => {
        try {
            res.write(': keepalive\n\n');
            if (typeof res.flush === 'function') res.flush();
        } catch {
            clearInterval(keepalive);
        }
    }, 15000);

    const listener = () => sendSSE(res, job);
    job.listeners.add(listener);
    sendSSE(res, job);

    req.on('close', () => {
        clearInterval(keepalive);
        job.listeners.delete(listener);
        if (job.listeners.size === 0 && ['done', 'error', 'canceled'].includes(job.status)) {
            scheduleJobCleanup(job);
        }
    });
});

async function fetchVideoInfo(url) {
    const pythonCmd = await detectPythonCmd();
    if (!pythonCmd) {
        throw new Error('yt-dlp not found on server. Run: pip3 install yt-dlp');
    }

    const args = [
        ...pythonCmd.prefix,
        ...getYtdlpBaseArgs(url),
        '--dump-single-json',
        '--no-warnings',
        url
    ];

    return new Promise((resolve, reject) => {
        const proc = spawn(pythonCmd.cmd, args, {
            cwd: uploadsDir,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, PATH: extendedPath, Path: extendedPath }
        });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            proc.kill('SIGTERM');
            reject(new Error('URL analysis timed out.'));
        }, 45000);

        proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 5 * 1024 * 1024) {
                clearTimeout(timer);
                proc.kill('SIGTERM');
                reject(new Error('URL analysis response was too large.'));
            }
        });

        proc.stderr.on('data', (chunk) => {
            if (stderr.length < 8000) stderr += chunk.toString();
        });

        proc.on('error', () => {
            clearTimeout(timer);
            reject(new Error('Could not start yt-dlp.'));
        });

        proc.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                return reject(new Error(buildErrorMessage(stderr)));
            }

            try {
                return resolve(JSON.parse(stdout));
            } catch {
                return reject(new Error('Could not read format information.'));
            }
        });
    });
}

function formatBytes(value) {
    const bytes = Number(value || 0);
    if (!Number.isFinite(bytes) || bytes <= 0) return '';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function buildFormatOptions(info) {
    const options = [{
        formatId: '',
        quality: 'best',
        label: 'Best available',
        detail: 'Let yt-dlp choose the highest quality stream'
    }];

    const formats = Array.isArray(info.formats) ? info.formats : [];
    const videoFormats = formats
        .filter(format => format && format.format_id && format.vcodec && format.vcodec !== 'none' && Number(format.height) > 0)
        .sort((a, b) => {
            const heightDiff = Number(b.height || 0) - Number(a.height || 0);
            if (heightDiff) return heightDiff;
            const audioDiff = Number(Boolean(b.acodec && b.acodec !== 'none')) - Number(Boolean(a.acodec && a.acodec !== 'none'));
            if (audioDiff) return audioDiff;
            return Number(b.tbr || 0) - Number(a.tbr || 0);
        });

    const seenHeights = new Set();
    for (const format of videoFormats) {
        const height = Number(format.height || 0);
        if (!height || seenHeights.has(height)) continue;
        seenHeights.add(height);

        const hasAudio = format.acodec && format.acodec !== 'none';
        const formatId = hasAudio
            ? String(format.format_id)
            : `${format.format_id}+bestaudio/best`;
        const fps = Number(format.fps || 0);
        const size = formatBytes(format.filesize || format.filesize_approx);
        const bitrate = Number(format.tbr || 0) > 0 ? `${Math.round(format.tbr)} kbps` : '';
        const parts = [format.ext, fps > 30 ? `${Math.round(fps)}fps` : '', size, bitrate].filter(Boolean);

        options.push({
            formatId,
            quality: String(height),
            label: `${height}p${fps > 30 ? ` ${Math.round(fps)}fps` : ''}`,
            detail: parts.join(' - ')
        });

        if (options.length >= 13) break;
    }

    return options;
}

router.getImportJobs = () => Array.from(activeJobs.values()).map(serializeJob);

module.exports = router;
