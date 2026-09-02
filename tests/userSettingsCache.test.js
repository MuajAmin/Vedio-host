const { describe, test, expect, beforeEach } = require('bun:test');
const db = require('../database');

describe('User Settings In-Memory Cache Optimization', () => {
    beforeEach(() => {
        if (typeof db.resetUserSettingsCache === 'function') {
            db.resetUserSettingsCache();
        }
    });

    test('getUserSettings returns default settings for missing users', () => {
        const testUser = 'test_user_defaults_' + Date.now();
        const settings = db.getUserSettings(testUser);
        expect(settings).toEqual({ ui_mode: 'standard', theme: 'cinematic' });

        const hajeraSettings = db.getUserSettings('hajera');
        expect(hajeraSettings.theme).toBe('sunset');
    });

    test('getUserSettings caches results in memory and returns cached instance', () => {
        const testUser = 'test_cache_user_' + Date.now();
        const s1 = db.getUserSettings(testUser);
        const s2 = db.getUserSettings(testUser);

        expect(s1).toBe(s2); // Exact same object reference from Map cache
        expect(s1).toEqual({ ui_mode: 'standard', theme: 'cinematic' });
    });

    test('setUserSetting updates database and synchronously updates in-memory cache', () => {
        const testUser = 'test_set_setting_user_' + Date.now();

        // Populate initial cache
        const initial = db.getUserSettings(testUser);
        expect(initial.theme).toBe('cinematic');
        expect(initial.ui_mode).toBe('standard');

        // Update theme
        const themeSuccess = db.setUserSetting(testUser, 'theme', 'cyberpunk');
        expect(themeSuccess).toBe(true);

        const updatedTheme = db.getUserSettings(testUser);
        expect(updatedTheme.theme).toBe('cyberpunk');
        expect(updatedTheme.ui_mode).toBe('standard');

        // Update ui_mode
        const modeSuccess = db.setUserSetting(testUser, 'ui_mode', 'minimal');
        expect(modeSuccess).toBe(true);

        const updatedMode = db.getUserSettings(testUser);
        expect(updatedMode.theme).toBe('cyberpunk');
        expect(updatedMode.ui_mode).toBe('minimal');

        // Reset cache and verify DB row persistence
        db.resetUserSettingsCache();
        const reloaded = db.getUserSettings(testUser);
        expect(reloaded).toEqual({ ui_mode: 'minimal', theme: 'cyberpunk' });
    });
});
