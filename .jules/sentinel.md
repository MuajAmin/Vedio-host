## 2025-05-18 - Unhandled request hanging on inline CSRF validation failure
**Vulnerability:** Multiple POST handlers (`/profile/avatar`, `/profile/avatar/remove`, `/import-url`, `/thumbnail/:id`, etc.) returned bare `undefined` on `!validateCsrf(req)` failure without returning an HTTP response (`403 Forbidden`).
**Learning:** Bypassing standard Express middleware to perform inline CSRF checks after multipart parsing risk leaving HTTP requests hanging indefinitely if validation fails without an explicit error response.
**Prevention:** Always invoke a central error handler like `handleCsrfError(req, res)` that responds with 403 (JSON/HTML) whenever an inline security check fails.

## 2026-08-28 - Missing video ownership check on modification/deletion routes
**Vulnerability:** `POST /rename/:id` and `POST /delete/:id` only checked `isAuthenticated`, allowing any logged-in user to rename or delete videos uploaded by other users.
**Learning:** Checking generic authentication middleware without validating resource ownership (`video.uploaded_by`) or admin role (`req.session.user === 'muaj'`) leaves endpoints vulnerable to Broken Object Level Authorization (BOLA).
**Prevention:** Always verify resource ownership or explicit admin privileges before performing state-changing operations on database records and disk/CDN files.
