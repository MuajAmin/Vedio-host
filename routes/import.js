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
const r2 = require('../utils/r2');

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

const thumbnailsDir = path.join(__dirname, '..', 'uploads', 'thumbnails');
if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
}

const cookiesDir = path.join(__dirname, '..', 'data');

// Configuration for 1 vCPU / 1 GB RAM VPS
const MAX_QUEUE_SIZE = 20;
const COMPLETED_JOB_TTL_MS = 5 * 60 * 1000;
const DEFAULT_DOWNLOAD_TIMEOUT_MS = parseInt(process.env.IMPORT_TIMEOUT_MS, 10) || (20 * 60 * 1000); // 20 min max
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 min without progress or file growth
const MAX_IMPORT_FILE_SIZE = '2000M'; // 2 GB limit per video to protect VPS disk
const LEGACY_QUALITIES = new Set(['best', '720', '480', '360']);
const VALID_VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.webm', '.mov', '.avi', '.flv', '.m4v', '.ts']);
const NON_VIDEO_EXTENSIONS = new Set(['.jpg', '.jpeg', '.webp', '.png', '.gif', '.vtt', '.srt', '.json', '.part', '.temp', '.ytdl']);

const activeJobs = new Map();
const pendingQueue = [];
let currentJob = null;
let cachedPythonCmd = null;

// Format probe queue (max 1 concurrent format analysis to protect 1 vCPU / 1 GB RAM)
let activeFormatProbeCount = 0;
const MAX_CONCURRENT_FORMAT_PROBES = 1;

/**
 * Normalizes hostnames for comparison.
 */
function normalizeHostname(hostname) {
    return String(hostname || '')
        .trim()
        .toLowerCase()
        .replace(/^\[/, '')
        .replace(/\]$/, '')
        .replace(/\.$/, '');
}

/**
 * Checks if an IP address belongs to a private, loopback, link-local, or cloud metadata network.
 */
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
            first === 0 ||                              // Current network (0.0.0.0/8)
            first === 10 ||                             // Private Class A (10.0.0.0/8)
            first === 127 ||                            // Loopback (127.0.0.0/8)
            (first === 100 && second >= 64 && second <= 127) || // Carrier-grade NAT (100.64.0.0/10)
            (first === 169 && second === 254) ||        // Link-local / Cloud metadata (169.254.0.0/16)
            (first === 172 && second >= 16 && second <= 31) || // Private Class B (172.16.0.0/12)
            (first === 192 && second === 168) ||        // Private Class C (192.168.0.0/16)
            (first === 192 && second === 0 && parts[2] === 0) || // IETF Protocol (192.0.0.0/24)
            (first === 192 && second === 0 && parts[2] === 2) || // TEST-NET-1 (192.0.2.0/24)
            (first === 198 && (second === 18 || second === 19)) || // Benchmark (198.18.0.0/15)
            (first === 198 && second === 51 && parts[2] === 100) || // TEST-NET-2 (198.51.100.0/24)
            (first === 203 && second === 0 && parts[2] === 113) ||  // TEST-NET-3 (203.0.113.0/24)
            first >= 224                                // Multicast & Reserved (224.0.0.0/4, 240.0.0.0/4)
        );
    }

    if (version === 6) {
        return (
            host === '::' ||
            host === '::1' ||
            host.startsWith('fe80:') || // Link-local
            host.startsWith('fc') ||    // Unique local
            host.startsWith('fd') ||    // Unique local
            host.startsWith('ff')       // Multicast
        );
    }

    return false;
}

/**
 * Validates whether a given URL is a safe, public HTTP/HTTPS URL.
 * Protects against SSRF, command injection, and local filesystem probing.
 */
async function isValidImportUrl(value) {
    try {
        const raw = String(value || '').trim();
        if (!raw || raw.length < 8 || raw.length > 2048) return false;
        if (raw.startsWith('-')) return false; // Prevent option injection
        if (/[\x00-\x1f\x7f]/.test(raw)) return false; // Reject control characters

        const url = new URL(raw);
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

        const hostname = normalizeHostname(url.hostname);
        if (!hostname) return false;

        // Block local and internal hostnames
        if (
            hostname === 'localhost' ||
            hostname.endsWith('.localhost') ||
            hostname.endsWith('.local') ||
            hostname.endsWith('.internal') ||
            hostname === 'metadata.google.internal' ||
            hostname === 'instance-data'
        ) {
            return false;
        }

        if (net.isIP(hostname)) {
            return !isPrivateAddress(hostname);
        }

        // Perform DNS lookup to prevent DNS-rebinding SSRF attacks
        const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
        if (!addresses.length) return false;

        return addresses.every(record => !isPrivateAddress(record.address));
    } catch {
        return false;
    }
}

/**
 * Normalizes video source URLs for consistent duplicate detection.
 * Strips tracking parameters, converts short links to canonical URLs.
 */
function normalizeSourceUrl(rawUrl) {
    try {
        const parsed = new URL(String(rawUrl || '').trim());
        let host = parsed.hostname.toLowerCase();
        let pathname = parsed.pathname;

        // Strip common tracking and metadata query parameters
        const trackingParams = [
            'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
            'si', 'feature', 'fbclid', 'igshid', 'gclid', 'ref', 'source', 'campaign'
        ];
        trackingParams.forEach(param => parsed.searchParams.delete(param));

        // YouTube canonicalization
        if (host === 'youtu.be') {
            const videoId = pathname.replace(/^\//, '').split('/')[0];
            if (videoId) {
                return `https://www.youtube.com/watch?v=${videoId}`;
            }
        }

        if (host.includes('youtube.com')) {
            // Shorts: /shorts/VIDEO_ID -> /watch?v=VIDEO_ID
            const shortsMatch = pathname.match(/^\/shorts\/([a-zA-Z0-9_-]+)/);
            if (shortsMatch) {
                return `https://www.youtube.com/watch?v=${shortsMatch[1]}`;
            }

            const v = parsed.searchParams.get('v');
            if (v) {
                return `https://www.youtube.com/watch?v=${v.replace(/\/+$/, '')}`;
            }
        }

        // Strip trailing slashes on pathname
        parsed.pathname = pathname.replace(/\/+$/, '') || '/';
        return parsed.toString().replace(/\/+$/, '');
    } catch {
        return String(rawUrl || '').trim();
    }
}

function sanitizeQuality(value) {
    const quality = String(value || '720').trim();
    return LEGACY_QUALITIES.has(quality) ? quality : '720';
}

function sanitizeFormatId(value) {
    const formatId = String(value || '').trim();
    if (!formatId || formatId === 'best') return '';
    if (formatId.length > 80) return '';
    if (formatId.startsWith('-')) return '';
    // Strict format identifier: alphanumeric, +, _, -, /
    if (!/^[a-zA-Z0-9_+-]+(\+[a-zA-Z0-9_+-]+)*$/.test(formatId)) return '';
    return formatId;
}

function sanitizeTitle(value) {
    return String(value || '')
        .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '') // Strip ANSI terminal codes
        .replace(/[\x00-\x1f\x7f]/g, '')        // Strip ASCII control characters
        .trim()
        .slice(0, 180);
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
        normalizedUrl: job.normalizedUrl,
        status: job.status,
        progress: job.progress,
        speed: job.speed,
        eta: job.eta,
        title: job.title,
        error: job.error,
        isPermanentError: Boolean(job.isPermanentError),
        retryCount: job.retryCount || 0,
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

/**
 * Throttles listener notifications to prevent CPU and socket buffer exhaustion.
 */
function notifyListeners(job, force = false) {
    const now = Date.now();
    if (!force && job._lastNotified && (now - job._lastNotified < 350)) {
        return;
    }
    job._lastNotified = now;
    for (const listener of job.listeners) {
        listener();
    }
}

function notifyQueue() {
    for (const job of pendingQueue) {
        notifyListeners(job, true);
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
    notifyListeners(job, true);
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
    notifyListeners(job, true);
    notifyQueue();

    startDownload(job).catch((err) => {
        job.status = 'error';
        job.error = err.message || 'Download failed.';
        finishCurrentJob(job);
    });
}

/**
 * Robust process termination helper.
 * Sends SIGTERM, followed by forceful SIGKILL (or taskkill on Windows) if process doesn't exit within 3s.
 */
function killProcessTree(proc) {
    if (!proc || !proc.pid) return;

    try {
        if (process.platform === 'win32') {
            proc.kill('SIGTERM');
            const killTimer = setTimeout(() => {
                try {
                    spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], {
                        stdio: 'ignore',
                        windowsHide: true
                    });
                } catch {}
            }, 2500);
            killTimer.unref();
        } else {
            proc.kill('SIGTERM');
            const killTimer = setTimeout(() => {
                try {
                    proc.kill('SIGKILL');
                } catch {}
            }, 2500);
            killTimer.unref();
        }
    } catch {}
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
            const timer = setTimeout(() => {
                if (!settled) {
                    settled = true;
                    killProcessTree(proc);
                    tryNext();
                }
            }, 5000);

            proc.on('close', (code) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
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
                clearTimeout(timer);
                tryNext();
            });
        }

        tryNext();
    });
}

/**
 * Domain clusters for flexible cookie matching (matches variants like xhplus.live -> xhamster).
 */
const DOMAIN_FAMILIES = {
    youtube: ['youtube.com', 'youtu.be', 'm.youtube.com', 'music.youtube.com', 'gaming.youtube.com'],
    pornhub: ['pornhub.com', 'www.pornhub.com', 'm.pornhub.com', 'pornhubpremium.com', 'phncdn.com'],
    xhamster: [
        'xhamster.com', 'm.xhamster.com', 'xhamster2.com', 'xhamster3.com',
        'xhamster.desi', 'xhday.com', 'xhvid.com', 'xhplus.live', 'xh.live',
        'xhamster.one', 'xhamster.link'
    ]
};

function cleanHost(h) {
    return String(h || '').trim().toLowerCase().replace(/^www\./, '').replace(/^m\./, '');
}

function findCookiesFileForUrl(url) {
    try {
        if (!fs.existsSync(cookiesDir)) return null;
        const hostname = new URL(String(url || '')).hostname.toLowerCase();
        const hostClean = cleanHost(hostname);
        const files = fs.readdirSync(cookiesDir).filter(f => f.endsWith('_cookies.txt'));

        // 1. Direct or base match
        for (const file of files) {
            const fileDomain = file.replace('_cookies.txt', '').toLowerCase();
            const fileClean = cleanHost(fileDomain);

            if (
                hostname === fileDomain ||
                hostClean === fileClean ||
                hostname.endsWith('.' + fileDomain) ||
                fileDomain.endsWith('.' + hostname) ||
                hostClean.endsWith('.' + fileClean) ||
                fileClean.endsWith('.' + hostClean)
            ) {
                const fullPath = path.join(cookiesDir, file);
                if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 50) {
                    return fullPath;
                }
            }
        }

        // 2. Family match (e.g. xhplus.live_cookies.txt for xhamster.com or vice-versa)
        for (const [family, domains] of Object.entries(DOMAIN_FAMILIES)) {
            const isUrlInFamily = domains.some(d => hostClean === cleanHost(d) || hostClean.endsWith('.' + cleanHost(d)));
            if (isUrlInFamily) {
                for (const file of files) {
                    const fileDomain = file.replace('_cookies.txt', '').toLowerCase();
                    const fileClean = cleanHost(fileDomain);
                    const isFileInFamily = domains.some(d => fileClean === cleanHost(d) || fileClean.endsWith('.' + cleanHost(d)));
                    if (isFileInFamily) {
                        const fullPath = path.join(cookiesDir, file);
                        if (fs.existsSync(fullPath) && fs.statSync(fullPath).size > 50) {
                            return fullPath;
                        }
                    }
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
        '--socket-timeout', '20',
        '--geo-bypass',
        '--age-limit', '99',
        '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        '--add-header', 'Accept-Language: en-US,en;q=0.9',
        '--add-header', 'Sec-Fetch-Mode: navigate',
        '--extractor-args', 'youtube:player_client=android,web;player_skip=webpage,configs'
    ];

    const matchedCookies = url ? findCookiesFileForUrl(url) : null;
    const fallbackFile = (process.env.YTDLP_COOKIES_FILE || '').trim();
    const cookiesBrowser = (process.env.YTDLP_COOKIES_BROWSER || '').trim().toLowerCase();

    if (matchedCookies) {
        args.push('--cookies', matchedCookies);
        console.log(`[import] Using cookies: ${path.basename(matchedCookies)} for ${url}`);
    } else if (fallbackFile && fs.existsSync(fallbackFile)) {
        args.push('--cookies', fallbackFile);
        console.log(`[import] Using fallback cookies: ${path.basename(fallbackFile)}`);
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
        '--write-thumbnail',
        '--print', 'before_dl:%(title)s',
        '--no-mtime',
        '--no-overwrites',
        // Max file size protection for 1GB RAM / limited VPS disk
        '--max-filesize', MAX_IMPORT_FILE_SIZE,
        // Lightweight fragments and buffer for 1 vCPU / 1 GB RAM
        '--concurrent-fragments', '2',
        '--buffer-size', '2M',
        '--retries', '3',
        '--fragment-retries', '3',
        // Faststart moov atom placement for instant playback
        '--postprocessor-args', 'ffmpeg:-movflags +faststart',
        '--prefer-free-formats'
    ];

    const formatId = sanitizeFormatId(job.formatId);
    if (formatId) {
        args.push('-f', formatId);
    } else {
        const formatSort = job.quality === 'best'
            ? 'res,fps,size,br'
            : `res:${job.quality},fps,size,br`;
        args.push('-f', 'b/bv*+ba/best', '-S', formatSort);
    }

    // Always use '--' before URL to prevent CLI option injection
    args.push('--', job.url);
    return args;
}

async function findAndSaveSourceThumbnail(jobId, videoId) {
    try {
        const files = await fs.promises.readdir(uploadsDir);
        const thumbCandidate = files.find(file => 
            file.startsWith(jobId) && 
            ['.jpg', '.jpeg', '.webp', '.png'].includes(path.extname(file).toLowerCase())
        );

        if (thumbCandidate) {
            const srcPath = path.join(uploadsDir, thumbCandidate);
            const stat = await fs.promises.stat(srcPath);
            // Verify thumbnail is non-empty and reasonably sized (< 10MB)
            if (stat.size > 500 && stat.size < 10 * 1024 * 1024) {
                const ext = path.extname(thumbCandidate).toLowerCase();
                const targetFilename = `${videoId}${ext}`;
                const targetPath = path.join(thumbnailsDir, targetFilename);

                await fs.promises.rename(srcPath, targetPath);
                console.log(`[import] Saved official source thumbnail for video ${videoId} -> ${targetFilename}`);
                return targetFilename;
            } else {
                await fs.promises.unlink(srcPath).catch(() => {});
            }
        }
    } catch (err) {
        console.warn('[import] Could not process source thumbnail:', err.message);
    }
    return null;
}

/**
 * Removes all temporary files created for a job.
 */
async function cleanupJobFiles(jobId) {
    try {
        const files = (await fs.promises.readdir(uploadsDir)).filter(file => file.startsWith(jobId));
        await Promise.all(files.map(file => fs.promises.unlink(path.join(uploadsDir, file)).catch(() => {})));
    } catch {
        // Nothing to clean.
    }
}

/**
 * Removes any leftover intermediate files (unmerged streams, temp chunks) after successful download.
 */
async function cleanupJobExtraFiles(jobId, keepFilename) {
    try {
        const files = (await fs.promises.readdir(uploadsDir)).filter(file => file.startsWith(jobId) && file !== keepFilename);
        await Promise.all(files.map(file => fs.promises.unlink(path.join(uploadsDir, file)).catch(() => {})));
    } catch {}
}

/**
 * Finds completed video file. Strictly ignores .part, .temp, and non-video files.
 */
async function findDownloadedFile(jobId, fallbackPath, fallbackFilename) {
    let candidates = [];
    try {
        const files = (await fs.promises.readdir(uploadsDir)).filter(file => file.startsWith(jobId));
        for (const file of files) {
            const ext = path.extname(file).toLowerCase();
            // Strictly exclude partial, temp, and non-video extensions
            if (NON_VIDEO_EXTENSIONS.has(ext) || file.endsWith('.part') || file.endsWith('.temp') || file.endsWith('.ytdl')) {
                continue;
            }
            if (!VALID_VIDEO_EXTENSIONS.has(ext)) {
                continue;
            }

            const filePath = path.join(uploadsDir, file);
            try {
                const stat = await fs.promises.stat(filePath);
                if (stat.isFile() && stat.size > 0) {
                    candidates.push({ file, filePath, size: stat.size });
                }
            } catch {}
        }
    } catch {}

    candidates.sort((a, b) => b.size - a.size);

    if (candidates.length > 0) {
        return {
            finalFilename: candidates[0].file,
            finalPath: candidates[0].filePath,
            fileSize: candidates[0].size
        };
    }

    try {
        const stat = await fs.promises.stat(fallbackPath);
        const fallbackExt = path.extname(fallbackPath).toLowerCase();
        if (stat.isFile() && stat.size > 0 && !NON_VIDEO_EXTENSIONS.has(fallbackExt)) {
            return {
                finalFilename: fallbackFilename,
                finalPath: fallbackPath,
                fileSize: stat.size
            };
        }
    } catch {}

    return null;
}

function parseProgressLine(job, line) {
    const trimmed = line.trim();
    if (!trimmed) return;

    if (!job.gotTitle && !trimmed.includes('|||') && !trimmed.includes('%')) {
        job.gotTitle = true;
        if (!job.customTitle) {
            job.title = sanitizeTitle(trimmed);
        }
        notifyListeners(job, true);
        return;
    }

    if (!trimmed.includes('|||')) return;

    const parts = trimmed.split('|||');
    const percentStr = (parts[0] || '').replace(/[^0-9.]/g, '');
    const percent = parseFloat(percentStr);

    if (!Number.isNaN(percent)) {
        job.gotStdoutProgress = true;
        const newProgress = Math.min(99, Math.round(percent));
        const progressChanged = Math.abs(newProgress - (job.progress || 0)) >= 1;
        job.progress = newProgress;
        job.speed = (parts[1] || '').trim().replace('Unknown', '');
        job.eta = (parts[2] || '').trim().replace('Unknown', '');
        job.status = 'downloading';
        job.lastProgressAt = Date.now();
        if (progressChanged) {
            notifyListeners(job, false);
        }
    }
}

function classifyErrorMessage(stderrBuffer) {
    const raw = String(stderrBuffer || '').trim();
    const text = raw.toLowerCase();
    let isPermanent = false;
    let message = 'Download failed.';

    // Extract exact yt-dlp error line if available
    const errorMatch = raw.match(/ERROR:\s*(.+?)(?:\r?\n|$)/);
    if (errorMatch && errorMatch[1]) {
        message = errorMatch[1].trim().slice(0, 200);
    }

    if (text.includes('unsupported url') || text.includes('no video formats found')) {
        isPermanent = true;
        message = 'This URL is not supported or contains no downloadable video.';
    } else if (text.includes('http error 410')) {
        isPermanent = true;
        message = 'This video has been permanently removed (HTTP 410 Gone).';
    } else if (text.includes('http error 404') || text.includes('video not found') || text.includes('does not exist')) {
        isPermanent = true;
        message = 'Video not found at this URL.';
    } else if (text.includes('private video') || text.includes('members-only')) {
        isPermanent = true;
        message = 'Video is private or restricted to members.';
    } else if (text.includes('sign in to confirm you’re not a bot') || text.includes('sign in to confirm you\'re not a bot')) {
        isPermanent = false;
        message = 'Site requested bot verification. Cookies may need to be updated.';
    } else if (text.includes('http error 403') || text.includes('http error 401')) {
        isPermanent = false;
        message = message.includes('ERROR:') ? message : 'Access denied (HTTP 403/401). Cookies may be expired or refreshed.';
    } else if (text.includes('file is larger than max-filesize') || text.includes('max-filesize')) {
        isPermanent = true;
        message = `Video exceeds the maximum allowed file size (${MAX_IMPORT_FILE_SIZE}).`;
    } else if (text.includes('network') || text.includes('connection') || text.includes('timed out') || text.includes('timeout')) {
        isPermanent = false;
        message = 'Network timeout or connection reset. You can retry this download.';
    }

    return { message, isPermanent };
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
        job.isPermanentError = false;
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
    job.lastProgressAt = Date.now();
    notifyListeners(job, true);

    return new Promise((resolve) => {
        let settled = false;
        let stderrBuffer = '';
        let stdoutBuffer = '';
        let lastSize = 0;
        let lastSizeChangeAt = Date.now();

        const finish = () => {
            if (settled) return;
            settled = true;
            clearInterval(fileSizeMonitor);
            clearTimeout(globalTimeoutTimer);
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

        // Global download execution timeout (e.g. 20 minutes)
        const globalTimeoutTimer = setTimeout(() => {
            if (settled) return;
            console.warn(`[import] Job ${job.id} timed out after ${DEFAULT_DOWNLOAD_TIMEOUT_MS}ms`);
            job.status = 'error';
            job.error = 'Download timed out after 20 minutes.';
            job.isPermanentError = false;
            killProcessTree(proc);
            cleanupJobFiles(job.id);
            finish();
        }, DEFAULT_DOWNLOAD_TIMEOUT_MS);
        globalTimeoutTimer.unref();

        // Monitor file size and detect stalls/inactivity
        const fileSizeMonitor = setInterval(async () => {
            if (settled || job.canceled) return;
            try {
                const files = (await fs.promises.readdir(uploadsDir)).filter(file => file.startsWith(job.id));
                let totalSize = 0;
                for (const file of files) {
                    try {
                        const stat = await fs.promises.stat(path.join(uploadsDir, file));
                        totalSize += stat.size;
                    } catch {}
                }

                if (totalSize !== lastSize) {
                    lastSize = totalSize;
                    lastSizeChangeAt = Date.now();
                } else if (Date.now() - lastSizeChangeAt > INACTIVITY_TIMEOUT_MS && Date.now() - (job.lastProgressAt || 0) > INACTIVITY_TIMEOUT_MS) {
                    console.warn(`[import] Job ${job.id} stalled for 5 minutes without progress.`);
                    job.status = 'error';
                    job.error = 'Download stalled with no network progress.';
                    job.isPermanentError = false;
                    killProcessTree(proc);
                    await cleanupJobFiles(job.id);
                    return finish();
                }

                if (!job.gotStdoutProgress && totalSize > 0) {
                    const mb = (totalSize / (1024 * 1024)).toFixed(1);
                    job.speed = `${mb} MB downloaded`;
                    job.status = 'downloading';
                    job.progress = Math.min(90, Math.max(5, Math.floor(totalSize / (1024 * 1024))));
                    notifyListeners(job, false);
                }
            } catch {}
        }, 1000);

        proc.stdout.on('data', (data) => {
            stdoutBuffer += data.toString();
            if (stdoutBuffer.length > 32768) {
                stdoutBuffer = stdoutBuffer.slice(-16384);
            }
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
            if (stderrBuffer.length < 10000) {
                stderrBuffer += chunk;
            }
        });

        proc.on('close', async (code) => {
            clearInterval(fileSizeMonitor);
            clearTimeout(globalTimeoutTimer);
            job.proc = null;

            if (job.canceled) {
                await cleanupJobFiles(job.id);
                job.status = 'canceled';
                job.error = 'Import canceled.';
                job.progress = 0;
                notifyListeners(job, true);
                return finish();
            }

            job.progress = 99;
            job.speed = '';
            job.eta = '';
            job.status = 'downloading';
            notifyListeners(job, true);

            let downloaded = null;
            try {
                downloaded = await findDownloadedFile(job.id, outputPath, outputFilename);
                if (downloaded) {
                    console.log('[import] Valid video file found:', downloaded.finalFilename, downloaded.fileSize);
                }
            } catch (findErr) {
                console.log('[import] findDownloadedFile error:', findErr.message);
                downloaded = null;
            }

            const MIN_VALID_SIZE = 100 * 1024; // 100 KB
            if (downloaded && downloaded.fileSize >= MIN_VALID_SIZE) {
                if (code !== 0) {
                    console.warn('[import] yt-dlp exited non-zero but valid video file was retrieved.');
                }

                const videoId = uuidv4();
                const title = sanitizeTitle(job.customTitle || job.title || 'Imported Video');

                let thumbnail = null;
                let duration = null;
                try {
                    const { generateVideoThumbnail, getVideoDuration } = require('../utils/thumbnail');
                    const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('Thumbnail timeout')), 30000));

                    // 1. Try to grab official source thumbnail downloaded by yt-dlp
                    thumbnail = await findAndSaveSourceThumbnail(job.id, videoId);

                    // 2. Fetch duration & fallback to FFmpeg thumbnail only if source thumbnail wasn't found
                    const tasks = [getVideoDuration(downloaded.finalFilename)];
                    if (!thumbnail) {
                        tasks.push(generateVideoThumbnail(downloaded.finalFilename, videoId));
                    }

                    const results = await Promise.race([
                        Promise.all(tasks),
                        timeoutPromise
                    ]);

                    duration = results[0];
                    if (!thumbnail && results[1]) {
                        thumbnail = results[1];
                    }
                } catch (err) {
                    console.warn('[import] Metadata extraction error:', err.message);
                }

                try {
                    const ext = path.extname(downloaded.finalFilename).toLowerCase() || '.mp4';
                    db.prepare(
                        `INSERT INTO videos
                            (id, title, filename, original_name, size, thumbnail, duration, source_url, import_quality, uploaded_by)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                    ).run(
                        videoId,
                        title,
                        downloaded.finalFilename,
                        `${title}${ext}`,
                        downloaded.fileSize,
                        thumbnail,
                        duration,
                        job.normalizedUrl || job.url,
                        job.qualityLabel || job.quality,
                        job.uploadedBy || 'muaj'
                    );

                    // Clean up any other leftover stream chunks for this job
                    await cleanupJobExtraFiles(job.id, downloaded.finalFilename);

                    // Upload to R2 CDN in background
                    if (r2.isR2Enabled()) {
                        const videoPath = path.join(uploadsDir, downloaded.finalFilename);
                        r2.uploadToR2(videoPath, downloaded.finalFilename)
                            .then(() => console.log(`[R2] Import upload done: ${downloaded.finalFilename}`))
                            .catch(err => console.error(`[R2] Import upload failed: ${err.message}`));
                    }

                    job.status = 'done';
                    job.progress = 100;
                    job.videoId = videoId;
                    job.title = title;
                    console.log('[import] SUCCESS - saved as', videoId);
                    notifyListeners(job, true);
                    return finish();
                } catch (dbErr) {
                    console.log('[import] DB error:', dbErr.message);
                    job.status = 'error';
                    job.error = 'Downloaded but failed to save to database.';
                    job.isPermanentError = false;
                    notifyListeners(job, true);
                    return finish();
                }
            }

            await cleanupJobFiles(job.id);
            const { message, isPermanent } = classifyErrorMessage(stderrBuffer);
            job.status = 'error';
            job.error = message;
            job.isPermanentError = isPermanent;
            console.log('[import] FAILED:', job.error, `(permanent: ${isPermanent})`);
            notifyListeners(job, true);
            return finish();
        });

        proc.on('error', (err) => {
            clearInterval(fileSizeMonitor);
            clearTimeout(globalTimeoutTimer);
            job.proc = null;
            job.status = 'error';
            job.error = 'Could not start download process. Ensure yt-dlp and python are installed.';
            job.isPermanentError = false;
            notifyListeners(job, true);
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

// ----------------------------------------------------
// Startup Cleanup for Orphaned Temp Files
// ----------------------------------------------------
async function cleanupOrphanedImportFiles() {
    try {
        if (!fs.existsSync(uploadsDir)) return;
        const files = await fs.promises.readdir(uploadsDir);
        const rows = db.prepare('SELECT filename FROM videos').all();
        const activeDbFilenames = new Set(rows.map(r => r.filename));

        let cleaned = 0;
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(uploadsDir, file);
            try {
                const stat = await fs.promises.stat(filePath);
                const ageMs = now - stat.mtimeMs;
                const ext = path.extname(file).toLowerCase();

                // Delete partial files or unreferenced UUID files older than 15 mins
                if (file.endsWith('.part') || file.endsWith('.temp') || file.endsWith('.ytdl') || NON_VIDEO_EXTENSIONS.has(ext)) {
                    if (ageMs > 5 * 60 * 1000) {
                        await fs.promises.unlink(filePath).catch(() => {});
                        cleaned++;
                    }
                } else if (!activeDbFilenames.has(file) && ageMs > 30 * 60 * 1000) {
                    // Orphaned video file not in DB
                    await fs.promises.unlink(filePath).catch(() => {});
                    cleaned++;
                }
            } catch {}
        }
        if (cleaned > 0) {
            console.log(`[import-cleanup] Reclaimed disk space: cleaned ${cleaned} orphaned temp/download file(s).`);
        }
    } catch (err) {
        console.warn('[import-cleanup] Startup cleanup error:', err.message);
    }
}

// ----------------------------------------------------
// Routes
// ----------------------------------------------------

router.post('/import-url', isAuthenticated, async (req, res) => {
    let csrfOk = false;
    requireCsrf(req, res, () => {
        csrfOk = true;
    });
    if (!csrfOk) return;

    if (activeJobs.size >= MAX_QUEUE_SIZE) {
        return res.status(429).json({ error: 'Import queue is full. Please wait for current jobs to finish.' });
    }

    const urls = parseUrlsFromBody(req.body);
    const customTitle = sanitizeTitle(req.body.title);
    const quality = sanitizeQuality(req.body.quality);
    const formatId = sanitizeFormatId(req.body.formatId);
    const qualityLabel = String(req.body.qualityLabel || quality).trim().slice(0, 80);

    if (urls.length === 0) {
        return res.status(400).json({ error: 'No URL provided.' });
    }

    const jobs = [];
    const alreadyExistingVideos = [];

    for (const url of urls) {
        const valid = await isValidImportUrl(url);
        if (!valid) {
            return res.status(400).json({ error: `Invalid or restricted URL: ${url.slice(0, 100)}` });
        }

        const normalizedUrl = normalizeSourceUrl(url);

        // 1. Check if video already exists in database
        const existingInDb = (typeof db.getVideoBySourceUrl === 'function')
            ? (db.getVideoBySourceUrl(normalizedUrl) || db.getVideoBySourceUrl(url))
            : null;

        if (existingInDb) {
            alreadyExistingVideos.push(existingInDb);
            continue;
        }

        // 2. Check if already active or queued
        const existingJob = (currentJob && (currentJob.normalizedUrl === normalizedUrl || currentJob.url === url))
            ? currentJob
            : pendingQueue.find(j => j.normalizedUrl === normalizedUrl || j.url === url);

        if (existingJob) {
            jobs.push(serializeJob(existingJob));
            continue;
        }

        const job = {
            id: uuidv4(),
            url,
            normalizedUrl,
            customTitle: urls.length === 1 ? customTitle : '',
            quality,
            formatId: urls.length === 1 ? formatId : '',
            qualityLabel: urls.length === 1 ? qualityLabel : quality,
            uploadedBy: req.session.user || 'muaj',
            status: 'queued',
            progress: 0,
            speed: '',
            eta: '',
            title: customTitle || 'Queued import',
            error: null,
            isPermanentError: false,
            retryCount: 0,
            videoId: null,
            listeners: new Set(),
            createdAt: new Date().toISOString(),
            startedAt: null,
            finishedAt: null,
            proc: null,
            canceled: false,
            gotTitle: false,
            gotStdoutProgress: false,
            _lastNotified: 0
        };

        enqueueJob(job);
        jobs.push(serializeJob(job));
    }

    if (alreadyExistingVideos.length > 0 && jobs.length === 0) {
        const video = alreadyExistingVideos[0];
        return res.json({
            alreadyExists: true,
            videoId: video.id,
            title: video.title,
            message: `"${video.title}" is already in your library.`
        });
    }

    res.json({
        jobId: jobs.length > 0 ? jobs[0].id : null,
        jobs,
        alreadyExistingCount: alreadyExistingVideos.length,
        message: jobs.length > 1 ? `${jobs.length} import(s) queued` : (jobs.length === 1 ? 'Import queued' : 'Video already in library')
    });
});

router.post('/import-formats', isAuthenticated, async (req, res) => {
    let csrfOk = false;
    requireCsrf(req, res, () => {
        csrfOk = true;
    });
    if (!csrfOk) return;

    const url = String(req.body.url || '').trim();
    if (!url) {
        return res.status(400).json({ error: 'No URL provided.' });
    }

    const valid = await isValidImportUrl(url);
    if (!valid) {
        return res.status(400).json({ error: 'Invalid or restricted URL. Must be a public http:// or https:// video URL.' });
    }

    // Limit concurrent format analysis to protect 1 vCPU / 1 GB RAM
    if (activeFormatProbeCount >= MAX_CONCURRENT_FORMAT_PROBES) {
        return res.status(429).json({ error: 'Server is currently analyzing another URL. Please wait a few seconds and try again.' });
    }

    activeFormatProbeCount++;
    try {
        const info = await fetchVideoInfo(url);
        res.json({
            title: sanitizeTitle(info.title || ''),
            duration: info.duration || null,
            formats: buildFormatOptions(info)
        });
    } catch (err) {
        res.status(400).json({ error: err.message || 'Could not analyze this URL.' });
    } finally {
        activeFormatProbeCount = Math.max(0, activeFormatProbeCount - 1);
    }
});

router.get('/import-jobs', isAuthenticated, (req, res) => {
    const jobs = Array.from(activeJobs.values())
        .map(serializeJob)
        .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    res.json({ jobs });
});

router.post('/import-cancel/:jobId', isAuthenticated, (req, res) => {
    let csrfOk = false;
    requireCsrf(req, res, () => {
        csrfOk = true;
    });
    if (!csrfOk) return;

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
        notifyListeners(job, true);
        notifyQueue();
        scheduleJobCleanup(job);
        return res.json({ success: true });
    }

    if (job.status === 'starting' || job.status === 'downloading') {
        job.canceled = true;
        if (job.proc) {
            killProcessTree(job.proc);
        }
        job.status = 'canceled';
        job.error = 'Import canceled.';
        notifyListeners(job, true);
        notifyQueue();
        scheduleJobCleanup(job);
        return res.json({ success: true });
    }

    return res.status(400).json({ error: 'This import cannot be canceled now.' });
});

router.post('/import-retry/:jobId', isAuthenticated, async (req, res) => {
    let csrfOk = false;
    requireCsrf(req, res, () => {
        csrfOk = true;
    });
    if (!csrfOk) return;

    const oldJob = activeJobs.get(req.params.jobId);
    if (!oldJob) {
        return res.status(404).json({ error: 'Job not found.' });
    }

    if (oldJob.isPermanentError) {
        return res.status(400).json({ error: `Cannot retry: ${oldJob.error}` });
    }

    const retryCount = (oldJob.retryCount || 0) + 1;
    if (retryCount > 3) {
        return res.status(400).json({ error: 'Maximum retry limit reached (3 attempts).' });
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
        normalizedUrl: oldJob.normalizedUrl || normalizeSourceUrl(oldJob.url),
        customTitle: oldJob.customTitle || '',
        quality: oldJob.quality,
        formatId: oldJob.formatId,
        qualityLabel: oldJob.qualityLabel,
        uploadedBy: oldJob.uploadedBy || req.session.user || 'muaj',
        status: 'queued',
        progress: 0,
        speed: '',
        eta: '',
        title: oldJob.customTitle || oldJob.title || 'Queued import',
        error: null,
        isPermanentError: false,
        retryCount,
        videoId: null,
        listeners: new Set(),
        createdAt: new Date().toISOString(),
        startedAt: null,
        finishedAt: null,
        proc: null,
        canceled: false,
        gotTitle: false,
        gotStdoutProgress: false,
        _lastNotified: 0
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
    keepalive.unref();

    const listener = () => sendSSE(res, job);
    job.listeners.add(listener);
    sendSSE(res, job);

    const cleanup = () => {
        clearInterval(keepalive);
        job.listeners.delete(listener);
        if (job.listeners.size === 0 && ['done', 'error', 'canceled'].includes(job.status)) {
            scheduleJobCleanup(job);
        }
    };

    req.on('close', cleanup);
    res.on('finish', cleanup);
    res.on('error', cleanup);
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
        '--',
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
            killProcessTree(proc);
            reject(new Error('URL analysis timed out.'));
        }, 45000);
        timer.unref();

        proc.stdout.on('data', (chunk) => {
            stdout += chunk.toString();
            if (stdout.length > 5 * 1024 * 1024) {
                clearTimeout(timer);
                killProcessTree(proc);
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

            if (stdout.trim()) {
                try {
                    const info = JSON.parse(stdout);
                    if (info && (info.formats || info.title || info.id)) {
                        if (code !== 0) {
                            console.warn('[import] fetchVideoInfo: yt-dlp exited with code', code, 'but got valid JSON — using it');
                        }
                        return resolve(info);
                    }
                } catch {
                    // JSON parse failed, fall through
                }
            }

            if (code !== 0) {
                const { message } = classifyErrorMessage(stderr);
                return reject(new Error(message));
            }

            return reject(new Error('Could not read format information.'));
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
router.cleanupOrphanedImportFiles = cleanupOrphanedImportFiles;
router.normalizeSourceUrl = normalizeSourceUrl;
router.isValidImportUrl = isValidImportUrl;
router.sanitizeFormatId = sanitizeFormatId;
router.sanitizeTitle = sanitizeTitle;

module.exports = router;
