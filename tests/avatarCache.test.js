const { describe, test, expect, beforeEach } = require('bun:test');
const db = require('../database');
const { getCachedAvatars, invalidateAvatarCache } = require('../utils/security');

describe('Avatar In-Memory Cache Optimization', () => {
    beforeEach(() => {
        invalidateAvatarCache();
    });

    test('getCachedAvatars returns user avatars from cache', () => {
        db.setUserAvatar('testuser_avatar_cache', 'avatar123.jpg');
        invalidateAvatarCache();

        const avatars1 = getCachedAvatars();
        expect(avatars1['testuser_avatar_cache']).toBe('avatar123.jpg');

        // Direct DB update without invalidating cache
        db.prepare(`
            UPDATE user_profiles SET avatar = 'avatar999.jpg' WHERE username = 'testuser_avatar_cache'
        `).run();

        // Should still return cached value 'avatar123.jpg'
        const avatars2 = getCachedAvatars();
        expect(avatars2['testuser_avatar_cache']).toBe('avatar123.jpg');

        // Invalidate cache and check updated value
        invalidateAvatarCache();
        const avatars3 = getCachedAvatars();
        expect(avatars3['testuser_avatar_cache']).toBe('avatar999.jpg');

        // Clean up
        db.deleteUserAvatar('testuser_avatar_cache');
        invalidateAvatarCache();
    });
});
