const { S3Client, DeleteObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');
const fs = require('fs');
const path = require('path');

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || '';
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || '';
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || '';
const R2_BUCKET = process.env.R2_BUCKET || 'videohost';
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || '';

let r2Enabled = false;
let s3Client = null;

if (R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY) {
    s3Client = new S3Client({
        region: 'auto',
        endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
            accessKeyId: R2_ACCESS_KEY_ID,
            secretAccessKey: R2_SECRET_ACCESS_KEY,
        },
    });
    r2Enabled = true;
    console.log('[R2] Cloudflare R2 CDN configured successfully.');
} else {
    console.warn('[R2] R2 credentials not configured — videos will stream from VPS only.');
}

/**
 * Check if R2 is configured and ready to use.
 */
function isR2Enabled() {
    return r2Enabled;
}

/**
 * Get the public CDN URL for a video file.
 * @param {string} filename - The video filename (UUID-based)
 * @returns {string|null} Full public URL or null if R2 is not configured
 */
function getPublicUrl(filename) {
    if (!R2_PUBLIC_URL || !filename) return null;
    return `${R2_PUBLIC_URL.replace(/\/$/, '')}/${encodeURIComponent(filename)}`;
}

/**
 * Get the MIME type for a video file based on its extension.
 */
function getMimeType(filename) {
    const ext = path.extname(filename).toLowerCase();
    const mimeMap = {
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.mkv': 'video/x-matroska',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.flv': 'video/x-flv',
        '.wmv': 'video/x-ms-wmv',
        '.m4v': 'video/mp4'
    };
    return mimeMap[ext] || 'video/mp4';
}

/**
 * Upload a video file to R2.
 * Streams the file to avoid loading it entirely into memory (safe for 1GB VPS).
 * @param {string} filePath - Absolute path to the video file on disk
 * @param {string} filename - The filename to use as the R2 object key
 * @returns {Promise<boolean>} true if upload succeeded
 */
async function uploadToR2(filePath, filename) {
    if (!r2Enabled) return false;

    const stat = await fs.promises.stat(filePath);
    const contentType = getMimeType(filename);
    const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
    const uploadStart = Date.now();
    console.log(`[R2] ⬆ Upload start: ${filename} (${sizeMB} MB)`);

    const parallelUpload = new Upload({
        client: s3Client,
        params: {
            Bucket: R2_BUCKET,
            Key: filename,
            Body: fs.createReadStream(filePath),
            ContentType: contentType,
            CacheControl: 'public, max-age=2592000, immutable', // 30 days — videos are UUID-named & never change
        },
        partSize: 15 * 1024 * 1024, // 15MB chunks (fast throughput)
        queueSize: 5, // 5 concurrent chunks for high upload speed (max ~75MB in-flight)
        leavePartsOnError: false,
    });

    await parallelUpload.done();
    const elapsed = ((Date.now() - uploadStart) / 1000).toFixed(1);
    console.log(`[R2] ✓ Upload done: ${filename} (${sizeMB} MB) in ${elapsed}s`);
    return true;
}

/**
 * Delete a video file from R2.
 * @param {string} filename - The filename (R2 object key) to delete
 * @returns {Promise<boolean>} true if deletion succeeded
 */
async function deleteFromR2(filename) {
    if (!r2Enabled || !filename) return false;

    console.log(`[R2] ⬇ Delete start: ${filename}`);
    const command = new DeleteObjectCommand({
        Bucket: R2_BUCKET,
        Key: filename,
    });

    await s3Client.send(command);
    console.log(`[R2] ✓ Delete done: ${filename}`);
    return true;
}

/**
 * Check if a file exists on R2.
 * @param {string} filename - The filename (R2 object key) to check
 * @returns {Promise<boolean>} true if the object exists
 */
async function existsOnR2(filename) {
    if (!r2Enabled || !filename) return false;

    try {
        const command = new HeadObjectCommand({
            Bucket: R2_BUCKET,
            Key: filename,
        });
        await s3Client.send(command);
        return true;
    } catch {
        return false;
    }
}

module.exports = {
    isR2Enabled,
    getPublicUrl,
    uploadToR2,
    deleteFromR2,
    existsOnR2
};
