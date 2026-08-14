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

        // Step 1: Get video duration via ffprobe so we can seek to the middle
        const probeArgs = [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'csv=p=0',
            inputPath
        ];

        execFile('ffprobe', probeArgs, { timeout: 10000, windowsHide: true }, (probeErr, probeStdout) => {
            let seekTime = '00:00:02'; // fallback if ffprobe fails

            if (!probeErr) {
                const totalSeconds = parseFloat(probeStdout.trim());
                if (isFinite(totalSeconds) && totalSeconds > 0) {
                    // Seek to exact middle of the video
                    const midSeconds = Math.floor(totalSeconds / 2);
                    const hh = String(Math.floor(midSeconds / 3600)).padStart(2, '0');
                    const mm = String(Math.floor((midSeconds % 3600) / 60)).padStart(2, '0');
                    const ss = String(midSeconds % 60).padStart(2, '0');
                    seekTime = `${hh}:${mm}:${ss}`;
                }
            }

            const runFfmpeg = (time) => {
                const args = [
                    '-y',
                    '-ss', time,
                    '-i', inputPath,
                    '-vframes', '1',
                    '-vf', 'scale=480:-1',
                    '-q:v', '3',
                    outputPath
                ];

                execFile('ffmpeg', args, { timeout: 15000, windowsHide: true }, (err) => {
                    if (err) {
                        if (time !== '00:00:00') {
                            // Retry at 0 second in case seek position is invalid
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

            runFfmpeg(seekTime);
        });
    });
}

/**
 * Scans database for videos without a thumbnail and generates missing thumbnails sequentially.
 * Runs in background to prevent blocking server boot.
 */
async function backfillMissingThumbnails() {
    try {
        const rows = db.prepare(
            'SELECT id, filename, thumbnail, duration FROM videos WHERE thumbnail IS NULL OR thumbnail = \'\' OR duration IS NULL OR duration = \'\''
        ).all();

        if (rows.length === 0) return;

        console.log(`[backfill] Found ${rows.length} video(s) missing metadata. Processing in background...`);

        for (const video of rows) {
            // Generate thumbnail if missing
            if (!video.thumbnail) {
                const thumbFilename = await generateVideoThumbnail(video.filename, video.id);
                if (thumbFilename) {
                    db.prepare('UPDATE videos SET thumbnail = ? WHERE id = ?').run(thumbFilename, video.id);
                    console.log(`[backfill] Generated thumbnail for video ${video.id}`);
                }
            }
            // Extract duration if missing
            if (!video.duration) {
                const dur = await getVideoDuration(video.filename);
                if (dur) {
                    db.prepare('UPDATE videos SET duration = ? WHERE id = ?').run(dur, video.id);
                    console.log(`[backfill] Extracted duration ${dur} for video ${video.id}`);
                }
            }
        }
    } catch (err) {
        console.error('[backfill] Error during metadata backfill:', err.message);
    }
}

/**
 * Gets video duration using ffprobe (comes with ffmpeg).
 * Lightweight — reads only container metadata, no decoding.
 * 
 * @param {string} videoFilename Filename in uploads/videos
 * @returns {Promise<string|null>} Duration as "H:MM:SS" or "M:SS", null if failed
 */
function getVideoDuration(videoFilename) {
    return new Promise((resolve) => {
        const inputPath = path.join(videosDir, videoFilename);

        if (!fs.existsSync(inputPath)) {
            return resolve(null);
        }

        const args = [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'csv=p=0',
            inputPath
        ];

        execFile('ffprobe', args, { timeout: 10000, windowsHide: true }, (err, stdout) => {
            if (err) {
                return resolve(null);
            }

            const seconds = parseFloat(stdout.trim());
            if (!isFinite(seconds) || seconds <= 0) {
                return resolve(null);
            }

            // Format as H:MM:SS or M:SS
            const h = Math.floor(seconds / 3600);
            const m = Math.floor((seconds % 3600) / 60);
            const s = Math.floor(seconds % 60);

            if (h > 0) {
                resolve(`${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`);
            } else {
                resolve(`${m}:${s < 10 ? '0' : ''}${s}`);
            }
        });
    });
}

module.exports = {
    generateVideoThumbnail,
    getVideoDuration,
    backfillMissingThumbnails,
    thumbnailsDir
};
