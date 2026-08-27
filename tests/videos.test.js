const { describe, test, expect, beforeAll, afterAll } = require('bun:test');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const security = require('../utils/security');

describe('Video Deletion & CSRF Token Validation', () => {
    const testVideoId = 'test-delete-uuid-12345';
    const testFilename = 'test-delete-video.mp4';
    const uploadsDir = path.join(__dirname, '..', 'uploads', 'videos');

    beforeAll(() => {
        // Ensure dummy video file exists on disk
        if (!fs.existsSync(uploadsDir)) {
            fs.mkdirSync(uploadsDir, { recursive: true });
        }
        fs.writeFileSync(path.join(uploadsDir, testFilename), 'dummy video content');

        // Insert video record into DB
        db.prepare('DELETE FROM videos WHERE id = ? OR filename = ?').run(testVideoId, testFilename);
        db.prepare(`
            INSERT INTO videos (id, title, filename, original_name, size, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(testVideoId, 'Test Video To Delete', testFilename, 'test.mp4', 1000, 'muaj');
    });

    afterAll(() => {
        // Clean up
        db.prepare('DELETE FROM videos WHERE id = ? OR filename = ?').run(testVideoId, testFilename);
        const filePath = path.join(uploadsDir, testFilename);
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    });

    test('validateCsrf should return false when CSRF token is missing or invalid', () => {
        const mockReqNoCsrf = {
            method: 'POST',
            session: { csrfToken: 'valid-test-csrf-token' },
            body: {},
            headers: {},
            get: () => null
        };
        expect(security.validateCsrf(mockReqNoCsrf)).toBe(false);

        const mockReqInvalidCsrf = {
            method: 'POST',
            session: { csrfToken: 'valid-test-csrf-token' },
            body: { _csrf: 'wrong-token' },
            headers: {},
            get: () => null
        };
        expect(security.validateCsrf(mockReqInvalidCsrf)).toBe(false);
    });

    test('validateCsrf should return true for valid token in body or header', () => {
        const mockReqBody = {
            method: 'POST',
            session: { csrfToken: 'valid-test-csrf-token' },
            body: { _csrf: 'valid-test-csrf-token' },
            headers: {},
            get: () => null
        };
        expect(security.validateCsrf(mockReqBody)).toBe(true);

        const mockReqHeader = {
            method: 'POST',
            session: { csrfToken: 'valid-test-csrf-token' },
            body: {},
            headers: { 'x-csrf-token': 'valid-test-csrf-token' },
            get: (h) => String(h).toLowerCase() === 'x-csrf-token' ? 'valid-test-csrf-token' : null
        };
        expect(security.validateCsrf(mockReqHeader)).toBe(true);
    });

    test('Database deletion removes video record cleanly', () => {
        // Verify video exists before deletion
        let video = db.prepare('SELECT * FROM videos WHERE id = ?').get(testVideoId);
        expect(video).not.toBeNull();
        expect(video.id).toBe(testVideoId);

        // Perform DB deletion logic
        db.prepare('DELETE FROM videos WHERE id = ?').run(testVideoId);

        // Verify video is removed from DB (better-sqlite3 returns undefined for non-existent row)
        video = db.prepare('SELECT * FROM videos WHERE id = ?').get(testVideoId);
        expect(video == null).toBe(true);
    });

    test('Full video deletion removes local video file, thumbnail, and DB record', async () => {
        const fullDeleteId = 'test-full-delete-id';
        const videoFilename = 'test-full-delete-video.mp4';
        const thumbFilename = 'test-full-delete-thumb.jpg';
        const videoFilePath = path.join(uploadsDir, videoFilename);
        const thumbnailsDir = path.join(__dirname, '..', 'uploads', 'thumbnails');
        const thumbFilePath = path.join(thumbnailsDir, thumbFilename);

        if (!fs.existsSync(thumbnailsDir)) {
            fs.mkdirSync(thumbnailsDir, { recursive: true });
        }

        // Create dummy video file and thumbnail on disk
        fs.writeFileSync(videoFilePath, 'dummy video data');
        fs.writeFileSync(thumbFilePath, 'dummy thumbnail data');

        // Insert video record with thumbnail
        db.prepare('DELETE FROM videos WHERE id = ? OR filename = ?').run(fullDeleteId, videoFilename);
        db.prepare(`
            INSERT INTO videos (id, title, filename, original_name, size, thumbnail, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(fullDeleteId, 'Full Delete Video', videoFilename, 'test.mp4', 1000, thumbFilename, 'muaj');

        // Import videos router to test route handler
        const express = require('express');
        const videosRouter = require('../routes/videos');
        const app = express();
        app.use(express.urlencoded({ extended: true }));
        app.use(express.json());
        // Mock session middleware
        app.use((req, res, next) => {
            req.session = { user: 'muaj', csrfToken: 'test-csrf-token' };
            next();
        });
        app.use('/', videosRouter);

        // Start ephemeral HTTP server
        const server = app.listen(0);
        const port = server.address().port;

        // Send request to delete endpoint
        const res = await fetch(`http://localhost:${port}/delete/${fullDeleteId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'x-csrf-token': 'test-csrf-token',
                'Accept': 'application/json'
            }
        });

        server.close();

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);

        // Verify DB record is deleted
        const dbVideo = db.prepare('SELECT * FROM videos WHERE id = ?').get(fullDeleteId);
        expect(dbVideo == null).toBe(true);

        // Verify local video file is unlinked
        expect(fs.existsSync(videoFilePath)).toBe(false);

        // Verify local thumbnail file is unlinked
        expect(fs.existsSync(thumbFilePath)).toBe(false);
    });

    test('Video deletion succeeds even if local files are already missing', async () => {
        const missingFileId = 'test-missing-file-id';
        const missingFilename = 'nonexistent-video.mp4';

        db.prepare('DELETE FROM videos WHERE id = ? OR filename = ?').run(missingFileId, missingFilename);
        db.prepare(`
            INSERT INTO videos (id, title, filename, original_name, size, uploaded_by)
            VALUES (?, ?, ?, ?, ?, ?)
        `).run(missingFileId, 'Missing File Video', missingFilename, 'test.mp4', 1000, 'muaj');

        const express = require('express');
        const videosRouter = require('../routes/videos');
        const app = express();
        app.use(express.urlencoded({ extended: true }));
        app.use(express.json());
        app.use((req, res, next) => {
            req.session = { user: 'muaj', csrfToken: 'test-csrf-token' };
            next();
        });
        app.use('/', videosRouter);

        // Start ephemeral HTTP server
        const server = app.listen(0);
        const port = server.address().port;

        const res = await fetch(`http://localhost:${port}/delete/${missingFileId}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'x-csrf-token': 'test-csrf-token',
                'Accept': 'application/json'
            }
        });

        server.close();

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data.success).toBe(true);

        // Verify DB record is deleted despite missing local file
        const dbVideo = db.prepare('SELECT * FROM videos WHERE id = ?').get(missingFileId);
        expect(dbVideo == null).toBe(true);
    });
});
