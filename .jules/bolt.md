## 2025-05-19 - Zero-dependency cookie parsing in hot request paths
**Learning:** Calling external `cookie.parse` in request middleware (`attachLocals` and `fastMediaAuth`) introduces package import overhead on every HTTP request and can break test runners when transitive packages are not hoisted in `package.json`.
**Action:** Use a fast zero-dependency inline `parseCookies` scanner in `utils/security.js` and `server.js` for lightweight HTTP header parsing.

## 2025-05-18 - Middleware DB query bottleneck in `isUserBlocked`
**Learning:** `isAuthenticated` middleware runs on 100% of authenticated HTTP requests (including presence pings every 10s and API polling). Calling uncompiled SQLite queries inside middleware introduces unnecessary I/O overhead on every single request.
**Action:** Always use in-memory Set/Map caches in `database.js` for high-frequency security/permission checks, ensuring mutation functions update the cache synchronously and fallback gracefully to DB reads if the cache is unavailable.
