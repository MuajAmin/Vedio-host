// =============================================================================
//  Watch Together — Auth Token Utilities
//  HMAC-SHA256 tokens for VPS ↔ Worker authentication.
//  Tokens are short-lived (5 min) and carry user identity + room access.
// =============================================================================

/**
 * Validates an HMAC-SHA256 auth token at the Worker/DO edge.
 *
 * Token format: base64url(JSON({ roomId, user, role, exp })) + '.' + base64url(HMAC)
 *
 * @param {string} token - The full token string
 * @param {string} secret - The shared secret (WT_SHARED_SECRET)
 * @returns {Promise<{ valid: boolean, payload?: object, error?: string }>}
 */
export async function validateToken(token, secret) {
    if (!token || !secret) {
        return { valid: false, error: 'Missing token or secret' };
    }

    const dotIndex = token.lastIndexOf('.');
    if (dotIndex === -1) {
        return { valid: false, error: 'Malformed token' };
    }

    const payloadB64 = token.slice(0, dotIndex);
    const signatureB64 = token.slice(dotIndex + 1);

    // Verify HMAC signature
    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['verify']
    );

    const signatureBytes = base64urlDecode(signatureB64);
    const payloadBytes = new TextEncoder().encode(payloadB64);

    const valid = await crypto.subtle.verify('HMAC', key, signatureBytes, payloadBytes);
    if (!valid) {
        return { valid: false, error: 'Invalid signature' };
    }

    // Decode payload
    let payload;
    try {
        const decoded = new TextDecoder().decode(base64urlDecode(payloadB64));
        payload = JSON.parse(decoded);
    } catch {
        return { valid: false, error: 'Invalid payload encoding' };
    }

    // Check expiry
    if (!payload.exp || Date.now() > payload.exp) {
        return { valid: false, error: 'Token expired' };
    }

    // Validate required fields
    if (!payload.roomId || !payload.user) {
        return { valid: false, error: 'Missing required fields' };
    }

    return { valid: true, payload };
}

/**
 * Generates an HMAC-SHA256 auth token (for use on the VPS / Node.js side).
 * This function uses Web Crypto API — works in both Node.js 18+ and Workers.
 *
 * @param {object} params
 * @param {string} params.roomId
 * @param {string} params.user
 * @param {string} params.role - 'host' or 'guest'
 * @param {string} secret - The shared secret
 * @param {number} [ttlMs=300000] - Token TTL in milliseconds (default 5 min)
 * @returns {Promise<string>} The signed token
 */
export async function generateToken({ roomId, user, role }, secret, ttlMs = 5 * 60 * 1000) {
    const payload = {
        roomId,
        user,
        role,
        exp: Date.now() + ttlMs,
        iat: Date.now()
    };

    const payloadB64 = base64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));

    const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
    );

    const signature = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(payloadB64)
    );

    const signatureB64 = base64urlEncode(new Uint8Array(signature));

    return `${payloadB64}.${signatureB64}`;
}

// ─── Base64url helpers (no padding, URL-safe) ────────────────────────────────

function base64urlEncode(bytes) {
    const binString = Array.from(bytes, (b) => String.fromCharCode(b)).join('');
    return btoa(binString).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(str) {
    // Restore standard base64
    let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
    // Add padding
    while (base64.length % 4) {
        base64 += '=';
    }
    const binString = atob(base64);
    return Uint8Array.from(binString, (c) => c.charCodeAt(0));
}
