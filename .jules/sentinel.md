## 2025-05-18 - Unhandled request hanging on inline CSRF validation failure
**Vulnerability:** Multiple POST handlers (`/profile/avatar`, `/profile/avatar/remove`, `/import-url`, `/thumbnail/:id`, etc.) returned bare `undefined` on `!validateCsrf(req)` failure without returning an HTTP response (`403 Forbidden`).
**Learning:** Bypassing standard Express middleware to perform inline CSRF checks after multipart parsing risk leaving HTTP requests hanging indefinitely if validation fails without an explicit error response.
**Prevention:** Always invoke a central error handler like `handleCsrfError(req, res)` that responds with 403 (JSON/HTML) whenever an inline security check fails.
