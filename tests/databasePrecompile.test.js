const { describe, test, expect, beforeEach } = require('bun:test');
const db = require('../database');

describe('Precompiled Database Helpers Optimization', () => {
    test('getUserSettings & setUserSetting work correctly with precompiled statements', () => {
        const testUser = 'test_user_settings_' + Date.now();

        // Default settings
        const initial = db.getUserSettings(testUser);
        expect(initial).toEqual({ ui_mode: 'standard', theme: 'cinematic' });

        // Update ui_mode
        const ok1 = db.setUserSetting(testUser, 'ui_mode', 'minimal');
        expect(ok1).toBe(true);

        // Update theme
        const ok2 = db.setUserSetting(testUser, 'theme', 'cyberpunk');
        expect(ok2).toBe(true);

        // Verify updated settings
        const updated = db.getUserSettings(testUser);
        expect(updated).toEqual({ ui_mode: 'minimal', theme: 'cyberpunk' });
    });

    test('getUserAvatar, setUserAvatar, deleteUserAvatar, and getAllUserAvatars work correctly', () => {
        const testUser = 'test_user_avatar_' + Date.now();

        expect(db.getUserAvatar(testUser)).toBeNull();

        db.setUserAvatar(testUser, 'avatar_test.png');
        expect(db.getUserAvatar(testUser)).toBe('avatar_test.png');

        const all = db.getAllUserAvatars();
        expect(all[testUser]).toBe('avatar_test.png');

        db.deleteUserAvatar(testUser);
        expect(db.getUserAvatar(testUser)).toBeNull();
    });

    test('Push subscription helper functions work correctly', () => {
        const testUser = 'test_user_push_' + Date.now();
        const endpoint = 'https://push.example.com/sub/' + Date.now();
        const sub = {
            endpoint,
            keys: {
                p256dh: 'test_p256dh',
                auth: 'test_auth'
            }
        };

        // Save subscription
        const saved = db.savePushSubscription(testUser, sub, 'TestAgent');
        expect(saved).toBe(true);

        // Get subscriptions
        const subs = db.getPushSubscriptions(testUser);
        expect(subs.length).toBe(1);
        expect(subs[0].endpoint).toBe(endpoint);
        expect(subs[0].username).toBe(testUser);

        // Touch subscription
        db.touchPushSubscription(endpoint);

        // Delete single subscription
        const deleted = db.deletePushSubscription(endpoint);
        expect(deleted).toBe(true);
        expect(db.getPushSubscriptions(testUser).length).toBe(0);

        // Save again and delete for user
        db.savePushSubscription(testUser, sub, 'TestAgent');
        const countDeleted = db.deletePushSubscriptionsForUser(testUser);
        expect(countDeleted).toBe(1);
    });

    test('Session helpers countUserSessions and pruneExpiredSessions run without error', () => {
        const count = db.countUserSessions('non_existent_user');
        expect(count).toBe(0);

        expect(() => db.pruneExpiredSessions()).not.toThrow();
    });

    test('Activity log helpers clearOldActivityLogs and pruneActivityLogs execute cleanly', () => {
        const testUser = 'test_user_logs_' + Date.now();

        db.logActivity(testUser, 'test_action', { details: 'test activity' });
        const activities = db.getRecentActivities(testUser, 10);
        expect(activities.length).toBeGreaterThan(0);

        expect(() => db.clearOldActivityLogs(testUser)).not.toThrow();
        expect(() => db.pruneActivityLogs(100)).not.toThrow();
    });
});
