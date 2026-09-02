const { describe, test, expect } = require('bun:test');
const db = require('../database');

describe('Precompiled Database Statements Optimization', () => {
    test('getUserAvatar, setUserAvatar, getAllUserAvatars, and deleteUserAvatar work correctly with precompiled statements', () => {
        const testUser = 'test_prep_user';
        const avatar1 = 'avatar_prep_1.jpg';
        const avatar2 = 'avatar_prep_2.jpg';

        // Set avatar
        db.setUserAvatar(testUser, avatar1);
        expect(db.getUserAvatar(testUser)).toBe(avatar1);

        const allAvatars = db.getAllUserAvatars();
        expect(allAvatars[testUser]).toBe(avatar1);

        // Update avatar
        db.setUserAvatar(testUser, avatar2);
        expect(db.getUserAvatar(testUser)).toBe(avatar2);

        // Delete avatar
        db.deleteUserAvatar(testUser);
        expect(db.getUserAvatar(testUser)).toBeNull();
    });

    test('getUserSettings and setUserSetting work correctly with precompiled statements', () => {
        const testUser = 'test_settings_user';

        // Default settings
        const initialSettings = db.getUserSettings(testUser);
        expect(initialSettings.ui_mode).toBe('standard');
        expect(initialSettings.theme).toBe('cinematic');

        // Update ui_mode
        const modeUpdated = db.setUserSetting(testUser, 'ui_mode', 'minimal');
        expect(modeUpdated).toBe(true);
        expect(db.getUserSettings(testUser).ui_mode).toBe('minimal');

        // Update theme
        const themeUpdated = db.setUserSetting(testUser, 'theme', 'cyberpunk');
        expect(themeUpdated).toBe(true);

        const updatedSettings = db.getUserSettings(testUser);
        expect(updatedSettings.ui_mode).toBe('minimal');
        expect(updatedSettings.theme).toBe('cyberpunk');
    });

    test('getVideoBySourceUrl works correctly with precompiled statements', () => {
        const testId = 'test_prep_video_id';
        const testSourceUrl = 'https://example.com/videos/test_prep_video.mp4';

        db.prepare(`
            INSERT INTO videos (id, title, filename, source_url, uploaded_by)
            VALUES (?, ?, ?, ?, ?)
        `).run(testId, 'Test Prep Video', 'test_prep_video.mp4', testSourceUrl, 'muaj');

        const found = db.getVideoBySourceUrl(testSourceUrl);
        expect(found).not.toBeNull();
        expect(found.id).toBe(testId);
        expect(found.title).toBe('Test Prep Video');

        expect(db.getVideoBySourceUrl('https://example.com/nonexistent.mp4')).toBeNull();

        // Cleanup
        db.prepare('DELETE FROM videos WHERE id = ?').run(testId);
    });

    test('Push subscription helpers work correctly with precompiled statements', () => {
        const testUser = 'test_push_user';
        const sub = {
            endpoint: 'https://push.example.com/sub/test123456',
            keys: { p256dh: 'keys123', auth: 'auth456' }
        };

        const saved = db.savePushSubscription(testUser, sub, 'TestAgent/1.0');
        expect(saved).toBe(true);

        const list = db.getPushSubscriptions(testUser);
        expect(list.length).toBeGreaterThan(0);
        expect(list.some(s => s.endpoint === sub.endpoint)).toBe(true);

        const deleted = db.deletePushSubscription(sub.endpoint);
        expect(deleted).toBe(true);

        const listAfter = db.getPushSubscriptions(testUser);
        expect(listAfter.some(s => s.endpoint === sub.endpoint)).toBe(false);
    });
});
