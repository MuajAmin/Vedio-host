const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
const db = require('../database');

const uploadsDir = path.join(__dirname, '..', 'uploads');
const videosDir = path.join(uploadsDir, 'videos');

/**
 * Checks whether an MP4/M4V file already has its moov atom before the mdat atom.
 * When moov is at the end, browsers must download the entire file before playback
 * can begin — this is the #1 cause of slow video start and broken seeking.
 *
 * Uses ffprobe to read the atom order without decoding the video.
 *
 * @param {string} filePath Absolute path to the video file
 * @returns {Promise<boolean>} true if moov is already at the start (optimized)
 */
function isFaststartOptimized(filePath) {
    return new Promise((resolve) => {
        // ffprobe -v error -show_entries format_tags=major_brand won't tell us atom order.
        // Instead, read the first 128 bytes to check for the moov atom position.
        // MP4 files have a box structure: [size(4)][type(4)][...]
        // If moov comes before mdat, the file is faststart-optimized.

        const args = [
            '-v', 'error',
            '-show_entries', 'format=format_name',
            '-of', 'csv=p=0',
            filePath
        ];

        execFile('ffprobe', args, { timeout: 5000, windowsHide: true }, (err, stdout) => {
            if (err) return resolve(false);

            const format = (stdout || '').trim().toLowerCase();
            // Only optimize MP4/M4V containers
            if (!format.includes('mp4') && !format.includes('m4v') && !format.includes('mov')) {
                return resolve(true); // Not an MP4 — skip (not applicable)
            }

            // Read the first 64KB to find atom order
            const fd = fs.openSync(filePath, 'r');
            const buf = Buffer.alloc(65536);
            let bytesRead;
            try {
                bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
            } catch {
                fs.closeSync(fd);
                return resolve(false);
            }
            fs.closeSync(fd);

            // Parse top-level MP4 atoms (boxes)
            let offset = 0;
            let foundMoov = false;
            let foundMdat = false;

            while (offset + 8 <= bytesRead) {
                const size = buf.readUInt32BE(offset);
                const type = buf.toString('ascii', offset + 4, offset + 8);

                if (type === 'moov') {
                    foundMoov = true;
                    if (!foundMdat) return resolve(true); // moov before mdat = optimized
                    return resolve(false); // moov after mdat = not optimized
                }

                if (type === 'mdat') {
                    foundMdat = true;
                    if (foundMoov) return resolve(true); // moov came first
                    // mdat found first — moov must be after, but let's continue scanning
                    // For large mdat atoms, moov is definitely after
                    return resolve(false);
                }

                // Move to next atom
                if (size === 0) break; // size 0 means atom extends to end of file
                if (size === 1) {
                    // 64-bit extended size
                    if (offset + 16 > bytesRead) break;
                    // Skip — extended size atoms are rare at the start
                    break;
                }
                if (size < 8) break; // Invalid atom

                offset += size;
            }

            // If we couldn't find both atoms in the first 64KB, assume not optimized
            // (a well-optimized file has moov in the first few KB)
            resolve(foundMoov && !foundMdat);
        });
    });
}

/**
 * Runs ffmpeg -movflags +faststart on an MP4 file to move the moov atom
 * to the beginning. This is a metadata-only operation — it reads the moov
 * atom from the end, writes it to the beginning, and shifts the mdat data.
 *
 * For a 500MB file, this takes ~5-15 seconds and uses minimal CPU.
 * It does require temporary disk space equal to the file size.
 *
 * @param {string} filePath Absolute path to the video file
 * @returns {Promise<boolean>} true if optimization succeeded
 */
function optimizeFaststart(filePath) {
    return new Promise((resolve) => {
        const ext = path.extname(filePath).toLowerCase();
        if (ext !== '.mp4' && ext !== '.m4v') {
            return resolve(false); // Only optimize MP4/M4V
        }

        const dir = path.dirname(filePath);
        const base = path.basename(filePath, ext);
        const tempPath = path.join(dir, `${base}_faststart_tmp${ext}`);

        const args = [
            '-y',
            '-i', filePath,
            '-c', 'copy',           // No re-encoding — just copy streams
            '-movflags', '+faststart',
            '-map_metadata', '0',   // Preserve metadata
            tempPath
        ];

        console.log(`[faststart] Optimizing: ${path.basename(filePath)}`);

        execFile('ffmpeg', args, {
            timeout: 120000, // 2 min timeout (enough for 1GB+ files)
            windowsHide: true,
            maxBuffer: 1024 * 1024
        }, async (err) => {
            if (err) {
                console.warn(`[faststart] FFmpeg failed for ${path.basename(filePath)}:`, err.message);
                // Clean up temp file
                try { await fs.promises.unlink(tempPath); } catch {}
                return resolve(false);
            }

            try {
                // Verify temp file exists and is reasonable size
                const originalStat = await fs.promises.stat(filePath);
                const tempStat = await fs.promises.stat(tempPath);

                // Temp file should be roughly the same size (±5%)
                const sizeRatio = tempStat.size / originalStat.size;
                if (sizeRatio < 0.9 || sizeRatio > 1.1) {
                    console.warn(`[faststart] Output size suspicious (${sizeRatio.toFixed(2)}x original), skipping`);
                    await fs.promises.unlink(tempPath);
                    return resolve(false);
                }

                // Replace original with optimized version
                await fs.promises.rename(tempPath, filePath);
                console.log(`[faststart] ✓ Optimized: ${path.basename(filePath)} (${(originalStat.size / 1024 / 1024).toFixed(1)} MB)`);
                return resolve(true);
            } catch (fsErr) {
                console.warn(`[faststart] File replacement failed:`, fsErr.message);
                try { await fs.promises.unlink(tempPath); } catch {}
                return resolve(false);
            }
        });
    });
}

/**
 * Scans all video files in the database and optimizes any MP4/M4V files
 * that don't have the moov atom at the start. Runs sequentially to avoid
 * overwhelming the 1-core VPS.
 *
 * Safe to call on server boot — skips already-optimized files quickly.
 */
async function backfillFaststart() {
    try {
        const rows = db.prepare(
            "SELECT id, filename, size FROM videos WHERE filename LIKE '%.mp4' OR filename LIKE '%.m4v'"
        ).all();

        if (rows.length === 0) return;

        let optimized = 0;
        let skipped = 0;
        let failed = 0;

        console.log(`[faststart] Scanning ${rows.length} MP4/M4V video(s) for moov atom placement...`);

        for (const video of rows) {
            const filePath = path.join(videosDir, video.filename);

            try {
                await fs.promises.access(filePath, fs.constants.R_OK | fs.constants.W_OK);
            } catch {
                skipped++;
                continue; // File missing or not writable
            }

            const isOptimized = await isFaststartOptimized(filePath);
            if (isOptimized) {
                skipped++;
                continue;
            }

            const success = await optimizeFaststart(filePath);
            if (success) {
                // Update file size in DB (may change slightly after faststart)
                try {
                    const newStat = await fs.promises.stat(filePath);
                    db.prepare('UPDATE videos SET size = ? WHERE id = ?').run(newStat.size, video.id);
                } catch {}
                optimized++;
            } else {
                failed++;
            }

            // Small delay between files to avoid CPU spikes
            await new Promise(r => setTimeout(r, 500));
        }

        if (optimized > 0 || failed > 0) {
            console.log(`[faststart] Done: ${optimized} optimized, ${skipped} already OK, ${failed} failed`);
        } else {
            console.log(`[faststart] All ${skipped} video(s) already have faststart — nothing to do`);
        }
    } catch (err) {
        console.error('[faststart] Error during backfill:', err.message);
    }
}

module.exports = {
    isFaststartOptimized,
    optimizeFaststart,
    backfillFaststart
};
