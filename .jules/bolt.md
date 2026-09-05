## 2025-05-18 - Middleware DB query bottleneck in `isUserBlocked`
**Learning:** `isAuthenticated` middleware runs on 100% of authenticated HTTP requests (including presence pings every 10s and API polling). Calling uncompiled SQLite queries inside middleware introduces unnecessary I/O overhead on every single request.
**Action:** Always use in-memory Set/Map caches in `database.js` for high-frequency security/permission checks, ensuring mutation functions update the cache synchronously and fallback gracefully to DB reads if the cache is unavailable.

## 2025-05-19 - Precompiling SQLite statements for high-frequency playback endpoints
**Learning:** High-frequency routes like `/watch-progress/:id` and `/stream/:videoKey` fire every few seconds during video playback. Calling `db.prepare(...)` dynamically inside route handlers causes repeated SQL query compilation and string parsing overhead.
**Action:** Always precompile SQL statements at module top-level in route files or `database.js` for high-frequency route handlers.
