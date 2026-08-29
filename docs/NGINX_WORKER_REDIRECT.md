# muaj.bro.bd → Cloudflare Worker Redirect

**Date:** 2026-08-29
**Change type:** Nginx configuration (no package installs, no reinstall)
**Downtime:** none (graceful `systemctl reload`, master PID unchanged)

---

## 1. Goal

Make the public hostname `muaj.bro.bd` (and `www.muaj.bro.bd`) permanently
redirect to the Cloudflare Worker:

```
https://videohost-edge.muajamin2021.workers.dev$request_uri
```

`muaj.bro.bd` cannot be added to Cloudflare as a custom domain because the
root domain (`bro.bd`) is not under our control, so the redirect has to be
performed by Nginx on the VPS rather than at the Cloudflare edge.

---

## 2. Hostname roles after this change

| Hostname | Before | After |
|---|---|---|
| `muaj.bro.bd` | served the app | **308 → Worker** |
| `www.muaj.bro.bd` | served the app (no DNS record exists) | **308 → Worker** |
| `origin.muaj.bro.bd` | served the app | **unchanged — still serves the app** |

`origin.muaj.bro.bd` is intentionally left alone: it is the backend origin the
Worker pulls real content from.

---

## 3. Changes made to `/etc/nginx/sites-available/muaj.bro.bd`

Three edits, all in one file:

1. **Line 37** (HTTP `:80` app block) —
   `server_name muaj.bro.bd www.muaj.bro.bd origin.muaj.bro.bd;`
   → `server_name origin.muaj.bro.bd;`
2. **Line 54** (HTTPS `:443` app block) — same narrowing to `origin` only.
3. **Lines 30-32** — commented out the Certbot-generated
   `if ($host = muaj.bro.bd) { return 301 ... }` block, which would otherwise
   still capture `muaj.bro.bd` on port 80.
4. **Appended** two new `server` blocks (HTTP `:80` and HTTPS `:443`) that
   answer for `muaj.bro.bd` + `www.muaj.bro.bd` and issue the redirect.

The tracked copy in `nginx-videohost.conf` was updated to match.

---

## 4. Three design decisions worth knowing

### 4.1 `308`, not `301`

A `301` makes browsers downgrade `POST` to `GET` and **drop the request body**,
which silently breaks logins, uploads and API POSTs. `308 Permanent Redirect`
has identical permanent/caching/SEO semantics but preserves method and body.

Verified: `curl -L -X POST` arrives at the Worker still as `POST`.

### 4.2 The redirect lives inside `location /`, not at server level

A server-level `return` runs in Nginx's **rewrite phase**, which happens
*before* any location content handler. Placed there, it pre-empts the ACME
challenge block and **breaks Let's Encrypt renewal**.

This was caught in an isolated sandbox test before touching production:

```
ACME challenge -> expected 200, got "301 Moved Permanently"   # would break SSL
```

Keeping the redirect inside `location /` lets the higher-priority
`location ^~ /.well-known/acme-challenge/` win. Both new blocks therefore
include an explicit ACME exception.

### 4.3 Worker loop exemption

The Worker fetches its origin as `https://origin.muaj.bro.bd` **but overrides
the `Host` header to `muaj.bro.bd`** (4 places in `workers/src/worker.js`).
Nginx routes by `Host`, so a naive redirect would return a redirect to the
Worker's own origin fetch, creating an infinite `Worker -> Nginx -> Worker` loop.

All four origin fetches set `X-Edge-Worker-Loop: 1`, so the redirect blocks
exempt any request carrying that header and proxy it to the app instead.

---

## 5. Verification performed

| Check | Result |
|---|---|
| `nginx -t` | syntax OK |
| Reload | graceful; master PID unchanged (no downtime) |
| `curl -I http://muaj.bro.bd/stream/v.mp4?token=abc&t=42` | `308`, path + query preserved |
| `curl -I https://muaj.bro.bd/stream/v.mp4?token=abc&t=42` | `308`, path + query preserved |
| `curl -I https://origin.muaj.bro.bd/` | `200` — app still served |
| `curl -I -H 'X-Edge-Worker-Loop: 1' https://muaj.bro.bd/` | `200` — no redirect, no loop |
| `curl -IL https://muaj.bro.bd/` | `nginx 308` then `cloudflare 200` |
| `curl -L -X POST` | method still `POST` after redirect |
| Encoded URI `/a%20b/c?q=1%262&x=%C3%A9` | preserved byte-for-byte |
| ACME probe `/.well-known/acme-challenge/p` | `404` (not `308`) — exemption works |
| `certbot renew --dry-run` | **"Congratulations, all simulated renewals succeeded"** |

---

## 6. Backups & rollback

Created before any modification, on the VPS:

```
/root/nginx-backups/muaj.bro.bd.bak_<TIMESTAMP>     # the modified file
/root/nginx-backups/nginx-full-<TIMESTAMP>.tar.gz   # whole /etc/nginx tree
/root/nginx-backups/LAST_BACKUP_TS                  # newest timestamp
```

Backup integrity was confirmed by matching md5 against the live file.

To roll back:

```bash
bash scripts/rollback-nginx-redirect.sh
```

The script snapshots the current config first (so the rollback is itself
reversible), restores the backup, runs `nginx -t`, and reloads gracefully,
reverting automatically if validation fails.

Manual equivalent:

```bash
cp -a /root/nginx-backups/muaj.bro.bd.bak_<TS> /etc/nginx/sites-available/muaj.bro.bd
nginx -t && systemctl reload nginx
```

---

## 7. Known follow-ups (not blockers)

These are consequences of routing users through the Worker, not defects in
this change:

1. **Upload cap 550 MB to 100 MB.** Nginx allows `client_max_body_size 550M`,
   but Cloudflare Workers hard-cap request bodies at 100 MB. Large video
   uploads through `muaj.bro.bd` will fail at 100 MB. If large uploads must
   keep working, point the upload form at `origin.muaj.bro.bd` (which bypasses
   the Worker) or upload directly to R2 with a presigned URL.
2. **One-time logout.** Session cookies scoped to `muaj.bro.bd` are not sent to
   `*.workers.dev`, so currently signed-in users will need to sign in again.
3. **CORS allowlist.** `ALLOWED_ORIGINS` in `workers/src/worker.js` lists only
   `https://muaj.bro.bd` and `https://www.muaj.bro.bd`. Since the browser's
   origin is now the `workers.dev` hostname, add it there if credentialed
   cross-origin XHR fails.
4. **Address bar shows `workers.dev`.** Inherent to a redirect (as opposed to a
   reverse proxy). Serving the Worker under the pretty hostname would require
   control of the root domain.
