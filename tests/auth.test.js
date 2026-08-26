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
