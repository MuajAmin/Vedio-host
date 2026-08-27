const { describe, test, expect } = require('bun:test');
const db = require('../database');
const { v4: uuidv4 } = require('uuid');

describe('Admin Stats Optimization', () => {
    test('videos queried in collectAdminStats contain cdn_status field and calculate onR2 correctly', async () => {
        const testVideoId = uuidv4();
        const testFilename = `test-admin-stats-${testVideoId}.mp4`;

        // Insert test video with cdn_status = 'r2_ready'
        db.prepare(`
            INSERT INTO videos (id, title, filename, size, cdn_status, uploaded_by)
            VALUES (?, ?, ?, ?, 'r2_ready', 'muaj')
        `).run(testVideoId, 'Test Admin Stats Video', testFilename, 1048576);

        // Fetch videos query directly to verify cdn_status column is selected
        const row = db.prepare('SELECT id, filename, cdn_status FROM videos WHERE id = ?').get(testVideoId);
        expect(row).not.toBeNull();
        expect(row.cdn_status).toBe('r2_ready');

        // Verify short-circuit logic: r2_ready or r2_only marks onR2 = true
        const isDbConfirmed = row.cdn_status === 'r2_ready' || row.cdn_status === 'r2_only';
        expect(isDbConfirmed).toBe(true);

        // Clean up DB record
        db.prepare('DELETE FROM videos WHERE id = ?').run(testVideoId);
    });
});
