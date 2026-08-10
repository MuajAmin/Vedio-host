const express = require('express');
const router = express.Router();
const { isAuthenticated } = require('../middleware/auth');
const db = require('../database');

const MAX_COMMENT_LENGTH = 2000;

// POST /comment/:videoId — Add comment
router.post('/comment/:videoId', isAuthenticated, (req, res) => {
    const { text } = req.body;
    const videoId = req.params.videoId;
    const user = req.session.user;
    const isAjax = req.xhr || req.headers.accept?.includes('application/json');

    // Validate text is a string
    if (typeof text !== 'string') {
        if (isAjax) return res.status(400).json({ error: 'Invalid comment.' });
        return res.redirect(`/watch/${videoId}`);
    }

    const commentText = text.trim();

    if (commentText.length === 0) {
        if (isAjax) return res.status(400).json({ error: 'Comment cannot be empty.' });
        return res.redirect(`/watch/${videoId}`);
    }

    // Verify video exists
    const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId);
    if (!video) {
        if (isAjax) return res.status(404).json({ error: 'Video not found.' });
        return res.status(404).redirect('/dashboard');
    }

    const truncated = commentText.slice(0, MAX_COMMENT_LENGTH);

    db.prepare(
        'INSERT INTO comments (video_id, user, text) VALUES (?, ?, ?)'
    ).run(videoId, user, truncated);

    if (isAjax) {
        return res.json({
            success: true,
            comment: {
                user,
                text: truncated,
                created_at: new Date().toISOString()
            }
        });
    }

    res.redirect(`/watch/${videoId}`);
});

// POST /comment/delete/:id — Delete comment (only comment owner or Muaj)
router.post('/comment/delete/:id', isAuthenticated, (req, res) => {
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);

    if (comment && (req.session.user === 'muaj' || req.session.user === comment.user)) {
        db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
        return res.redirect(`/watch/${encodeURIComponent(comment.video_id)}`);
    }

    res.redirect('/dashboard');
});

module.exports = router;
