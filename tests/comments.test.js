const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const db = require('../database');

describe('Precompiled Comment Statements & Route Logic', () => {
    const testVideoId = 'test-comment-video-123';

    beforeAll(() => {
        db.prepare(`
            INSERT INTO videos (id, title, filename, uploaded_by)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO NOTHING
        `).run(testVideoId, 'Test Comment Video', 'test-comment-video.mp4', 'muaj');
    });

    afterAll(() => {
        db.prepare('DELETE FROM comments WHERE video_id = ?').run(testVideoId);
        db.prepare('DELETE FROM videos WHERE id = ?').run(testVideoId);
    });

    test('Inserting comment into database works with precompiled statement', () => {
        const stmtVerifyVideoExists = db.prepare('SELECT id FROM videos WHERE id = ?');
        const stmtInsertComment = db.prepare('INSERT INTO comments (video_id, user, text) VALUES (?, ?, ?)');
        const stmtGetCommentsForVideo = db.prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY created_at DESC');

        const video = stmtVerifyVideoExists.get(testVideoId);
        expect(video).not.toBeNull();
        expect(video.id).toBe(testVideoId);

        const result = stmtInsertComment.run(testVideoId, 'hajera', 'This is a test comment from precompiled statement.');
        expect(result.changes).toBe(1);

        const comments = stmtGetCommentsForVideo.all(testVideoId);
        expect(comments.length).toBeGreaterThanOrEqual(1);
        expect(comments[0].user).toBe('hajera');
        expect(comments[0].text).toBe('This is a test comment from precompiled statement.');
    });

    test('Deleting comment from database works with precompiled statement', () => {
        const stmtGetCommentsForVideo = db.prepare('SELECT * FROM comments WHERE video_id = ? ORDER BY created_at DESC');
        const stmtDeleteComment = db.prepare('DELETE FROM comments WHERE id = ?');

        const commentsBefore = stmtGetCommentsForVideo.all(testVideoId);
        expect(commentsBefore.length).toBeGreaterThan(0);

        const commentToDelete = commentsBefore[0];
        const delResult = stmtDeleteComment.run(commentToDelete.id);
        expect(delResult.changes).toBe(1);

        const commentsAfter = stmtGetCommentsForVideo.all(testVideoId);
        expect(commentsAfter.some(c => c.id === commentToDelete.id)).toBe(false);
    });
});
