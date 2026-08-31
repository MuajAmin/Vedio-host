// ============================================================
//  ASSET VERSION — SINGLE SOURCE OF TRUTH
// ============================================================
//  Every static asset URL is cache-busted with ?v=<ASSET_VERSION>.
//
//  Why this file exists:
//  Early Hints / preload Link headers previously hardcoded their own version
//  strings, which drifted out of sync with the versions actually referenced in
//  layout.ejs. When they disagree the browser preloads one URL and then
//  downloads a *different* URL for the same file — silently doubling bytes for
//  the largest assets on the page and wasting the preload entirely.
//
//  Keeping one constant here makes that class of bug impossible on the server.
//
//  NOTE: workers/src/worker.js has its own copy of this value because it is
//  deployed separately and cannot import from the VPS app. If you bump the
//  version here, bump ASSET_VERSION in workers/src/worker.js too. The CI
//  workflow enforces that they match.
// ============================================================

const ASSET_VERSION = '14.8';

/**
 * Build a cache-busted asset URL.
 * @param {string} p Absolute asset path, e.g. '/js/app.js'
 * @returns {string}
 */
function asset(p) {
    return `${p}?v=${ASSET_VERSION}`;
}

// Assets required by every page (authenticated or not).
const GLOBAL_PRELOAD = [
    { path: '/css/style.css', as: 'style' },
    { path: '/css/design-system.css', as: 'style' },
    { path: '/js/theme-init.js', as: 'script' },
    { path: '/js/app.js', as: 'script' }
];

// Assets only loaded on authenticated pages (emoji rendering for chat).
const AUTH_PRELOAD = [
    { path: '/js/twemoji.min.js', as: 'script' },
    { path: '/js/whatsapp-emojis.js', as: 'script' }
];

// Real-time features (messaging + calling) load on every page because incoming
// calls and messages must be received regardless of which page the user is on.
const REALTIME_PRELOAD = [
    { path: '/css/messages.css', as: 'style' },
    { path: '/css/calling.css', as: 'style' },
    { path: '/js/messages.js', as: 'script' },
    { path: '/js/calling.js', as: 'script' },
    { path: '/js/watchTogether.js', as: 'script' }
];

const PRECONNECT = [
    '<https://fonts.googleapis.com>; rel=preconnect',
    '<https://fonts.gstatic.com>; rel=preconnect; crossorigin',
    '<https://cdn.jsdelivr.net>; rel=preconnect'
];

/**
 * Build the Link header value for 103 Early Hints / preload.
 * @param {{ minimalUi?: boolean, authenticated?: boolean }} [opts]
 * @returns {string}
 */
function buildEarlyHintsHeader(opts = {}) {
    // Logged-out pages (login) don't load the realtime stack or emoji assets,
    // so preloading them would waste the visitor's bandwidth entirely.
    const authenticated = opts.authenticated !== false;
    const entries = authenticated
        ? [...GLOBAL_PRELOAD, ...AUTH_PRELOAD, ...REALTIME_PRELOAD]
        : [...GLOBAL_PRELOAD];

    // minimal.css is ~97KB and only applies under html[data-ui-mode="minimal"].
    // Only preload it for users actually in minimal mode.
    if (opts.minimalUi) {
        entries.push({ path: '/css/minimal.css', as: 'style' });
    }

    const links = entries.map(e => `<${asset(e.path)}>; rel=preload; as=${e.as}`);
    return [...links, ...PRECONNECT].join(', ');
}

module.exports = {
    ASSET_VERSION,
    asset,
    buildEarlyHintsHeader
};
