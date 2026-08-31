## 2026-08-28 - SSRF filter bypass via IPv4-mapped IPv6 hex literals
**Vulnerability:** WHATWG `URL` canonicalizes IPv4-mapped IPv6 literals (`http://[::ffff:127.0.0.1]/`) to hex notation (`[::ffff:7f00:1]`). Regex matching only dotted-quad IPv4-mapped strings (`::ffff:127.0.0.1`) failed to detect the hex form, returning `false` for `isPrivateAddress()` and allowing SSRF to loopback and metadata endpoints.
**Learning:** Checking IPv6 representations requires parsing and decoding embedded IPv4 addresses in both dotted-quad and compressed hex formats before evaluating network range boundaries.
**Prevention:** Convert hex-encoded IPv4-mapped (`::ffff:7f00:1`) and IPv4-compatible (`::7f00:1`) IPv6 literals into standard dotted-quad IPv4 strings prior to range classification.

## 2025-05-18 - Unhandled request hanging on inline CSRF validation failure
**Vulnerability:** Multiple POST handlers (`/profile/avatar`, `/profile/avatar/remove`, `/import-url`, `/thumbnail/:id`, etc.) returned bare `undefined` on `!validateCsrf(req)` failure without returning an HTTP response (`403 Forbidden`).
**Learning:** Bypassing standard Express middleware to perform inline CSRF checks after multipart parsing risk leaving HTTP requests hanging indefinitely if validation fails without an explicit error response.
**Prevention:** Always invoke a central error handler like `handleCsrfError(req, res)` that responds with 403 (JSON/HTML) whenever an inline security check fails.
