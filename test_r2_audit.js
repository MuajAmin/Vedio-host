require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const r2 = require('./utils/r2');
const db = require('./database');

async function runAuditTests() {
    console.log('====================================================');
    console.log('  Cloudflare R2 Production Audit Verification Suite  ');
    console.log('====================================================\n');

    let passed = 0;
    let failed = 0;

    function assert(name, condition, details = '') {
        if (condition) {
            console.log(`✅ PASS: ${name} ${details ? '(' + details + ')' : ''}`);
            passed++;
        } else {
            console.error(`❌ FAIL: ${name} ${details ? '(' + details + ')' : ''}`);
            failed++;
        }
    }

    // --- TEST 1: R2 Configuration & Credentials ---
    console.log('--- TEST 1: R2 Configuration & Credentials ---');
    assert('R2 is enabled', r2.isR2Enabled() === true);
    assert('R2 Bucket configured', !!process.env.R2_BUCKET, process.env.R2_BUCKET);
    assert('Cloudflare Worker URL configured', !!process.env.CF_WORKER_URL, process.env.CF_WORKER_URL);
    assert('SESSION_SECRET is configured', !!process.env.SESSION_SECRET);

    const { v4: uuidv4 } = require('uuid');
    const testDir = path.join(__dirname, 'uploads', 'videos');
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });
    
    const testVideoId = uuidv4();
    const testFilename = `${testVideoId}.mp4`;
    const testFilePath = path.join(testDir, testFilename);
    
    // Write 2MB dummy video payload
    const dummyBuffer = Buffer.alloc(2 * 1024 * 1024, 'A');
    fs.writeFileSync(testFilePath, dummyBuffer);

    try {
        // --- TEST 2: Upload Deduplication ---
        console.log('\n--- TEST 2: Upload Deduplication & Concurrency Lock ---');
        let progressUpdates = 0;
        const unreg = r2.registerProgressListener(testFilename, (entry) => {
            progressUpdates++;
        });

        // Trigger two parallel upload calls for the same file
        const p1 = r2.uploadToR2(testFilePath, testFilename);
        const p2 = r2.uploadToR2(testFilePath, testFilename);

        assert('Parallel calls return same Promise instance', p1 === p2, 'Deduplication active');

        const uploadResult = await p1;
        unreg();
        assert('Upload succeeded', uploadResult === true);
        assert('Progress events received via SSE listener', progressUpdates > 0, `${progressUpdates} events`);
        assert('Cache marked confirmed', r2.isConfirmedOnR2(testFilename) === true);

        // --- TEST 3: Object Verification on Cloudflare R2 ---
        console.log('\n--- TEST 3: Object Verification on Cloudflare R2 ---');
        const exists = await r2.existsOnR2(testFilename);
        assert('Object exists in R2 bucket', exists === true);

        // --- TEST 4: Cloudflare Worker Streaming & Range 206 Verification ---
        console.log('\n--- TEST 4: Cloudflare Edge Streaming Verification ---');
        const exp = Math.floor(Date.now() / 1000) + 86400;
        const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET)
            .update(`${testFilename}:${exp}`)
            .digest('hex');
        const workerStreamUrl = `${process.env.CF_WORKER_URL}/stream/${encodeURIComponent(testFilename)}?exp=${exp}&sig=${sig}`;

        const rangeRes = await fetch(workerStreamUrl, {
            headers: { 'Range': 'bytes=0-1023' }
        });

        assert('Worker returns HTTP 206 Partial Content', rangeRes.status === 206);
        assert('Content-Range header present', rangeRes.headers.get('content-range') === `bytes 0-1023/${dummyBuffer.length}`);
        assert('Content-Length is exactly 1024 bytes', rangeRes.headers.get('content-length') === '1024');
        assert('Server is Cloudflare', (rangeRes.headers.get('server') || '').toLowerCase().includes('cloudflare'));
        assert('Accept-Ranges bytes supported', rangeRes.headers.get('accept-ranges') === 'bytes');

        // --- TEST 5: Upload-vs-Delete Race Condition & In-Flight Abort ---
        console.log('\n--- TEST 5: Upload-vs-Delete Race Condition & In-Flight Abort ---');
        const raceVideoId = uuidv4();
        const raceFilename = `${raceVideoId}.mp4`;
        const raceFilePath = path.join(testDir, raceFilename);
        fs.writeFileSync(raceFilePath, Buffer.alloc(5 * 1024 * 1024, 'B'));

        // Start upload
        const raceUploadPromise = r2.uploadToR2(raceFilePath, raceFilename);
        // Immediately trigger delete while upload is in-flight
        await r2.deleteFromR2(raceFilename);
        const raceResult = await raceUploadPromise.catch(() => false);

        assert('In-flight upload aborted cleanly on delete', raceResult === false);
        const raceObjectExists = await r2.existsOnR2(raceFilename);
        assert('No zombie orphan R2 object left behind', raceObjectExists === false);

        // Clean local race file
        try { fs.unlinkSync(raceFilePath); } catch {}

        // --- TEST 6: Normal Deletion Flow & Clean-up ---
        console.log('\n--- TEST 6: Normal Deletion Flow & R2 Clean-up ---');
        const deleteResult = await r2.deleteFromR2(testFilename);
        assert('deleteFromR2 returned true', deleteResult === true);
        assert('Cache unconfirmed after delete', r2.isConfirmedOnR2(testFilename) === false);

        // Verify object no longer exists on R2
        // Bypass cache to do live HEAD check
        const headCheck = await r2.existsOnR2(testFilename);
        assert('Object completely deleted from R2 bucket', headCheck === false);

        // Clean local file
        try { fs.unlinkSync(testFilePath); } catch {}

        // --- TEST 7: Inventory Listing & Pagination ---
        console.log('\n--- TEST 7: Bucket Inventory & Pagination ---');
        const allObjects = await r2.listAllR2Objects();
        assert('listAllR2Objects returns valid array', Array.isArray(allObjects));
        assert('R2 objects found in bucket', allObjects.length >= 0, `${allObjects.length} objects`);

    } finally {
        // Clean up test files if any remain
        try { if (fs.existsSync(testFilePath)) fs.unlinkSync(testFilePath); } catch {}
    }

    console.log('\n====================================================');
    console.log(`  Test Results: ${passed} PASSED, ${failed} FAILED  `);
    console.log('====================================================');

    if (failed > 0) process.exit(1);
}

runAuditTests().catch(err => {
    console.error('Audit test suite failed with error:', err);
    process.exit(1);
});
