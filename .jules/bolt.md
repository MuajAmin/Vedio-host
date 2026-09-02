## 2025-05-18 - Middleware DB query bottleneck in `isUserBlocked`
**Learning:** `isAuthenticated` middleware runs on 100% of authenticated HTTP requests (including presence pings every 10s and API polling). Calling uncompiled SQLite queries inside middleware introduces unnecessary I/O overhead on every single request.
**Action:** Always use in-memory Set/Map caches in `database.js` for high-frequency security/permission checks, ensuring mutation functions update the cache synchronously and fallback gracefully to DB reads if the cache is unavailable.

## 2025-05-19 - Per-request DB query overhead in `getUserSettings`
**Learning:** `attachLocals` middleware executes on every HTTP request and fetched user settings by compiling and executing a SQLite SELECT query inline. Precompiling the query at module top-level and pairing it with an in-memory Map cache eliminates SQLite compilation overhead and converts frequent disk reads to instant $O(1)$ memory accesses.
**Action:** Precompile top-level SQLite statements in `database.js` and wrap high-frequency read helpers with synchronous in-memory Map caches, updating the cache synchronously during write/update calls.
