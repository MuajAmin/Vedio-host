#!/usr/bin/env node
'use strict';

/**
 * Measures the real VPS -> R2 path with the same AWS SDK multipart uploader
 * used by the application. It never runs unless R2_BENCHMARK_CONFIRM=1 is
 * supplied, and it deletes every temporary object it creates.
 *
 * Example:
 *   R2_BENCHMARK_CONFIRM=1 R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... \
 *   R2_SECRET_ACCESS_KEY=... node scripts/r2-upload-benchmark.js
 */
const dns = require('dns').promises;
const https = require('https');
const { Readable } = require('stream');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { Upload } = require('@aws-sdk/lib-storage');

const MiB = 1024 * 1024;
const required = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'];
const missing = required.filter((name) => !process.env[name]);
if (process.env.R2_BENCHMARK_CONFIRM !== '1' || missing.length) {
    console.error('Refusing to run. Set R2_BENCHMARK_CONFIRM=1 and:', missing.join(', ') || 'R2 credentials.');
    process.exit(2);
}

const sizeMiB = Number.parseInt(process.env.R2_BENCHMARK_SIZE_MB || '64', 10);
if (!Number.isInteger(sizeMiB) || sizeMiB < 16 || sizeMiB > 512) {
    throw new Error('R2_BENCHMARK_SIZE_MB must be an integer from 16 to 512.');
}

const accountId = process.env.R2_ACCOUNT_ID;
const endpointHost = `${accountId}.r2.cloudflarestorage.com`;
const endpoint = `https://${endpointHost}`;
const bucket = process.env.R2_BUCKET || 'videohost';
const cases = (process.env.R2_BENCHMARK_CASES || '8x3,16x3,32x2').split(',').map((item) => {
    const match = item.trim().match(/^(5|6|7|8|9|[1-9]\d{1,2})x([1-4])$/);
    if (!match) throw new Error(`Invalid benchmark case: ${item}. Use e.g. 16x3.`);
    return { partMiB: Number(match[1]), queueSize: Number(match[2]) };
});

function elapsedMs(start) { return Number(process.hrtime.bigint() - start) / 1e6; }
function benchmarkBody(totalBytes, chunkBytes = MiB) {
    let sent = 0;
    return new Readable({
        read() {
            if (sent >= totalBytes) return this.push(null);
            const length = Math.min(chunkBytes, totalBytes - sent);
            sent += length;
            // A zero-filled buffer avoids measuring random-number generation
            // instead of the disk/network path. The object is deleted after
            // each case, so its contents are irrelevant.
            this.push(Buffer.alloc(length));
        }
    });
}

async function measureControlPlane() {
    const dnsStart = process.hrtime.bigint();
    const addresses = await dns.lookup(endpointHost, { all: true, verbatim: true });
    const dnsMs = elapsedMs(dnsStart);
    const tlsMs = await new Promise((resolve, reject) => {
        const start = process.hrtime.bigint();
        const request = https.request({ host: endpointHost, method: 'HEAD', path: '/', timeout: 10000, ALPNProtocols: ['h2', 'http/1.1'] }, (response) => {
            response.resume();
            resolve({ ms: elapsedMs(start), alpn: response.socket.alpnProtocol || 'http/1.1', status: response.statusCode });
        });
        request.once('timeout', () => request.destroy(new Error('TLS probe timed out')));
        request.once('error', reject);
        request.end();
    });
    console.log(JSON.stringify({ type: 'control-plane', endpointHost, addresses, dnsMs: Number(dnsMs.toFixed(1)), tlsMs: Number(tlsMs.ms.toFixed(1)), alpn: tlsMs.alpn, status: tlsMs.status }));
}

async function main() {
    await measureControlPlane();
    const agent = new https.Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4 });
    const client = new S3Client({
        region: 'auto', endpoint,
        credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY },
        requestHandler: new (require('@smithy/node-http-handler').NodeHttpHandler)({ httpsAgent: agent, connectionTimeout: 10000, socketTimeout: 120000 }),
        maxAttempts: 3,
    });
    const totalBytes = sizeMiB * MiB;
    try {
        for (const test of cases) {
            const key = `_bench/r2-upload-${Date.now()}-${test.partMiB}m-${test.queueSize}q.bin`;
            const start = process.hrtime.bigint();
            const upload = new Upload({
                client,
                params: { Bucket: bucket, Key: key, Body: benchmarkBody(totalBytes), ContentType: 'application/octet-stream' },
                partSize: test.partMiB * MiB, queueSize: test.queueSize, leavePartsOnError: false,
            });
            await upload.done();
            const seconds = elapsedMs(start) / 1000;
            console.log(JSON.stringify({ type: 'multipart', sizeMiB, partMiB: test.partMiB, queueSize: test.queueSize, seconds: Number(seconds.toFixed(3)), mibPerSecond: Number((sizeMiB / seconds).toFixed(2)) }));
            await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        }
    } finally {
        agent.destroy();
    }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
