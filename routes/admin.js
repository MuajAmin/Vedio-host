const express = require('express');
const path = require('path');
const fs = require('fs');
const { isMuaj } = require('../middleware/auth');
const db = require('../database');
const importRoutes = require('./import');

const router = express.Router();
const videosDir = path.join(__dirname, '..', 'uploads', 'videos');
const thumbnailsDir = path.join(__dirname, '..', 'uploads', 'thumbnails');

function listFiles(dir) {
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
        .map((name) => {
            const fullPath = path.join(dir, name);
            try {
                const stat = fs.statSync(fullPath);
                return stat.isFile() ? { name, fullPath, size: stat.size } : null;
            } catch {
                return null;
            }
        })
        .filter(Boolean);
}

function sumBytes(files) {
    return files.reduce((total, file) => total + file.size, 0);
}

function getImportJobs() {
    if (typeof importRoutes.getImportJobs !== 'function') return [];
    return importRoutes.getImportJobs();
}

function collectAdminStats() {
    const videos = db.prepare(
        'SELECT id, title, filename, thumbnail, size, duration, uploaded_by, uploaded_at, import_quality FROM videos ORDER BY uploaded_at DESC'
    ).all();
    const commentsCount = db.prepare('SELECT COUNT(*) AS count FROM comments').get().count;
    const progressCount = db.prepare('SELECT COUNT(*) AS count FROM watch_progress').get().count;
    const sessionCount = db.prepare(
        'SELECT COUNT(*) AS count FROM sessions WHERE expires_at > ? AND sess LIKE \'%"user":%\''
    ).get(Date.now()).count;
    const importJobs = getImportJobs().sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));

    const videoFiles = listFiles(videosDir);
    const thumbnailFiles = listFiles(thumbnailsDir);
    const dbVideoFiles = new Set(videos.map(video => video.filename).filter(Boolean));
    const dbThumbnailFiles = new Set(videos.map(video => video.thumbnail).filter(Boolean));
    const activeImportIds = new Set(importJobs
        .filter(job => ['queued', 'starting', 'downloading'].includes(job.status))
        .map(job => job.id));

    const orphanVideos = videoFiles.filter(file => {
        if (dbVideoFiles.has(file.name)) return false;
        return !Array.from(activeImportIds).some(id => file.name.startsWith(id));
    });
    const orphanThumbnails = thumbnailFiles.filter(file => !dbThumbnailFiles.has(file.name));

    return {
        videos,
        commentsCount,
        progressCount,
        sessionCount,
        importJobs,
        videoFiles,
        thumbnailFiles,
        orphanVideos,
        orphanThumbnails,
        storageBytes: sumBytes(videoFiles) + sumBytes(thumbnailFiles),
        videoBytes: sumBytes(videoFiles),
        thumbnailBytes: sumBytes(thumbnailFiles)
    };
}

router.get('/admin', isMuaj, (req, res) => {
    res.render('admin', {
        user: req.session.user,
        stats: collectAdminStats(),
        cleanupResult: null
    });
});

router.post('/admin/cleanup', isMuaj, async (req, res) => {
    const stats = collectAdminStats();
    const targets = [...stats.orphanVideos, ...stats.orphanThumbnails];
    let deleted = 0;
    let bytesFreed = 0;

    for (const file of targets) {
        try {
            await fs.promises.unlink(file.fullPath);
            deleted += 1;
            bytesFreed += file.size;
        } catch {}
    }

    res.render('admin', {
        user: req.session.user,
        stats: collectAdminStats(),
        cleanupResult: { deleted, bytesFreed }
    });
});

module.exports = router;
