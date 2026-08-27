## 2025-05-18 - Middleware DB query bottleneck in `isUserBlocked`
**Learning:** `isAuthenticated` middleware runs on 100% of authenticated HTTP requests (including presence pings every 10s and API polling). Calling uncompiled SQLite queries inside middleware introduces unnecessary I/O overhead on every single request.
**Action:** Always use in-memory Set/Map caches in `database.js` for high-frequency security/permission checks, ensuring mutation functions update the cache synchronously and fallback gracefully to DB reads if the cache is unavailable.

## 2025-05-19 - Admin stats R2 HEAD query network bottleneck
**Learning:** `collectAdminStats` in `routes/admin.js` checked video presence on Cloudflare R2 via network HEAD requests (`existsOnR2`) for videos not in the in-memory confirmed set because `cdn_status` was omitted from the `videos` SQL `SELECT`.
**Action:** Always include `cdn_status` when querying video records and short-circuit R2 availability checks using `v.cdn_status === 'r2_ready' || v.cdn_status === 'r2_only'` before making outbound HTTP HEAD requests.
