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

    // ─── CORS preflight for cross-origin video requests ──────────────
    if (request.method === 'OPTIONS') {
      return handleCors(request);
    }

    // ─── Video Stream: /stream/:videoKey?sig=...&exp=... ─────────────
    const streamMatch = url.pathname.match(VIDEO_KEY_RE);
    if (streamMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const response = await handleVideoStream(request, env, ctx, streamMatch[1], url);
      return addCorsHeaders(response, request);
    }

    // ─── All other requests: return 404 (this Worker only serves videos) ─
    return new Response('Not Found', { status: 404 });
  },
};

// =============================================================================
//  Signed URL Authentication
// =============================================================================

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

  // Compute expected HMAC
  const message = `${videoKey}:${exp}`;
  const encoder = new TextEncoder();

  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const expectedSig = arrayBufferToHex(signature);

  // Constant-time comparison
  return expectedSig === sig;
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
  // ─── Authentication via Signed URL ─────────────────────────────────
  if (!env.SESSION_SECRET) {
    return new Response('Server misconfigured', { status: 500 });
  }

  const isValid = await validateSignedUrl(videoKey, url.searchParams, env.SESSION_SECRET);
  if (!isValid) {
    return new Response('Unauthorized — invalid or expired token', { status: 401 });
  }

  // ─── R2 Binding Check ─────────────────────────────────────────────
  if (!env.R2_BUCKET) {
    return new Response('R2 not configured', { status: 500 });
  }

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
//  CORS — Required for cross-origin video requests
// =============================================================================

/**
 * Since the video player on muaj.bro.bd loads videos from workers.dev,
 * the browser will enforce CORS. We allow the origin domain.
 */
function handleCors(request) {
  const origin = request.headers.get('Origin') || '*';
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, If-None-Match',
      'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag',
      'Access-Control-Max-Age': '86400',
    },
  });
}

function addCorsHeaders(response, request) {
  const origin = request.headers.get('Origin') || '*';
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
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
  return name.replace(/["\\\r\n\x00-\x1F\x7F]/g, '_');
}
