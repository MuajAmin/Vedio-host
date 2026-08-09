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
    const commentText = String(text || '').trim();

    if (commentText.length === 0) {
        return res.redirect(`/watch/${videoId}`);
    }

    // Verify video exists
    const video = db.prepare('SELECT id FROM videos WHERE id = ?').get(videoId);
    if (!video) {
        return res.status(404).redirect('/dashboard');
    }

    db.prepare(
        'INSERT INTO comments (video_id, user, text) VALUES (?, ?, ?)'
    ).run(videoId, user, commentText.slice(0, MAX_COMMENT_LENGTH));

    res.redirect(`/watch/${videoId}`);
});

// POST /comment/delete/:id — Delete comment (only comment owner or Muaj)
router.post('/comment/delete/:id', isAuthenticated, (req, res) => {
    const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(req.params.id);

    if (comment && (req.session.user === 'muaj' || req.session.user === comment.user)) {
        db.prepare('DELETE FROM comments WHERE id = ?').run(req.params.id);
        return res.redirect(`/watch/${comment.video_id}`);
    }

    res.redirect('/dashboard');
});

module.exports = router;
