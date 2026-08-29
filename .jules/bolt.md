## 2025-05-19 - Zero-dependency cookie parsing for high-frequency middleware
**Learning:** High-frequency middleware like `attachLocals` and `fastMediaAuth` run on 100% of HTTP requests and media stream bursts. Requiring unlisted third-party packages like `cookie` breaks in strict package managers (pnpm) and causes unnecessary object allocations and URI decoding for unrelated cookies on every request.
**Action:** Use a fast, targeted `getCookieValue` helper function for extracting cookie values in high-frequency middleware, avoiding external dependencies and reducing per-request object creation.

## 2025-05-18 - Middleware DB query bottleneck in `isUserBlocked`
**Learning:** `isAuthenticated` middleware runs on 100% of authenticated HTTP requests (including presence pings every 10s and API polling). Calling uncompiled SQLite queries inside middleware introduces unnecessary I/O overhead on every single request.
**Action:** Always use in-memory Set/Map caches in `database.js` for high-frequency security/permission checks, ensuring mutation functions update the cache synchronously and fallback gracefully to DB reads if the cache is unavailable.
