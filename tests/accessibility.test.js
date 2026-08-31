const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const VIEWS_DIR = path.join(ROOT, 'views');

describe('Accessibility ARIA attribute consistency', () => {
    test('themeSwitcherNavBtn buttons have non-empty aria-label attributes', () => {
        const viewFiles = ['dashboard.ejs', 'watch.ejs', 'upload.ejs', 'admin.ejs'];
        for (const file of viewFiles) {
            const content = fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');
            const match = content.match(/id="themeSwitcherNavBtn"[^>]*aria-label="([^"]+)"/);
            expect(match).not.toBeNull();
            expect(match[1].trim().length).toBeGreaterThan(0);
        }
    });

    test('themeSwitcherBtn on login page has non-empty aria-label attribute', () => {
        const content = fs.readFileSync(path.join(VIEWS_DIR, 'login.ejs'), 'utf8');
        const match = content.match(/id="themeSwitcherBtn"[^>]*aria-label="([^"]+)"/);
        expect(match).not.toBeNull();
        expect(match[1].trim().length).toBeGreaterThan(0);
    });

    test('profileBadgeBtn elements have non-empty aria-label attributes', () => {
        const viewFiles = ['dashboard.ejs', 'watch.ejs', 'upload.ejs', 'admin.ejs'];
        for (const file of viewFiles) {
            const content = fs.readFileSync(path.join(VIEWS_DIR, file), 'utf8');
            const match = content.match(/id="profileBadgeBtn"[^>]*aria-label="([^"]+)"/);
            expect(match).not.toBeNull();
            expect(match[1].trim().length).toBeGreaterThan(0);
        }
    });
});
