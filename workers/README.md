# VideoHost Edge Worker — Deployment Guide

## Overview

This Worker runs on Cloudflare's edge network and intercepts requests to `muaj.bro.bd`
before they reach the VPS. It provides:

- **R2 Video Proxy**: Streams videos directly from R2 at the edge (zero VPS bandwidth)
- **Security Headers**: Applies HSTS, CSP, X-Frame-Options on all responses
- **Static Asset Caching**: Caches CSS/JS/images at Cloudflare's edge with 7-day TTL
- **Edge Validation**: Blocks path traversal, bot probes, and suspicious file requests
- **Range Request Support**: Full HTTP 206 Partial Content for video seeking

## Prerequisites

1. **Cloudflare Account** with the domain `muaj.bro.bd` already configured
2. **Cloudflare R2 Bucket** named `videohost` (already exists)
3. **Bun Runtime** installed locally

## Quick Start

### 1. Install Dependencies

```bash
bun install
```

### 2. Authenticate with Cloudflare

```bash
bunx wrangler login
```

This opens a browser window to authorize the CLI.

### 3. Deploy Cloudflare Worker

```bash
bunx wrangler deploy
```

### 4. Set the Session Secret

```bash
bunx wrangler secret put SESSION_SECRET
# Enter the same SESSION_SECRET value from your VPS .env file
```

### 5. Configure Routes

Uncomment the routes section in `wrangler.toml`:

```toml
[routes]
pattern = "muaj.bro.bd/*"
zone_name = "bro.bd"
```

> **Note**: Replace `bro.bd` with your actual Cloudflare zone name if different.

### 6. Deploy

```bash
cd workers
npm run deploy
# or: wrangler deploy
```

### 7. Verify

```bash
# Check security headers
curl -sI https://muaj.bro.bd/dashboard | grep -E "(X-Content|X-Frame|Strict-Transport|Permissions-Policy)"

# Check video streaming (replace with a real video key)
curl -v -H "Range: bytes=0-1023" \
     -H "Cookie: videohost.sid=<your-session-cookie>" \
     https://muaj.bro.bd/stream/<video-uuid>.mp4
```

## VPS-Side Configuration (Phase 6)

Add these to your VPS `.env` file for cache purge on video deletion:

```env
# Cloudflare Workers — Edge cache purge
CF_ZONE_ID=<your-zone-id>
CF_API_TOKEN=<your-api-token>
CF_DOMAIN=muaj.bro.bd
```

### Getting Your Zone ID
1. Go to Cloudflare Dashboard → Select your domain
2. The Zone ID is on the right sidebar of the Overview page

### Creating an API Token
1. Go to Cloudflare Dashboard → My Profile → API Tokens
2. Click "Create Token"
3. Use the "Edit zone" template, or create a custom token with:
   - **Permission**: Zone → Cache Purge → Purge
   - **Zone Resources**: Include → Specific zone → your domain

## Development

```bash
cd workers
npm run dev
```

This starts a local Worker dev server with R2 binding simulation.

## Rollback

### Instant (< 1 minute)
Go to **Cloudflare Dashboard → Workers & Pages → videohost-edge → Triggers → Routes**
and delete the route `muaj.bro.bd/*`.

All traffic immediately reverts to flowing directly to the VPS.

### Partial Feature Disable
Comment out specific route handlers in `src/worker.js` and redeploy:

```bash
cd workers
wrangler deploy
```

## Monitoring

```bash
# Real-time Worker logs
cd workers
npm run tail
# or: wrangler tail
```

## Architecture

```
Browser → Cloudflare Edge
              ↓
         Worker Router
              ↓
    ┌─────────┼──────────┐
    ↓         ↓          ↓
  /stream/* → R2 Proxy   All other → VPS Origin
  *.css,js  → Edge Cache  (with security headers)
```
