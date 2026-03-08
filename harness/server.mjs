/**
 * Dev server with required COOP/COEP headers.
 *
 * WebGPU + SharedArrayBuffer both require cross-origin isolation:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 *
 * Also supports HTTP Range requests (RFC 7233) for on-demand block fetching
 * of the SteamOS ext2 image.
 *
 * URL routing:
 *   /               → harness/index.html
 *   /steam/*        → ../steam/*    (large disk images, served with range support)
 *   /canary/*       → CANARY_PKG/*  (Canary WASM package — canary_wasm.js + .wasm)
 *   /*              → harness/*     (JS modules, HTML, etc.)
 *
 * Set CANARY_PKG env var to override the default Canary package path.
 * Default assumes Canary repo is a sibling of the SteamWeb directory:
 *   D:\Dev Proj\Canary\crates\canary-wasm\pkg
 *
 * Usage: node server.mjs
 *
 * ── Verbose client tracking ──────────────────────────────────────────────────
 *
 * Each TLS session gets a short UUID (8 hex chars) for log correlation.
 * With HTTP/2, all requests from one browser tab share a single TLS session,
 * so you will see one conn-ID per browser tab (unlike HTTP/1.1's 6 sockets).
 *
 * Inferred client states (from request patterns):
 *   connected → init → loading-js → loading-wasm →
 *   loading-image → image-loaded → booting
 *
 * Log format:
 *   [HH:MM:SS.mmm] [conn-uuid] EVENT            detail…
 *
 * Events:
 *   CONNECTED   — new TCP socket; includes remote addr and active conn count
 *   STATE       — state transition (prev → next)
 *   SEND START  — large file (>10 MiB) download beginning
 *   PROGRESS    — large file download checkpoint (~10% intervals)
 *   200 / 200 DONE / 206 range — request completion with size, time, speed
 *   206 range   — Range request; image requests include cumulative % progress
 *   403 / 404   — error responses
 *   DISCONNECTED — socket closed; session summary (duration, bytes, req count)
 */

import http2                                               from 'node:http2';
import { createReadStream, mkdirSync,
         readFileSync, writeFileSync, existsSync }         from 'node:fs';
import { stat }                                           from 'node:fs/promises';
import { extname, join, resolve, dirname, sep }           from 'node:path';
import { fileURLToPath }                                  from 'node:url';
import { randomUUID }                                     from 'node:crypto';
import { createGzip }                                     from 'node:zlib';
import { networkInterfaces, tmpdir }                      from 'node:os';
import { execFileSync }                                   from 'node:child_process';

import * as Sentry from '@sentry/node';

const HARNESS   = dirname(fileURLToPath(import.meta.url));
// Sentry error monitoring
Sentry.init({
    dsn: 'https://1c4a4feca7200264db154982ce6ff0d5@o972642.ingest.us.sentry.io/4511009816182784',
    tracesSampleRate: 0.1,
    environment: process.env.NODE_ENV ?? 'production',
    release: 'webx@0.1.0',
});
process.on('unhandledRejection', (reason) => Sentry.captureException(reason));
process.on('uncaughtException',  (err)    => { Sentry.captureException(err); throw err; });


const REPO_ROOT = resolve(join(HARNESS, '..'));
const PORT      = 3000;

// ── Self-signed TLS certificate ───────────────────────────────────────────────
// HTTPS is required for crossOriginIsolated (COOP/COEP) on non-localhost origins.
// Generated once via openssl at startup; cached in system temp across restarts.
// Browsers show "Not secure" — click Advanced → Proceed to accept once per browser.
{
    const dir  = join(tmpdir(), 'webx-dev-tls');
    const cert = join(dir, 'cert.pem');
    const key  = join(dir, 'key.pem');
    const cnf  = join(dir, 'openssl.cnf');
    if (!existsSync(cert) || !existsSync(key)) {
        mkdirSync(dir, { recursive: true });
        // Minimal openssl config — avoids "Can't open openssl.cnf" on Windows.
        writeFileSync(cnf,
            '[req]\ndistinguished_name=dn\n[dn]\nCN=webx-dev\n' +
            '[ext]\nsubjectAltName=IP:0.0.0.0,IP:127.0.0.1,DNS:localhost\n');
        execFileSync('openssl', [
            'req', '-x509', '-newkey', 'rsa:2048',
            '-keyout', key, '-out', cert,
            '-days', '3650', '-nodes', '-subj', '/CN=webx-dev',
            '-config', cnf, '-extensions', 'ext',
        ], { stdio: 'pipe', env: { ...process.env, OPENSSL_CONF: cnf } });
        console.log(`[TLS] Self-signed cert generated → ${cert}`);
    }
}
const TLS_KEY  = readFileSync(join(tmpdir(), 'webx-dev-tls', 'key.pem'),  'utf8');
const TLS_CERT = readFileSync(join(tmpdir(), 'webx-dev-tls', 'cert.pem'), 'utf8');

/* Path to the Canary wasm-pack output directory.
 * Default: sibling repo at ../../Canary/crates/canary-wasm/pkg relative to WebX root.
 * Override with CANARY_PKG environment variable. */
const CANARY_PKG = process.env.CANARY_PKG
    ?? resolve(REPO_ROOT, '..', 'Canary', 'crates', 'canary-wasm', 'pkg');


// â”€â”€ Asset versioning â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Version derived from WASM build timestamp so every `wasm-pack build`
// automatically busts browser caches without manual intervention.
import { statSync } from 'node:fs';
function computeVersion() {
    try {
        const wasmPath = join(HARNESS, 'canary_wasm_bg.wasm');
        return (statSync(wasmPath).mtimeMs | 0).toString(36);
    } catch { return Date.now().toString(36); }
}
const ASSET_VERSION = computeVersion();

const MIME = {
    '.html': 'text/html',
    '.mjs':  'text/javascript',
    '.js':   'text/javascript',
    '.css':  'text/css',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.ext2': 'application/octet-stream',
};

const CORS = {
    'Cross-Origin-Opener-Policy':   'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Access-Control-Allow-Origin':  '*',
};

/* Allowed filesystem roots — restrict path traversal */
const ALLOWED_ROOTS = [
    resolve(HARNESS),
    resolve(join(REPO_ROOT, 'steam')),
    resolve(CANARY_PKG),
];

function isAllowed(realPath) {
    return ALLOWED_ROOTS.some(r => realPath.startsWith(r + sep) || realPath === r);
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function fmtBytes(n) {
    if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GiB`;
    if (n >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)} MiB`;
    if (n >= 1_024)         return `${(n / 1_024).toFixed(1)} KiB`;
    return `${n} B`;
}

function fmtSpeed(bytes, ms) {
    if (ms < 1) return '?/s';
    return `${fmtBytes((bytes / ms) * 1000)}/s`;
}

function fmtDuration(ms) {
    if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m ${((ms % 60_000) / 1000).toFixed(1)}s`;
    if (ms >= 1_000)  return `${(ms / 1000).toFixed(2)}s`;
    return `${ms}ms`;
}

/** HH:MM:SS.mmm from the current local time. */
function ts() {
    return new Date().toISOString().slice(11, 23);
}

/** Last path segment, truncated to 32 chars for readability. */
function shortName(p) {
    const base = p === '/' ? 'index.html' : p.split('/').pop();
    return base.length > 32 ? `…${base.slice(-29)}` : base;
}

function clog(uuid, event, detail = '') {
    const line = `[${ts()}] [${uuid}] ${event.padEnd(16)}`;
    console.log(detail ? `${line}  ${detail}` : line);
}

// ── Client tracking ───────────────────────────────────────────────────────────

/**
 * One entry per active TCP socket.
 * @typedef {{ uuid: string, state: string, connectedAt: number,
 *             bytesSent: number, requestCount: number,
 *             imageSize: number, imageBytesFetched: number }} ClientInfo
 */

/** @type {Map<string, ClientInfo>} */
const clients = new Map();

/**
 * Return (creating if needed) the ClientInfo for this request's TCP socket.
 * Registers a one-time 'close' listener for session teardown logging.
 */
function getClient(req) {
    const sock = req.socket;
    const key  = `${sock.remoteAddress}:${sock.remotePort}`;

    if (!clients.has(key)) {
        const uuid = randomUUID().replace(/-/g, '').slice(0, 8);
        /** @type {ClientInfo} */
        const info = {
            uuid,
            state:             'connected',
            connectedAt:       Date.now(),
            bytesSent:         0,
            requestCount:      0,
            imageSize:         0,   // total ext2 file size (set on first access)
            imageBytesFetched: 0,   // cumulative image bytes served to this conn
        };
        clients.set(key, info);

        sock.once('close', () => {
            const c = clients.get(key);
            if (!c) return;
            const dur = Date.now() - c.connectedAt;
            clog(c.uuid, 'DISCONNECTED',
                `state=${c.state}  duration=${fmtDuration(dur)}  ` +
                `sent=${fmtBytes(c.bytesSent)}  reqs=${c.requestCount}`);
            clients.delete(key);
        });

        clog(uuid, 'CONNECTED',
            `addr=${sock.remoteAddress}  active-conns=${clients.size}`);
    }

    return clients.get(key);
}

function setState(client, next) {
    if (client.state === next) return;
    clog(client.uuid, 'STATE', `${client.state} → ${next}`);
    client.state = next;
}

/**
 * Infer a client state transition from the request path and whether it
 * is a range request.  States progress roughly as:
 *   connected → init → loading-js → loading-wasm → loading-image
 *                                                → image-loaded
 *                                                → booting  (range reqs)
 */
function inferState(client, path, isRange) {
    if (path === '/' || path.endsWith('.html')) {
        setState(client, 'init');
    } else if (path.startsWith('/canary/') && path.endsWith('.wasm')) {
        setState(client, 'loading-wasm');
    } else if (path.startsWith('/canary/')) {
        // JS module (canary_wasm.js) or JSON — early asset load
        if (client.state === 'connected' || client.state === 'init')
            setState(client, 'loading-js');
    } else if (path.startsWith('/steam/') && path.endsWith('.ext2')) {
        if (isRange) {
            // Range request → Canary is fetching ext2 blocks on demand (guest booting)
            if (client.state !== 'booting') setState(client, 'booting');
        } else {
            setState(client, 'loading-image');
        }
    }
}

// ── Request handler ───────────────────────────────────────────────────────────

/* Large-file thresholds:
 *   > LARGE_LOG_THRESHOLD  → log SEND START + 200 DONE (not just a one-liner)
 *   > PROGRESS_THRESHOLD   → also emit PROGRESS every ~10%
 */
const LARGE_LOG_THRESHOLD = 1 * 1024 * 1024;   //  1 MiB
const PROGRESS_THRESHOLD  = 10 * 1024 * 1024;  // 10 MiB

// HTTP/2 with allowHTTP1 fallback — Chrome multiplexes dozens of Range
// requests over a single H2 connection, bypassing the HTTP/1.1 6-connection
// limit that previously capped ext2 block-scan throughput.
http2.createSecureServer({ allowHTTP1: true, key: TLS_KEY, cert: TLS_CERT }, async (req, res) => {
    const client = getClient(req);
    client.requestCount++;

    const url  = new URL(req.url, `http://localhost:${PORT}`);
    const path = url.pathname;

    /* URL → filesystem */
    let file;
    if (path === '/') {
        file = join(HARNESS, 'index.html');
    } else if (path.startsWith('/steam/')) {
        file = join(REPO_ROOT, path);
    } else if (path.startsWith('/canary/')) {
        file = join(CANARY_PKG, path.slice('/canary/'.length));
    } else {
        file = join(HARNESS, path);
    }

    const realFile = resolve(file);
    if (!isAllowed(realFile)) {
        clog(client.uuid, '403', path);
        res.writeHead(403); res.end('Forbidden'); return;
    }

    /* Silence browser favicon requests */
    if (path === '/favicon.ico') { res.writeHead(204); res.end(); return; }

    let fileStat;
    try { fileStat = await stat(realFile); }
    catch {
        clog(client.uuid, '404', path);
        res.writeHead(404); res.end('Not found'); return;
    }

    const isRange   = !!req.headers['range'];
    const isImage   = path.startsWith('/steam/') && path.endsWith('.ext2');
    const isLarge   = fileStat.size > LARGE_LOG_THRESHOLD;
    const hasProgress = fileStat.size > PROGRESS_THRESHOLD;

    inferState(client, path, isRange);

    const contentType  = MIME[extname(realFile)] ?? 'application/octet-stream';
    const lastModified = fileStat.mtime.toUTCString();  /* Required by HttpBytesDevice */
    const etag         = `"${fileStat.size}-${fileStat.mtimeMs | 0}"`;
    const reqStart     = Date.now();

    // Never cache JS/WASM — always serve fresh so updates take effect immediately.
    const isScript = ['.js', '.mjs', '.wasm'].includes(extname(realFile));
    // Scripts always served fresh â€” never return 304 for JS/WASM
    // so stale cached code can't survive a wasm-pack rebuild.

    if (isRange) {
        /* ── Range request (RFC 7233) ──────────────────────────────────────
         * Canary fetches ext2 image blocks on demand using Range: bytes=start-end.
         * Must respond 206 Partial Content (not 200), with Last-Modified for validation.
         */
        const rangeHeader = req.headers['range'];
        const match = rangeHeader.match(/bytes=(\d*)-(\d*)/);
        if (!match) { res.writeHead(400); res.end('Bad Range'); return; }

        const fileSize  = fileStat.size;
        const start     = match[1] ? parseInt(match[1], 10) : 0;
        const end       = match[2] ? Math.min(parseInt(match[2], 10), fileSize - 1)
                                   : fileSize - 1;

        if (start > end || start >= fileSize) {
            res.writeHead(416, { 'Content-Range': `bytes */${fileSize}` });
            res.end(); return;
        }

        const chunkSize = end - start + 1;

        res.writeHead(206, {
            ...CORS,
            'Content-Type':   contentType,
            'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
            'Content-Length': String(chunkSize),
            'Accept-Ranges':  'bytes',
            'Last-Modified':  lastModified,
        });

        createReadStream(realFile, { start, end }).pipe(res);

        res.on('finish', () => {
            const elapsed = Date.now() - reqStart;
            client.bytesSent += chunkSize;

            if (isImage) {
                if (client.imageSize === 0) client.imageSize = fileSize;
                client.imageBytesFetched += chunkSize;
                const pct = `${((client.imageBytesFetched / fileSize) * 100).toFixed(2)}%`;
                clog(client.uuid, '206 range',
                    `${shortName(path)}  [${start}–${end}]  chunk=${fmtBytes(chunkSize)}  ` +
                    `cumulative=${fmtBytes(client.imageBytesFetched)}/${fmtBytes(fileSize)} (${pct})  ` +
                    `@${fmtSpeed(chunkSize, elapsed)}`);
            } else {
                clog(client.uuid, '206 range',
                    `${shortName(path)}  [${start}–${end}]  ${fmtBytes(chunkSize)}  @${fmtSpeed(chunkSize, elapsed)}`);
            }
        });

    } else if (isImage) {
        /* ── ext2 image: serve gzip-compressed to halve transfer size ──────
         *
         * The browser auto-decompresses Content-Encoding: gzip responses, so
         * canary-host.mjs receives the raw ext2 bytes via its ReadableStream
         * reader without any extra JS-side decompression code.
         *
         * X-Uncompressed-Length carries the original file size so the client
         * can pre-allocate the exact Uint8Array before streaming starts.
         *
         * Priority:
         *   1. steamos-webx.ext2.gz — pre-compressed (fastest, preferred)
         *      Create with: gzip -1 -k steam/steamos-webx.ext2
         *   2. On-the-fly gzip level 1 (no .gz file found)
         *      Slower first request but no offline step required.
         *
         * Range requests on compressed content are not well-defined, so the
         * gzip path is non-range only.  Range requests still hit the plain path.
         */
        const gzPath = realFile + '.gz';
        let gzStat = null;
        try { gzStat = await stat(gzPath); } catch { /* no .gz file */ }

        if (gzStat) {
            /* ── Pre-compressed .ext2.gz ── */
            clog(client.uuid, 'SEND START',
                `${shortName(path)}  pre-compressed  ` +
                `compressed=${fmtBytes(gzStat.size)}  uncompressed=${fmtBytes(fileStat.size)}`);

            res.writeHead(200, {
                ...CORS,
                'Content-Type':          contentType,
                'Content-Encoding':      'gzip',
                'Content-Length':        String(gzStat.size),
                'X-Uncompressed-Length': String(fileStat.size),
                'Last-Modified':         lastModified,
            });

            const gzStream  = createReadStream(gzPath);
            const step      = Math.ceil(gzStat.size / 10);
            let bytesSoFar  = 0;
            let nextMark    = step;

            gzStream.on('data', (chunk) => {
                bytesSoFar += chunk.length;
                if (bytesSoFar >= nextMark) {
                    const elapsed = Date.now() - reqStart;
                    const pct = Math.min(100, Math.round((bytesSoFar / gzStat.size) * 100));
                    clog(client.uuid, 'PROGRESS',
                        `${shortName(path)}  ${pct}%  ` +
                        `${fmtBytes(bytesSoFar)}/${fmtBytes(gzStat.size)} compressed  ` +
                        `@${fmtSpeed(bytesSoFar, elapsed)}`);
                    nextMark += step;
                }
            });

            gzStream.pipe(res);
            req.on('close', () => gzStream.destroy());

            res.on('finish', () => {
                const elapsed = Date.now() - reqStart;
                client.bytesSent += gzStat.size;
                if (client.imageSize === 0) client.imageSize = fileStat.size;
                setState(client, 'image-loaded');
                clog(client.uuid, '200 DONE',
                    `${shortName(path)}  ` +
                    `${fmtBytes(gzStat.size)} → ${fmtBytes(fileStat.size)} decompressed  ` +
                    `in ${fmtDuration(elapsed)}  @${fmtSpeed(gzStat.size, elapsed)}`);
            });

        } else {
            /* ── On-the-fly gzip level 1 ── */
            clog(client.uuid, 'SEND START',
                `${shortName(path)}  on-the-fly gzip/1  uncompressed=${fmtBytes(fileStat.size)}  ` +
                `(tip: gzip -1 -k steam/${shortName(path)} to pre-compress)`);

            res.writeHead(200, {
                ...CORS,
                'Content-Type':          contentType,
                'Content-Encoding':      'gzip',
                'X-Uncompressed-Length': String(fileStat.size),
                'Last-Modified':         lastModified,
                /* No Content-Length — compressed size unknown until EOF */
            });

            const rawStream = createReadStream(realFile);
            const gzip      = createGzip({ level: 1, chunkSize: 256 * 1024 });

            /* Track uncompressed bytes read to show disk-read progress. */
            const step     = Math.ceil(fileStat.size / 10);
            let bytesSoFar = 0;
            let nextMark   = step;

            rawStream.on('data', (chunk) => {
                bytesSoFar += chunk.length;
                if (bytesSoFar >= nextMark) {
                    const elapsed = Date.now() - reqStart;
                    const pct = Math.min(100, Math.round((bytesSoFar / fileStat.size) * 100));
                    clog(client.uuid, 'PROGRESS',
                        `${shortName(path)}  ${pct}%  ` +
                        `${fmtBytes(bytesSoFar)}/${fmtBytes(fileStat.size)} (uncompressed)  ` +
                        `@${fmtSpeed(bytesSoFar, elapsed)} disk`);
                    nextMark += step;
                }
            });

            rawStream.pipe(gzip).pipe(res);
            req.on('close', () => rawStream.destroy());

            res.on('finish', () => {
                const elapsed = Date.now() - reqStart;
                client.bytesSent += fileStat.size;  /* approximate; compressed bytes unknown */
                if (client.imageSize === 0) client.imageSize = fileStat.size;
                setState(client, 'image-loaded');
                clog(client.uuid, '200 DONE',
                    `${shortName(path)}  ${fmtBytes(fileStat.size)} uncompressed  ` +
                    `in ${fmtDuration(elapsed)}  @${fmtSpeed(fileStat.size, elapsed)} disk`);
            });
        }

    } else {
        /* ── Normal (non-range, non-image) response ────────────────────────
         * Stream the file to avoid loading large assets into memory.
         */
        res.writeHead(200, {
            ...CORS,
            'Content-Type':   contentType,
            'Content-Length': String(fileStat.size),
            'Accept-Ranges':  'bytes',
            'Last-Modified':  lastModified,
            'ETag':           etag,
            ...(isScript ? { 'Cache-Control': 'no-store' } : {}),
        });

        // Inject ASSET_VERSION into index.html so JS imports are cache-busted
        let stream;
        if (path === '/' || path === '/index.html' || realFile.endsWith('index.html')) {
            const { readFileSync } = await import('node:fs');
            let html = readFileSync(realFile, 'utf8');
            html = html.replace(/canary-host\.mjs(?:\?v=[^'"]*)?/g, `canary-host.mjs?v=${ASSET_VERSION}`);
            res.writeHead(200, {
                ...CORS,
                'Content-Type':   'text/html',
                'Content-Length': Buffer.byteLength(html),
                'Cache-Control':  'no-store',
            });
            res.end(html);
            return;
        }
        stream = createReadStream(realFile);

        if (isLarge) {
            clog(client.uuid, 'SEND START',
                `${shortName(path)}  size=${fmtBytes(fileStat.size)}`);
        }

        /* Emit PROGRESS every ~10% for very large files. */
        if (hasProgress) {
            const step = Math.ceil(fileStat.size / 10);
            let bytesSoFar  = 0;
            let nextMark    = step;

            stream.on('data', (chunk) => {
                bytesSoFar += chunk.length;
                if (bytesSoFar >= nextMark) {
                    const elapsed = Date.now() - reqStart;
                    const pct = Math.min(100, Math.round((bytesSoFar / fileStat.size) * 100));
                    clog(client.uuid, 'PROGRESS',
                        `${shortName(path)}  ${pct}%  ` +
                        `${fmtBytes(bytesSoFar)}/${fmtBytes(fileStat.size)}  ` +
                        `@${fmtSpeed(bytesSoFar, elapsed)}`);
                    nextMark += step;
                }
            });
        }

        stream.pipe(res);

        res.on('finish', () => {
            const elapsed = Date.now() - reqStart;
            client.bytesSent += fileStat.size;

            if (isLarge) {
                clog(client.uuid, '200 DONE',
                    `${shortName(path)}  ${fmtBytes(fileStat.size)}  ` +
                    `in ${fmtDuration(elapsed)}  @${fmtSpeed(fileStat.size, elapsed)}`);
            } else {
                clog(client.uuid, '200',
                    `${shortName(path)}  ${fmtBytes(fileStat.size)}  ${fmtDuration(elapsed)}`);
            }
        });
    }

}).listen(PORT, '0.0.0.0', () => {
    const nets = Object.values(networkInterfaces()).flat().filter(n => n.family === 'IPv4' && !n.internal);
    const lan  = nets[0]?.address ?? '(run ipconfig to find your IP)';
    console.log('');
    console.log(`  WebX dev server:    https://localhost:${PORT}  (LAN: https://${lan}:${PORT})`);
    console.log('  TLS: self-signed — click Advanced → Proceed in browser on first visit');
    console.log('  COOP/COEP headers:  active (WebGPU + SharedArrayBuffer enabled)');
    console.log(`  Guest image:        ${join(REPO_ROOT, 'steam', 'steamos-webx.ext2')}`);
    console.log(`  Canary WASM pkg:    ${CANARY_PKG}`);
    console.log('');
    console.log('  Client log: [HH:MM:SS.mmm] [conn-uuid] EVENT  detail');
    console.log('  States:     connected → init → loading-js → loading-wasm');
    console.log('              → loading-image → image-loaded → booting');
    console.log('');
});
