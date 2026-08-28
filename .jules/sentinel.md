## 2025-05-18 - Unhandled request hanging on inline CSRF validation failure
**Vulnerability:** Multiple POST handlers (`/profile/avatar`, `/profile/avatar/remove`, `/import-url`, `/thumbnail/:id`, etc.) returned bare `undefined` on `!validateCsrf(req)` failure without returning an HTTP response (`403 Forbidden`).
**Learning:** Bypassing standard Express middleware to perform inline CSRF checks after multipart parsing risk leaving HTTP requests hanging indefinitely if validation fails without an explicit error response.
**Prevention:** Always invoke a central error handler like `handleCsrfError(req, res)` that responds with 403 (JSON/HTML) whenever an inline security check fails.

## 2026-08-28 - SSRF filter bypass via compressed hex IPv4-mapped IPv6 literals
**Vulnerability:** `isPrivateAddress` regex only checked dotted-quad `::ffff:127.0.0.1`, but WHATWG URL parsing normalizes IPv4-mapped IPv6 literals to compressed hex `::ffff:7f00:1`, bypassing the check.
**Learning:** Standard URL parsers reformat IPv6 hostnames into compressed hex notation before validation, breaking simple text/regex pattern matching on dotted quad representations.
**Prevention:** Always parse and decode embedded IPv4 octets out of IPv6 hex mapped addresses into dotted quad numbers before applying network range/blocklist validation.
