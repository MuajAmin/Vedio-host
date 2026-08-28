# VideoHost — Security & Code Audit

**Date:** 2026-08-28
**Commit audited:** `6710d3c`
**Scope:** Express/Bun origin app (`server.js`, `routes/`, `utils/`, `middleware/`), EJS views, client JS, Cloudflare Worker (`workers/src/`), Nginx config, CI workflow.
**Codebase size:** ~30,000 LOC
**Test suite:** 17/17 passing (`bun test`)

---

## Summary

The application shows genuine security engineering: parameterised SQL throughout, CSRF on state-changing routes, `timingSafeEqual` signature checks in the Worker, session regeneration on login, an SSRF allowlist on the importer, `internal`-scoped Nginx `X-Accel-Redirect` locations, and a hardened CSP. Prior agent notes (`.jules/sentinel.md`) show a pattern of fixing real bugs properly.

The findings below are the gaps that remain. Two are exploitable today (H-1, H-2); one is a credential-exposure issue requiring rotation (H-3).

| ID | Severity | Issue |
|----|----------|-------|
| H-1 | High | SSRF filter bypass via IPv4-mapped IPv6 literals |
| H-2 | High | Broken access control: any user can rename/delete any video |
| H-3 | High | Real password committed to git history (`.env`) |
| M-1 | Medium | Worker admin signed URLs break when `WORKER_HMAC_SECRET` is set |
| M-2 | Medium | Login rate limiter keyed on spoofable client IP |
| M-3 | Medium | Blocked users retain media/stream access until session expiry |
| M-4 | Medium | Non-constant-time HMAC comparison on `/api/internal-presence-sync` |
| L-1 | Low | Thumbnails served publicly without authentication |
| L-2 | Low | `--no-check-certificates` disables TLS validation in importer |
| L-3 | Low | Quality selection silently ignored for video-only formats |
| L-4 | Low | Audit-log IP is attacker-controlled |

---

## H-1 — SSRF filter bypass via IPv4-mapped IPv6 literals

**File:** `routes/import.js:68-111` (`isPrivateAddress`)
**Reachable from:** `POST /import-url`, `POST /import-formats` (any authenticated user)

`isPrivateAddress` handles the IPv4-mapped form `::ffff:127.0.0.1` via the regex on line 70, which only matches **dotted-quad** mapped addresses. But WHATWG URL parsing normalises IPv6 literals to **compressed hex**, so `::ffff:127.0.0.1` becomes `::ffff:7f00:1` before the check runs. The hex form matches none of the IPv6 prefixes on lines 100-107 (`::`, `::1`, `fe80:`, `fc`, `fd`, `ff`), so the function returns `false` — treated as public.

### Verified

```
blocked  http://127.0.0.1:3000/admin
blocked  http://localhost/
blocked  http://[::1]/
blocked  http://169.254.169.254/latest/meta-data/
blocked  http://[0:0:0:0:0:0:0:1]/
ALLOWED  http://[::ffff:7f00:1]/               <-- loopback
ALLOWED  http://[0:0:0:0:0:ffff:127.0.0.1]/    <-- loopback
ALLOWED  http://[::ffff:169.254.169.254]/      <-- cloud metadata
```

Normalisation confirmed:

```
http://[::ffff:127.0.0.1]/          -> hostname = [::ffff:7f00:1]
http://[::ffff:169.254.169.254]/    -> hostname = [::ffff:a9fe:a9fe]
```

**Impact:** `yt-dlp` is spawned against the attacker-supplied URL, reaching the loopback interface (the app's own admin surface on `:3000`, other localhost services) and the cloud metadata endpoint at `169.254.169.254`. On a metadata-v1 instance this can expose IAM credentials. The DNS-rebinding guard on line 147 does not help: IP literals skip DNS resolution entirely (line 142).

**Fix:** Decode the mapped IPv4 out of the hex form before classification, rather than pattern-matching text. Extract the embedded IPv4 from any `::ffff:` address and re-run the v4 checks:

```js
// after: const version = net.isIP(ip);
if (version === 6) {
    // Normalise IPv4-mapped IPv6 (::ffff:a.b.c.d AND ::ffff:7f00:1) to dotted quad
    const m = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
    if (m) {
        const hi = parseInt(m[1], 16), lo = parseInt(m[2], 16);
        const v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
        return isPrivateAddress(v4);
    }
}
```

Also add `::ffff:` and IPv4-compatible `::` prefixes to the blocklist, and prefer an explicit allowlist of import hosts if the feature only ever targets known video sites.

---

## H-2 — Broken access control: any user can rename or delete any video

**File:** `routes/videos.js:608` (`POST /rename/:id`), `routes/videos.js:621` (`POST /delete/:id`)

Both routes are guarded only by `isAuthenticated`. There is no ownership check against `videos.uploaded_by` and no `isMuaj` role check:

```js
router.post('/rename/:id', isAuthenticated, (req, res) => {
    const result = db.prepare('UPDATE videos SET title = ? WHERE id = ?').run(newTitle, req.params.id);
```

`/delete/:id` performs irreversible destruction — R2 object delete, Cloudflare cache purge, local file `unlink`, thumbnail `unlink`, and DB row delete (cascading to comments and watch progress).

Contrast with the thumbnail routes at lines 985 and 1029, which correctly use `isMuaj`. The comment-delete route at `routes/comments.js:65` also correctly checks `req.session.user === 'muaj' || req.session.user === comment.user`. So the intended model exists; these two routes just miss it.

The UI is not a mitigation: `views/watch.ejs:108` builds `deleteForm` unconditionally (no `isAdmin` guard, unlike the thumbnail block at line 665), so the non-admin user `hajera` is shown the Delete button. Either way, a direct `POST` bypasses the template.

**Impact:** The lower-privileged account can permanently delete the entire video library. For a two-user private app the blast radius is contained, but the action is unrecoverable and the audit trail attributes it to whoever was logged in.

**Fix:** Decide the intended policy and enforce it server-side. If deletion is admin-only, use `isMuaj`. If uploaders may delete their own:

```js
const video = db.prepare('SELECT uploaded_by FROM videos WHERE id = ?').get(req.params.id);
if (!video) return res.status(404).json({ error: 'Video not found.' });
if (req.session.user !== 'muaj' && video.uploaded_by !== req.session.user) {
    return res.status(403).json({ error: 'Not permitted.' });
}
```

Then gate `deleteForm` in `views/watch.ejs` and the dashboard on the same condition.

---

## H-3 — Real password committed to git history

**Files:** commits `506695b`, `187403a` (path `.env`)

`.env` is correctly in `.gitignore` today and absent from all current branch trees, but it remains reachable in history:

```
$ git log --all --oneline --name-only -- .env
187403a Add .gitignore and remove untracked modules
506695b main
```

Inspecting the blob (values redacted here):

| Key | Length | Placeholder? |
|-----|--------|--------------|
| `MUAJ_PASSWORD` | 7 chars | **No — appears to be a real password** |
| `HAJERA_PASSWORD` | 9 chars | **No — appears to be a real password** |
| `SESSION_SECRET` | 32 chars | Yes (`change this in production`) |

Both login passwords are short enough to be weak independent of exposure — `MUAJ_PASSWORD` at 7 characters is brute-forceable offline in seconds, and the app's only authentication factor is this single password (`middleware/auth.js:45`).

**Impact:** Anyone with repository read access (including anyone who cloned it, and any fork) can recover the admin password from history. This is full application compromise. Note the repo also has 13 remote branches, widening exposure.

**Fix, in order:**
1. **Rotate both passwords now** to long random values — this is the only step that actually closes the exposure. Assume the committed values are public.
2. Rotate `SESSION_SECRET` too (invalidates existing sessions, which is desirable here).
3. Purge the blob from history (`git filter-repo --path .env --invert-paths`) and force-push, coordinating with anyone holding clones. History rewriting does not un-leak the value, so step 1 remains mandatory.
4. Consider a stronger auth factor than a single shared password (per-user credentials, hashed at rest, plus TOTP).

---

## M-1 — Worker admin signed URLs break when `WORKER_HMAC_SECRET` is set

**File:** `routes/admin.js:16-24`

`getWorkerAdminSignedUrl` signs with `SESSION_SECRET` only:

```js
const secret = process.env.SESSION_SECRET;
```

Every other signer uses the documented precedence `WORKER_HMAC_SECRET || SESSION_SECRET` — `utils/r2.js:695`, `utils/r2.js:728`, `routes/videos.js:1310`, `routes/videos.js:1327`, `routes/admin.js:980`, and the Worker's own verifier at `workers/src/worker.js:363`.

`.env.example` presents `WORKER_HMAC_SECRET` as the recommended defence-in-depth setting. Once an operator sets it, the Worker verifies against `WORKER_HMAC_SECRET` while this one function still signs with `SESSION_SECRET` — every signature mismatches.

**Impact:** Not a vulnerability (it fails closed), but a latent correctness bug. `POST /admin/r2/scan-bucket` and `POST /admin/r2/clean-orphans` silently lose their Worker path and fall back to the slower S3 SDK (`routes/admin.js:641`, `routes/admin.js:725`) — the failure is swallowed by `console.warn`, so it degrades invisibly. It also means the config is untested in the intended production posture.

**Fix:**

```js
const secret = process.env.WORKER_HMAC_SECRET || process.env.SESSION_SECRET;
```

Better: export the single `generateWorkerSignature` helper from `utils/r2.js` and delete this duplicate.

---

## M-2 — Login rate limiter keyed on spoofable client IP

**File:** `routes/auth.js:19-21`, `utils/device.js:34-41`

`getAttemptKey` uses `req.ip`, which is trustworthy — `app.set('trust proxy', 1)` (`server.js:54`) makes Express take the *rightmost* untrusted hop, and Nginx appends the real peer via `$proxy_add_x_forwarded_for` (`nginx-videohost.conf:197`). Verified:

```
Attacker sends X-Forwarded-For: "1.2.3.4", nginx appends real "127.0.0.1"
  req.ip              = 127.0.0.1   <-- correct
  getClientIp(req)    = 1.2.3.4     <-- attacker-controlled
```

So the limiter itself is sound. Two real weaknesses remain:

1. **The limit is generous and never escalates.** 8 attempts per 15 minutes per IP, with no global cap. Against a 7-character password (H-3) and a distributed source, this is not a meaningful barrier. There is no lockout escalation, no CAPTCHA, and no alerting.
2. **Counter resets on restart.** `attempts` is an in-process `Map` (line 7); the app restarting clears all lockouts.

**Fix:** Lower `MAX_LOGIN_ATTEMPTS`, add exponential backoff on repeated failure, add a global failure counter independent of IP, and persist the counter in SQLite so restarts do not clear it. Log failures at a level that surfaces in monitoring.

---

## M-3 — Blocked users retain media access until session expiry

**File:** `server.js:158-204` (`fastMediaAuth`)

The `fastMediaAuth` fast path validates the signed cookie and session row directly, deliberately skipping `express-session` for performance. It does **not** call `db.isUserBlocked` — confirmed: zero occurrences in the function body. The full middleware chain does check, at `middleware/auth.js:11`.

`db.blockUser` does call `destroyUserSessions` (`database.js:327`), which deletes the session rows, so the primary path is handled. But `fastMediaAuth` also holds its own 10-second in-memory cache (`mediaAuthCache`, line 155):

```js
const cached = mediaAuthCache.get(sid);
if (cached && cached.expiresAt > now) {
    req.session = { user: cached.user };
    return next();
}
```

A blocked user's in-flight requests keep succeeding for up to 10 seconds after the block, since the cache is never invalidated on block.

**Impact:** Low in practice — a 10-second window on `/stream/`, `/voice/` after an admin block. Worth closing because "block" is expected to be immediate, and the routes it covers are the bandwidth-expensive ones.

**Fix:** Export a `mediaAuthCache` invalidation hook and call it from `blockUser`/`destroyUserSessions`; optionally add a blocked-user check to `fastMediaAuth` (the blocked set is already an in-memory cache per `database.js:283`, so the cost is negligible).

---

## M-4 — Non-constant-time HMAC comparison on internal sync endpoint

**File:** `routes/videos.js:901-904`

```js
const expectedSig = crypto.createHmac('sha256', secret).update(`sync:${exp}`).digest('hex');
if (sig.toLowerCase() !== expectedSig.toLowerCase()) {
```

String `!==` short-circuits on first differing byte. The Worker side does this correctly with `timingSafeEqual` (`workers/src/worker.js:437`), and `utils/security.js:42` already provides `timingSafeCompare` — this call site just does not use them.

`POST /api/internal-presence-sync` is registered **before** the session and CSRF middleware (`server.js:259`), so it is reachable unauthenticated by design, guarded only by this HMAC.

**Impact:** Remote timing attacks across a network are noisy and hard to exploit, and the signed message is only `sync:<exp>` (low value — presence/progress writes for a fixed two-user set, already constrained at line 907). Low practical risk, but it is a signature check on an unauthenticated endpoint and should be constant-time on principle.

**Fix:**

```js
const { timingSafeCompare } = require('../utils/security');
if (!timingSafeCompare(String(sig).toLowerCase(), expectedSig)) { ... }
```

---

## Low severity

**L-1 — Thumbnails and avatars served without authentication.**
`server.js:271-272` register `/thumbnails/:file` and `/avatars/:file` with no auth middleware (`/voice/` correctly uses `fastMediaAuth`). The comment calls them "public hashed image assets", but thumbnail filenames are `<videoId><ext>` where `videoId` is a UUIDv4 (`routes/videos.js:388`, `routes/import.js:566`, `utils/thumbnail.js:26`) — unguessable, so this is security-by-obscurity rather than a direct leak. However, any UUID leaked via `Referer`, logs, or a shared link exposes a frame of private video content, and `Cache-Control: public` permits shared-cache storage. Consider `fastMediaAuth` on thumbnails; the 10s cache makes the cost small.

**L-2 — TLS verification disabled in importer.**
`routes/import.js:485` passes `--no-check-certificates` to every `yt-dlp` invocation, so import traffic is vulnerable to MitM. Combined with H-1, this widens what a network-positioned attacker can do. Remove the flag, or scope it to specific hosts that genuinely need it.

**L-3 — Quality selection silently ignored for video-only formats.**
`sanitizeFormatId` (`routes/import.js:207-215`) rejects any `formatId` containing `/`, but `buildFormatOptions` generates exactly that shape for video-only streams: `` `${format.format_id}+bestaudio/best` `` (line 1443). Verified:

```
"137+bestaudio/best" -> REJECTED (falls back)
"299+bestaudio/best" -> REJECTED (falls back)
"137"                -> ACCEPTED
```

So selecting most specific resolutions from the UI silently falls back to the default `-S res:720` sort. A functional bug, not a security one — the regex is correctly conservative. Fix by allowing `/` in the pattern while keeping the leading-`-` and length guards, or by having the client send only the bare `format_id`.

**L-4 — Audit-log IP is attacker-controlled.**
`getClientIp` (`utils/device.js:34-41`) returns the leftmost `X-Forwarded-For` entry, which any client can set (verified above: returns `1.2.3.4`). This value is written to the activity log and session records via `db.logActivity` / `db.updateUserPresence` (`routes/auth.js:86`, `routes/videos.js:743`). Forensic records and the admin session table can therefore be poisoned with arbitrary IPs. Use `req.ip` (already correct under `trust proxy`) for anything security-relevant.

---

## What is working well

Worth recording so it is not regressed:

- **SQL injection:** No dynamic SQL found. Every query reviewed in `database.js` and `routes/` uses bound parameters, including the `json_extract` session queries (`database.js:399`, `database.js:420`).
- **XSS:** All EJS interpolation of user data routes through `escapeHtml` (`ejs.escapeXML`). The nine `<%-` sites in `views/layout.ejs` render only `renderAvatar` output, which escapes both username and filename internally (`utils/security.js:56-66`). Client-side, `messages.js` and `watchTogether.js` define and use local `escapeHtml` before `innerHTML`.
- **CSRF:** Applied globally (`server.js:351`) with a documented exemption list for multipart routes, each of which re-validates inline after multer parses — and each returns `handleCsrfError` rather than hanging, which was the bug recorded in `.jules/sentinel.md`. `sendBeacon` calls include `_csrf` in the JSON body (`calling.js:1699`).
- **Path traversal:** `getSafeVideoPath` / `getSafeThumbnailPath` (`routes/videos.js:1153-1175`) resolve-then-verify correctly; `serveMediaFile` applies `path.basename` (`server.js:224`).
- **Command injection:** All `spawn` calls pass argument arrays (never a shell), and `--` terminates options before every user-supplied URL (`routes/import.js:548`, `routes/import.js:1343`, `routes/videos.js:1057`).
- **Nginx:** All four `X-Accel-Redirect` targets carry the `internal` directive, so they cannot be reached directly.
- **Session hygiene:** `regenerate()` on login prevents fixation; `httpOnly` + `sameSite: 'lax'` + conditional `secure`; unauthenticated sessions capped at 30 minutes (`utils/sessionStore.js:87`); production startup asserts required secrets (`server.js:19`).

---

## Recommended order

1. **H-3** — rotate credentials (exposure is live; everything else is secondary to this)
2. **H-2** — add the authorization check (one-line fix, prevents irreversible data loss)
3. **H-1** — fix the IPv6 mapped-address normalisation
4. **M-1** — one-line secret precedence fix
5. **M-2, M-3, M-4**, then the Low items

I have not changed any application code — this audit is read-only. Happy to implement any of these fixes.
