const { describe, test, expect } = require('bun:test');
const db = require('../database');

describe('Precompiled Database Statement Helpers', () => {
    test('getUserAvatar, setUserAvatar, getAllUserAvatars, and deleteUserAvatar work correctly', () => {
        const testUser = 'test_avatar_user_' + Date.now();
        expect(db.getUserAvatar(testUser)).toBeNull();

        db.setUserAvatar(testUser, 'test-avatar.jpg');
        expect(db.getUserAvatar(testUser)).toBe('test-avatar.jpg');

        const allAvatars = db.getAllUserAvatars();
        expect(allAvatars[testUser]).toBe('test-avatar.jpg');

        db.deleteUserAvatar(testUser);
        expect(db.getUserAvatar(testUser)).toBeNull();
    });

    test('getUserSettings and setUserSetting work correctly', () => {
        const testUser = 'test_settings_user_' + Date.now();
        const initial = db.getUserSettings(testUser);
        expect(initial.ui_mode).toBe('standard');
        expect(initial.theme).toBe('cinematic');

        db.setUserSetting(testUser, 'ui_mode', 'minimal');
        db.setUserSetting(testUser, 'theme', 'cyberpunk');

        const updated = db.getUserSettings(testUser);
        expect(updated.ui_mode).toBe('minimal');
        expect(updated.theme).toBe('cyberpunk');
    });

    test('getVideoBySourceUrl returns video by source URL or null', () => {
        expect(db.getVideoBySourceUrl(null)).toBeNull();
        expect(db.getVideoBySourceUrl('https://nonexistent-source-url.test/video')).toBeNull();
    });

    test('call log precompiled helpers work correctly', () => {
        const callId = 'test_call_' + Date.now();
        expect(db.getCallLog(callId)).toBeNull();

        const created = db.createCallLog({
            id: callId,
            caller: 'muaj',
            receiver: 'hajera',
            callType: 'audio'
        });

        expect(created).not.toBeNull();
        expect(created.id).toBe(callId);
        expect(created.caller).toBe('muaj');
        expect(created.receiver).toBe('hajera');

        const updated = db.updateCallLog(callId, {
            status: 'completed',
            durationSeconds: 120
        });

        expect(updated).not.toBeNull();
        expect(updated.status).toBe('completed');
        expect(updated.durationSeconds).toBe(120);

        const recent = db.getRecentCallLogs('muaj', 'hajera', 10);
        expect(recent.length).toBeGreaterThanOrEqual(1);
        expect(recent.some(c => c.id === callId)).toBeTrue();
    });

    test('push subscription precompiled helpers work correctly', () => {
        const testUser = 'test_push_user_' + Date.now();
        const endpoint = 'https://push.example.com/sub/' + Date.now();

        expect(db.getPushSubscriptions(testUser)).toEqual([]);

        const saved = db.savePushSubscription(testUser, {
            endpoint,
            keys: { p256dh: 'test-p256dh', auth: 'test-auth' }
        }, 'TestBrowser/1.0');

        expect(saved).toBeTrue();

        const subs = db.getPushSubscriptions(testUser);
        expect(subs.length).toBe(1);
        expect(subs[0].endpoint).toBe(endpoint);

        db.touchPushSubscription(endpoint);

        const deleted = db.deletePushSubscription(endpoint);
        expect(deleted).toBeTrue();
        expect(db.getPushSubscriptions(testUser)).toEqual([]);

        db.savePushSubscription(testUser, {
            endpoint,
            keys: { p256dh: 'test-p256dh', auth: 'test-auth' }
        });
        const count = db.deletePushSubscriptionsForUser(testUser);
        expect(count).toBeGreaterThanOrEqual(1);

        db.cleanupStalePushSubscriptions(30);
    });

    test('pruneActivityLogs and clearOldActivityLogs run without errors', () => {
        const testUser = 'test_activity_user_' + Date.now();
        db.logActivity(testUser, 'test_action', { details: 'test activity' });

        const recent = db.getRecentActivities(testUser, 10);
        expect(recent.length).toBeGreaterThanOrEqual(1);

        db.clearOldActivityLogs(testUser);
        db.pruneActivityLogs(1500);
    });
});
