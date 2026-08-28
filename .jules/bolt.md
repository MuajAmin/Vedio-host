## 2025-05-18 - Middleware DB query bottleneck in `isUserBlocked`
**Learning:** `isAuthenticated` middleware runs on 100% of authenticated HTTP requests (including presence pings every 10s and API polling). Calling uncompiled SQLite queries inside middleware introduces unnecessary I/O overhead on every single request.
**Action:** Always use in-memory Set/Map caches in `database.js` for high-frequency security/permission checks, ensuring mutation functions update the cache synchronously and fallback gracefully to DB reads if the cache is unavailable.

## 2025-05-19 - DB Column Selection in Admin Stats and Unhandled Module Fallbacks
**Learning:** Selecting incomplete video columns in `collectAdminStats` caused `v.cdn_status` to be `undefined`, forcing `collectAdminStats` to issue external S3 HEAD requests to Cloudflare R2 for every video on admin page loads and polling loops.
**Action:** Always include status columns (like `cdn_status`) in queries that perform conditional remote API checks, so the state can be resolved instantly from DB metadata.
