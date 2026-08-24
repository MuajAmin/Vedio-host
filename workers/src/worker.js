// =============================================================================
//  VideoHost — Cloudflare Edge Worker
//  Non-destructive middleware: security headers, R2 video proxy, static cache,
//  edge validation. All routes fall through to origin VPS when not handled.
// =============================================================================

// ─── Constants ──────────────────────────────────────────────────────────────

/** Routes that MUST bypass the Worker entirely (SSE streams, large uploads). */
const BYPASS_PATTERNS = [
  /^\/upload$/,                          // POST body up to 550 MB — exceeds 100 MB Worker limit
  /^\/import-progress\//,                // SSE long-lived stream
  /^\/messages\/stream/,                 // SSE long-lived stream
  /^\/watch-together\/stream\//,         // SSE long-lived stream
  /^\/api\/call\/events/,                // SSE long-lived stream
];

/** File extensions served as static assets with long-lived immutable caching. */
const STATIC_ASSET_RE = /\.(css|js|png|jpg|jpeg|gif|ico|svg|webp|woff|woff2|ttf|eot|json|webmanifest)$/i;

/**
 * UUID v4 pattern used in video keys (with optional file extension).
 * Matches: 550e8400-e29b-41d4-a716-446655440000 or 550e8400-e29b-41d4-a716-446655440000.mp4
 */
const VIDEO_KEY_RE = /^\/stream\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i;

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

/** Session validation cache TTL. */
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// =============================================================================
//  Entry Point
// =============================================================================

export default {
  /**
   * @param {Request} request
   * @param {{ R2_BUCKET: R2Bucket, ORIGIN: string, SESSION_SECRET: string }} env
   * @param {ExecutionContext} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ─── Phase 0: Bypass routes that Workers cannot handle ───────────
    if (shouldBypass(url, request.method)) {
      return fetch(request);
    }

    // ─── Phase 5: Edge request validation ────────────────────────────
    const blocked = validateRequest(request, url);
    if (blocked) return blocked;

    // ─── Phase 3: R2 Video Streaming Proxy ───────────────────────────
    const streamMatch = url.pathname.match(VIDEO_KEY_RE);
    if (streamMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      return handleVideoStream(request, env, ctx, streamMatch[1]);
    }

    // ─── Phase 2: Static Asset Edge Caching ──────────────────────────
    if (STATIC_ASSET_RE.test(url.pathname) && request.method === 'GET') {
      return handleStaticAsset(request, ctx);
    }

    // ─── Phase 1: Pass through to origin with security headers ───────
    const response = await fetch(request);
    return applySecurityHeaders(response);
  },
};

// =============================================================================
//  Phase 0 — Bypass Logic
// =============================================================================

function shouldBypass(url, method) {
  if (url.pathname === '/upload' && method === 'POST') return true;
  return BYPASS_PATTERNS.some((re) => re.test(url.pathname));
}

// =============================================================================
//  Phase 1 — Security Headers
// =============================================================================

function applySecurityHeaders(response) {
  if (response.status === 0) return response;

  const headers = new Headers(response.headers);
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  headers.set('Referrer-Policy', 'same-origin');
  headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  headers.set('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=(), payment=()');
  headers.delete('X-Powered-By');
  headers.delete('Server');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// =============================================================================
//  Phase 2 — Static Asset Edge Caching
// =============================================================================

async function handleStaticAsset(request, ctx) {
  const cache = caches.default;
  const cached = await cache.match(request);
  if (cached) return applySecurityHeaders(cached);

  const originResponse = await fetch(request);

  if (originResponse.ok) {
    const cacheHeaders = new Headers(originResponse.headers);
    cacheHeaders.set('Cache-Control', 'public, max-age=604800, immutable');

    const cacheableResponse = new Response(originResponse.body, {
      status: originResponse.status,
      statusText: originResponse.statusText,
      headers: cacheHeaders,
    });

    ctx.waitUntil(cache.put(request, cacheableResponse.clone()));
    return applySecurityHeaders(cacheableResponse);
  }

  return applySecurityHeaders(originResponse);
}

// =============================================================================
//  Phase 3 — R2 Video Streaming Proxy
// =============================================================================

async function handleVideoStream(request, env, ctx, videoKey) {
  // ─── Authentication ────────────────────────────────────────────────
  const authResult = await validateStreamAuth(request, env);
  if (!authResult.valid) {
    return new Response('Unauthorized', { status: 401, headers: { 'Content-Type': 'text/plain' } });
  }

  // ─── R2 Binding Check ─────────────────────────────────────────────
  if (!env.R2_BUCKET) {
    return passToOrigin(request);
  }

  // ─── Resolve R2 Object Key ─────────────────────────────────────────
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

  // ─── R2 Miss: Fall through to origin VPS ───────────────────────────
  if (!object) {
    return passToOrigin(request);
  }

  // ─── Build Response ────────────────────────────────────────────────
  const responseHeaders = new Headers();
  const contentType = object.httpMetadata?.contentType || getVideoMimeType(objectKey);
  responseHeaders.set('Content-Type', contentType);
  responseHeaders.set('Accept-Ranges', 'bytes');
  responseHeaders.set('Cache-Control', 'private, max-age=86400, no-transform');
  responseHeaders.set('X-Content-Type-Options', 'nosniff');
  responseHeaders.set('Connection', 'keep-alive');

  if (object.httpEtag) responseHeaders.set('ETag', object.httpEtag);
  if (object.uploaded) responseHeaders.set('Last-Modified', object.uploaded.toUTCString());

  const basename = objectKey.split('/').pop() || 'video.mp4';
  responseHeaders.set('Content-Disposition', `inline; filename="${encodeBasename(basename)}"`);

  // Security headers
  responseHeaders.set('X-Frame-Options', 'DENY');
  responseHeaders.set('Referrer-Policy', 'same-origin');
  responseHeaders.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // ─── Range Response (206 Partial Content) ──────────────────────────
  if (object.range) {
    const offset = 'offset' in object.range ? object.range.offset : 0;
    const length = 'length' in object.range ? object.range.length : object.size;
    const end = offset + length - 1;

    responseHeaders.set('Content-Range', `bytes ${offset}-${end}/${object.size}`);
    responseHeaders.set('Content-Length', length.toString());

    if (request.method === 'HEAD') return new Response(null, { status: 206, headers: responseHeaders });
    return new Response(object.body, { status: 206, headers: responseHeaders });
  }

  // ─── Full Response (200 OK) ────────────────────────────────────────
  responseHeaders.set('Content-Length', object.size.toString());
  if (request.method === 'HEAD') return new Response(null, { status: 200, headers: responseHeaders });
  return new Response(object.body, { status: 200, headers: responseHeaders });
}

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
  const startStr = match[1];
  const endStr = match[2];

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

function getVideoMimeType(filename) {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'video/mp4';
  return VIDEO_MIME_MAP[filename.slice(dot).toLowerCase()] || 'video/mp4';
}

function encodeBasename(name) {
  return name.replace(/["\\\r\n\x00-\x1F\x7F]/g, '_');
}

// =============================================================================
//  Phase 4 — Edge Authentication (Origin Cookie Passthrough)
// =============================================================================

async function validateStreamAuth(request, env) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const sidMatch = cookieHeader.match(/videohost\.sid=([^;]+)/);
  if (!sidMatch) return { valid: false };

  const sessionCookie = sidMatch[1];
  const cacheKey = `session-check:${hashCode(sessionCookie)}`;

  // Check CF Cache API
  const cache = caches.default;
  const cacheUrl = new URL(`https://session-cache.internal/${cacheKey}`);
  const cacheRequest = new Request(cacheUrl.toString());

  const cached = await cache.match(cacheRequest);
  if (cached) return cached.json();

  // Cache miss — validate against origin VPS
  try {
    const originUrl = (env.ORIGIN || 'https://muaj.bro.bd').replace(/\/$/, '');
    const dashCheck = await fetch(`${originUrl}/dashboard`, {
      method: 'HEAD',
      headers: {
        Cookie: `videohost.sid=${sessionCookie}`,
        'X-Requested-With': 'XMLHttpRequest',
      },
      redirect: 'manual',
    });

    const valid = dashCheck.status === 200;
    const result = { valid };

    const cacheResponse = new Response(JSON.stringify(result), {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': `max-age=${SESSION_CACHE_TTL_MS / 1000}`,
      },
    });
    await cache.put(cacheRequest, cacheResponse);
    return result;
  } catch {
    return { valid: false };
  }
}

function hashCode(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

// =============================================================================
//  Phase 5 — Edge Request Validation
// =============================================================================

function validateRequest(request, url) {
  if (url.pathname.includes('..') || url.pathname.includes('%2e%2e') || url.pathname.includes('%2E%2E')) {
    return new Response('Bad Request', { status: 400 });
  }
  if (url.pathname.length > 2048) {
    return new Response('URI Too Long', { status: 414 });
  }
  const ua = request.headers.get('User-Agent') || '';
  if (!ua && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/health') && request.method !== 'OPTIONS') {
    return new Response('Forbidden', { status: 403 });
  }
  if (/\.(php|asp|aspx|jsp|cgi|env|git|svn|htaccess|htpasswd|sql|bak|swp)$/i.test(url.pathname)) {
    return new Response('Not Found', { status: 404 });
  }
  return null;
}

// =============================================================================
//  Utility
// =============================================================================

async function passToOrigin(request) {
  const response = await fetch(request);
  return applySecurityHeaders(response);
}
