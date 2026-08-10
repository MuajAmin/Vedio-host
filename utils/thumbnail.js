const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const db = require('../database');

const uploadsDir = path.join(__dirname, '..', 'uploads');
const videosDir = path.join(uploadsDir, 'videos');
const thumbnailsDir = path.join(uploadsDir, 'thumbnails');

// Ensure thumbnails directory exists
if (!fs.existsSync(thumbnailsDir)) {
    fs.mkdirSync(thumbnailsDir, { recursive: true });
}

/**
 * Extracts a single frame thumbnail from a video file using FFmpeg.
 * Optimized for 1 vCPU / 1 GB RAM VPS (single frame, scaled to 480px width, fast execution).
 * 
 * @param {string} videoFilename Filename of the video in uploads/videos
 * @param {string} videoId Video ID used for thumbnail filename
 * @returns {Promise<string|null>} Thumbnail filename if generated, null if failed
 */
function generateVideoThumbnail(videoFilename, videoId) {
    return new Promise((resolve) => {
        const inputPath = path.join(videosDir, videoFilename);
        const thumbFilename = `${videoId}.jpg`;
        const outputPath = path.join(thumbnailsDir, thumbFilename);

        if (!fs.existsSync(inputPath)) {
            console.warn(`[thumbnail] Video file not found: ${inputPath}`);
            return resolve(null);
        }

        // Try extracting frame at 2 seconds. If video is very short, try at 0 second.
        const runFfmpeg = (seekTime) => {
            const args = [
                '-y',
                '-ss', seekTime,
                '-i', inputPath,
                '-vframes', '1',
                '-vf', 'scale=480:-1',
                '-q:v', '3',
                outputPath
            ];

            execFile('ffmpeg', args, { timeout: 15000, windowsHide: true }, (err) => {
                if (err) {
                    if (seekTime === '00:00:02') {
                        // Retry at 0 second in case video is < 2s
                        return runFfmpeg('00:00:00');
                    }
                    console.warn(`[thumbnail] FFmpeg extraction failed for ${videoFilename}:`, err.message);
                    return resolve(null);
                }

                if (fs.existsSync(outputPath)) {
                    return resolve(thumbFilename);
                }
                return resolve(null);
            });
        };

        runFfmpeg('00:00:02');
    });
}

/**
 * Scans database for videos without a thumbnail and generates missing thumbnails sequentially.
 * Runs in background to prevent blocking server boot.
 */
async function backfillMissingThumbnails() {
    try {
        const rows = db.prepare(
            'SELECT id, filename FROM videos WHERE thumbnail IS NULL OR thumbnail = ""'
        ).all();

        if (rows.length === 0) return;

        console.log(`[thumbnail] Found ${rows.length} video(s) missing thumbnails. Processing in background...`);

        for (const video of rows) {
            const thumbFilename = await generateVideoThumbnail(video.filename, video.id);
            if (thumbFilename) {
                db.prepare('UPDATE videos SET thumbnail = ? WHERE id = ?').run(thumbFilename, video.id);
                console.log(`[thumbnail] Generated thumbnail for video ${video.id}`);
            }
        }
    } catch (err) {
        console.error('[thumbnail] Error during thumbnail backfill:', err.message);
    }
}

module.exports = {
    generateVideoThumbnail,
    backfillMissingThumbnails,
    thumbnailsDir
};
