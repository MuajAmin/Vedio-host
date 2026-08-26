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
});
