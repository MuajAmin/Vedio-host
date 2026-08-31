// =============================================================================
//  VideoHost — Cloudflare Edge Worker
//  - R2 Video CDN with Signed URL authentication
//  - [Feature 1] On-the-Fly Image & Thumbnail Optimization
//  - [Feature 2] Zero-Downtime Auto-Failover Maintenance Mode
//  - [Feature 3] Edge Caching for Static Assets & Security Headers
//  - WebRTC Call Signaling WebSocket Bridge
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

/** MIME type mapping for image file extensions. */
const IMAGE_MIME_MAP = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** Valid video key pattern — UUID with optional extension. */
const VIDEO_KEY_RE = /^\/stream\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i;

/** Valid upload key pattern — same as video key. */
const UPLOAD_KEY_RE = /^\/upload\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i;

/** Valid R2 check key pattern — same as video key. */
const R2_CHECK_KEY_RE = /^\/api\/r2-check\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i;

/** Valid image / thumbnail optimization route pattern — supports URL-encoded and nested keys. */
const IMAGE_OPT_KEY_RE = /^\/(?:img-opt|thumbnail-opt)\/([a-zA-Z0-9_.\-\/%~+@]+)$/;

/** HTTP status codes that MUST NOT contain a message body per WHATWG Fetch spec. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** Allowed CORS origins — restrict to our own domain. */
const ALLOWED_ORIGINS = new Set([
  'https://muaj.bro.bd',
  'https://www.muaj.bro.bd',
]);

/** Static file extensions for edge caching. */
const STATIC_EXTENSIONS = new Set([
  '.css', '.js', '.mjs', '.map',
  '.woff', '.woff2', '.ttf', '.eot', '.otf',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.svg', '.ico',
  '.webmanifest', '.json', '.xml', '.txt'
]);

const STATIC_PREFIXES = ['/css/', '/js/', '/fonts/', '/icons/', '/img/', '/images/', '/favicon.ico', '/robots.txt', '/manifest.json'];

/** Private / dynamic path prefixes and sensitive files that MUST NEVER be edge-cached. */
const DYNAMIC_OR_PRIVATE_PREFIXES = [
  '/sw.js',
  '/thumbnails/',
  '/avatars/',
  '/voice/',
  '/stream/',
  '/upload',
  '/api/',
  '/messages',
  '/watch-together',
  '/import',
  '/call',
  '/admin',
  '/login',
  '/logout',
  '/dashboard',
  '/watch/',
  '/profile',
  '/comment/',
  '/delete/',
  '/rename/',
  '/health'
];

/** WebSocket idle timeout for call signaling (5 minutes). */
const CALL_WS_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Max request body size for admin endpoints (100 KB). */
const MAX_ADMIN_BODY_SIZE = 100 * 1024;

/** Batch delete parallelism limit. */
const DELETE_BATCH_CONCURRENCY = 10;

// ─── 103 Early Hints Resources ──────────────────────────────────────────────
// ASSET_VERSION must stay in sync with ASSET_VERSION in utils/assets.js.
// If the Worker preloads a different ?v= than the page actually requests, the
// browser downloads the same file twice and the preload is wasted. CI enforces
// that these two values match.
const ASSET_VERSION = '14.8';
const v = (p) => `${p}?v=${ASSET_VERSION}`;

const GLOBAL_EARLY_HINT_LINKS = [
  `<${v('/css/style.css')}>; rel=preload; as=style`,
  `<${v('/css/design-system.css')}>; rel=preload; as=style`,
  `<${v('/js/theme-init.js')}>; rel=preload; as=script`,
  `<${v('/js/app.js')}>; rel=preload; as=script`,
  `<${v('/js/twemoji.min.js')}>; rel=preload; as=script`,
  `<${v('/js/whatsapp-emojis.js')}>; rel=preload; as=script`,
  '<https://fonts.googleapis.com>; rel=preconnect',
  '<https://fonts.gstatic.com>; rel=preconnect; crossorigin',
  '<https://cdn.jsdelivr.net>; rel=preconnect'
];

// Realtime (messaging + calling) assets load on every authenticated page,
// because incoming calls and messages must be received from any page — not
// only /messages. Preloading them globally matches actual page behaviour.
const MESSAGES_EARLY_HINT_LINKS = [
  `<${v('/css/messages.css')}>; rel=preload; as=style`,
  `<${v('/css/calling.css')}>; rel=preload; as=style`,
  `<${v('/js/messages.js')}>; rel=preload; as=script`,
  `<${v('/js/calling.js')}>; rel=preload; as=script`,
  `<${v('/js/watchTogether.js')}>; rel=preload; as=script`
];

/**
 * Returns Link header value containing Early Hints preload/preconnect directives
 * for the requested HTML page.
 * @param {string} pathname
 * @returns {string}
 */
function getEarlyHintLinkHeader(pathname) {
  // Realtime assets are referenced by layout.ejs on every authenticated page
  // (so incoming calls/messages work site-wide), not just under /messages.
  // Restricting the hint to those prefixes meant most navigations discovered
  // messages.js / calling.js late in the waterfall.
  const links = [...GLOBAL_EARLY_HINT_LINKS, ...MESSAGES_EARLY_HINT_LINKS];
  return links.join(', ');
}

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
  // Edge image/thumbnail optimizer
  {
    method: ['GET', 'HEAD'],
    pattern: IMAGE_OPT_KEY_RE,
    handler: handleImageOptimization,
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
  // Edge Watch Progress & Presence Tracker (Hajera / Muaj)
  {
    method: 'POST',
    pattern: '/api/edge-watch-progress',
    handler: handleEdgeWatchProgress,
  },
  // Edge Live Presence for Admin Dashboard
  {
    method: 'GET',
    pattern: '/api/edge-presence-live',
    handler: handleEdgePresenceLive,
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

/**
 * Checks whether a given request path is a public static asset suitable for Edge Caching.
 * @param {string} pathname
 * @returns {boolean}
 */
function isStaticAsset(pathname) {
  // 1. Explicitly reject any private, authenticated, streaming, or dynamic paths
  if (DYNAMIC_OR_PRIVATE_PREFIXES.some(p => pathname.startsWith(p))) {
    return false;
  }

  // 2. Check known static directory prefixes
  if (STATIC_PREFIXES.some(p => pathname.startsWith(p))) {
    return true;
  }

  // 3. Check static file extensions for public files
  const dot = pathname.lastIndexOf('.');
  if (dot !== -1) {
    const ext = pathname.slice(dot).toLowerCase();
    if (STATIC_EXTENSIONS.has(ext)) {
      return true;
    }
  }

  return false;
}

// =============================================================================
//  Entry Point
// =============================================================================

export default {
  /**
   * @param {Request} request
   * @param {{ R2_BUCKET?: R2Bucket, SESSION_SECRET?: string, WORKER_HMAC_SECRET?: string, ORIGIN_URL?: string }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── Loop protection ──────────────────────────────────────────────
    if (request.headers.get('X-Edge-Worker-Loop')) {
      return new Response('Proxy loop detected at Edge. Check ORIGIN_URL configuration.', { status: 508 });
    }

    // ─── CORS preflight ──────────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return handleCors(request);
    }

    // ─── 1. Route matching (Edge-specific endpoints) ──────────────────
    const found = matchRoute(request.method, url.pathname);
    if (found) {
      const { route, match } = found;

      // Special case: WebSocket upgrade check
      if (url.pathname === '/call-signaling' && request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }

      // Extract capture group (videoKey / imageKey) if regex matched and safely decode
      let capturedKey = null;
      if (match && match[1]) {
        try {
          capturedKey = decodeURIComponent(match[1]);
        } catch {
          return jsonError('Invalid URL encoding in request path', 400);
        }
      }
      const response = await route.handler(request, env, ctx, capturedKey, url);
      return addCorsHeaders(response, request);
    }

    // ─── 2. Feature 3: Static Asset Edge Caching ─────────────────────
    if (request.method === 'GET' && isStaticAsset(url.pathname)) {
      const staticResponse = await handleStaticAsset(request, env, ctx, url);
      return addCorsHeaders(staticResponse, request);
    }

    // ─── 3. Feature 2: Origin Pass-Through & Auto-Failover ───────────
    const originResponse = await handleOriginWithFailover(request, env, ctx, url);
    return addCorsHeaders(originResponse, request);
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
 * @param {{ SESSION_SECRET?: string, WORKER_HMAC_SECRET?: string, R2_BUCKET?: R2Bucket }} env
 * @param {string} signatureKey - The key used in HMAC signature (videoKey, 'inventory', etc.)
 * @param {URL} url
 * @param {{ requireR2?: boolean }} [options]
 * @returns {Promise<Response|null>}
 */
async function authenticate(env, signatureKey, url, options = {}) {
  const { requireR2 = true } = options;
  // Prefer WORKER_HMAC_SECRET (defense-in-depth), fall back to SESSION_SECRET for backward compat
  const secret = env.WORKER_HMAC_SECRET || env.SESSION_SECRET;
  if (!secret) {
    return jsonError('Server misconfigured — no auth secret', 500);
  }
  const isValid = await validateSignedUrl(signatureKey, url.searchParams, secret);
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

  // Constant-time comparison — prevents timing side-channel attacks (case-insensitive hex comparison)
  return timingSafeEqual(expectedSig, String(sig).toLowerCase());
}

/**
 * Validates an image optimization signed URL token.
 * Canonical payload covers: filename/key, width, height, quality, format, expiry.
 *
 * @param {string} imageKey - The image filename/key
 * @param {URLSearchParams} params - Query parameters (sig, exp, w, h, q, format)
 * @param {string} secret - The shared SESSION_SECRET or WORKER_HMAC_SECRET
 * @returns {Promise<{ valid: boolean, error?: string, width?: number, height?: number, quality?: number, format?: string }>}
 */
async function validateImageSignedUrl(imageKey, params, secret) {
  const sig = params.get('sig');
  const exp = params.get('exp');

  if (!sig || !exp) {
    return { valid: false, error: 'Unauthorized — missing signature or expiry token' };
  }

  const expiryTs = parseInt(exp, 10);
  if (!Number.isFinite(expiryTs) || Date.now() > expiryTs * 1000) {
    return { valid: false, error: 'Unauthorized — token has expired' };
  }

  // Parse and validate parameters with strict boundaries
  const rawW = params.get('w');
  const rawH = params.get('h');
  const rawQ = params.get('q');
  const rawF = params.get('format');

  const width = rawW ? parseInt(rawW, 10) : 480;
  const height = rawH ? parseInt(rawH, 10) : 0;
  const quality = rawQ ? parseInt(rawQ, 10) : 80;
  const format = rawF ? String(rawF).toLowerCase() : 'webp';

  if (!Number.isInteger(width) || width < 16 || width > 1920) {
    return { valid: false, error: 'Invalid width: must be between 16 and 1920' };
  }
  if (!Number.isInteger(height) || height < 0 || height > 1920) {
    return { valid: false, error: 'Invalid height: must be between 0 and 1920' };
  }
  if (!Number.isInteger(quality) || quality < 10 || quality > 100) {
    return { valid: false, error: 'Invalid quality: must be between 10 and 100' };
  }
  const allowedFormats = new Set(['webp', 'avif', 'jpeg', 'png', 'auto']);
  if (!allowedFormats.has(format)) {
    return { valid: false, error: 'Invalid format: must be webp, avif, jpeg, png, or auto' };
  }

  // Canonical HMAC signature check: ${imageKey}:${width}:${height}:${quality}:${format}:${exp}
  const message = `${imageKey}:${width}:${height}:${quality}:${format}:${exp}`;
  const encoder = new TextEncoder();
  const key = await getHmacKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const expectedSig = arrayBufferToHex(signature);

  if (!timingSafeEqual(expectedSig, String(sig).toLowerCase())) {
    return { valid: false, error: 'Unauthorized — invalid signature or parameter tampering detected' };
  }

  return { valid: true, width, height, quality, format };
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
  if (typeof a !== 'string' || typeof b !== 'string') return false;
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
  // RFC 7232 requires 304 to include ETag and Cache-Control headers.
  if (!object && r2Options.onlyIf) {
    const notModHeaders = new Headers();
    notModHeaders.set('Cache-Control', 'public, max-age=86400, no-transform');
    // Pass through If-None-Match as ETag so browser can continue validating
    const ifNoneMatch = request.headers.get('If-None-Match');
    if (ifNoneMatch) notModHeaders.set('ETag', ifNoneMatch);
    return new Response(null, {
      status: 304,
      headers: notModHeaders,
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
  // Allow Cloudflare edge to cache video responses — signed URL ensures only authorized clients get them
  headers.set('Cache-Control', 'public, max-age=31536000, immutable, no-transform');
  headers.set('X-Content-Type-Options', 'nosniff');

  if (object.httpEtag) headers.set('ETag', object.httpEtag);
  if (object.uploaded) headers.set('Last-Modified', object.uploaded.toUTCString());

  const basename = objectKey.split('/').pop() || 'video.mp4';
  headers.set('Content-Disposition', `inline; filename="${encodeBasename(basename)}"`);

  // ─── Range Response (206 Partial Content) ──────────────────────────
  if (object.range) {
    let offset = 0;
    let length = object.size;
    if ('offset' in object.range) {
      offset = object.range.offset;
      length = 'length' in object.range ? object.range.length : (object.size - offset);
    } else if ('suffix' in object.range) {
      offset = Math.max(0, object.size - object.range.suffix);
      length = Math.min(object.range.suffix, object.size);
    }
    const end = Math.min(object.size - 1, Math.max(offset, offset + length - 1));

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
//  [Feature 1] Image & Thumbnail Optimization Handler
// =============================================================================

/**
 * On-the-fly Image/Thumbnail Optimizer with WebP/AVIF support and Edge Caching.
 * - Mandatory HMAC verification protecting key, dimensions, quality, and format.
 * - Bounds check on all transformation parameters (16..1920 width, 10..100 quality).
 * - Cache key deterministically reflects: source + width + height + quality + format.
 * - Uses Cloudflare Image Resizing when available, or serves R2/Origin with optimal headers.
 *
 * @param {Request} request
 * @param {{ R2_BUCKET?: R2Bucket, SESSION_SECRET?: string, WORKER_HMAC_SECRET?: string, ORIGIN_URL?: string }} env
 * @param {ExecutionContext} ctx
 * @param {string} imageKey
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleImageOptimization(request, env, ctx, imageKey, url) {
  // Path traversal guard
  if (!imageKey || imageKey.includes('..') || imageKey.startsWith('/') || imageKey.includes('\\')) {
    return jsonError('Invalid image key', 400);
  }

  const secret = env.WORKER_HMAC_SECRET || env.SESSION_SECRET;
  if (!secret) {
    return jsonError('Server misconfigured — missing signature secret', 500);
  }

  // 1. Mandatory HMAC Token & Parameter Validation
  const auth = await validateImageSignedUrl(imageKey, url.searchParams, secret);
  if (!auth.valid) {
    return jsonError(auth.error || 'Unauthorized', 401);
  }

  const { width, height, quality, format } = auth;

  // 2. Deterministic Edge Cache Key (Source + Dimensions + Quality + Format)
  const cacheParams = new URLSearchParams();
  cacheParams.set('w', width.toString());
  if (height > 0) cacheParams.set('h', height.toString());
  cacheParams.set('q', quality.toString());
  cacheParams.set('format', format);

  const cacheKeyUrl = `${url.origin}/img-opt/${encodeURIComponent(imageKey)}?${cacheParams.toString()}`;
  const cacheKey = new Request(cacheKeyUrl, {
    method: 'GET',
    headers: { 'Accept': request.headers.get('Accept') || '' }
  });

  const cache = caches.default;
  let cached = await cache.match(cacheKey);
  if (cached) {
    const headers = new Headers(cached.headers);
    headers.set('CF-Edge-Cache', 'HIT');
    return new Response(cached.body, { status: cached.status, headers });
  }

  let imageResponse = null;

  // 3. Transformation via Cloudflare Image Resizing subrequest
  const originBase = env.ORIGIN_URL || 'https://origin.muaj.bro.bd';
  const sourceSubpath = (imageKey.startsWith('avatars/') || imageKey.startsWith('thumbnails/'))
    ? `/${imageKey}`
    : `/thumbnails/${imageKey}`;
  const sourceUrl = new URL(sourceSubpath, originBase);

  const originHeaders = new Headers(request.headers);
  originHeaders.set('X-Edge-Worker-Loop', '1');
  originHeaders.set('Host', 'muaj.bro.bd');

  const resizeOptions = {
    method: 'GET',
    headers: originHeaders,
    cf: {
      image: {
        width,
        height: height > 0 ? height : undefined,
        quality,
        format: format === 'auto' ? 'auto' : format,
        fit: 'scale-down',
        metadata: 'none',
      },
    },
  };

  try {
    const resizedRes = await fetch(sourceUrl.toString(), resizeOptions);
    if (resizedRes.ok) {
      imageResponse = resizedRes;
    }
  } catch {}

  // 4. Fallback: Fetch directly from R2 if Cloudflare Image Resizing is not active
  if (!imageResponse && env.R2_BUCKET) {
    try {
      let obj = await env.R2_BUCKET.get(imageKey);
      if (!obj && !imageKey.startsWith('thumbnails/')) {
        obj = await env.R2_BUCKET.get(`thumbnails/${imageKey}`);
      }
      if (!obj && !imageKey.startsWith('avatars/')) {
        obj = await env.R2_BUCKET.get(`avatars/${imageKey}`);
      }
      if (obj) {
        const mime = obj.httpMetadata?.contentType || getImageMimeType(imageKey);
        const headers = new Headers();
        headers.set('Content-Type', mime);
        if (obj.httpEtag) headers.set('ETag', obj.httpEtag);
        if (obj.uploaded) headers.set('Last-Modified', obj.uploaded.toUTCString());
        imageResponse = new Response(obj.body, { headers });
      }
    } catch {}
  }

  // 5. Fallback: Fetch from Origin Server directly
  if (!imageResponse) {
    try {
      const fallbackRes = await fetch(sourceUrl.toString(), {
        headers: originHeaders,
        signal: AbortSignal.timeout(10000),
      });
      if (fallbackRes.ok) {
        imageResponse = fallbackRes;
      }
    } catch {}
  }

  if (!imageResponse) {
    return new Response('Image not found', { status: 404 });
  }

  // 6. Cache-Control Strategy:
  // - UUID/content-hashed thumbnails: immutable (30 days)
  // - Mutable avatars (e.g. user profile avatars): 1 day with stale-while-revalidate
  const isVersionedKey = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}/i.test(imageKey) || imageKey.includes('_v');
  const cacheControlValue = isVersionedKey
    ? 'public, max-age=2592000, immutable'
    : 'public, max-age=86400, stale-while-revalidate=43200';

  const responseHeaders = new Headers(imageResponse.headers);
  responseHeaders.set('Cache-Control', cacheControlValue);
  responseHeaders.set('Vary', 'Accept');
  responseHeaders.set('CF-Edge-Cache', 'MISS');
  applyEdgeSecurityHeaders(responseHeaders);

  const finalResponse = new Response(imageResponse.body, {
    status: 200,
    headers: responseHeaders,
  });

  // Store in Cloudflare Edge Cache
  ctx.waitUntil(cache.put(cacheKey, finalResponse.clone()));
  return finalResponse;
}

// =============================================================================
//  [Feature 3] Static Asset Edge Caching Handler
// =============================================================================

/**
 * Handles caching of CSS, JS, fonts, and images at the Cloudflare Edge.
 * Guards against caching any private or authenticated responses.
 * @param {Request} request
 * @param {{ ORIGIN_URL?: string }} env
 * @param {ExecutionContext} ctx
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleStaticAsset(request, env, ctx, url) {
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), {
    method: 'GET',
    headers: { 'Accept-Encoding': request.headers.get('Accept-Encoding') || '' }
  });

  // 1. Check Cloudflare Edge Cache
  let cached = await cache.match(cacheKey);
  if (cached) {
    // Conditional GET: Respond 304 if ETag matches
    const ifNoneMatch = request.headers.get('If-None-Match');
    const cachedEtag = cached.headers.get('ETag');
    if (ifNoneMatch && cachedEtag && ifNoneMatch === cachedEtag) {
      const notModHeaders = new Headers(cached.headers);
      notModHeaders.set('CF-Edge-Cache', 'HIT');
      return new Response(null, { status: 304, headers: notModHeaders });
    }

    const headers = new Headers(cached.headers);
    headers.set('CF-Edge-Cache', 'HIT');
    const isNullBody = NULL_BODY_STATUSES.has(cached.status) || request.method === 'HEAD';
    return new Response(isNullBody ? null : cached.body, {
      status: cached.status,
      statusText: cached.statusText,
      headers,
    });
  }

  // 2. Fetch from Origin with loop protection
  const originBase = env.ORIGIN_URL || 'https://origin.muaj.bro.bd';
  const originUrl = new URL(url.pathname + url.search, originBase);

  const originHeaders = new Headers(request.headers);
  originHeaders.set('X-Edge-Worker-Loop', '1');
  originHeaders.set('Host', 'muaj.bro.bd');

  try {
    const originResponse = await fetch(originUrl.toString(), {
      method: request.method,
      headers: originHeaders,
      signal: AbortSignal.timeout(10000),
    });

    if (!originResponse.ok) {
      if ([502, 503, 504].includes(originResponse.status)) {
        return renderFailoverResponse(request, originResponse.status);
      }
      return originResponse;
    }

    const originCc = (originResponse.headers.get('Cache-Control') || '').toLowerCase();
    const hasSetCookie = originResponse.headers.has('Set-Cookie');

    // Security Guard: Never publicly cache private, no-store, no-cache, or cookie-setting responses
    const isPrivate = originCc.includes('private') ||
                      originCc.includes('no-store') ||
                      originCc.includes('no-cache') ||
                      hasSetCookie;

    const headers = new Headers(originResponse.headers);
    headers.set('CF-Edge-Cache', 'MISS');
    applyEdgeSecurityHeaders(headers);

    if (!isPrivate && originResponse.status === 200) {
      // Safe public static asset — cache at Edge for 7 days
      headers.set('Cache-Control', 'public, max-age=604800, stale-while-revalidate=86400');
      const responseToCache = new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers,
      });

      ctx.waitUntil(cache.put(cacheKey, responseToCache.clone()));
      return responseToCache;
    }

    // If private or non-200, return directly without inserting into public cache (safely handle null-body status)
    const isNullBody = NULL_BODY_STATUSES.has(originResponse.status) || request.method === 'HEAD';
    return new Response(isNullBody ? null : originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers,
    });
  } catch (err) {
    return renderFailoverResponse(request, 503, err.message);
  }
}

// =============================================================================
//  [Feature 2] Origin Pass-Through & Auto-Failover Maintenance Mode
// =============================================================================

/** Long-running routes that must NOT be aborted by a short failover timeout. */
const LONG_RUNNING_PREFIXES = [
  '/upload',
  '/api/upload',
  '/import-url',
  '/import-progress',
  '/messages/stream',
  '/watch-together/stream',
  '/api/r2-progress',
  '/api/call/events',
  '/download/'
];

/**
 * Forwards requests to Origin VPS and catches 502/503/504/timeout with a maintenance page.
 * Preserves streaming request bodies and long-running SSE connections.
 * @param {Request} request
 * @param {{ ORIGIN_URL?: string }} env
 * @param {ExecutionContext} ctx
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleOriginWithFailover(request, env, ctx, url) {
  const originBase = env.ORIGIN_URL || 'https://origin.muaj.bro.bd';
  const targetUrl = new URL(url.pathname + url.search, originBase);

  // Preserve request headers & attach forwarding & loop-protection headers
  const headers = new Headers(request.headers);
  headers.set('X-Edge-Worker-Loop', '1');
  headers.set('X-Forwarded-Host', url.host);
  headers.set('X-Forwarded-Proto', url.protocol.replace(':', ''));
  headers.set('Host', 'muaj.bro.bd');

  const isLongRunning = LONG_RUNNING_PREFIXES.some(p => url.pathname.startsWith(p));
  const isStreamBody = !['GET', 'HEAD'].includes(request.method) && request.body;

  const fetchOpts = {
    method: request.method,
    headers,
    body: isStreamBody ? request.body : null,
    redirect: 'manual',
  };

  // Cloudflare Workers requires duplex: 'half' when request.body is a ReadableStream
  if (isStreamBody) {
    fetchOpts.duplex = 'half';
  }

  // Only apply failover timeout to ordinary short-lived requests (15s); never abort uploads or SSE streams
  if (!isLongRunning) {
    fetchOpts.signal = AbortSignal.timeout(15000);
  }

  try {
    const originResponse = await fetch(targetUrl.toString(), fetchOpts);

    // Failover only on infrastructure availability errors (502/503/504)
    // NEVER intercept ordinary application-level 500 errors
    if ([502, 503, 504].includes(originResponse.status)) {
      return renderFailoverResponse(request, originResponse.status);
    }

    // Apply security headers to live response
    const newHeaders = new Headers(originResponse.headers);
    applyEdgeSecurityHeaders(newHeaders);

    // Apply 103 Early Hints Link header to HTML page navigation responses
    const contentType = (newHeaders.get('Content-Type') || '').toLowerCase();
    if (request.method === 'GET' && (contentType.includes('text/html') || !contentType)) {
      const earlyHints = getEarlyHintLinkHeader(url.pathname);
      const existingLink = newHeaders.get('Link');
      newHeaders.set('Link', existingLink ? `${existingLink}, ${earlyHints}` : earlyHints);
    }

    // Safely construct Response without throwing TypeError on null-body statuses (304, 204, etc.)
    const isNullBody = NULL_BODY_STATUSES.has(originResponse.status) || request.method === 'HEAD';
    return new Response(isNullBody ? null : originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: newHeaders,
    });
  } catch (err) {
    // Network level error / Connection refused / Gateway Timeout
    return renderFailoverResponse(request, 503, err.message);
  }
}

/**
 * Returns either an aesthetic HTML Maintenance Page or a JSON/text error on server downtime.
 * Guarantees API and media endpoints never receive HTML payloads.
 * @param {Request} request
 * @param {number} status
 * @param {string} [detail]
 * @returns {Response}
 */
function renderFailoverResponse(request, status = 503, detail = '') {
  const url = new URL(request.url);
  const accept = request.headers.get('Accept') || '';
  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/call') || accept.includes('application/json');
  const isHtml = accept.includes('text/html') && !isApi;

  if (isHtml && request.method === 'GET') {
    return new Response(getMaintenanceHtml(), {
      status: 503,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, no-cache, must-revalidate',
        'Retry-After': '5',
      },
    });
  }

  if (isApi) {
    return jsonError('Server is temporarily undergoing maintenance or restarting. Please retry in a few seconds.', 503);
  }

  return new Response('503 Service Temporarily Unavailable — Server is undergoing maintenance', {
    status: 503,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Retry-After': '5',
    },
  });
}

/**
 * Generates the animated, dark-mode Maintenance HTML with smart /health polling.
 * @returns {string}
 */
function getMaintenanceHtml() {
  return `<!DOCTYPE html>
<html lang="bn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>সার্ভার আপডেট চলছে • VideoHost</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: rgba(18, 20, 29, 0.88);
      --card-border: rgba(255, 255, 255, 0.09);
      --primary: #6366f1;
      --primary-glow: rgba(99, 102, 241, 0.35);
      --accent: #ec4899;
      --text: #f8fafc;
      --text-muted: #94a3b8;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at top center, #1e1b4b 0%, #090a0f 65%);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .maintenance-card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border-radius: 1.5rem;
      padding: 2.5rem 2rem;
      max-width: 480px;
      width: 100%;
      text-align: center;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7), 0 0 30px var(--primary-glow);
      animation: floatIn 0.8s cubic-bezier(0.16, 1, 0.3, 1);
    }
    @keyframes floatIn {
      from { opacity: 0; transform: translateY(20px) scale(0.96); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .icon-container {
      position: relative;
      width: 80px;
      height: 80px;
      margin: 0 auto 1.5rem;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .pulse-ring {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: var(--primary);
      opacity: 0.3;
      animation: pulseRing 2s infinite cubic-bezier(0.4, 0, 0.6, 1);
    }
    @keyframes pulseRing {
      0% { transform: scale(0.8); opacity: 0.6; }
      100% { transform: scale(1.6); opacity: 0; }
    }
    .icon-box {
      position: relative;
      width: 64px;
      height: 64px;
      background: linear-gradient(135deg, var(--primary), var(--accent));
      border-radius: 1rem;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 10px 20px rgba(99, 102, 241, 0.4);
    }
    .icon-box svg {
      width: 32px;
      height: 32px;
      fill: none;
      stroke: white;
      stroke-width: 2;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    h1 {
      font-size: 1.5rem;
      font-weight: 700;
      margin-bottom: 0.5rem;
      background: linear-gradient(to right, #ffffff, #cbd5e1);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      color: var(--text-muted);
      font-size: 0.95rem;
      line-height: 1.5;
      margin-bottom: 1.75rem;
    }
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.5rem;
      padding: 0.4rem 0.9rem;
      border-radius: 9999px;
      background: rgba(99, 102, 241, 0.12);
      border: 1px solid rgba(99, 102, 241, 0.3);
      color: #a5b4fc;
      font-size: 0.82rem;
      font-weight: 500;
      margin-bottom: 1.75rem;
      transition: all 0.3s ease;
    }
    .status-badge.online {
      background: rgba(16, 185, 129, 0.15);
      border-color: rgba(16, 185, 129, 0.4);
      color: #34d399;
    }
    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f59e0b;
      box-shadow: 0 0 8px #f59e0b;
      animation: blink 1.5s infinite;
    }
    .status-badge.online .status-dot {
      background: #10b981;
      box-shadow: 0 0 8px #10b981;
    }
    @keyframes blink {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    .retry-bar-container {
      background: rgba(255, 255, 255, 0.05);
      border-radius: 9999px;
      height: 6px;
      overflow: hidden;
      margin-bottom: 1.5rem;
      position: relative;
    }
    .retry-bar {
      height: 100%;
      background: linear-gradient(90deg, var(--primary), var(--accent));
      width: 0%;
      border-radius: 9999px;
      transition: width 1s linear;
    }
    .btn-retry {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
      background: linear-gradient(135deg, #4f46e5, #6366f1);
      color: white;
      border: none;
      padding: 0.75rem 1.5rem;
      border-radius: 0.75rem;
      font-size: 0.95rem;
      font-weight: 600;
      cursor: pointer;
      width: 100%;
      transition: all 0.2s ease;
      box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
    }
    .btn-retry:hover {
      transform: translateY(-1px);
      box-shadow: 0 6px 20px rgba(99, 102, 241, 0.45);
    }
    .btn-retry:active {
      transform: translateY(1px);
    }
    .btn-retry:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="maintenance-card">
    <div class="icon-container">
      <div class="pulse-ring"></div>
      <div class="icon-box">
        <svg viewBox="0 0 24 24"><path d="M12 2v4m0 12v4M4.93 4.93l2.83 2.83m8.48 8.48l2.83 2.83M2 12h4m12 0h4M4.93 19.07l2.83-2.83m8.48-8.48l2.83-2.83"/></svg>
      </div>
    </div>
    <h1>সার্ভার আপডেট চলছে</h1>
    <p class="subtitle">VideoHost সার্ভারে একটি দ্রুত রক্ষণাবেক্ষণ/রিস্টার্ট চলছে। পেজটি স্বয়ংক্রিয়ভাবে রিকানেক্ট হবে।</p>
    <div class="status-badge" id="statusBadge">
      <span class="status-dot"></span>
      <span id="statusText">Checking server in <strong id="countdown">5</strong>s...</span>
    </div>
    <div class="retry-bar-container">
      <div class="retry-bar" id="progressBar"></div>
    </div>
    <button class="btn-retry" id="reloadBtn" onclick="manualCheck()">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg>
      <span>এখনই রিলোড দিন (Reload Now)</span>
    </button>
  </div>
  <script>
    const INTERVAL = 5;
    let timeLeft = INTERVAL;
    const countdownEl = document.getElementById('countdown');
    const progressBar = document.getElementById('progressBar');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const reloadBtn = document.getElementById('reloadBtn');
    let isChecking = false;

    async function checkHealth() {
      if (isChecking) return;
      isChecking = true;
      try {
        const res = await fetch('/health?ts=' + Date.now(), {
          cache: 'no-store',
          signal: AbortSignal.timeout(3500)
        });
        if (res.ok) {
          const data = await res.json().catch(() => ({ status: 'ok' }));
          if (data && data.status === 'ok') {
            statusBadge.classList.add('online');
            statusText.textContent = 'সার্ভার অনলাইন! পেজ লোড হচ্ছে...';
            setTimeout(() => { window.location.reload(); }, 600);
            return true;
          }
        }
      } catch (e) {
        // Server still unreachable
      } finally {
        isChecking = false;
      }
      return false;
    }

    async function manualCheck() {
      if (reloadBtn) reloadBtn.disabled = true;
      statusText.textContent = 'সার্ভার চেক করা হচ্ছে...';
      const isUp = await checkHealth();
      if (!isUp) {
        statusText.innerHTML = 'সার্ভার এখনও প্রস্তুত নয়। আবার <strong id="countdown">5</strong>s পরে চেষ্টা করা হবে...';
        timeLeft = INTERVAL;
        if (reloadBtn) reloadBtn.disabled = false;
      }
    }

    setInterval(async () => {
      if (document.hidden) return; // Pause polling when tab is inactive
      timeLeft--;
      if (countdownEl && timeLeft > 0) countdownEl.textContent = timeLeft;
      if (progressBar) progressBar.style.width = ((INTERVAL - timeLeft) / INTERVAL * 100) + '%';
      if (timeLeft <= 0) {
        timeLeft = INTERVAL;
        if (progressBar) progressBar.style.width = '0%';
        await checkHealth();
      }
    }, 1000);
  </script>
</body>
</html>`;
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
    let head = await env.R2_BUCKET.head(videoKey);
    if (!head && !videoKey.includes('.')) {
      head = await env.R2_BUCKET.head(`${videoKey}.mp4`);
    }
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
  const callSecret = env.WORKER_HMAC_SECRET || env.SESSION_SECRET;
  if (!callSecret) {
    return new Response('Server misconfigured', { status: 500 });
  }
  const isValid = await validateSignedUrl(`call:${user}`, url.searchParams, callSecret);
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

// =============================================================================
//  Edge Watch Progress Tracker & Live Presence Engine
// =============================================================================

/** Module-level live user presence tracking (user -> presence data) */
const liveUserPresence = new Map();
const lastVpsSyncMap = new Map();

/**
 * Generates an HMAC hex signature for internal edge-to-origin relays.
 * @param {string} message
 * @param {string} secret
 * @returns {Promise<string>}
 */
async function generateHmacHex(message, secret) {
  const key = await getHmacKey(secret);
  const encoder = new TextEncoder();
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return arrayBufferToHex(signature);
}

/**
 * Handles real-time telemetry from video player (Hajera / Muaj)
 * - Updates Edge in-memory live playback state
 * - Asynchronously relays to VPS SQLite database via /api/internal-presence-sync
 *
 * @param {Request} request
 * @param {{ ORIGIN_URL?: string, WORKER_HMAC_SECRET?: string, SESSION_SECRET?: string }} env
 * @param {ExecutionContext} ctx
 * @param {string|null} _capturedKey
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleEdgeWatchProgress(request, env, ctx, _capturedKey, url) {
  const secret = env.WORKER_HMAC_SECRET || env.SESSION_SECRET;
  if (!secret) {
    return jsonError('Server misconfigured — no auth secret', 500);
  }

  const user = url.searchParams.get('user') || '';
  if (!user || (user !== 'muaj' && user !== 'hajera')) {
    return jsonError('Invalid user', 400);
  }

  // Validate signed tracker token
  const isValid = await validateSignedUrl(`tracker:${user}`, url.searchParams, secret);
  if (!isValid) {
    return jsonError('Unauthorized — invalid tracker token', 401);
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonError('Invalid JSON payload', 400);
  }

  const { videoId, videoTitle, position, duration, playing, ended, source } = body;
  const posNum = Number(position) || 0;
  const durNum = Number(duration) || 0;

  // 1. Update Edge in-memory live presence state
  const presenceData = {
    user,
    videoId: String(videoId || ''),
    videoTitle: String(videoTitle || ''),
    position: posNum,
    duration: durNum,
    playing: !!playing,
    ended: !!ended,
    source: source || 'web',
    percent: durNum > 0 ? Math.min(100, Math.round((posNum / durNum) * 100)) : 0,
    updatedAt: Date.now(),
    ip: request.headers.get('CF-Connecting-IP') || '',
    country: request.headers.get('CF-IPCountry') || 'BD',
    colo: request.cf?.colo || 'DAC'
  };

  liveUserPresence.set(user, presenceData);

  // 2. Smart Throttle: Only relay to VPS SQLite if 15s elapsed OR critical event (pause/ended/completed)
  const lastSyncTime = lastVpsSyncMap.get(user) || 0;
  const now = Date.now();
  const isCriticalEvent = ended || !playing || (durNum > 0 && posNum >= durNum - 10);
  const shouldRelayToVps = isCriticalEvent || (now - lastSyncTime >= 15000);

  if (shouldRelayToVps) {
    lastVpsSyncMap.set(user, now);

    const originBase = env.ORIGIN_URL || 'https://origin.muaj.bro.bd';
    const syncUrl = `${originBase.replace(/\/$/, '')}/api/internal-presence-sync`;
    const exp = Math.floor(now / 1000) + 300;

    const syncPromise = (async () => {
      try {
        const sig = await generateHmacHex(`sync:${exp}`, secret);
        const response = await fetch(`${syncUrl}?sig=${sig}&exp=${exp}&user=${encodeURIComponent(user)}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Edge-Worker-Loop': '1',
            'Host': 'muaj.bro.bd'
          },
          body: JSON.stringify({
            user,
            videoId,
            position: posNum,
            duration: durNum,
            playing: !!playing,
            ended: !!ended,
            videoTitle
          }),
          signal: AbortSignal.timeout(8000)
        });
        if (!response.ok) {
          throw new Error(`Origin presence sync failed with ${response.status}`);
        }
      } catch {}
    })();

    ctx.waitUntil(syncPromise);
  }

  return jsonOk({ success: true, ts: now, percent: presenceData.percent });
}

/**
 * Returns Edge live presence state for Admin Dashboard
 * @param {Request} request
 * @param {{ WORKER_HMAC_SECRET?: string, SESSION_SECRET?: string }} env
 * @param {ExecutionContext} ctx
 * @param {string|null} _capturedKey
 * @param {URL} url
 * @returns {Promise<Response>}
 */
async function handleEdgePresenceLive(request, env, ctx, _capturedKey, url) {
  const secret = env.WORKER_HMAC_SECRET || env.SESSION_SECRET;
  if (!secret) {
    return jsonError('Server misconfigured', 500);
  }

  const isValid = await validateSignedUrl('admin-presence', url.searchParams, secret);
  if (!isValid) {
    return jsonError('Unauthorized', 401);
  }

  const presenceObj = {};
  const now = Date.now();

  for (const [uname, data] of liveUserPresence.entries()) {
    const isRecent = (now - data.updatedAt) < 60000; // active within last 60s
    presenceObj[uname] = {
      ...data,
      isLive: isRecent,
      secondsAgo: Math.floor((now - data.updatedAt) / 1000)
    };
  }

  return jsonOk({
    success: true,
    presence: presenceObj,
    serverTime: now
  }, 200, { 'Cache-Control': 'no-cache, no-store' });
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
      'Access-Control-Allow-Headers': 'Content-Type, Range, If-None-Match, X-Requested-With, Cache-Control, Authorization',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function addCorsHeaders(response, request) {
  // Never reconstruct WebSocket upgrade (101) responses — preserves webSocket binding
  if (response.status === 101 || response.webSocket) {
    return response;
  }

  const origin = request.headers.get('Origin');
  // Only add CORS headers if origin is allowed (or same-origin requests with no Origin header)
  const allowedOrigin = isAllowedOrigin(origin) ? origin : null;
  if (!allowedOrigin) return response;

  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', allowedOrigin);
  headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');

  // Handle null-body statuses and HEAD requests safely
  const isNullBody = NULL_BODY_STATUSES.has(response.status) || request.method === 'HEAD';
  return new Response(isNullBody ? null : response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// =============================================================================
//  Utilities & Security
// =============================================================================

function applyEdgeSecurityHeaders(headers) {
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'SAMEORIGIN');
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
}

function getVideoMimeType(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'video/mp4';
  return VIDEO_MIME_MAP[filename.slice(dot).toLowerCase()] || 'video/mp4';
}

function getImageMimeType(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'image/jpeg';
  return IMAGE_MIME_MAP[filename.slice(dot).toLowerCase()] || 'image/jpeg';
}

function encodeBasename(name) {
  return name.replace(/["\\\\r\n\x00-\x1F\x7F]/g, '_');
}
