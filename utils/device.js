function parseUserAgent(ua) {
    if (!ua || typeof ua !== 'string') return 'Unknown Device';
    const s = ua.toLowerCase();

    let os = 'Desktop';
    let icon = '💻';

    if (s.includes('android')) {
        os = 'Android';
        icon = '📱';
    } else if (s.includes('iphone') || s.includes('ipad') || s.includes('ipod')) {
        os = 'iOS';
        icon = '📱';
    } else if (s.includes('windows')) {
        os = 'Windows';
        icon = '💻';
    } else if (s.includes('macintosh') || s.includes('mac os')) {
        os = 'macOS';
        icon = '💻';
    } else if (s.includes('linux')) {
        os = 'Linux';
        icon = '💻';
    }

    let browser = 'Browser';
    if (s.includes('edg/')) browser = 'Edge';
    else if (s.includes('opr/') || s.includes('opera')) browser = 'Opera';
    else if (s.includes('chrome')) browser = 'Chrome';
    else if (s.includes('safari') && !s.includes('chrome')) browser = 'Safari';
    else if (s.includes('firefox')) browser = 'Firefox';

    return `${icon} ${os} (${browser})`;
}

function getClientIp(req) {
    if (!req) return '127.0.0.1';
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) {
        return forwarded.split(',')[0].trim();
    }
    return req.ip || req.socket?.remoteAddress || '127.0.0.1';
}

module.exports = { parseUserAgent, getClientIp };
