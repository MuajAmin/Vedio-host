// =============================================================================
//  VideoHost — Cloudflare Edge Worker
//  R2 Video CDN with Signed URL authentication.
//  Works without root domain — VPS redirects to workers.dev URL.
// =============================================================================

// ─── Constants ──────────────────────────────────────────────────────────────

/** MIME type mapping for video file extensions. */
const VIDEO_MIME_MAP = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.flv': 'video/x-flv',
  '.wmv': 'video/x-ms-wmv',
  '.m4v': 'video/mp4',
};

/** Valid video key pattern — UUID with optional extension. */
const VIDEO_KEY_RE = /^\/stream\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i;

/** Valid upload key pattern — same as video key. */
const UPLOAD_KEY_RE = /^\/upload\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i;

/** Valid R2 check key pattern — same as video key. */
const R2_CHECK_KEY_RE = /^\/api\/r2-check\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i;

/** Allowed CORS origins — restrict to our own domain. */
const ALLOWED_ORIGINS = new Set([
  'https://muaj.bro.bd',
  'https://www.muaj.bro.bd',
]);

/** WebSocket idle timeout for call signaling (5 minutes). */
const CALL_WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Max request body size for admin endpoints (100 KB). */
const MAX_ADMIN_BODY_SIZE = 100 * 1024;

/** Batch delete parallelism limit. */
const DELETE_BATCH_CONCURRENCY = 10;

// =============================================================================
//  Simple Router
// =============================================================================

/**
 * @typedef {Object} Route
 * @property {string|string[]} method - HTTP method(s) to match
 * @property {RegExp|string}   pattern - URL pathname regex or exact string
 * @property {Function}        handler - async (request, env, ctx, match, url) => Response
 */

/** @type {Route[]} */
const routes = [
  // Video streaming
  {
    method: ['GET', 'HEAD'],
    pattern: VIDEO_KEY_RE,
    handler: handleVideoStream,
  },
  // Direct-to-R2 upload
  {
    method: 'PUT',
    pattern: UPLOAD_KEY_RE,
    handler: handleDirectUpload,
  },
  // Edge R2 inventory & audit
  {
    method: 'GET',
    pattern: '/api/r2-inventory',
    handler: handleR2Inventory,
  },
  // Edge fast check
  {
    method: ['GET', 'HEAD'],
    pattern: R2_CHECK_KEY_RE,
    handler: handleR2Check,
  },
  // Edge R2 delete batch (orphan cleanup)
  {
    method: 'POST',
    pattern: '/api/r2-delete-batch',
    handler: handleR2DeleteBatch,
  },
  // WebRTC call signaling WebSocket
  {
    method: null, // any method — WebSocket upgrade
    pattern: '/call-signaling',
    handler: handleCallSignalingWebSocket,
  },
];

/**
 * Match a request against the route table.
 * @param {string} method
 * @param {string} pathname
 * @returns {{ route: Route, match: RegExpMatchArray|null }|null}
 */
function matchRoute(method, pathname) {
  for (const route of routes) {
    // Method check (null = any method)
    if (route.method !== null) {
      const methods = Array.isArray(route.method) ? route.method : [route.method];
      if (!methods.includes(method)) continue;
    }

    // Pattern check
    if (typeof route.pattern === 'string') {
      if (pathname === route.pattern) return { route, match: null };
    } else {
      const m = pathname.match(route.pattern);
      if (m) return { route, match: m };
    }
  }
  return null;
}

// =============================================================================
//  Entry Point
// =============================================================================

export default {
  /**
   * @param {Request} request
   * @param {{ R2_BUCKET: R2Bucket, SESSION_SECRET: string }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── CORS preflight ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return handleCors(request);
    }

    // ─── Route matching ──────────────────────────────────────────────
    const found = matchRoute(request.method, url.pathname);
    if (!found) {
      return new Response('Not Found', { status: 404 });
    }

    const { route, match } = found;

    // Special case: WebSocket upgrade check
    if (url.pathname === '/call-signaling' && request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    // Extract capture group (videoKey) if regex matched
    const capturedKey = match ? match[1] : null;
    const response = await route.handler(request, env, ctx, capturedKey, url);
    return addCorsHeaders(response, request);
  },
};

// =============================================================================
//  JSON Response Helpers (DRY)
// =============================================================================

/**
 * Return a JSON error response.
 * @param {string} message
 * @param {number} status
 * @returns {Response}
 */
function jsonError(message, status) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Return a JSON success response.
 * @param {object} data
 * @param {number} [status=200]
 * @param {object} [extraHeaders={}]
 * @returns {Response}
 */
function jsonOk(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

// =============================================================================
//  Common Auth Guard (DRY)
// =============================================================================

/**
 * Authenticate a signed admin/API request. Returns null if auth passed,
 * or a Response to return immediately on failure.
 *
 * @param {{ SESSION_SECRET?: string, R2_BUCKET?: R2Bucket }} env
 * @param {string} signatureKey - The key used in HMAC signature (videoKey, 'inventory', etc.)
 * @param {URL} url
 * @param {{ requireR2?: boolean }} [options]
 * @returns {Promise<Response|null>}
 */
async function authenticate(env, signatureKey, url, options = {}) {
  const { requireR2 = true } = options;
  if (!env.SESSION_SECRET) {
    return jsonError('Server misconfigured', 500);
  }
  const isValid = await validateSignedUrl(signatureKey, url.searchParams, env.SESSION_SECRET);
  if (!isValid) {
    return jsonError('Unauthorized — invalid or expired token', 401);
  }
  if (requireR2 && !env.R2_BUCKET) {
    return jsonError('R2 not configured', 500);
  }
  return null; // auth passed
}

// =============================================================================
//  Signed URL Authentication
// =============================================================================

// ─── HMAC CryptoKey Cache ────────────────────────────────────────────────────
// Workers reuse isolates across requests within the same colo. Caching the key
// avoids re-importing on every 206 range request during a playback session.
let _cachedHmacKey = null;
let _cachedHmacSecret = null;

/**
 * Get or create a cached HMAC-SHA256 CryptoKey for the given secret.
 * @param {string} secret
 * @returns {Promise<CryptoKey>}
 */
async function getHmacKey(secret) {
  if (_cachedHmacKey && _cachedHmacSecret === secret) return _cachedHmacKey;
  const encoder = new TextEncoder();
  _cachedHmacKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  _cachedHmacSecret = secret;
  return _cachedHmacKey;
}

/**
 * Validates a signed URL token.
 *
 * The VPS generates: sig = HMAC-SHA256(videoKey + ":" + expiry, SESSION_SECRET)
 * The Worker validates it using the same SESSION_SECRET.
 *
 * @param {string} videoKey - The video filename/UUID from the URL path
 * @param {URLSearchParams} params - Query parameters (sig, exp)
 * @param {string} secret - The shared SESSION_SECRET
 * @returns {Promise<boolean>}
 */
async function validateSignedUrl(videoKey, params, secret) {
  const sig = params.get('sig');
  const exp = params.get('exp');

  if (!sig || !exp) return false;

  // Check expiry
  const expiryTs = parseInt(exp, 10);
  if (!Number.isFinite(expiryTs) || Date.now() > expiryTs * 1000) {
    return false; // Expired
  }

  // Compute expected HMAC using cached key
  const message = `${videoKey}:${exp}`;
  const encoder = new TextEncoder();
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const expectedSig = arrayBufferToHex(signature);

  // Constant-time comparison — prevents timing side-channel attacks
  return timingSafeEqual(expectedSig, sig);
}

/**
 * Converts an ArrayBuffer to a hex string.
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function arrayBufferToHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

// =============================================================================
//  R2 Video Streaming
// =============================================================================

/**
 * Proxies video streams directly from R2 with signed URL auth.
 *
 * @param {Request} request
 * @param {{ R2_BUCKET: R2Bucket, SESSION_SECRET: string }} env
 * @param {ExecutionContext} ctx
 * @param {string} videoKey
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleVideoStream(request, env, ctx, videoKey, url) {
  const authErr = await authenticate(env, videoKey, url);
  if (authErr) return authErr;

  // ─── Resolve R2 Object ─────────────────────────────────────────────
  let object = null;
  let objectKey = videoKey;
  const r2Options = buildR2Options(request);

  try {
    object = await env.R2_BUCKET.get(objectKey, r2Options);
  } catch { /* fall through */ }

  // If not found and no extension, try with .mp4
  if (!object && !objectKey.includes('.')) {
    try {
      objectKey = `${videoKey}.mp4`;
      object = await env.R2_BUCKET.get(objectKey, r2Options);
    } catch { /* fall through */ }
  }

  // ─── 304 Not Modified ──────────────────────────────────────────────
  // R2 returns null when onlyIf conditional check fails (ETag matches).
  // Respond with 304 to save bandwidth — browser already has this data.
  if (!object && r2Options.onlyIf) {
    return new Response(null, {
      status: 304,
      headers: { 'Cache-Control': 'private, max-age=86400, no-transform' },
    });
  }

  if (!object) {
    return new Response('Video not found on R2', { status: 404 });
  }

  // ─── Build Response Headers ────────────────────────────────────────
  const headers = new Headers();
  const contentType = object.httpMetadata?.contentType || getVideoMimeType(objectKey);
  headers.set('Content-Type', contentType);
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, max-age=86400, no-transform');
  headers.set('X-Content-Type-Options', 'nosniff');

  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());

  const basename = objectKey.split('/').pop() || 'video.mp4';
  headers.set('Content-Disposition', `inline; filename="${encodeBasename(basename)}"`);

  // ─── Range Response (206 Partial Content) ──────────────────────────
  if (object.range) {
    const offset = 'offset' in object.range ? object.range.offset : 0;
    const length = 'length' in object.range ? object.range.length : object.size;
    const end = offset + length - 1;

    headers.set('Content-Range', `bytes ${offset}-${end}/${object.size}`);
    headers.set('Content-Length', length.toString());

    if (request.method === 'HEAD') return new Response(null, { status: 206, headers });
    return new Response(object.body, { status: 206, headers });
  }

  // ─── Full Response (200 OK) ────────────────────────────────────────
  headers.set('Content-Length', object.size.toString());
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers });
  return new Response(object.body, { status: 200, headers });
}

// =============================================================================
//  Range Request Parsing
// =============================================================================

function buildR2Options(request) {
  const options = {};
  const rangeHeader = request.headers.get('Range');
  if (rangeHeader) {
    const parsed = parseRangeHeader(rangeHeader);
    if (parsed) options.range = parsed;
  }
  const ifNoneMatch = request.headers.get('If-None-Match');
  if (ifNoneMatch) {
    options.onlyIf = { etagDoesNotMatch: ifNoneMatch };
  }
  return options;
}

function parseRangeHeader(rangeHeader) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) return null;
  const [, startStr, endStr] = match;

  if (startStr === '' && endStr !== '') {
    const suffix = parseInt(endStr, 10);
    return (Number.isFinite(suffix) && suffix > 0) ? { suffix } : null;
  }
  if (startStr !== '' && endStr === '') {
    const offset = parseInt(startStr, 10);
    return (Number.isFinite(offset) && offset >= 0) ? { offset } : null;
  }
  if (startStr !== '' && endStr !== '') {
    const start = parseInt(startStr, 10);
    const end = parseInt(endStr, 10);
    return (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end >= start)
      ? { offset: start, length: end - start + 1 }
      : null;
  }
  return null;
}

// =============================================================================
//  Direct-to-R2 Upload Handler
// =============================================================================

async function handleDirectUpload(request, env, ctx, videoKey, url) {
  const authErr = await authenticate(env, videoKey, url);
  if (authErr) return authErr;

  const contentType = request.headers.get('Content-Type') || getVideoMimeType(videoKey);

  try {
    const object = await env.R2_BUCKET.put(videoKey, request.body, {
      httpMetadata: {
        contentType,
        cacheControl: 'public, max-age=2592000, immutable',
      },
      customMetadata: {
        uploadedAt: new Date().toISOString(),
      },
    });

    return jsonOk({
      success: true,
      key: object.key,
      size: object.size,
      etag: object.httpEtag,
    });
  } catch (err) {
    return jsonError(err.message || 'Upload failed', 500);
  }
}

// =============================================================================
//  Edge R2 Inventory & Audit Handler (with full pagination)
// =============================================================================

async function handleR2Inventory(request, env, ctx, _capturedKey, url) {
  const authErr = await authenticate(env, 'inventory', url);
  if (authErr) return authErr;

  try {
    const { files, totalBytes } = await listAllR2Objects(env.R2_BUCKET);

    return jsonOk({
      success: true,
      totalCount: files.length,
      totalBytes,
      truncated: false,
      files,
    }, 200, { 'Cache-Control': 'no-cache' });
  } catch (err) {
    return jsonError(err.message || 'Inventory failed', 500);
  }
}

/**
 * List all objects in the R2 bucket with cursor-based pagination.
 * Handles buckets with >1000 objects (R2 returns max 1000 per call).
 * @param {R2Bucket} bucket
 * @returns {Promise<{ files: object[], totalBytes: number }>}
 */
async function listAllR2Objects(bucket) {
  const files = [];
  let totalBytes = 0;
  let cursor = undefined;

  do {
    const listed = await bucket.list({ limit: 1000, cursor });
    for (const obj of listed.objects) {
      totalBytes += obj.size;
      files.push({
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded,
        etag: obj.httpEtag,
      });
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return { files, totalBytes };
}

// =============================================================================
//  Edge Fast Check Handler
// =============================================================================

async function handleR2Check(request, env, ctx, videoKey, url) {
  const authErr = await authenticate(env, videoKey, url);
  if (authErr) return authErr;

  try {
    const head = await env.R2_BUCKET.head(videoKey);
    if (!head) {
      return jsonOk({ exists: false, key: videoKey }, 404);
    }

    return jsonOk({
      exists: true,
      key: head.key,
      size: head.size,
      uploaded: head.uploaded,
    });
  } catch (err) {
    return jsonError(err.message, 500);
  }
}

// =============================================================================
//  Edge R2 Delete Batch Handler (Orphan Cleanup)
// =============================================================================

async function handleR2DeleteBatch(request, env, ctx, _capturedKey, url) {
  const authErr = await authenticate(env, 'delete-batch', url);
  if (authErr) return authErr;

  // Guard against oversized payloads
  const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (contentLength > MAX_ADMIN_BODY_SIZE) {
    return jsonError('Request body too large', 413);
  }

  try {
    const body = await request.json();
    const keys = body && Array.isArray(body.keys) ? body.keys : [];

    if (keys.length === 0) {
      return jsonError('No keys provided', 400);
    }

    // Parallel deletion with concurrency limit
    const safeKeys = keys.slice(0, 100);
    const deleted = [];
    const failed = [];

    for (let i = 0; i < safeKeys.length; i += DELETE_BATCH_CONCURRENCY) {
      const batch = safeKeys.slice(i, i + DELETE_BATCH_CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async (key) => {
          const k = typeof key === 'string' ? key.trim() : '';
          if (!k) return null;
          await env.R2_BUCKET.delete(k);
          return k;
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          deleted.push(r.value);
        } else if (r.status === 'rejected') {
          failed.push(r.reason?.message || 'Unknown error');
        }
      }
    }

    return jsonOk({
      success: true,
      deletedCount: deleted.length,
      deleted,
      failedCount: failed.length,
      failed: failed.length > 0 ? failed : undefined,
    });
  } catch (err) {
    return jsonError(err.message || 'Delete failed', 500);
  }
}

// =============================================================================
//  CORS — Restricted to allowed origins
// =============================================================================

/**
 * Check if an origin is in the whitelist.
 * @param {string|null} origin
 * @returns {boolean}
 */
function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGINS.has(origin);
}

function handleCors(request) {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, PUT, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Range, If-None-Match, X-Requested-With',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function addCorsHeaders(response, request) {
  const origin = request.headers.get('Origin');
  // Only add CORS headers if origin is allowed (or same-origin requests with no Origin header)
  const allowedOrigin = isAllowedOrigin(origin) ? origin : null;
  if (!allowedOrigin) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// =============================================================================
//  Utilities
// =============================================================================

function getVideoMimeType(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'video/mp4';
  return VIDEO_MIME_MAP[filename.slice(dot).toLowerCase()] || 'video/mp4';
}

function encodeBasename(name) {
  return name.replace(/["\\\\r\n\x00-\x1F\x7F]/g, '_');
}

// =============================================================================
//  Edge WebRTC Call Signaling WebSocket Handler
// =============================================================================

// NOTE: connectedCallUsers lives in module-level memory and does NOT survive
// isolate eviction (cold starts, scaling). Cloudflare can evict isolates at any
// time, silently breaking active WebSocket connections. The client-side call UI
// must handle reconnection gracefully. For durable WebSocket state, use Durable
// Objects (which this project already has infrastructure for via Watch Together).
const connectedCallUsers = new Map(); // username -> Set<WebSocket>

async function handleCallSignalingWebSocket(request, env, ctx, _capturedKey, url) {
  const user = url.searchParams.get('user');
  if (!user || (user !== 'muaj' && user !== 'hajera')) {
    return new Response('Invalid user', { status: 400 });
  }

  // Mandatory signed token validation — consistent with all other handlers
  if (!env.SESSION_SECRET) {
    return new Response('Server misconfigured', { status: 500 });
  }
  const isValid = await validateSignedUrl(`call:${user}`, url.searchParams, env.SESSION_SECRET);
  if (!isValid) {
    return new Response('Unauthorized token', { status: 401 });
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();

  if (!connectedCallUsers.has(user)) {
    connectedCallUsers.set(user, new Set());
  }
  connectedCallUsers.get(user).add(server);

  const partner = user === 'muaj' ? 'hajera' : 'muaj';

  // ─── Idle timeout — close stale connections after 5 minutes of silence ─
  let lastActivity = Date.now();
  const idleTimer = setInterval(() => {
    if (Date.now() - lastActivity > CALL_WS_IDLE_TIMEOUT_MS) {
      try { server.close(1000, 'Idle timeout'); } catch {}
      clearInterval(idleTimer);
    }
  }, 30000);

  server.addEventListener('message', async (event) => {
    lastActivity = Date.now();
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'ping') {
        server.send(JSON.stringify({ type: 'pong', ts: Date.now() }));
        return;
      }

      // Forward signal directly to partner
      const partnerSockets = connectedCallUsers.get(partner);
      if (partnerSockets && partnerSockets.size > 0) {
        const payload = JSON.stringify({ ...data, sender: user, ts: Date.now() });
        for (const sock of partnerSockets) {
          try {
            sock.send(payload);
          } catch (e) {
            partnerSockets.delete(sock);
          }
        }
      }
    } catch (err) {
      // ignore parsing error
    }
  });

  const cleanup = () => {
    clearInterval(idleTimer);
    const sockets = connectedCallUsers.get(user);
    if (sockets) {
      sockets.delete(server);
      if (sockets.size === 0) connectedCallUsers.delete(user);
    }
  };

  server.addEventListener('close', cleanup);
  server.addEventListener('error', cleanup);

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
