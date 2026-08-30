# Frontend Audit — Redesign Baseline (2026-08-30)

Audit of the complete frontend performed before the redesign work.
Backend routes, business logic and APIs were reviewed and left unchanged.

## Architecture (as found)

- **Server-rendered EJS** (no build step): `views/*.ejs` compose through
  `views/layout.ejs` via `include('layout', { body })`.
- **Vanilla JS**: `public/js/app.js` (global UI), `messages.js` (DM + drawer),
  `calling.js` (WebRTC), `watchTogether.js`, `theme-init.js` (blocking
  anti-FOUC script), emoji helpers.
- **CSS layers**: `style.css` (Standard UI + 4 palettes), `minimal.css`
  (Minimal UI override layer scoped to `html[data-ui-mode="minimal"]`),
  `messages.css`, `calling.css`.
- **UI Mode system already present**: `data-ui-mode="standard|minimal"` on
  `<html>`, switch is attribute-only → instant, no reload, no state loss.
  Persisted to localStorage + cookie + DB (`user_settings`).
- **Palette themes**: `data-theme="cinematic|cyberpunk|emerald|sunset"`,
  same persistence pipeline.
- **Asset versioning**: single source `utils/assets.js` (`ASSET_VERSION`),
  mirrored in `workers/src/worker.js`, used by 103 Early Hints.

## Bugs found (all fixed in this PR)

| # | Bug | Impact | Fix |
|---|-----|--------|-----|
| 1 | `/favicon.ico` → 404 | Console error on **every** page load | Added `public/favicon.ico` + `<link rel="icon">` in layout |
| 2 | `sw.js` precache pinned to `?v=14.2` while pages request `?v=14.3` | Service-worker precache never hit → every asset downloaded twice on Android PWA | Version bump synced across `utils/assets.js`, `sw.js`, `workers/src/worker.js` (CI-checked) |
| 3 | `showToast()` invoked in app.js but never defined | UI-mode/theme change feedback silently never appears | Implemented accessible global toast (aria-live) |
| 4 | `closeProfileModal` block-scoped inside `if (profileModal)` | Opening Settings from the Profile modal leaves the profile modal stuck open behind it | Exposed shared close function |
| 5 | No light theme exists (all 4 palettes dark-only) | Requirement gap | Added orthogonal `data-scheme="dark|light"` layer across all 4 CSS files, all palettes, both UI modes |
| 6 | Logged-out pages load the full realtime stack (messages/calling/watchTogether JS+CSS, emoji data) | ~8 needless requests / big transfer on the login page | Layout + Early Hints now gate realtime assets on session presence |
| 7 | Early Hints preloads realtime assets for anonymous visitors | Wasted preload bandwidth | `buildEarlyHintsHeader({ authenticated })` |
| 8 | No `:focus-visible` styles anywhere | Keyboard/switch-access users get no focus indication | Global design-system focus ring |
| 9 | Only 2 narrow `prefers-reduced-motion` rules | Motion-sensitive users get full animation set | Global reduced-motion kill-switch |
| 10 | `renderAvatar()` duplicated in 5 EJS views + `utils/security.js` | Duplicate logic drift risk | Views now use the shared `res.locals.renderAvatar` |
| 11 | Touch targets in Standard UI mobile nav < 44px in places | Android ergonomics | Min touch-target tokens applied |

## Duplications / inconsistencies noted

- `style.css` contains two `:root` token blocks (line ~6 and ~7846 for the
  nav dock) and four per-palette override blocks scattered — consolidated
  where safe; nav-dock tokens kept (they are component-scoped).
- `messages.css` and `calling.css` define their own token namespaces
  (`--msg-*`, `--call-*`). `--msg-*` correctly derives from the app theme
  vars; `--call-*` was fully hardcoded dark → now derives + light override.

## Performance notes

- `backdrop-filter` usage: 4 in messages.css, 16 in calling.css, 8 in
  minimal.css (0 in style.css after prior optimization pass). Call UI blur
  is acceptable (single overlay, not scroll content).
- All page HTML is `no-store` (session-scoped) — correct.
- Videos/thumbnails/avatars have dedicated fast-path auth (no session
  write) — untouched.

## What was intentionally NOT changed

- Backend routes, database schema, session handling, CSRF, upload/import
  pipelines, WebRTC signaling, SSE streams, push notifications.
- The scheme (light/dark) preference is persisted via cookie +
  localStorage only — no DB schema change required; the server reads the
  cookie in `attachLocals` purely to render the right `data-scheme`
  attribute and avoid a flash of wrong scheme.
