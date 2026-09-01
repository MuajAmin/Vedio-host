const { expect, test, describe } = require('bun:test');
const db = require('../database');

describe('Precompiled SQLite Statements Verification', () => {
    test('getUserSettings & setUserSetting work correctly', () => {
        const settingsInitial = db.getUserSettings('testuser_perf');
        expect(settingsInitial).toBeDefined();

        db.setUserSetting('testuser_perf', 'theme', 'cyberpunk');
        const settingsUpdated = db.getUserSettings('testuser_perf');
        expect(settingsUpdated.theme).toBe('cyberpunk');
    });

    test('getUserAvatar & setUserAvatar & deleteUserAvatar work correctly', () => {
        db.setUserAvatar('testuser_perf', 'test_avatar.png');
        const avatar = db.getUserAvatar('testuser_perf');
        expect(avatar).toBe('test_avatar.png');

        const allAvatars = db.getAllUserAvatars();
        expect(allAvatars.testuser_perf).toBe('test_avatar.png');

        db.deleteUserAvatar('testuser_perf');
        expect(db.getUserAvatar('testuser_perf')).toBeNull();
    });

    test('getVideoBySourceUrl works correctly', () => {
        expect(db.getVideoBySourceUrl('non_existent_url')).toBeNull();
    });
});
