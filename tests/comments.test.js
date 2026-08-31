const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const express = require('express');
const db = require('../database');
const commentRoutes = require('../routes/comments');

describe('Comments Route Optimization & Functionality', () => {
    const testVideoId = 'test-comment-video-123';
    const testVideoTitle = 'Test Comment Video Title';

    beforeAll(() => {
        // Ensure test video exists in database
        db.prepare('DELETE FROM videos WHERE id = ?').run(testVideoId);
        db.prepare(`
            INSERT INTO videos (id, title, filename, original_name, size, uploaded_by)
            VALUES (?, ?, 'test-comment-video.mp4', 'test.mp4', 1024, 'muaj')
        `).run(testVideoId, testVideoTitle);
    });

    afterAll(() => {
        // Clean up test comments and video
        db.prepare('DELETE FROM comments WHERE video_id = ?').run(testVideoId);
        db.prepare('DELETE FROM videos WHERE id = ?').run(testVideoId);
    });

    test('POST /comment/:videoId adds comment and logs activity with video title', async () => {
        const app = express();
        app.use(express.urlencoded({ extended: true }));
        app.use(express.json());
        app.use((req, res, next) => {
            req.session = { user: 'hajera' };
            next();
        });
        app.use('/', commentRoutes);

        const server = app.listen(0);
        const port = server.address().port;

        const res = await fetch(`http://localhost:${port}/comment/${testVideoId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify({ text: 'Awesome video!' })
        });

        server.close();

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);
        expect(data.comment.user).toBe('hajera');
        expect(data.comment.text).toBe('Awesome video!');

        // Check comment in database
        const row = db.prepare('SELECT * FROM comments WHERE video_id = ? AND user = ?').get(testVideoId, 'hajera');
        expect(row).not.toBeNull();
        expect(row.text).toBe('Awesome video!');

        // Check activity log recorded with the video title directly from optimized single query
        const activity = db.prepare('SELECT * FROM activity_logs WHERE username = ? AND action = ? ORDER BY created_at DESC LIMIT 1')
            .get('hajera', 'comment_added');
        expect(activity).not.toBeNull();
        expect(activity.video_title).toBe(testVideoTitle);
    });

    test('POST /comment/delete/:id deletes comment', async () => {
        // Insert comment to delete
        const info = db.prepare(
            'INSERT INTO comments (video_id, user, text) VALUES (?, ?, ?)'
        ).run(testVideoId, 'hajera', 'To be deleted');
        const commentId = info.lastInsertRowid;

        const app = express();
        app.use(express.urlencoded({ extended: true }));
        app.use(express.json());
        app.use((req, res, next) => {
            req.session = { user: 'hajera' };
            next();
        });
        app.use('/', commentRoutes);

        const server = app.listen(0);
        const port = server.address().port;

        const res = await fetch(`http://localhost:${port}/comment/delete/${commentId}`, {
            method: 'POST',
            redirect: 'manual'
        });

        server.close();

        expect(res.status).toBe(302); // Redirect back to watch page

        // Verify comment is removed from database
        const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(commentId);
        expect(comment == null).toBe(true);
    });
});
