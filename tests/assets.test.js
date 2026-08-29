const { describe, test, expect } = require('bun:test');
const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const { ASSET_VERSION, asset, buildEarlyHintsHeader } = require('../utils/assets');

const ROOT = path.join(__dirname, '..');

function extractPreloads(header) {
    return [...header.matchAll(/<(\/(?:css|js)\/[\w.-]+)\?v=([\w.]+)>/g)]
        .map(([, p, v]) => ({ path: p, version: v }));
}

describe('Asset versioning & Early Hints consistency', () => {
    test('asset() appends the shared version', () => {
        expect(asset('/js/app.js')).toBe(`/js/app.js?v=${ASSET_VERSION}`);
    });

    test('every Early Hints preload uses the shared ASSET_VERSION', () => {
        const preloads = extractPreloads(buildEarlyHintsHeader());
        expect(preloads.length).toBeGreaterThan(0);
        for (const p of preloads) {
            expect(p.version).toBe(ASSET_VERSION);
        }
    });

    test('every preloaded asset actually exists on disk (no wasted preload / 404)', () => {
        const preloads = extractPreloads(buildEarlyHintsHeader({ minimalUi: true }));
        for (const p of preloads) {
            const filePath = path.join(ROOT, 'public', p.path);
            expect(fs.existsSync(filePath)).toBe(true);
        }
    });

    test('layout.ejs asset URLs match the preloaded URLs exactly', () => {
        // Regression guard: preload URLs previously drifted from the URLs the
        // page requested (v=13.9 preloaded vs v=14.0 requested), which made the
        // browser download messages.css and messages.js twice.
        const layout = fs.readFileSync(path.join(ROOT, 'views', 'layout.ejs'), 'utf8');
        const rendered = ejs.render(
            layout.split('\n').filter(l => /assetVersion/.test(l)).join('\n'),
            { assetVersion: ASSET_VERSION }
        );

        const requested = [...rendered.matchAll(/["'](\/(?:css|js)\/[\w.-]+)\?v=([\w.]+)["']/g)]
            .map(([, p, v]) => ({ path: p, version: v }));

        expect(requested.length).toBeGreaterThan(0);

        // No hardcoded versions should remain in layout.ejs
        for (const r of requested) {
            expect(r.version).toBe(ASSET_VERSION);
        }

        // Everything preloaded must be something the page actually requests.
        const requestedPaths = new Set(requested.map(r => r.path));
        for (const p of extractPreloads(buildEarlyHintsHeader({ minimalUi: true }))) {
            expect(requestedPaths.has(p.path)).toBe(true);
        }
    });

    test('minimal.css is only preloaded for minimal UI mode', () => {
        // minimal.css is ~97KB and only applies under html[data-ui-mode="minimal"].
        expect(buildEarlyHintsHeader({ minimalUi: false })).not.toContain('minimal.css');
        expect(buildEarlyHintsHeader({ minimalUi: true })).toContain('minimal.css');
    });

    test('Worker ASSET_VERSION matches the app ASSET_VERSION', () => {
        // The Worker is deployed separately and keeps its own copy of the
        // version. If they diverge, Early Hints preload the wrong URLs.
        const worker = fs.readFileSync(path.join(ROOT, 'workers', 'src', 'worker.js'), 'utf8');
        const m = worker.match(/const ASSET_VERSION\s*=\s*['"]([\w.]+)['"]/);
        expect(m).not.toBeNull();
        expect(m[1]).toBe(ASSET_VERSION);
    });

    test('no stale hardcoded asset versions remain in server.js or layout.ejs', () => {
        const files = ['server.js', 'views/layout.ejs'];
        for (const f of files) {
            const content = fs.readFileSync(path.join(ROOT, f), 'utf8');
            const stale = content.match(/\?v=1[0-9]\.[0-9]/g);
            expect(stale).toBeNull();
        }
    });
});
