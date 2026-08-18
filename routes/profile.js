const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { isAuthenticated } = require('../middleware/auth');
const { requireCsrf, invalidateAvatarCache, invalidateSettingsCache } = require('../utils/security');
const db = require('../database');

const avatarsDir = path.join(__dirname, '..', 'uploads', 'avatars');
if (!fs.existsSync(avatarsDir)) {
    fs.mkdirSync(avatarsDir, { recursive: true });
}

const avatarStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, avatarsDir),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname).toLowerCase() || '.jpg';
        cb(null, `${req.session.user}-${Date.now()}${ext}`);
    }
});

const avatarUpload = multer({
    storage: avatarStorage,
    limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
    fileFilter: (req, file, cb) => {
        const allowed = new Set(['.jpg', '.jpeg', '.png', '.webp']);
        const ext = path.extname(file.originalname).toLowerCase();
        if (allowed.has(ext)) return cb(null, true);
        cb(new Error('Only JPG, PNG, or WebP image files are allowed.'));
    }
});

// POST /profile/avatar - Upload profile picture
router.post('/profile/avatar', isAuthenticated, (req, res) => {
    avatarUpload.single('avatar')(req, res, (err) => {
        const returnUrl = req.get('Referrer') || '/dashboard';
        const isJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));

        if (err) {
            if (isJson) return res.status(400).json({ error: err.message });
            return res.redirect(returnUrl);
        }

        let csrfOk = false;
        requireCsrf(req, res, () => { csrfOk = true; });
        if (!csrfOk) {
            if (req.file) fs.promises.unlink(req.file.path).catch(() => {});
            return;
        }

        if (!req.file) {
            if (isJson) return res.status(400).json({ error: 'No image file selected.' });
            return res.redirect(returnUrl);
        }

        // Delete old custom avatar file if present
        const oldAvatar = db.getUserAvatar(req.session.user);
        if (oldAvatar && oldAvatar !== req.file.filename) {
            const oldPath = path.join(avatarsDir, path.basename(oldAvatar));
            if (fs.existsSync(oldPath)) {
                fs.promises.unlink(oldPath).catch(() => {});
            }
        }

        db.setUserAvatar(req.session.user, req.file.filename);
        invalidateAvatarCache(); // flush cache so new avatar shows immediately

        if (isJson) {
            return res.json({
                success: true,
                avatar: req.file.filename,
                url: `/avatars/${req.file.filename}`
            });
        }

        return res.redirect(returnUrl);
    });
});

// POST /profile/avatar/remove - Remove custom photo & revert to default letter avatar
router.post('/profile/avatar/remove', isAuthenticated, (req, res) => {
    let csrfOk = false;
    requireCsrf(req, res, () => { csrfOk = true; });
    if (!csrfOk) return;

    const returnUrl = req.get('Referrer') || '/dashboard';
    const isJson = req.xhr || (req.headers.accept && req.headers.accept.includes('application/json'));

    const oldAvatar = db.getUserAvatar(req.session.user);
    if (oldAvatar) {
        const oldPath = path.join(avatarsDir, path.basename(oldAvatar));
        if (fs.existsSync(oldPath)) {
            fs.promises.unlink(oldPath).catch(() => {});
        }
    }
    db.deleteUserAvatar(req.session.user);
    invalidateAvatarCache(); // flush cache so removal shows immediately

    if (isJson) {
        return res.json({ success: true });
    }
    return res.redirect(returnUrl);
});

// GET /api/settings — Get user preferences
router.get('/api/settings', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const settings = db.getUserSettings(user);
    res.json({ success: true, settings });
});

// POST /api/settings/ui-mode — Save UI Mode preference
router.post('/api/settings/ui-mode', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const mode = (req.body && req.body.ui_mode) ? String(req.body.ui_mode).trim().toLowerCase() : (typeof req.body === 'string' ? req.body.trim().toLowerCase() : '');
    
    if (mode !== 'standard' && mode !== 'minimal') {
        return res.status(400).json({ error: 'Invalid UI mode. Must be "standard" or "minimal".' });
    }

    db.setUserSetting(user, 'ui_mode', mode);
    invalidateSettingsCache(user);

    return res.json({ success: true, ui_mode: mode });
});

// POST /api/settings/theme — Save Palette Theme preference
router.post('/api/settings/theme', isAuthenticated, (req, res) => {
    const user = req.session.user;
    const theme = (req.body && req.body.theme) ? String(req.body.theme).trim().toLowerCase() : (typeof req.body === 'string' ? req.body.trim().toLowerCase() : '');
    const validThemes = new Set(['cinematic', 'cyberpunk', 'emerald', 'sunset']);

    if (!validThemes.has(theme)) {
        return res.status(400).json({ error: 'Invalid theme.' });
    }

    db.setUserSetting(user, 'theme', theme);
    invalidateSettingsCache(user);

    return res.json({ success: true, theme });
});

module.exports = router;
