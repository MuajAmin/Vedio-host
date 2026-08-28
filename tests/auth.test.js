const { describe, test, expect, afterAll } = require('bun:test');
const db = require('../database');

describe('Blocked Users In-Memory Cache Optimization', () => {
    const testUser = 'test_blocked_user_cache_123';

    afterAll(() => {
        // Cleanup test user
        db.unblockUser(testUser);
        db.resetBlockedUsersCache();
    });

    test('isUserBlocked should return false for unblocked user', () => {
        expect(db.isUserBlocked(testUser)).toBe(false);
        expect(db.isUserBlocked(null)).toBe(false);
        expect(db.isUserBlocked('')).toBe(false);
    });

    test('blockUser should block user and update in-memory cache instantly', () => {
        db.blockUser(testUser, 'Test block reason');
        expect(db.isUserBlocked(testUser)).toBe(true);

        // Verify DB record also exists
        const blockedList = db.getBlockedUsers();
        const found = blockedList.some(b => b.username === testUser);
        expect(found).toBe(true);
    });

    test('resetBlockedUsersCache should force lazy reload from DB on next check', () => {
        db.resetBlockedUsersCache();
        expect(db.isUserBlocked(testUser)).toBe(true);
    });

    test('unblockUser should unblock user and update in-memory cache instantly', () => {
        db.unblockUser(testUser);
        expect(db.isUserBlocked(testUser)).toBe(false);

        // Verify DB record was removed
        const blockedList = db.getBlockedUsers();
        const found = blockedList.some(b => b.username === testUser);
        expect(found).toBe(false);
    });
});

describe('Precompiled Database Query Helpers', () => {
    const testUser = 'test_precompiled_query_user';

    afterAll(() => {
        db.deleteUserAvatar(testUser);
    });

    test('getUserSettings and setUserSetting should return correct precompiled query results', () => {
        const defaults = db.getUserSettings(testUser);
        expect(defaults.ui_mode).toBe('standard');
        expect(defaults.theme).toBe('cinematic');

        db.setUserSetting(testUser, 'theme', 'cyberpunk');
        const updatedTheme = db.getUserSettings(testUser);
        expect(updatedTheme.theme).toBe('cyberpunk');

        db.setUserSetting(testUser, 'ui_mode', 'minimal');
        const updatedMode = db.getUserSettings(testUser);
        expect(updatedMode.ui_mode).toBe('minimal');
    });

    test('getUserAvatar, setUserAvatar, getAllUserAvatars, deleteUserAvatar work with precompiled statements', () => {
        expect(db.getUserAvatar(testUser)).toBeNull();

        db.setUserAvatar(testUser, 'test_avatar.jpg');
        expect(db.getUserAvatar(testUser)).toBe('test_avatar.jpg');

        const allAvatars = db.getAllUserAvatars();
        expect(allAvatars[testUser]).toBe('test_avatar.jpg');

        db.deleteUserAvatar(testUser);
        expect(db.getUserAvatar(testUser)).toBeNull();
    });
});
