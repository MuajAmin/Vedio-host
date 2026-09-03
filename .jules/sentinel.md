## 2025-05-18 - Unhandled request hanging on inline CSRF validation failure
**Vulnerability:** Multiple POST handlers (`/profile/avatar`, `/profile/avatar/remove`, `/import-url`, `/thumbnail/:id`, etc.) returned bare `undefined` on `!validateCsrf(req)` failure without returning an HTTP response (`403 Forbidden`).
**Learning:** Bypassing standard Express middleware to perform inline CSRF checks after multipart parsing risk leaving HTTP requests hanging indefinitely if validation fails without an explicit error response.
**Prevention:** Always invoke a central error handler like `handleCsrfError(req, res)` that responds with 403 (JSON/HTML) whenever an inline security check fails.

## 2026-08-28 - Broken access control on video deletion and rename routes
**Vulnerability:** `POST /rename/:id` and `POST /delete/:id` only checked `isAuthenticated` without verifying video ownership (`uploaded_by`) or admin status (`muaj`), allowing any authenticated user to rename or delete any video.
**Learning:** Routes performing state changes on resource IDs must explicitly check `req.session.user === 'muaj' || req.session.user === resource.uploaded_by` even when UI controls are hidden for non-admin users.
**Prevention:** Always perform explicit server-side authorization checks against resource ownership or admin role before updating or destroying database records or files.
