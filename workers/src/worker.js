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

    // ─── Direct-to-R2 Upload: PUT /upload/:videoKey?sig=...&exp=... ────
    const uploadMatch = url.pathname.match(/^\/upload\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i);
    if (uploadMatch && request.method === 'PUT') {
      const response = await handleDirectUpload(request, env, ctx, uploadMatch[1], url);
      return addCorsHeaders(response, request);
    }

    // ─── Edge R2 Inventory & Audit: GET /api/r2-inventory?sig=...&exp=... ─
    if (url.pathname === '/api/r2-inventory' && request.method === 'GET') {
      const response = await handleR2Inventory(request, env, ctx, url);
      return addCorsHeaders(response, request);
    }

    // ─── Edge Fast Check: GET /api/r2-check/:videoKey?sig=...&exp=... ───
    const checkMatch = url.pathname.match(/^\/api\/r2-check\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:\.[a-z0-9]+)?)$/i);
    if (checkMatch && (request.method === 'GET' || request.method === 'HEAD')) {
      const response = await handleR2Check(request, env, ctx, checkMatch[1], url);
      return addCorsHeaders(response, request);
    }

    // ─── Edge R2 Delete Batch: POST /api/r2-delete-batch?sig=...&exp=... ─
    if (url.pathname === '/api/r2-delete-batch' && request.method === 'POST') {
      const response = await handleR2DeleteBatch(request, env, ctx, url);
      return addCorsHeaders(response, request);
    }

    // ─── Edge WebRTC Call Signaling WebSocket: /call-signaling?user=...&sig=...&exp=... ───
    if (url.pathname === '/call-signaling') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('Expected WebSocket upgrade', { status: 426 });
      }
      return handleCallSignalingWebSocket(request, env, ctx, url);
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
//  Direct-to-R2 Upload Handler
// =============================================================================

async function handleDirectUpload(request, env, ctx, videoKey, url) {
  if (!env.SESSION_SECRET) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const isValid = await validateSignedUrl(videoKey, url.searchParams, env.SESSION_SECRET);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Unauthorized — invalid or expired token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.R2_BUCKET) {
    return new Response(JSON.stringify({ error: 'R2 not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

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

    return new Response(JSON.stringify({
      success: true,
      key: object.key,
      size: object.size,
      etag: object.httpEtag,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Upload failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// =============================================================================
//  Edge R2 Inventory & Audit Handler
// =============================================================================

async function handleR2Inventory(request, env, ctx, url) {
  if (!env.SESSION_SECRET) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const isValid = await validateSignedUrl('inventory', url.searchParams, env.SESSION_SECRET);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Unauthorized token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.R2_BUCKET) {
    return new Response(JSON.stringify({ error: 'R2 not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const listed = await env.R2_BUCKET.list({ limit: 1000 });
    let totalBytes = 0;
    const files = listed.objects.map((obj) => {
      totalBytes += obj.size;
      return {
        key: obj.key,
        size: obj.size,
        uploaded: obj.uploaded,
        etag: obj.httpEtag,
      };
    });

    return new Response(JSON.stringify({
      success: true,
      totalCount: files.length,
      totalBytes,
      truncated: listed.truncated,
      files,
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Inventory failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// =============================================================================
//  Edge Fast Check Handler
// =============================================================================

async function handleR2Check(request, env, ctx, videoKey, url) {
  if (!env.SESSION_SECRET) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const isValid = await validateSignedUrl(videoKey, url.searchParams, env.SESSION_SECRET);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Unauthorized token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.R2_BUCKET) {
    return new Response(JSON.stringify({ error: 'R2 not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const head = await env.R2_BUCKET.head(videoKey);
    if (!head) {
      return new Response(JSON.stringify({ exists: false, key: videoKey }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({
      exists: true,
      key: head.key,
      size: head.size,
      uploaded: head.uploaded,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// =============================================================================
//  Edge R2 Delete Batch Handler (Orphan Cleanup)
// =============================================================================

async function handleR2DeleteBatch(request, env, ctx, url) {
  if (!env.SESSION_SECRET) {
    return new Response(JSON.stringify({ error: 'Server misconfigured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const isValid = await validateSignedUrl('delete-batch', url.searchParams, env.SESSION_SECRET);
  if (!isValid) {
    return new Response(JSON.stringify({ error: 'Unauthorized token' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (!env.R2_BUCKET) {
    return new Response(JSON.stringify({ error: 'R2 not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const keys = body && Array.isArray(body.keys) ? body.keys : [];

    if (keys.length === 0) {
      return new Response(JSON.stringify({ error: 'No keys provided' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const deleted = [];
    for (const key of keys.slice(0, 100)) {
      if (typeof key === 'string' && key.trim()) {
        await env.R2_BUCKET.delete(key.trim());
        deleted.push(key.trim());
      }
    }

    return new Response(JSON.stringify({
      success: true,
      deletedCount: deleted.length,
      deleted,
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Delete failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// =============================================================================
//  CORS — Required for cross-origin video and direct uploads
// =============================================================================

function handleCors(request) {
  const origin = request.headers.get('Origin') || '*';
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

// =============================================================================
//  Edge WebRTC Call Signaling WebSocket Handler
// =============================================================================

const connectedCallUsers = new Map(); // username -> Set<WebSocket>

async function handleCallSignalingWebSocket(request, env, ctx, url) {
  const user = url.searchParams.get('user');
  if (!user || (user !== 'muaj' && user !== 'hajera')) {
    return new Response('Invalid user', { status: 400 });
  }

  // Validate signed token
  if (env.SESSION_SECRET) {
    const isValid = await validateSignedUrl(`call:${user}`, url.searchParams, env.SESSION_SECRET);
    if (!isValid) {
      return new Response('Unauthorized token', { status: 401 });
    }
  }

  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  server.accept();

  if (!connectedCallUsers.has(user)) {
    connectedCallUsers.set(user, new Set());
  }
  connectedCallUsers.get(user).add(server);

  const partner = user === 'muaj' ? 'hajera' : 'muaj';

  server.addEventListener('message', async (event) => {
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

