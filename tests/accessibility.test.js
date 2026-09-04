let describe, test, expect;
try {
    ({ describe, test, expect } = require('bun:test'));
} catch (e) {
    ({ describe, test, expect } = require('vitest'));
}

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

describe('Accessibility ARIA Labels Guard', () => {
    test('icon-only buttons in view templates have aria-label attributes', () => {
        const layout = fs.readFileSync(path.join(ROOT, 'views', 'layout.ejs'), 'utf8');
        const dashboard = fs.readFileSync(path.join(ROOT, 'views', 'dashboard.ejs'), 'utf8');
        const messages = fs.readFileSync(path.join(ROOT, 'views', 'messages.ejs'), 'utf8');

        // Check key controls in layout.ejs
        expect(layout).toContain('id="msgDrawerCloseBtn" title="Close" aria-label="Close message drawer"');
        expect(layout).toContain('id="profileCloseBtn" aria-label="Close profile picture modal"');
        expect(layout).toContain('aria-label="Expand to Full Page"');

        // Check key controls in dashboard.ejs
        expect(dashboard).toContain('id="themeSwitcherNavBtn" title="Change Theme & Appearance" aria-label="Change Theme & Appearance"');
        expect(dashboard).toContain('id="profileBadgeBtn" role="button" tabindex="0" title="Click to change profile picture" aria-label="User profile and settings"');

        // Check key controls in messages.ejs
        expect(messages).toContain('id="msgHeaderAudioCallBtn" title="Start Audio Call with ${h(partnerName)}" aria-label="Start Audio Call"');
        expect(messages).toContain('id="msgHeaderVideoCallBtn" title="Start Video Call with ${h(partnerName)}" aria-label="Start Video Call"');
    });
});
