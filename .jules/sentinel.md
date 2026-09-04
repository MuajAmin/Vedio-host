## 2025-05-18 - Unhandled request hanging on inline CSRF validation failure
**Vulnerability:** Multiple POST handlers (`/profile/avatar`, `/profile/avatar/remove`, `/import-url`, `/thumbnail/:id`, etc.) returned bare `undefined` on `!validateCsrf(req)` failure without returning an HTTP response (`403 Forbidden`).
**Learning:** Bypassing standard Express middleware to perform inline CSRF checks after multipart parsing risk leaving HTTP requests hanging indefinitely if validation fails without an explicit error response.
**Prevention:** Always invoke a central error handler like `handleCsrfError(req, res)` that responds with 403 (JSON/HTML) whenever an inline security check fails.

## 2026-09-04 - Broken access control on video modification and deletion
**Vulnerability:** `POST /rename/:id` and `POST /delete/:id` relied solely on `isAuthenticated` middleware, allowing any logged-in user to rename or permanently delete videos uploaded by others.
**Learning:** Checking authentication without verifying resource ownership (`uploaded_by === req.session.user`) or admin status (`req.session.user === 'muaj'`) creates an authorization bypass flaw.
**Prevention:** Always pair `isAuthenticated` on resource mutation endpoints with explicit ownership checks against `uploaded_by` or role checks against `isMuaj`.
